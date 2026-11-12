/**
 * Gateway smoke verifier for the Phase-2 P2-M1 milestone.
 *
 * Exercises the running DSH host's `dsh-movie-gateway` plugin (Leg B/C) end to
 * end, using brokered Matrix tokens exactly like a logged-in browser would:
 *
 *  - Leg C JSON-RPC (`POST /api/<ns>/<method>`):
 *      * `registry/list` + `registry/get` round-trip (known + unknown id);
 *      * `auth/principal` maps the caller's token to its DSH principal;
 *      * `auth/role` resolves host / member / none (fail-closed);
 *      * `assets/list` host-gate: the room creator succeeds, a joined member and
 *        a non-member are refused `forbidden`;
 *      * an invalid token is rejected `invalid-token`, a missing token
 *        `missing-token`.
 *  - Leg B ComfyUI subset: `/object_info`, `/system_stats`, and `POST /prompt`
 *      driving the `/ws` execution lifecycle (status -> queued -> execution_start
 *      -> executing -> progress -> executed -> execution_success).
 *  - Leg C stream mux: `/api/ws` `open` on channel `leg-b/exec` replays the
 *      lifecycle as `StreamFrame`s terminated by an `end` frame.
 *
 * Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory (movie-profile host must be up with the
 * gateway on port 8788 and identity `/auth` on 8787):
 *   node scripts/verify-gateway.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs,
  type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'
// Relative (not the `@dsh-movie/protocol` bare specifier) so Node's type
// stripping applies at runtime — the package symlink resolves into
// `node_modules`, which Node will not transform.
import { isExecMessage, type ExecMessage, type StreamFrame } from '../../protocol/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')

/** Load `server/.env` into process.env (existing keys win). */
function loadDotEnv(): void {
  let text: string
  try {
    text = readFileSync(resolve(serverRoot, '.env'), 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

const logger = {
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** A Leg C call result: the HTTP status plus the parsed `ApiResult` envelope. */
interface LegCCall {
  status: number
  ok: boolean
  result: unknown
  errorCode: string | undefined
}

/** Call a Leg C method with a bearer token and a params body. */
async function callLegC(gatewayUrl: string, method: string, token: string | null, params: Record<string, unknown>): Promise<LegCCall> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  const resp = await fetch(`${gatewayUrl}/api/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })
  const body = (await resp.json()) as { ok?: boolean; result?: unknown; error?: { code?: string } }
  return { status: resp.status, ok: body.ok === true, result: body.result, errorCode: body.error?.code }
}

/** Collect the Leg B `/ws` lifecycle for one submitted two-node prompt. */
async function collectExecLifecycle(gatewayUrl: string, wsBase: string): Promise<{ messages: ExecMessage[]; promptId: string }> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/ws`)
    const messages: ExecMessage[] = []
    let promptId = ''
    let sawSuccess = false
    let settled = false
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('Leg B lifecycle timed out'))
    }, 10_000)
    // The gateway broadcasts the lifecycle before it answers POST /prompt, so the
    // WS `execution_success` can beat the HTTP response that carries `prompt_id`.
    // Resolve only once BOTH have arrived to keep the prompt_id assertions stable.
    function settle(): void {
      if (settled || !sawSuccess || promptId === '') return
      settled = true
      clearTimeout(timer)
      socket.close()
      resolveCollect({ messages, promptId })
    }
    socket.addEventListener('open', () => {
      void (async () => {
        const resp = await fetch(`${gatewayUrl}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: {
              '1': { class_type: 'MovieTextToImage', inputs: {} },
              '2': { class_type: 'MovieSaveOutput', inputs: {} },
            },
          }),
        })
        const data = (await resp.json()) as { prompt_id?: string }
        promptId = typeof data.prompt_id === 'string' ? data.prompt_id : ''
        settle()
      })().catch((error: unknown) => rejectCollect(error instanceof Error ? error : new Error(String(error))))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (!isExecMessage(parsed)) return
      messages.push(parsed)
      if (parsed.type === 'execution_success') sawSuccess = true
      settle()
    })
    socket.addEventListener('error', () => { /* the timeout guards a hard failure */ })
  })
}

/** Collect the Leg C `/api/ws` mux frames for one `leg-b/exec` stream. */
async function collectMuxFrames(wsBase: string): Promise<StreamFrame[]> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/api/ws`)
    const frames: StreamFrame[] = []
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('Leg C mux timed out'))
    }, 10_000)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ op: 'open', stream: 's1', channel: 'leg-b/exec', params: { nodeIds: ['1', '2'] } }))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (typeof parsed !== 'object' || parsed === null) return
      const candidate = parsed as Partial<StreamFrame>
      if (typeof candidate.stream !== 'string' || typeof candidate.type !== 'string') return
      frames.push(parsed as StreamFrame)
      if (candidate.type === 'end' && candidate.stream === 's1') {
        clearTimeout(timer)
        socket.close()
        resolveCollect(frames)
      }
    })
    socket.addEventListener('error', () => { /* the timeout guards a hard failure */ })
  })
}

/** Dev-only throwaway local accounts; not real secrets. */
const HOST_LOCALPART = 'movie_gw_host'
const MEMBER_LOCALPART = 'movie_gw_member'
const OUTSIDER_LOCALPART = 'movie_gw_outsider'
const DEMO_PASSWORD = 'movie-gateway-pass'

async function main(): Promise<void> {
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
  const wsBase = gatewayUrl.replace(/^http/, 'ws')
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot verify.\n')
    process.exit(1)
  }
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }

  const hostId = `@${HOST_LOCALPART}:${serverName}`
  const memberId = `@${MEMBER_LOCALPART}:${serverName}`
  const outsiderId = `@${OUTSIDER_LOCALPART}:${serverName}`

  // Provision the three accounts and a room the host creates (host=creator).
  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Gateway Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Gateway Member' })
  await ensureUser(endpoint, logger, outsiderId, { password: DEMO_PASSWORD, displayName: 'Gateway Outsider' })
  const roomId = await createRoom(endpoint, logger, 'Movie Gateway Room', hostId, [memberId, botUserId])
  check('host created the gateway room', roomId !== null, roomId ?? 'none')
  if (roomId === null) process.exit(1)
  await joinRoomAs(endpoint, logger, memberId, roomId)
  await joinRoomAs(endpoint, logger, botUserId, roomId)

  const hostCreds = await brokerToken(endpoint, logger, hostId)
  const memberCreds = await brokerToken(endpoint, logger, memberId)
  const outsiderCreds = await brokerToken(endpoint, logger, outsiderId)
  check('brokered tokens for all three accounts', hostCreds !== null && memberCreds !== null && outsiderCreds !== null)
  if (hostCreds === null || memberCreds === null || outsiderCreds === null) process.exit(1)

  // 0. Gateway liveness.
  const health = await fetch(`${gatewayUrl}/health`)
  check('gateway /health answers ok', health.ok && ((await health.json()) as { ok?: boolean }).ok === true)

  // 1. Leg C registry round-trip.
  const list = await callLegC(gatewayUrl, 'registry/list', hostCreds.accessToken, {})
  const listEntries = list.ok ? ((list.result as { entries?: unknown[] }).entries ?? []) : []
  check('registry/list returns entries', list.status === 200 && list.ok && listEntries.length > 0, `${listEntries.length} entries`)

  const getKnown = await callLegC(gatewayUrl, 'registry/get', hostCreds.accessToken, { id: 'movie.text_to_image' })
  const knownEntry = getKnown.ok ? (getKnown.result as { entry?: { id?: string } }).entry : undefined
  check('registry/get returns the known entry', getKnown.status === 200 && getKnown.ok && knownEntry?.id === 'movie.text_to_image', knownEntry?.id ?? 'none')

  const getUnknown = await callLegC(gatewayUrl, 'registry/get', hostCreds.accessToken, { id: 'does.not.exist' })
  const unknownEntry = getUnknown.ok ? (getUnknown.result as { entry?: unknown }).entry : 'missing'
  check('registry/get returns null for an unknown id', getUnknown.status === 200 && getUnknown.ok && unknownEntry === null)

  // 2. Leg C auth: principal + role policy.
  const principal = await callLegC(gatewayUrl, 'auth/principal', hostCreds.accessToken, {})
  const principalUserId = principal.ok ? (principal.result as { principal?: { userId?: string } }).principal?.userId : undefined
  check('auth/principal maps the host token to the host principal', principal.status === 200 && principal.ok && principalUserId === hostId, principalUserId ?? 'none')

  const hostRole = await callLegC(gatewayUrl, 'auth/role', hostCreds.accessToken, { roomId })
  const memberRole = await callLegC(gatewayUrl, 'auth/role', memberCreds.accessToken, { roomId })
  const outsiderRole = await callLegC(gatewayUrl, 'auth/role', outsiderCreds.accessToken, { roomId })
  check('auth/role resolves the creator to "host"', hostRole.ok && (hostRole.result as { role?: string }).role === 'host', (hostRole.result as { role?: string }).role ?? 'none')
  check('auth/role resolves a joined participant to "member"', memberRole.ok && (memberRole.result as { role?: string }).role === 'member', (memberRole.result as { role?: string }).role ?? 'none')
  check('auth/role resolves a non-member to "none" (fail-closed)', outsiderRole.ok && (outsiderRole.result as { role?: string }).role === 'none', (outsiderRole.result as { role?: string }).role ?? 'none')

  // 3. Leg C host-gated assets/list.
  const assetsHost = await callLegC(gatewayUrl, 'assets/list', hostCreds.accessToken, { roomId })
  check('assets/list succeeds for the host', assetsHost.status === 200 && assetsHost.ok && Array.isArray((assetsHost.result as { assets?: unknown[] }).assets))
  const assetsMember = await callLegC(gatewayUrl, 'assets/list', memberCreds.accessToken, { roomId })
  check('assets/list is forbidden for a member (host-gated)', assetsMember.status === 403 && !assetsMember.ok && assetsMember.errorCode === 'forbidden', assetsMember.errorCode ?? `status ${assetsMember.status}`)
  const assetsOutsider = await callLegC(gatewayUrl, 'assets/list', outsiderCreds.accessToken, { roomId })
  check('assets/list is forbidden for a non-member', assetsOutsider.status === 403 && !assetsOutsider.ok && assetsOutsider.errorCode === 'forbidden', assetsOutsider.errorCode ?? `status ${assetsOutsider.status}`)

  // 4. Leg C token guards.
  const invalid = await callLegC(gatewayUrl, 'registry/list', 'bogus-token', {})
  check('an invalid token is rejected invalid-token', invalid.status === 401 && invalid.errorCode === 'invalid-token', invalid.errorCode ?? `status ${invalid.status}`)
  const missing = await callLegC(gatewayUrl, 'registry/list', null, {})
  check('a missing token is rejected missing-token', missing.status === 400 && missing.errorCode === 'missing-token', missing.errorCode ?? `status ${missing.status}`)

  // 5. Leg B HTTP subset.
  const objectInfo = await fetch(`${gatewayUrl}/object_info`)
  const objectInfoBody = objectInfo.ok ? ((await objectInfo.json()) as Record<string, unknown>) : {}
  check('/object_info advertises the movie node catalog', objectInfo.ok && 'MovieTextToImage' in objectInfoBody && 'MovieSaveOutput' in objectInfoBody)
  const systemStats = await fetch(`${gatewayUrl}/system_stats`)
  const systemStatsBody = systemStats.ok ? ((await systemStats.json()) as { system?: unknown }) : {}
  check('/system_stats answers with a system block', systemStats.ok && systemStatsBody.system !== undefined)

  // 6. Leg B /ws execution lifecycle.
  try {
    const { messages, promptId } = await collectExecLifecycle(gatewayUrl, wsBase)
    const typeAt = (type: string): number => messages.findIndex((m): boolean => m.type === type)
    const iQueued = typeAt('queued')
    const iStart = typeAt('execution_start')
    const iExecuting = typeAt('executing')
    const iProgress = typeAt('progress')
    const iExecuted = typeAt('executed')
    const iSuccess = typeAt('execution_success')
    check('lifecycle emitted a prompt_id', promptId !== '')
    check('lifecycle has status/queued/execution_start/executing/progress/executed/success', iQueued >= 0 && iStart >= 0 && iExecuting >= 0 && iProgress >= 0 && iExecuted >= 0 && iSuccess >= 0)
    check('lifecycle order is queued < execution_start < executing < execution_success', iQueued >= 0 && iQueued < iStart && iStart < iExecuting && iExecuting < iSuccess)
    check('lifecycle is the last message execution_success', messages.length > 0 && messages[messages.length - 1]?.type === 'execution_success')
    const queued = messages[iQueued]
    check('queued carries the submitted prompt_id', queued !== undefined && queued.type === 'queued' && queued.data.prompt_id === promptId)
  } catch (error) {
    check('Leg B /ws lifecycle completed', false, String(error))
  }

  // 7. Leg C /api/ws stream mux.
  try {
    const frames = await collectMuxFrames(wsBase)
    const dataFrames = frames.filter((f): boolean => f.type === 'data')
    const endFrame = frames.find((f): boolean => f.type === 'end')
    const payloadsAreExec = dataFrames.every((f): boolean => isExecMessage(f.payload))
    check('mux streamed data frames then an end frame', dataFrames.length > 0 && endFrame !== undefined)
    check('mux data frames carry Leg B lifecycle messages', payloadsAreExec)
  } catch (error) {
    check('Leg C /api/ws mux completed', false, String(error))
  }

  process.stdout.write(failures === 0 ? '\nALL GATEWAY CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
