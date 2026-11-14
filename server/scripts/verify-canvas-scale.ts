/**
 * 200-node canvas scale verifier (Phase-3 P3-M5).
 *
 * Two layers:
 *
 *  1. OFFLINE / deterministic (no network): a 200-node prompt graph is built
 *     and pushed through the `movie-executor` registry + validator + topological
 *     sort — every class type is known, the graph validates, and the chain sorts
 *     to all 200 ids in order.
 *
 *  2. LIVE gateway (movie-profile host up: gateway 8788, identity 8787,
 *     Synapse 8008) using brokered Matrix tokens like logged-in browsers:
 *     - the host autosaves + commits a 200-node editor graph; `workflow/get` and
 *       `history.get` both round-trip all 200 nodes;
 *     - the commit -> read-back round-trip stays under a latency budget;
 *     - a `workflow/watch` subscriber receives the 200-node commit frame.
 *
 * Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-canvas-scale.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs,
  type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'
import { MOVIE_NODES, isWorkflowWatchFrame, type PromptGraph, type WorkflowWatchFrame } from '../../protocol/src/index.ts'
import { isKnownClassType } from '../plugins/dsh-movie-gateway/src/movie-executor/registry.ts'
import { validatePromptGraph } from '../plugins/dsh-movie-gateway/src/movie-executor/validate.ts'
import { topoSort } from '../plugins/dsh-movie-gateway/src/movie-executor/topo.ts'

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

/** The node count for the stress graph. */
const SCALE = 200
/** Round-trip latency budget (ms) for commit -> read-back of the 200-node graph. */
const LATENCY_BUDGET_MS = 10_000

/** The six movie class types in pipeline (step) order. */
const ORDERED_CLASS_TYPES: string[] = [...MOVIE_NODES]
  .sort((a, b): number => (a.step ?? 0) - (b.step ?? 0))
  .map((node): string => node.classType)

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

/**
 * Build a 200-node flattened prompt graph as a chain "1"->"2"->...->"200",
 * class types cycling through the six movie nodes (slot 0 is always a valid
 * output for every movie class type).
 */
function buildScalePrompt(): PromptGraph {
  const graph: PromptGraph = {}
  for (let index = 1; index <= SCALE; index++) {
    const classType = ORDERED_CLASS_TYPES[(index - 1) % ORDERED_CLASS_TYPES.length] as string
    graph[String(index)] = index === 1
      ? { class_type: classType, inputs: {} }
      : { class_type: classType, inputs: { upstream: [String(index - 1), 0] } }
  }
  return graph
}

/**
 * Build a 200-node editor graph (the opaque `WorkflowGraph` the canvas/store
 * persist verbatim): nodes 1..200 in a grid, chained link-by-link.
 */
function buildScaleEditorGraph(marker: string): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = []
  const links: Array<unknown[]> = []
  for (let id = 1; id <= SCALE; id++) {
    const classType = ORDERED_CLASS_TYPES[(id - 1) % ORDERED_CLASS_TYPES.length] as string
    nodes.push({
      id,
      type: classType,
      pos: [80 + ((id - 1) % 10) * 260, 160 + Math.floor((id - 1) / 10) * 180],
      size: [240, 140],
      flags: 0,
      order: id - 1,
      mode: 0,
      title: id === 1 ? marker : undefined,
    })
    if (id > 1) links.push([id - 1, id - 1, 0, id, 0, 'SCRIPT'])
  }
  return { last_node_id: SCALE, last_link_id: links.length, nodes, links, version: 0.4 }
}

/** Count the nodes in a workflow/get or history.get graph payload. */
function nodeCount(graph: unknown): number {
  const nodes = (graph as { nodes?: unknown[] } | null)?.nodes
  return Array.isArray(nodes) ? nodes.length : 0
}

/** Run the offline 200-node registry / validate / topo checks. */
function offlineChecks(): void {
  process.stdout.write('\n— offline: 200-node prompt through the executor registry/validate/topo —\n')
  const prompt = buildScalePrompt()
  check('the scale prompt has 200 nodes', Object.keys(prompt).length === SCALE, `${Object.keys(prompt).length}`)
  check('every scale class type is known to the registry', ORDERED_CLASS_TYPES.every((classType): boolean => isKnownClassType(classType)))
  const validated = validatePromptGraph(prompt)
  check('validatePromptGraph accepts the 200-node chain', validated.ok, validated.ok ? 'ok' : JSON.stringify(validated.nodeErrors).slice(0, 200))
  const sorted = topoSort(prompt)
  check('topoSort orders all 200 nodes', sorted.ok && sorted.order.length === SCALE, sorted.ok ? `${sorted.order.length}` : `cycle: ${sorted.cycle.slice(0, 8).join(', ')}`)
  check('topoSort yields the chain in order 1..200', sorted.ok && sorted.order[0] === '1' && sorted.order[SCALE - 1] === String(SCALE), sorted.ok ? `${sorted.order[0]}..${sorted.order[SCALE - 1]}` : 'unsorted')
}

/** A polling `workflow/watch` mux stream that collects every data frame. */
interface ScaleWatchStream {
  frames: WorkflowWatchFrame[]
  waitFor: (pred: (frame: WorkflowWatchFrame) => boolean, timeoutMs: number) => Promise<WorkflowWatchFrame | null>
  close: () => void
}

/** Open a `workflow/watch` mux stream and collect its data frames for polling. */
function openWatch(wsBase: string, roomId: string, token: string): ScaleWatchStream {
  const socket = new WebSocket(`${wsBase}/api/ws`)
  const frames: WorkflowWatchFrame[] = []
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
    if (frame.stream === 'w1' && frame.type === 'data' && isWorkflowWatchFrame(frame.payload)) frames.push(frame.payload)
  })
  socket.addEventListener('error', () => { /* the polling timeouts guard a hard failure */ })
  return {
    frames,
    async waitFor(pred, timeoutMs): Promise<WorkflowWatchFrame | null> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = frames.find(pred)
        if (found !== undefined) return found
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
const HOST_LOCALPART = 'movie_scale_host'
const MEMBER_LOCALPART = 'movie_scale_member'
const DEMO_PASSWORD = 'movie-scale-pass'

async function liveChecks(): Promise<void> {
  process.stdout.write('\n— live: 200-node commit / read-back / watch over the gateway —\n')
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
  const wsBase = gatewayUrl.replace(/^http/, 'ws')
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; skipping live scale checks.\n')
    return
  }
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }
  const hostId = `@${HOST_LOCALPART}:${serverName}`
  const memberId = `@${MEMBER_LOCALPART}:${serverName}`

  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Scale Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Scale Member' })
  const roomId = await createRoom(endpoint, logger, 'Movie Scale Room', hostId, [memberId, botUserId])
  check('host created a fresh room', roomId !== null, roomId ?? 'none')
  if (roomId === null) return
  await joinRoomAs(endpoint, logger, memberId, roomId)
  await joinRoomAs(endpoint, logger, botUserId, roomId)

  const hostCreds = await brokerToken(endpoint, logger, hostId)
  const memberCreds = await brokerToken(endpoint, logger, memberId)
  check('brokered tokens for host + member', hostCreds !== null && memberCreds !== null)
  if (hostCreds === null || memberCreds === null) return

  const health = await fetch(`${gatewayUrl}/health`)
  check('gateway /health answers ok', health.ok && ((await health.json()) as { ok?: boolean }).ok === true)

  // A subscriber attaches before the commit. Waiting for its snapshot frame
  // proves the gateway registered the subscription, so the subsequent commit
  // broadcast cannot be missed.
  const watcher = openWatch(wsBase, roomId, memberCreds.accessToken)
  const snapshot = await watcher.waitFor((frame): boolean => frame.stage === 'snapshot', 15_000)
  check('a workflow/watch subscriber attaches and receives a snapshot', snapshot !== null && snapshot.stage === 'snapshot', snapshot?.stage ?? 'none')

  const bigGraph = buildScaleEditorGraph('scale-200')
  const started = Date.now()
  const draftPut = await callLegC(gatewayUrl, 'workspace/draft.put', hostCreds.accessToken, { roomId, graph: bigGraph })
  check('host autosaves the 200-node draft', draftPut.status === 200 && draftPut.ok, `status ${draftPut.status}`)
  const commit = await callLegC(gatewayUrl, 'workspace/commit', hostCreds.accessToken, { roomId, message: '200 nodes' })
  const commitRec = commit.result as { workflow?: { rev?: number } } | undefined
  check('host commits the 200-node graph (rev 1)', commit.ok && commitRec?.workflow?.rev === 1, `rev ${commitRec?.workflow?.rev ?? 'none'}`)
  const get = await callLegC(gatewayUrl, 'workflow/get', hostCreds.accessToken, { roomId })
  const getGraph = (get.result as { workflow?: { graph?: unknown } } | undefined)?.workflow?.graph
  check('workflow/get round-trips all 200 nodes', get.ok && nodeCount(getGraph) === SCALE, `${nodeCount(getGraph)} nodes`)
  const elapsed = Date.now() - started
  check(`commit -> read-back stays under the ${LATENCY_BUDGET_MS}ms budget`, elapsed < LATENCY_BUDGET_MS, `${elapsed}ms`)

  const history = await callLegC(gatewayUrl, 'workspace/history.get', hostCreds.accessToken, { roomId, rev: 1 })
  const historyGraph = (history.result as { graph?: unknown } | undefined)?.graph
  check('history.get(1) round-trips all 200 nodes', history.ok && nodeCount(historyGraph) === SCALE, `${nodeCount(historyGraph)} nodes`)

  const committedFrame = await watcher.waitFor((frame): boolean => frame.stage === 'committed' && frame.workflow.rev === 1, 15_000)
  check('a workflow/watch subscriber receives the 200-node commit', committedFrame !== null && committedFrame.stage === 'committed', committedFrame?.stage ?? 'none')
  if (committedFrame !== null && committedFrame.stage === 'committed') {
    check('the watched commit frame carries all 200 nodes', nodeCount(committedFrame.workflow.graph) === SCALE, `${nodeCount(committedFrame.workflow.graph)} nodes`)
  }
  watcher.close()
}

async function main(): Promise<void> {
  offlineChecks()
  await liveChecks()
  process.stdout.write(failures === 0 ? '\nALL CANVAS-SCALE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
