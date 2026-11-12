/**
 * Two-user canvas convergence verifier (Phase-2 M6/M7).
 *
 * Proves the host-authoritative in-memory workflow store gives two collaborators
 * a single converged graph over Leg C `workflow/get` + `workflow/put`, using
 * brokered Matrix tokens exactly like logged-in browsers would:
 *
 *  - a member `workflow/put` seeds the room graph (rev 1); a host `workflow/get`
 *    reads back the same graph and the member as last writer (multi-user
 *    convergence through the shared store);
 *  - a further host `put` with the current `baseRev` bumps the revision (rev 2);
 *  - a stale `baseRev` `put` is refused `conflict` (HTTP 409);
 *  - a non-member is refused `forbidden` on both get and put (fail-closed);
 *  - the token guards (`missing-token`, `invalid-token`) and param validation
 *    (`bad-request`) hold for the new namespace.
 *
 * Each run creates a fresh room, so the volatile store starts empty for it.
 * Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory (movie-profile host up with the gateway on
 * 8788 and identity `/auth` on 8787):
 *   node scripts/verify-two-user-canvas.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs,
  type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'

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

/** A read-back view of the persisted record (only the fields we assert on). */
interface RecordView {
  rev: number
  updatedBy: string | null
  graph: { nodes: Array<{ id: number; title?: string }> }
}

/** Unwrap a successful `workflow/*` response into its record (or null). */
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

/** Dev-only throwaway local accounts; not real secrets. */
const HOST_LOCALPART = 'movie_canvas_host'
const MEMBER_LOCALPART = 'movie_canvas_member'
const OUTSIDER_LOCALPART = 'movie_canvas_outsider'
const DEMO_PASSWORD = 'movie-canvas-pass'

async function main(): Promise<void> {
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot verify.\n')
    process.exit(1)
  }
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }

  const hostId = `@${HOST_LOCALPART}:${serverName}`
  const memberId = `@${MEMBER_LOCALPART}:${serverName}`
  const outsiderId = `@${OUTSIDER_LOCALPART}:${serverName}`

  // Provision three accounts and a fresh room the host creates (host=creator).
  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Canvas Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Canvas Member' })
  await ensureUser(endpoint, logger, outsiderId, { password: DEMO_PASSWORD, displayName: 'Canvas Outsider' })
  const roomId = await createRoom(endpoint, logger, 'Movie Canvas Room', hostId, [memberId, botUserId])
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

  // 1. A fresh room has no persisted graph yet.
  const emptyGet = await callLegC(gatewayUrl, 'workflow/get', hostCreds.accessToken, { roomId })
  check('workflow/get on a fresh room returns null', emptyGet.status === 200 && emptyGet.ok && recordOf(emptyGet) === null)

  // 2. The member seeds the graph (no baseRev -> rev 1).
  const memberPut = await callLegC(gatewayUrl, 'workflow/put', memberCreds.accessToken, { roomId, graph: makeGraph('member-seed') })
  const memberRec = recordOf(memberPut)
  check('member workflow/put seeds rev 1', memberPut.status === 200 && memberPut.ok && memberRec?.rev === 1, `rev ${memberRec?.rev ?? 'none'}`)

  // 3. The host reads back the same graph and the member as last writer.
  const hostGet = await callLegC(gatewayUrl, 'workflow/get', hostCreds.accessToken, { roomId })
  const hostRec = recordOf(hostGet)
  check('host workflow/get converges on the member graph', hostGet.ok && hostRec?.graph.nodes[0]?.title === 'member-seed', hostRec?.graph.nodes[0]?.title ?? 'none')
  check('host read reflects the member as last writer', hostRec?.updatedBy === memberId, hostRec?.updatedBy ?? 'none')

  // 4. The host writes with the current baseRev -> rev 2.
  const hostPut = await callLegC(gatewayUrl, 'workflow/put', hostCreds.accessToken, { roomId, graph: makeGraph('host-edit'), baseRev: 1 })
  const hostPutRec = recordOf(hostPut)
  check('host workflow/put with baseRev 1 bumps to rev 2', hostPut.status === 200 && hostPut.ok && hostPutRec?.rev === 2, `rev ${hostPutRec?.rev ?? 'none'}`)

  // 5. A stale baseRev write is refused with a 409 conflict.
  const stalePut = await callLegC(gatewayUrl, 'workflow/put', memberCreds.accessToken, { roomId, graph: makeGraph('stale'), baseRev: 1 })
  check('a stale baseRev put is refused conflict (409)', stalePut.status === 409 && !stalePut.ok && stalePut.errorCode === 'conflict', stalePut.errorCode ?? `status ${stalePut.status}`)

  // 6. The winning write persisted; the loser did not clobber it.
  const afterConflict = recordOf(await callLegC(gatewayUrl, 'workflow/get', memberCreds.accessToken, { roomId }))
  check('the graph still holds the winning rev-2 edit', afterConflict?.rev === 2 && afterConflict?.graph.nodes[0]?.title === 'host-edit', afterConflict?.graph.nodes[0]?.title ?? 'none')

  // 7. A non-member is refused on both get and put (fail-closed).
  const outsiderGet = await callLegC(gatewayUrl, 'workflow/get', outsiderCreds.accessToken, { roomId })
  check('workflow/get is forbidden for a non-member', outsiderGet.status === 403 && !outsiderGet.ok && outsiderGet.errorCode === 'forbidden', outsiderGet.errorCode ?? `status ${outsiderGet.status}`)
  const outsiderPut = await callLegC(gatewayUrl, 'workflow/put', outsiderCreds.accessToken, { roomId, graph: makeGraph('intruder') })
  check('workflow/put is forbidden for a non-member', outsiderPut.status === 403 && !outsiderPut.ok && outsiderPut.errorCode === 'forbidden', outsiderPut.errorCode ?? `status ${outsiderPut.status}`)

  // 8. Token guards on the new namespace.
  const missing = await callLegC(gatewayUrl, 'workflow/put', null, { roomId, graph: makeGraph('x') })
  check('a missing token is rejected missing-token', missing.status === 400 && missing.errorCode === 'missing-token', missing.errorCode ?? `status ${missing.status}`)
  const invalid = await callLegC(gatewayUrl, 'workflow/get', 'bogus-token', { roomId })
  check('an invalid token is rejected invalid-token', invalid.status === 401 && invalid.errorCode === 'invalid-token', invalid.errorCode ?? `status ${invalid.status}`)

  // 9. Param validation.
  const noGraph = await callLegC(gatewayUrl, 'workflow/put', memberCreds.accessToken, { roomId })
  check('a put without a graph is rejected bad-request', noGraph.status === 400 && noGraph.errorCode === 'bad-request', noGraph.errorCode ?? `status ${noGraph.status}`)
  const noRoom = await callLegC(gatewayUrl, 'workflow/get', memberCreds.accessToken, {})
  check('a get without a roomId is rejected bad-request', noRoom.status === 400 && noRoom.errorCode === 'bad-request', noRoom.errorCode ?? `status ${noRoom.status}`)

  process.stdout.write(failures === 0 ? '\nALL TWO-USER CANVAS CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
