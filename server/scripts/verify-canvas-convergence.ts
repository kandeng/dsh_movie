/**
 * Canvas convergence + host-governance verifier (Phase-3 P3-M5).
 *
 * Proves the host-exclusive collaboration model over Leg C, using brokered
 * Matrix tokens exactly like logged-in browsers would. It folds in (and
 * supersedes) the old `verify-two-user-canvas` assertions:
 *
 *  - `auth/role` resolves host / member / none for the three provisioned seats;
 *  - a MEMBER is refused `forbidden` (403) on every mutating call
 *    (`workflow/put`, `workspace/draft.put`, `workspace/commit`) — writes are
 *    host-only; a non-member is refused on read + write (fail-closed);
 *  - the HOST autosaves a draft and commits, bumping the revision;
 *  - a SECOND `workflow/watch` mux connection (the member) receives an initial
 *    `{stage:'snapshot'}` frame, then a `{stage:'committed'}` frame on the next
 *    host commit (live multi-user convergence);
 *  - `room/transferHost` flips the host seat: a `{stage:'role'}` frame reaches
 *    the watcher, `auth/role` re-resolves (old host -> member, new host -> host),
 *    the OLD host becomes forbidden-on-write, and the NEW host can commit;
 *  - an OUTSIDER is refused on `workflow/watch`;
 *  - the token guards (`missing-token`, `invalid-token`) and param validation
 *    (`bad-request`) hold for the workspace namespace.
 *
 * Each run creates a fresh room, so the file-backed workspace starts empty for
 * it. Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory (movie-profile host up with the gateway on
 * 8788 and identity `/auth` on 8787):
 *   node scripts/verify-canvas-convergence.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs,
  type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'
import { isWorkflowWatchFrame, type WorkflowWatchFrame } from '../../protocol/src/index.ts'

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

function sleep(ms: number): Promise<void> {
  return new Promise((sleepResolve): void => { setTimeout(sleepResolve, ms) })
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

/** A read-back view of a workflow record (only the fields we assert on). */
interface RecordView {
  rev: number
  updatedBy: string | null
  graph: { nodes: Array<{ id: number; title?: string }> }
}

/** Unwrap a successful `workflow/*` / `workspace/commit|revert` record. */
function recordOf(res: LegCCall): RecordView | null {
  if (!res.ok) return null
  const envelope = res.result as { workflow?: RecordView | null }
  return envelope.workflow ?? null
}

/** Build a small two-node editor graph tagged with a marker title on node 1. */
function makeGraph(marker: string): Record<string, unknown> {
  return {
    last_node_id: 2,
    last_link_id: 1,
    nodes: [
      { id: 1, type: 'MovieScript', pos: [80, 160], size: [240, 140], flags: 0, order: 0, mode: 0, title: marker },
      { id: 2, type: 'MovieShotPlan', pos: [400, 160], size: [240, 140], flags: 0, order: 1, mode: 0 },
    ],
    links: [[1, 1, 0, 2, 0, 'SCRIPT']],
    version: 0.4,
  }
}

/** A live `workflow/watch` mux subscription with polling helpers. */
interface WatchStream {
  frames: WorkflowWatchFrame[]
  errors: Array<{ code: string | undefined; message: string | undefined }>
  /** Poll until a frame matches `pred`, or `null` after `timeoutMs`. */
  waitFor(pred: (frame: WorkflowWatchFrame) => boolean, timeoutMs: number): Promise<WorkflowWatchFrame | null>
  /** Poll until an error frame arrives, or `null` after `timeoutMs`. */
  waitError(timeoutMs: number): Promise<{ code: string | undefined; message: string | undefined } | null>
  close(): void
}

/**
 * Open a `workflow/watch` mux stream and collect its frames. The stream stays
 * open (it does not self-terminate); call {@link WatchStream.close} when done.
 */
function openWatch(wsBase: string, roomId: string, token: string): WatchStream {
  const socket = new WebSocket(`${wsBase}/api/ws`)
  const frames: WorkflowWatchFrame[] = []
  const errors: Array<{ code: string | undefined; message: string | undefined }> = []
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ op: 'open', stream: 'w1', channel: 'workflow/watch', params: { roomId, token } }))
  })
  socket.addEventListener('message', (event: MessageEvent) => {
    const text = typeof event.data === 'string' ? event.data : ''
    if (text === '') return
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as { stream?: unknown; type?: unknown; payload?: unknown }
    if (frame.stream !== 'w1' || typeof frame.type !== 'string') return
    if (frame.type === 'data' && isWorkflowWatchFrame(frame.payload)) {
      frames.push(frame.payload)
      return
    }
    if (frame.type === 'error') {
      const payload = frame.payload as { code?: string; message?: string } | undefined
      errors.push({ code: payload?.code, message: payload?.message })
    }
  })
  socket.addEventListener('error', () => { /* the polling timeouts guard a hard failure */ })
  return {
    frames,
    errors,
    async waitFor(pred, timeoutMs): Promise<WorkflowWatchFrame | null> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = frames.find(pred)
        if (found !== undefined) return found
        if (Date.now() >= deadline) return null
        await sleep(50)
      }
    },
    async waitError(timeoutMs): Promise<{ code: string | undefined; message: string | undefined } | null> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (errors.length > 0) return errors[0] ?? null
        if (Date.now() >= deadline) return null
        await sleep(50)
      }
    },
    close(): void {
      try { socket.close() } catch { /* ignore */ }
    },
  }
}

/** Dev-only throwaway local accounts; not real secrets. */
const HOST_LOCALPART = 'movie_conv_host'
const MEMBER_LOCALPART = 'movie_conv_member'
const OUTSIDER_LOCALPART = 'movie_conv_outsider'
const DEMO_PASSWORD = 'movie-conv-pass'

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

  // Provision three accounts and a fresh room the host creates (host = creator,
  // so it holds the top power level and resolves to the `host` seat).
  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Convergence Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Convergence Member' })
  await ensureUser(endpoint, logger, outsiderId, { password: DEMO_PASSWORD, displayName: 'Convergence Outsider' })
  const roomId = await createRoom(endpoint, logger, 'Movie Convergence Room', hostId, [memberId, botUserId])
  check('host created a fresh canvas room', roomId !== null, roomId ?? 'none')
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

  process.stdout.write('\n— role resolution —\n')
  const hostRole = await callLegC(gatewayUrl, 'auth/role', hostCreds.accessToken, { roomId })
  check('auth/role resolves the creator to host', hostRole.ok && (hostRole.result as { role?: string }).role === 'host', (hostRole.result as { role?: string }).role ?? `status ${hostRole.status}`)
  const memberRole = await callLegC(gatewayUrl, 'auth/role', memberCreds.accessToken, { roomId })
  check('auth/role resolves a joined member to member', memberRole.ok && (memberRole.result as { role?: string }).role === 'member', (memberRole.result as { role?: string }).role ?? `status ${memberRole.status}`)
  const outsiderRole = await callLegC(gatewayUrl, 'auth/role', outsiderCreds.accessToken, { roomId })
  check('auth/role resolves a non-member to none', outsiderRole.ok && (outsiderRole.result as { role?: string }).role === 'none', (outsiderRole.result as { role?: string }).role ?? `status ${outsiderRole.status}`)

  process.stdout.write('\n— host-exclusive writes —\n')
  const memberPut = await callLegC(gatewayUrl, 'workflow/put', memberCreds.accessToken, { roomId, graph: makeGraph('member-write') })
  check('member workflow/put is forbidden (host-only)', memberPut.status === 403 && memberPut.errorCode === 'forbidden', memberPut.errorCode ?? `status ${memberPut.status}`)
  const memberDraft = await callLegC(gatewayUrl, 'workspace/draft.put', memberCreds.accessToken, { roomId, graph: makeGraph('member-draft') })
  check('member workspace/draft.put is forbidden (host-only)', memberDraft.status === 403 && memberDraft.errorCode === 'forbidden', memberDraft.errorCode ?? `status ${memberDraft.status}`)
  const memberCommit = await callLegC(gatewayUrl, 'workspace/commit', memberCreds.accessToken, { roomId, message: 'member commit' })
  check('member workspace/commit is forbidden (host-only)', memberCommit.status === 403 && memberCommit.errorCode === 'forbidden', memberCommit.errorCode ?? `status ${memberCommit.status}`)
  const outsiderGet = await callLegC(gatewayUrl, 'workflow/get', outsiderCreds.accessToken, { roomId })
  check('workflow/get is forbidden for a non-member', outsiderGet.status === 403 && outsiderGet.errorCode === 'forbidden', outsiderGet.errorCode ?? `status ${outsiderGet.status}`)
  const outsiderPut = await callLegC(gatewayUrl, 'workflow/put', outsiderCreds.accessToken, { roomId, graph: makeGraph('intruder') })
  check('workflow/put is forbidden for a non-member', outsiderPut.status === 403 && outsiderPut.errorCode === 'forbidden', outsiderPut.errorCode ?? `status ${outsiderPut.status}`)

  process.stdout.write('\n— host draft + commit —\n')
  const hostDraft = await callLegC(gatewayUrl, 'workspace/draft.put', hostCreds.accessToken, { roomId, graph: makeGraph('host-draft-A') })
  const hostDraftState = hostDraft.result as { hasDraft?: boolean } | undefined
  check('host workspace/draft.put autosaves a draft', hostDraft.status === 200 && hostDraft.ok && hostDraftState?.hasDraft === true, hostDraftState?.hasDraft === true ? 'draft saved' : `status ${hostDraft.status}`)
  const hostCommit = await callLegC(gatewayUrl, 'workspace/commit', hostCreds.accessToken, { roomId, message: 'r1' })
  const r1 = recordOf(hostCommit)
  check('host workspace/commit appends rev 1', hostCommit.status === 200 && hostCommit.ok && r1?.rev === 1, `rev ${r1?.rev ?? 'none'}`)

  process.stdout.write('\n— live workflow/watch convergence —\n')
  const memberWatch = openWatch(wsBase, roomId, memberCreds.accessToken)
  const snapshot = await memberWatch.waitFor((frame): boolean => frame.stage === 'snapshot', 10_000)
  check('a second watch connection receives a snapshot frame', snapshot !== null && snapshot.stage === 'snapshot')
  if (snapshot !== null && snapshot.stage === 'snapshot') {
    check('the snapshot carries the committed HEAD (rev 1)', snapshot.workflow?.rev === 1, `rev ${snapshot.workflow?.rev ?? 'none'}`)
    check('the snapshot resolves the watcher role to member', snapshot.role === 'member', snapshot.role)
    check('the snapshot names the current host', snapshot.host === hostId, snapshot.host ?? 'none')
  }
  // The host commits again; the member watcher must converge on the new HEAD.
  await callLegC(gatewayUrl, 'workspace/draft.put', hostCreds.accessToken, { roomId, graph: makeGraph('host-draft-B') })
  const hostCommit2 = await callLegC(gatewayUrl, 'workspace/commit', hostCreds.accessToken, { roomId, message: 'r2' })
  const r2 = recordOf(hostCommit2)
  check('host commits rev 2', hostCommit2.ok && r2?.rev === 2, `rev ${r2?.rev ?? 'none'}`)
  const committed = await memberWatch.waitFor((frame): boolean => frame.stage === 'committed' && frame.workflow.rev === 2, 10_000)
  check('the watcher receives the committed rev-2 frame', committed !== null && committed.stage === 'committed', committed?.stage ?? 'none')
  if (committed !== null && committed.stage === 'committed') {
    check('the committed frame attributes the write to the host', committed.by === hostId, committed.by ?? 'none')
    check('the committed frame carries the new graph', committed.workflow.graph.nodes[0]?.title === 'host-draft-B', committed.workflow.graph.nodes[0]?.title ?? 'none')
  }

  process.stdout.write('\n— host transfer —\n')
  const transfer = await callLegC(gatewayUrl, 'room/transferHost', hostCreds.accessToken, { roomId, targetUserId: memberId })
  const transferHost = (transfer.result as { host?: string } | undefined)?.host
  check('room/transferHost hands the seat to the member', transfer.status === 200 && transfer.ok && transferHost === memberId, transferHost ?? transfer.errorCode ?? `status ${transfer.status}`)
  const roleFrame = await memberWatch.waitFor((frame): boolean => frame.stage === 'role' && frame.host === memberId, 10_000)
  check('the watcher receives a role frame naming the new host', roleFrame !== null && roleFrame.stage === 'role', roleFrame?.stage ?? 'none')
  if (roleFrame !== null && roleFrame.stage === 'role') {
    check('the role frame promotes the watcher to host', roleFrame.role === 'host', roleFrame.role)
  }
  const oldHostRole = await callLegC(gatewayUrl, 'auth/role', hostCreds.accessToken, { roomId })
  check('auth/role demotes the old host to member', oldHostRole.ok && (oldHostRole.result as { role?: string }).role === 'member', (oldHostRole.result as { role?: string }).role ?? `status ${oldHostRole.status}`)
  const newHostRole = await callLegC(gatewayUrl, 'auth/role', memberCreds.accessToken, { roomId })
  check('auth/role promotes the new host', newHostRole.ok && (newHostRole.result as { role?: string }).role === 'host', (newHostRole.result as { role?: string }).role ?? `status ${newHostRole.status}`)
  const oldHostPut = await callLegC(gatewayUrl, 'workflow/put', hostCreds.accessToken, { roomId, graph: makeGraph('old-host') })
  check('the old host is now forbidden on write', oldHostPut.status === 403 && oldHostPut.errorCode === 'forbidden', oldHostPut.errorCode ?? `status ${oldHostPut.status}`)
  const oldHostCommit = await callLegC(gatewayUrl, 'workspace/commit', hostCreds.accessToken, { roomId, message: 'old host' })
  check('the old host is now forbidden on commit', oldHostCommit.status === 403 && oldHostCommit.errorCode === 'forbidden', oldHostCommit.errorCode ?? `status ${oldHostCommit.status}`)
  await callLegC(gatewayUrl, 'workspace/draft.put', memberCreds.accessToken, { roomId, graph: makeGraph('new-host-C') })
  const newHostCommit = await callLegC(gatewayUrl, 'workspace/commit', memberCreds.accessToken, { roomId, message: 'r3' })
  const r3 = recordOf(newHostCommit)
  check('the new host can commit (rev 3)', newHostCommit.status === 200 && newHostCommit.ok && r3?.rev === 3, `rev ${r3?.rev ?? 'none'}`)
  memberWatch.close()

  process.stdout.write('\n— outsider watch + guards —\n')
  const outsiderWatch = openWatch(wsBase, roomId, outsiderCreds.accessToken)
  const outsiderErr = await outsiderWatch.waitError(10_000)
  check('workflow/watch is forbidden for a non-member', outsiderErr !== null && outsiderErr.code === 'forbidden', outsiderErr?.code ?? 'none')
  outsiderWatch.close()

  const missing = await callLegC(gatewayUrl, 'workspace/commit', null, { roomId, message: 'x' })
  check('a missing token is rejected missing-token (400)', missing.status === 400 && missing.errorCode === 'missing-token', missing.errorCode ?? `status ${missing.status}`)
  const invalid = await callLegC(gatewayUrl, 'workspace/commit', 'bogus-token', { roomId, message: 'x' })
  check('an invalid token is rejected invalid-token (401)', invalid.status === 401 && invalid.errorCode === 'invalid-token', invalid.errorCode ?? `status ${invalid.status}`)
  const noRoom = await callLegC(gatewayUrl, 'workspace/commit', memberCreds.accessToken, { message: 'x' })
  check('a commit without a roomId is rejected bad-request (400)', noRoom.status === 400 && noRoom.errorCode === 'bad-request', noRoom.errorCode ?? `status ${noRoom.status}`)
  const transferByMember = await callLegC(gatewayUrl, 'room/transferHost', outsiderCreds.accessToken, { roomId, targetUserId: outsiderId })
  check('room/transferHost is forbidden for a non-member', transferByMember.status === 403 && transferByMember.errorCode === 'forbidden', transferByMember.errorCode ?? `status ${transferByMember.status}`)

  process.stdout.write(failures === 0 ? '\nALL CANVAS-CONVERGENCE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
