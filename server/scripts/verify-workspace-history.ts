/**
 * Workspace draft + version-history verifier (Phase-3 P3-M5).
 *
 * Proves the file-backed per-room workspace semantics over Leg C, using brokered
 * Matrix tokens like a logged-in host browser would:
 *
 *  - the HOST autosaves a draft (`workspace/draft.put`) with a server-side undo
 *    stack; `workspace/undo` / `workspace/redo` round-trip the working graph and
 *    move the undo/redo depths correctly;
 *  - `workspace/commit` appends an immutable FULL snapshot: `history.get(rev)`
 *    returns the exact graph and `history.list` metadata (rev / author /
 *    message) is correct;
 *  - `workspace/revert(rev)` is a FORWARD commit whose graph equals the old
 *    snapshot and which clears the working draft (history is never rewritten);
 *  - a MEMBER may read history (`history.list` / `history.get`) but is refused
 *    `forbidden` on every mutating call (draft.put / undo / commit).
 *
 * Each run creates a fresh room, so the workspace starts empty for it. Tokens
 * and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory (movie-profile host up with the gateway on
 * 8788 and identity `/auth` on 8787):
 *   node scripts/verify-workspace-history.ts
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

/** A graph view: only the marker title on node 1 matters for our assertions. */
interface GraphView { nodes: Array<{ id: number; title?: string }> }

/** The `DraftState` envelope returned by draft.put / undo / redo. */
interface DraftView {
  graph: GraphView
  hasDraft: boolean
  undoDepth: number
  redoDepth: number
}

/** One committed revision's metadata (the fields we assert on). */
interface CommitView { rev: number; author: string | null; message: string; file: string }

function draftOf(res: LegCCall): DraftView | null {
  if (!res.ok) return null
  return res.result as DraftView
}

function recordOf(res: LegCCall): { rev: number; graph: GraphView } | null {
  if (!res.ok) return null
  const envelope = res.result as { workflow?: { rev: number; graph: GraphView } | null }
  return envelope.workflow ?? null
}

/** The marker title on node 1 of a graph view (or `null`). */
function markerOf(graph: GraphView | null | undefined): string | null {
  return graph?.nodes.find((node): boolean => node.id === 1)?.title ?? null
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
const HOST_LOCALPART = 'movie_hist_host'
const MEMBER_LOCALPART = 'movie_hist_member'
const DEMO_PASSWORD = 'movie-hist-pass'

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

  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'History Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'History Member' })
  const roomId = await createRoom(endpoint, logger, 'Movie History Room', hostId, [memberId, botUserId])
  check('host created a fresh room', roomId !== null, roomId ?? 'none')
  if (roomId === null) process.exit(1)
  await joinRoomAs(endpoint, logger, memberId, roomId)
  await joinRoomAs(endpoint, logger, botUserId, roomId)

  const hostCreds = await brokerToken(endpoint, logger, hostId)
  const memberCreds = await brokerToken(endpoint, logger, memberId)
  check('brokered tokens for host + member', hostCreds !== null && memberCreds !== null)
  if (hostCreds === null || memberCreds === null) process.exit(1)

  const health = await fetch(`${gatewayUrl}/health`)
  check('gateway /health answers ok', health.ok && ((await health.json()) as { ok?: boolean }).ok === true)

  process.stdout.write('\n— host draft autosave + undo/redo —\n')
  const putA = draftOf(await callLegC(gatewayUrl, 'workspace/draft.put', hostCreds.accessToken, { roomId, graph: makeGraph('A') }))
  check('draft.put(A) stores graph A as a draft', putA !== null && putA.hasDraft && markerOf(putA.graph) === 'A', markerOf(putA?.graph) ?? 'none')
  check('draft.put(A) pushes one undo step', putA?.undoDepth === 1 && putA?.redoDepth === 0, `undo ${putA?.undoDepth ?? 'x'} redo ${putA?.redoDepth ?? 'x'}`)
  const putB = draftOf(await callLegC(gatewayUrl, 'workspace/draft.put', hostCreds.accessToken, { roomId, graph: makeGraph('B') }))
  check('draft.put(B) stores graph B', putB !== null && putB.hasDraft && markerOf(putB.graph) === 'B', markerOf(putB?.graph) ?? 'none')
  check('draft.put(B) stacks a second undo step', putB?.undoDepth === 2 && putB?.redoDepth === 0, `undo ${putB?.undoDepth ?? 'x'} redo ${putB?.redoDepth ?? 'x'}`)
  const undone = draftOf(await callLegC(gatewayUrl, 'workspace/undo', hostCreds.accessToken, { roomId }))
  check('undo restores graph A', undone !== null && markerOf(undone.graph) === 'A', markerOf(undone?.graph) ?? 'none')
  check('undo moves one step to redo', undone?.undoDepth === 1 && undone?.redoDepth === 1, `undo ${undone?.undoDepth ?? 'x'} redo ${undone?.redoDepth ?? 'x'}`)
  const redone = draftOf(await callLegC(gatewayUrl, 'workspace/redo', hostCreds.accessToken, { roomId }))
  check('redo restores graph B', redone !== null && markerOf(redone.graph) === 'B', markerOf(redone?.graph) ?? 'none')
  check('redo drains the redo stack back onto undo', redone?.undoDepth === 2 && redone?.redoDepth === 0, `undo ${redone?.undoDepth ?? 'x'} redo ${redone?.redoDepth ?? 'x'}`)

  process.stdout.write('\n— commit appends a full snapshot —\n')
  const c1 = recordOf(await callLegC(gatewayUrl, 'workspace/commit', hostCreds.accessToken, { roomId, message: 'first' }))
  check('commit appends rev 1 with graph B', c1 !== null && c1.rev === 1 && markerOf(c1.graph) === 'B', `rev ${c1?.rev ?? 'none'} ${markerOf(c1?.graph) ?? ''}`)
  const afterCommit = draftOf(await callLegC(gatewayUrl, 'workspace/draft.get', hostCreds.accessToken, { roomId }))
  check('commit clears the working draft', afterCommit !== null && afterCommit.hasDraft === false, afterCommit?.hasDraft === false ? 'no draft' : `hasDraft ${afterCommit?.hasDraft ?? 'x'}`)
  const get1 = await callLegC(gatewayUrl, 'workspace/history.get', hostCreds.accessToken, { roomId, rev: 1 })
  const get1Body = get1.result as { commit?: CommitView; graph?: GraphView } | undefined
  check('history.get(1) returns the exact committed graph', get1.ok && markerOf(get1Body?.graph) === 'B', markerOf(get1Body?.graph) ?? `status ${get1.status}`)
  check('history.get(1) metadata is correct', get1Body?.commit?.rev === 1 && get1Body?.commit?.message === 'first' && get1Body?.commit?.author === hostId, JSON.stringify(get1Body?.commit ?? null))

  // A second commit advances HEAD to rev 2.
  await callLegC(gatewayUrl, 'workspace/draft.put', hostCreds.accessToken, { roomId, graph: makeGraph('C') })
  const c2 = recordOf(await callLegC(gatewayUrl, 'workspace/commit', hostCreds.accessToken, { roomId, message: 'second' }))
  check('a second commit appends rev 2 with graph C', c2 !== null && c2.rev === 2 && markerOf(c2.graph) === 'C', `rev ${c2?.rev ?? 'none'} ${markerOf(c2?.graph) ?? ''}`)

  process.stdout.write('\n— revert is a forward commit —\n')
  const rev3 = recordOf(await callLegC(gatewayUrl, 'workspace/revert', hostCreds.accessToken, { roomId, rev: 1, message: 'back to r1' }))
  check('revert(1) creates a forward commit rev 3', rev3 !== null && rev3.rev === 3, `rev ${rev3?.rev ?? 'none'}`)
  check('revert(1) restores the old snapshot graph (B)', markerOf(rev3?.graph) === 'B', markerOf(rev3?.graph) ?? 'none')
  const afterRevert = draftOf(await callLegC(gatewayUrl, 'workspace/draft.get', hostCreds.accessToken, { roomId }))
  check('revert clears the working draft', afterRevert !== null && afterRevert.hasDraft === false, afterRevert?.hasDraft === false ? 'no draft' : `hasDraft ${afterRevert?.hasDraft ?? 'x'}`)
  const get3 = await callLegC(gatewayUrl, 'workspace/history.get', hostCreds.accessToken, { roomId, rev: 3 })
  const get3Body = get3.result as { graph?: GraphView } | undefined
  check('history.get(3) equals history.get(1) (no rewrite)', get3.ok && markerOf(get3Body?.graph) === 'B' && markerOf(get3Body?.graph) === markerOf(get1Body?.graph), markerOf(get3Body?.graph) ?? `status ${get3.status}`)

  process.stdout.write('\n— history index + member access —\n')
  const listRes = await callLegC(gatewayUrl, 'workspace/history.list', hostCreds.accessToken, { roomId })
  const commits = (listRes.result as { commits?: CommitView[] } | undefined)?.commits ?? []
  check('history.list holds all three commits in order', listRes.ok && commits.length === 3 && commits.map((c): number => c.rev).join(',') === '1,2,3', commits.map((c): number => c.rev).join(',') || `status ${listRes.status}`)
  check('history.list metadata messages are correct', commits.map((c): string => c.message).join('|') === 'first|second|back to r1', commits.map((c): string => c.message).join('|'))
  const memberList = await callLegC(gatewayUrl, 'workspace/history.list', memberCreds.accessToken, { roomId })
  check('a member may read the history index', memberList.status === 200 && memberList.ok, `status ${memberList.status}`)
  const memberGet = await callLegC(gatewayUrl, 'workspace/history.get', memberCreds.accessToken, { roomId, rev: 2 })
  const memberGetBody = memberGet.result as { graph?: GraphView } | undefined
  check('a member may read a committed snapshot', memberGet.ok && markerOf(memberGetBody?.graph) === 'C', markerOf(memberGetBody?.graph) ?? `status ${memberGet.status}`)
  const memberDraftPut = await callLegC(gatewayUrl, 'workspace/draft.put', memberCreds.accessToken, { roomId, graph: makeGraph('member') })
  check('a member is forbidden on draft.put', memberDraftPut.status === 403 && memberDraftPut.errorCode === 'forbidden', memberDraftPut.errorCode ?? `status ${memberDraftPut.status}`)
  const memberUndo = await callLegC(gatewayUrl, 'workspace/undo', memberCreds.accessToken, { roomId })
  check('a member is forbidden on undo', memberUndo.status === 403 && memberUndo.errorCode === 'forbidden', memberUndo.errorCode ?? `status ${memberUndo.status}`)
  const memberCommit = await callLegC(gatewayUrl, 'workspace/commit', memberCreds.accessToken, { roomId, message: 'nope' })
  check('a member is forbidden on commit', memberCommit.status === 403 && memberCommit.errorCode === 'forbidden', memberCommit.errorCode ?? `status ${memberCommit.status}`)
  const memberRevert = await callLegC(gatewayUrl, 'workspace/revert', memberCreds.accessToken, { roomId, rev: 1 })
  check('a member is forbidden on revert', memberRevert.status === 403 && memberRevert.errorCode === 'forbidden', memberRevert.errorCode ?? `status ${memberRevert.status}`)

  process.stdout.write('\n— guards —\n')
  const missingRev = await callLegC(gatewayUrl, 'workspace/history.get', hostCreds.accessToken, { roomId })
  check('history.get without a rev is bad-request (400)', missingRev.status === 400 && missingRev.errorCode === 'bad-request', missingRev.errorCode ?? `status ${missingRev.status}`)
  const unknownRev = await callLegC(gatewayUrl, 'workspace/history.get', hostCreds.accessToken, { roomId, rev: 999 })
  check('history.get on an unknown rev is not-found (404)', unknownRev.status === 404 && unknownRev.errorCode === 'not-found', unknownRev.errorCode ?? `status ${unknownRev.status}`)
  const badRevert = await callLegC(gatewayUrl, 'workspace/revert', hostCreds.accessToken, { roomId, rev: 999 })
  check('revert to an unknown rev is not-found (404)', badRevert.status === 404 && badRevert.errorCode === 'not-found', badRevert.errorCode ?? `status ${badRevert.status}`)

  process.stdout.write(failures === 0 ? '\nALL WORKSPACE-HISTORY CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
