/**
 * The Leg B/C gateway server: one loopback `node:http` server plus two
 * `noServer` WebSocket endpoints, generalizing the Phase-1 `/auth` listener.
 *
 * Surfaces:
 * - Leg C (JSON-RPC over HTTP): `POST /api/<ns>/<method>` dispatched through
 *   `@dsh-movie/protocol`'s {@link methodFromApiPath}. Every call presents the
 *   caller's Matrix access token (`Authorization: Bearer`, or a `token` body
 *   field) which the host maps to a {@link Principal} via `ctx.matrixIdentity`.
 *   `assets/list` is gated on the `host` room seat to prove the role policy.
 * - Leg C (stream mux over WS): `/api/ws` carries {@link StreamFrame}s keyed by
 *   a logical `stream` id; `open` on channel `leg-b/exec` replays the canned
 *   lifecycle as data frames, anything else errors `unimplemented` (M1 stub).
 * - Leg B (ComfyUI subset over HTTP): `GET /object_info`, `/system_stats`,
 *   `/queue`, `/history`, and `POST /prompt` which assigns an execution id and
 *   drives the lifecycle socket. No Python/model code runs on the host.
 * - Leg B (execution lifecycle over WS): `/ws` sends `status` on connect and
 *   broadcasts the {@link cannedLifecycle} for each submitted prompt.
 *
 * This is a local development prototype: it binds loopback only and answers CORS
 * with `*`. Production front-names it behind Caddy and tightens the origin; the
 * endpoint contract stays the same.
 *
 * @module dsh-movie-gateway/gateway-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  ApiError,
  ApiErrorCode,
  ApiOk,
  ApiResult,
  ExecMessage,
  LegCMethod,
  LegCResponse,
  MoviePipelineStatus,
  OpResult,
  Principal,
  PromptGraph,
  StreamControl,
  StreamFrame,
  StreamOpen,
  WorkflowGraph,
  WorkflowWatchFrame,
  MatrixUserId,
  RoomRole,
} from '@dsh-movie/protocol'
import { IMPLEMENTED_METHODS, methodFromApiPath, initialPipelineStatus } from '@dsh-movie/protocol'
import type { MatrixIdentity, MatrixPrincipal } from 'dsh-matrix-identity/types'
import {
  CANNED_ASSETS,
  CANNED_REGISTRY,
  CANNED_SYSTEM_STATS,
  cannedLifecycle,
  nodeIdsOf,
} from './fixtures.ts'
import { createWorkspaceStore } from './workspace-store.ts'
import { objectInfoFromMovieNodes } from './movie-executor/registry.ts'
// Activation: registers the built-in functional-node handlers (Phase-5 D1/D4).
import './movie-executor/adapters/index.ts'
import { validatePromptGraph } from './movie-executor/validate.ts'
import { topoSort } from './movie-executor/topo.ts'
import { startPromptJob, type StepTextGenerator } from './movie-executor/runner.ts'
import { cannedMediaProvider, type MediaProvider } from './movie-executor/media-provider.ts'
import { createRoomNotifier, type RoomPoster } from './movie-executor/room-notifier.ts'
import { availabilityFromInventory, type ModelAvailability } from './movie-executor/model-catalog.ts'
import type { ReviewFn } from './movie-executor/llm-text.ts'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { MovieGatewayInfo } from './types.ts'
import type { CanvasScriptAgent, CanvasGenerateResult } from './canvas-agent.ts'
import type { MovieDirector, MovieRunListener } from './movie-team/director.ts'

/** Diagnostics sink the gateway writes to (matches `ctx.logger`). */
export interface GatewayLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** What the gateway needs: where to bind and how to introspect tokens. */
export interface GatewayServerDeps {
  /** Loopback TCP port to bind. */
  port: number
  /** The identity service used to introspect tokens and resolve room roles. */
  identity: MatrixIdentity
  /** Diagnostics sink. */
  logger: GatewayLogger
  /**
   * Directory holding the pinned ComfyUI frontend build, served same-origin at
   * `/comfy/` (Phase-2 M5). When unset, `/comfy/` answers 503 so the Studio
   * canvas can show a clear "frontend not fetched" state instead of a blank 404.
   */
  staticDir?: string | undefined
  /**
   * Absolute path to the bridge extension JS we own, served at
   * `/comfy/extensions/dsh-movie-bridge.js` and listed by `/comfy/api/extensions`.
   */
  bridgeExtensionFile?: string | undefined
  /**
   * Optional real-LLM canvas op-script generator (Phase-3 P3-M3). When present,
   * `canvas/script` is accepted and streamed back over the mux; when absent it
   * answers `unimplemented` so the gateway boots without the agent runtime.
   */
  canvasAgent?: CanvasScriptAgent | undefined
  /**
   * Optional background-job registry (`ctx.jobs`, Phase-3 P3-M4). When present,
   * `POST /prompt` is validated, topo-sorted, and scheduled as a `movie-exec`
   * job that drives the lifecycle in dependency order; when absent the gateway
   * falls back to the canned lifecycle so `verify-comfy-bridge` stays green.
   */
  jobs?: JobRegistry | undefined
  /**
   * Optional media-artifact seam for the executor's non-text steps. Defaults to
   * {@link cannedMediaProvider}; in production the gateway injects a routing
   * provider that sends the functional `VideoGenerator` to Bailian "Happyhorse"
   * when configured and everything else to the canned fallback (D15).
   */
  mediaProvider?: MediaProvider | undefined
  /**
   * Optional real-text generator for the executor's text steps
   * (`MovieScript`/`MovieShotPlan`), wired to the Task-4 director. When absent,
   * text steps fall back to the canned provider.
   */
  stepText?: StepTextGenerator | undefined
  /**
   * Optional real reviewer seam (D5) for functional `*Reviewer` nodes, wired to
   * the Bailian LLM. When absent, reviewers fall back to a canned PASS verdict.
   */
  review?: ReviewFn | undefined
  /**
   * Optional D15 model-availability gate. When absent the gateway derives a
   * conservative gate (text only when {@link GatewayServerDeps.stepText} is
   * wired; image/video/audio unavailable) so an unbacked modality never silently
   * succeeds.
   */
  availability?: ModelAvailability | undefined
  /**
   * Optional room-posting seam (`ctx.matrixChat`) for the `customer_service`
   * notices (D15) and artifact echo (D8). When absent — or when a run carries no
   * `room_id` — every room post degrades to a log line.
   */
  matrixChat?: RoomPoster | undefined
  /**
   * Optional six-step movie pipeline director (Phase-3 P3-M4). When present,
   * `movie/run` is accepted and streamed over the mux; when absent it answers
   * `unimplemented` so the gateway boots without the agent runtime.
   */
  director?: MovieDirector | undefined
  /**
   * Absolute directory holding the file-backed per-room workspaces (P3-M5):
   * each room gets a sub-directory of committed history + host draft. When
   * unset (verifiers/tests) the store falls back to a throwaway temp dir.
   */
  workspaceRoot?: string | undefined
}

/** One live movie pipeline run (P3-M4): its evolving status and mux subscribers. */
interface MovieRunRecord {
  /** The room whose pipeline is running. */
  roomId: string
  /** The originating intent. */
  intent: string
  /** The authoritative pipeline status, updated as stages arrive. */
  pipeline: MoviePipelineStatus
  /** Live mux subscribers fanning out each incremental stage. */
  subscribers: Set<MovieRunListener>
  /** True once the director emitted its terminal `done` stage. */
  settled: boolean
}

/** One live `workflow/watch` subscriber (P3-M5): its viewer + frame sink. */
interface WatchSubscription {
  /** The Matrix user id of the watching client (used to compute per-viewer role). */
  userId: MatrixUserId
  /** Emit one watch frame to this subscriber's mux stream. */
  send(frame: WorkflowWatchFrame): void
}

/** A running gateway: introspection plus a reversible stop. */
export interface GatewayHandle {
  /** Whether the HTTP/WS server is currently listening. */
  isListening(): boolean
  /** The loopback coordinates the gateway is serving on. */
  info(): MovieGatewayInfo
  /** Stop listening, terminate sockets, and release the port. */
  stop(): Promise<void>
}

/** Bound the request body so a hostile client cannot exhaust memory. */
const MAX_BODY_BYTES = 65_536

/** MIME type by lowercase file extension for the `/comfy/` static route. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * The URL the frontend imports for our bridge extension, listed by
 * `/comfy/api/extensions`. The pinned frontend resolves each entry with
 * `fileURL(e) = api_base + e`, where `api_base` is `/comfy` for a subpath
 * deployment, so we advertise an api_base-relative path (leading slash, NO
 * `/comfy` prefix). That yields the final `/comfy/extensions/dsh-movie-bridge.js`
 * we serve below. Returning the absolute `/comfy/...` form would double the
 * prefix (`/comfy/comfy/...` -> 404 -> a vite preloadError that aborts
 * `app.setup()`, leaving node defs and the bridge unregistered).
 */
const BRIDGE_EXTENSION_URL = '/extensions/dsh-movie-bridge.js'

/** HTTP status each Leg C error code maps to. */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  'bad-request': 400,
  'missing-token': 400,
  'invalid-token': 401,
  'forbidden': 403,
  'not-found': 404,
  'conflict': 409,
  'unimplemented': 501,
  'internal': 500,
}

/** Attach permissive dev CORS headers (loopback prototype; tightened in prod). */
function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

/** Send an arbitrary JSON payload with CORS headers applied. */
function sendRaw(res: ServerResponse, status: number, payload: unknown): void {
  applyCors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Wrap a successful Leg C result. */
function ok<R>(result: R): ApiOk<R> {
  return { ok: true, result }
}

/** Wrap a failed Leg C result. */
function err(code: ApiErrorCode, message: string): ApiError {
  return { ok: false, error: { code, message } }
}

/** Send a Leg C {@link ApiResult}, deriving the HTTP status from its tag. */
function sendApi(res: ServerResponse, result: ApiResult<unknown>): void {
  const status = result.ok ? 200 : STATUS_BY_CODE[result.error.code]
  sendRaw(res, status, result)
}

/** Read a length-bounded request body as UTF-8 text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** Parse a request body into a JSON object (empty object when blank/invalid shape). */
async function readParams(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

/** Extract a non-empty string param, or `undefined`. */
function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Extract the bearer token from the `Authorization` header, if present. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const token = match?.[1]?.trim()
  return token !== undefined && token.length > 0 ? token : undefined
}

/** Map the identity plugin's principal onto the protocol's wire shape. */
function toPrincipal(principal: MatrixPrincipal): Principal {
  return {
    userId: principal.userId,
    localpart: principal.localpart,
    serverName: principal.serverName,
    deviceId: principal.deviceId,
  }
}

/** Maximum corrective re-plans per original canvas txn (bounds the §5 loop). */
const MAX_REPLANS = 2

/**
 * Start the loopback Leg B/C gateway. The returned handle is stopped by the
 * plugin's reversible effect teardown.
 * @param deps - bind port, identity service, and logger.
 * @returns the running gateway handle.
 */
export function startGatewayServer(deps: GatewayServerDeps): GatewayHandle {
  const { port, identity, logger, staticDir, bridgeExtensionFile, canvasAgent, jobs, mediaProvider, stepText, review, availability, matrixChat, director, workspaceRoot } = deps
  const execClients = new Set<WebSocket>()
  // D15/D8: the `customer_service` room notifier (posts the unavailable-model
  // notice and echoes executed artifacts) and the model-availability gate. Both
  // degrade safely: no matrixChat → log-only notices; no availability → a
  // conservative gate (text only when a text seam is wired).
  const notifier = createRoomNotifier(matrixChat, logger)
  const executorAvailability: ModelAvailability = availability
    ?? availabilityFromInventory({ text: stepText !== undefined, video: false, image: false, audio: false })
  // P3-M5: the host-authoritative, file-backed per-room workspace replaces the
  // volatile in-memory store. When no root is injected (verifiers/tests), fall
  // back to a throwaway temp dir so the gateway still boots.
  const workflowStore = createWorkspaceStore(workspaceRoot ?? join(tmpdir(), 'dsh-movie-workspaces'))
  /** Pending canvas script generations keyed by txnId (POST triggers, mux delivers). */
  const canvasPlans = new Map<string, Promise<CanvasGenerateResult>>()
  /** Last canvas execution result per room, retained for the P3-M4 re-plan loop. */
  const lastCanvasResults = new Map<string, { txnId: string; committed: boolean; opResults: OpResult[] }>()
  /** Original intent per canvas txn, so a re-plan can rebuild the corrective prompt. */
  const canvasIntents = new Map<string, string>()
  /** Per-txn canvas execution result, so `canvas/replan` can pull the failed ops. */
  const canvasResultsByTxn = new Map<string, { committed: boolean; opResults: OpResult[] }>()
  /** Maps a corrective txn back to the original txn it re-plans (for the cap). */
  const replanOrigin = new Map<string, string>()
  /** Re-plan count per original txn, capped by {@link MAX_REPLANS} to avoid loops. */
  const replanCounts = new Map<string, number>()
  /**
   * Live movie pipeline runs keyed by runId (P3-M4). The POST `movie/run` starts
   * the director and records the evolving pipeline; the `movie/run` mux channel
   * subscribes to incremental stages, and `movie/status` reads the last pipeline.
   */
  const movieRuns = new Map<string, MovieRunRecord>()
  /**
   * Live `workflow/watch` subscribers per room (P3-M5). Members and the host
   * attach to converge on the committed HEAD; every host write (commit/revert)
   * and every host transfer fans out here so all clients stay in sync.
   */
  const roomWatchers = new Map<string, Set<WatchSubscription>>()

  /** Fan one committed/reverted frame out to every watcher of a room. */
  function broadcastWatch(roomId: string, frame: WorkflowWatchFrame): void {
    const watchers = roomWatchers.get(roomId)
    if (watchers === undefined) return
    for (const sub of watchers) sub.send(frame)
  }

  /**
   * Fan a host-transfer out to every watcher, computing each viewer's own role
   * from the new host (a watcher is always a room member, so it is `host` when
   * it holds the seat and `member` otherwise).
   */
  function broadcastRoleChange(roomId: string, host: MatrixUserId | null): void {
    const watchers = roomWatchers.get(roomId)
    if (watchers === undefined) return
    for (const sub of watchers) {
      const role: RoomRole = host !== null && sub.userId === host ? 'host' : 'member'
      sub.send({ stage: 'role', host, role })
    }
  }
  let queueCounter = 0
  let listening = false

  /** Send one lifecycle message to a socket when it is open. */
  function sendExec(socket: WebSocket, message: ExecMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  /** Broadcast a lifecycle sequence to every connected `/ws` client. */
  function broadcastExec(messages: ExecMessage[]): void {
    for (const client of execClients) {
      for (const message of messages) sendExec(client, message)
    }
  }

  /** Send one mux frame to a socket when it is open. */
  function sendFrame(socket: WebSocket, frame: StreamFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  /**
   * Stream one canvas op-script generation over the mux (Phase-3 P3-M3). The
   * POST `canvas/script` call already started the generation and registered it
   * under `txnId`; this re-authenticates the socket caller, waits for the plan,
   * and emits a `script` data frame (or a typed `error`) followed by `end`.
   * Delivering over the mux (rather than the POST response) keeps the script
   * request-scoped, so a second browser tab cannot double-apply the same ops.
   * @param socket - the mux client socket.
   * @param open - the `open` control message carrying `{ roomId, txnId, token }`.
   */
  async function handleCanvasScriptStream(socket: WebSocket, open: StreamOpen): Promise<void> {
    const stream = open.stream
    const params = open.params ?? {}
    const token = stringParam(params, 'token')
    if (token === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'missing-token', message: 'a Matrix access token is required' } })
      return
    }
    const principal = await identity.whoami(token)
    if (principal === null) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'invalid-token', message: 'the Matrix access token was rejected' } })
      return
    }
    const roomId = stringParam(params, 'roomId')
    const txnId = stringParam(params, 'txnId')
    if (roomId === undefined || txnId === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'bad-request', message: 'roomId and txnId are required' } })
      return
    }
    const role = await identity.roomRole(roomId, principal.userId)
    if (role !== 'host') {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'forbidden', message: `role "${role}" may not request canvas scripts; host seat required` } })
      return
    }
    const plan = canvasPlans.get(txnId)
    if (plan === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'not-found', message: `no pending canvas script for txnId ${txnId}` } })
      return
    }
    sendFrame(socket, { stream, type: 'data', payload: { stage: 'generating', txnId } })
    const result = await plan
    canvasPlans.delete(txnId)
    if (!result.ok) {
      sendFrame(socket, { stream, type: 'error', payload: { code: result.code, message: result.message } })
      return
    }
    sendFrame(socket, { stream, type: 'data', payload: { stage: 'script', script: result.script } })
    sendFrame(socket, { stream, type: 'end' })
  }

  /**
   * Stream one movie pipeline run over the mux (Phase-3 P3-M4). The POST
   * `movie/run` call already started the director and registered the run under
   * `runId`; this re-authenticates the socket caller, replays the progress so
   * far, then fans out each incremental stage until the terminal `done`, and
   * closes the stream. Delivering over the mux keeps the run request-scoped.
   * @param socket - the mux client socket.
   * @param open - the `open` control message carrying `{ roomId, runId, token }`.
   */
  async function handleMovieRunStream(socket: WebSocket, open: StreamOpen): Promise<void> {
    const stream = open.stream
    const params = open.params ?? {}
    const token = stringParam(params, 'token')
    if (token === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'missing-token', message: 'a Matrix access token is required' } })
      return
    }
    const principal = await identity.whoami(token)
    if (principal === null) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'invalid-token', message: 'the Matrix access token was rejected' } })
      return
    }
    const roomId = stringParam(params, 'roomId')
    const runId = stringParam(params, 'runId')
    if (roomId === undefined || runId === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'bad-request', message: 'roomId and runId are required' } })
      return
    }
    const role = await identity.roomRole(roomId, principal.userId)
    if (role === 'none') {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'forbidden', message: 'role "none" may not stream the movie pipeline; room membership required' } })
      return
    }
    const record = movieRuns.get(runId)
    if (record === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'not-found', message: `no movie run for runId ${runId}` } })
      return
    }
    // Replay the progress so far so a subscriber that attaches mid-run sees it.
    for (const step of record.pipeline.steps) {
      sendFrame(socket, { stream, type: 'data', payload: { stage: 'step', step } })
    }
    if (record.settled) {
      sendFrame(socket, { stream, type: 'data', payload: { stage: 'done', pipeline: record.pipeline } })
      sendFrame(socket, { stream, type: 'end' })
      return
    }
    const listener: MovieRunListener = (stage): void => {
      sendFrame(socket, { stream, type: 'data', payload: stage })
      if (stage.stage === 'done') {
        record.subscribers.delete(listener)
        sendFrame(socket, { stream, type: 'end' })
      }
    }
    record.subscribers.add(listener)
    socket.on('close', () => record.subscribers.delete(listener))
    socket.on('error', () => record.subscribers.delete(listener))
  }

  /**
   * Subscribe a client to a room's live `workflow/watch` channel (Phase-3 P3-M5).
   * Re-authenticates the socket caller, refuses non-members, emits an initial
   * `snapshot` (committed HEAD + the caller's resolved role/host), then keeps the
   * stream open, fanning out every subsequent commit/revert/role frame so all
   * clients converge. Unlike `movie/run`, this stream does not self-terminate; it
   * closes when the socket does.
   * @param socket - the mux client socket.
   * @param open - the `open` control message carrying `{ roomId, token }`.
   */
  async function handleWorkflowWatchStream(socket: WebSocket, open: StreamOpen): Promise<void> {
    const stream = open.stream
    const params = open.params ?? {}
    const token = stringParam(params, 'token')
    if (token === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'missing-token', message: 'a Matrix access token is required' } })
      return
    }
    const principal = await identity.whoami(token)
    if (principal === null) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'invalid-token', message: 'the Matrix access token was rejected' } })
      return
    }
    const roomId = stringParam(params, 'roomId')
    if (roomId === undefined) {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'bad-request', message: 'roomId is required' } })
      return
    }
    const role = await identity.roomRole(roomId, principal.userId)
    if (role === 'none') {
      sendFrame(socket, { stream, type: 'error', payload: { code: 'forbidden', message: 'role "none" may not watch the workflow; room membership required' } })
      return
    }
    const host = await identity.roomHost(roomId)
    const snapshot: WorkflowWatchFrame = { stage: 'snapshot', workflow: workflowStore.getHead(roomId), role, host }
    sendFrame(socket, { stream, type: 'data', payload: snapshot })
    const sub: WatchSubscription = {
      userId: principal.userId,
      send(frame: WorkflowWatchFrame): void {
        sendFrame(socket, { stream, type: 'data', payload: frame })
      },
    }
    let watchers = roomWatchers.get(roomId)
    if (watchers === undefined) {
      watchers = new Set<WatchSubscription>()
      roomWatchers.set(roomId, watchers)
    }
    watchers.add(sub)
    const detach = (): void => {
      const set = roomWatchers.get(roomId)
      if (set === undefined) return
      set.delete(sub)
      if (set.size === 0) roomWatchers.delete(roomId)
    }
    socket.on('close', detach)
    socket.on('error', detach)
  }

  /**
   * Begin a corrective re-plan for a canvas transaction that did not fully
   * commit (Phase-3 P3-M4 observe->re-plan loop, design doc §5). Starts a
   * `canvasAgent.replan` turn seeded with the failed ops, registers it under a
   * fresh txnId in `canvasPlans` (so the client pulls it on the existing
   * `canvas/script` mux channel), and enforces a per-origin cap to avoid loops.
   * @param roomId - the room whose canvas is repaired.
   * @param sourceTxnId - the txn whose result triggered the re-plan.
   * @returns the fresh corrective txnId, or `null` when capped or unavailable.
   */
  function beginReplan(roomId: string, sourceTxnId: string): string | null {
    if (canvasAgent === undefined) return null
    const origin = replanOrigin.get(sourceTxnId) ?? sourceTxnId
    const count = replanCounts.get(origin) ?? 0
    if (count >= MAX_REPLANS) {
      logger.info('[movie-gateway] re-plan cap reached for origin txn=%s (%d/%d)', origin, count, MAX_REPLANS)
      return null
    }
    const intent = canvasIntents.get(sourceTxnId) ?? canvasIntents.get(origin) ?? ''
    const result = canvasResultsByTxn.get(sourceTxnId)
    const failedOps = (result?.opResults ?? []).filter((entry): boolean => !entry.ok)
    const graph = workflowStore.getHead(roomId)?.graph ?? null
    const replanTxnId = randomUUID()
    const plan = canvasAgent.replan(roomId, intent, failedOps, graph)
    // Swallow the floating rejection; the mux stream re-awaits the same plan.
    void plan.catch((): void => {})
    canvasPlans.set(replanTxnId, plan)
    canvasIntents.set(replanTxnId, intent)
    replanOrigin.set(replanTxnId, origin)
    replanCounts.set(origin, count + 1)
    // TTL sweep so an abandoned corrective txn frees its state.
    setTimeout(() => {
      canvasPlans.delete(replanTxnId)
      canvasIntents.delete(replanTxnId)
      replanOrigin.delete(replanTxnId)
    }, 120_000)
    logger.info('[movie-gateway] re-plan started txn=%s origin=%s room=%s attempt=%d', replanTxnId, origin, roomId, count + 1)
    return replanTxnId
  }

  /* ---------------------------- Leg C dispatch --------------------------- */

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'POST') {
      sendApi(res, err('bad-request', 'Leg C methods are POST /api/<ns>/<method>'))
      return
    }
    const method: LegCMethod | null = methodFromApiPath(pathname)
    if (method === null) {
      sendApi(res, err('not-found', `malformed api path: ${pathname}`))
      return
    }
    if (!IMPLEMENTED_METHODS.includes(method)) {
      sendApi(res, err('unimplemented', `${method} is not implemented in M1`))
      return
    }

    let params: Record<string, unknown>
    try {
      params = await readParams(req)
    } catch (error) {
      logger.warn('[movie-gateway] %s bad body: %s', method, String(error))
      sendApi(res, err('bad-request', 'invalid JSON body'))
      return
    }

    const token = bearerToken(req) ?? stringParam(params, 'token')
    if (token === undefined) {
      sendApi(res, err('missing-token', 'a Matrix access token is required'))
      return
    }
    const principal = await identity.whoami(token)
    if (principal === null) {
      sendApi(res, err('invalid-token', 'the Matrix access token was rejected'))
      return
    }

    switch (method) {
      case 'auth/principal': {
        const payload: LegCResponse<'auth/principal'> = {
          principal: toPrincipal(principal),
          principalId: identity.principalId(principal.userId),
        }
        sendApi(res, ok(payload))
        return
      }
      case 'auth/role': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        const payload: LegCResponse<'auth/role'> = { role }
        sendApi(res, ok(payload))
        return
      }
      case 'registry/list': {
        const kind = stringParam(params, 'kind')
        const entries = kind === undefined
          ? [...CANNED_REGISTRY]
          : CANNED_REGISTRY.filter((entry): boolean => entry.kind === kind)
        const payload: LegCResponse<'registry/list'> = { entries }
        sendApi(res, ok(payload))
        return
      }
      case 'registry/get': {
        const id = stringParam(params, 'id')
        if (id === undefined) {
          sendApi(res, err('bad-request', 'id is required'))
          return
        }
        const entry = CANNED_REGISTRY.find((candidate): boolean => candidate.id === id) ?? null
        const payload: LegCResponse<'registry/get'> = { entry }
        sendApi(res, ok(payload))
        return
      }
      case 'assets/list': {
        // M1 stub policy: the asset repository is host-gated. A caller must hold
        // the `host` seat in the given room; members and non-members are refused
        // (fail-closed), proving the roomRole policy over the wire.
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not list assets; host seat required`))
          return
        }
        const payload: LegCResponse<'assets/list'> = { assets: [...CANNED_ASSETS] }
        sendApi(res, ok(payload))
        return
      }
      case 'assets/get': {
        const id = stringParam(params, 'id')
        if (id === undefined) {
          sendApi(res, err('bad-request', 'id is required'))
          return
        }
        const asset = CANNED_ASSETS.find((candidate): boolean => candidate.id === id) ?? null
        const payload: LegCResponse<'assets/get'> = { asset }
        sendApi(res, ok(payload))
        return
      }
      case 'workflow/get': {
        // M6 workflow store: any room seat (host|member) may read the graph; a
        // non-member is refused fail-closed, mirroring the assets/list policy.
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not read the workflow; room membership required'))
          return
        }
        const payload: LegCResponse<'workflow/get'> = { workflow: workflowStore.getHead(roomId) }
        sendApi(res, ok(payload))
        return
      }
      case 'workflow/put': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const rawGraph = params['graph']
        if (typeof rawGraph !== 'object' || rawGraph === null) {
          sendApi(res, err('bad-request', 'graph is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not write the workflow; host seat required`))
          return
        }
        const rawBaseRev = params['baseRev']
        const baseRev = typeof rawBaseRev === 'number' && Number.isFinite(rawBaseRev) ? rawBaseRev : undefined
        const result = workflowStore.putGraph(roomId, rawGraph as WorkflowGraph, principal.userId, baseRev)
        if (!result.ok) {
          sendApi(res, err('conflict', `stale baseRev; the current revision is ${result.current.rev}`))
          return
        }
        broadcastWatch(roomId, { stage: 'committed', workflow: result.record, by: principal.userId })
        const payload: LegCResponse<'workflow/put'> = { workflow: result.record }
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/draft.get': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not read the draft; room membership required'))
          return
        }
        const payload: LegCResponse<'workspace/draft.get'> = workflowStore.readDraft(roomId)
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/draft.put': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const rawGraph = params['graph']
        if (typeof rawGraph !== 'object' || rawGraph === null) {
          sendApi(res, err('bad-request', 'graph is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not write the draft; host seat required`))
          return
        }
        const payload: LegCResponse<'workspace/draft.put'> = workflowStore.putDraft(roomId, rawGraph as WorkflowGraph)
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/undo': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not undo the draft; host seat required`))
          return
        }
        const payload: LegCResponse<'workspace/undo'> = workflowStore.undo(roomId)
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/redo': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not redo the draft; host seat required`))
          return
        }
        const payload: LegCResponse<'workspace/redo'> = workflowStore.redo(roomId)
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/commit': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not commit; host seat required`))
          return
        }
        const message = stringParam(params, 'message') ?? ''
        const record = workflowStore.commitDraft(roomId, principal.userId, message)
        if (record === null) {
          sendApi(res, err('not-found', 'nothing to commit; the workspace has no draft or head'))
          return
        }
        broadcastWatch(roomId, { stage: 'committed', workflow: record, by: principal.userId })
        const payload: LegCResponse<'workspace/commit'> = { workflow: record }
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/history.list': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not read history; room membership required'))
          return
        }
        const payload: LegCResponse<'workspace/history.list'> = { commits: workflowStore.listCommits(roomId) }
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/history.get': {
        const roomId = stringParam(params, 'roomId')
        const rawRev = params['rev']
        if (roomId === undefined || typeof rawRev !== 'number' || !Number.isFinite(rawRev)) {
          sendApi(res, err('bad-request', 'roomId and rev are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not read history; room membership required'))
          return
        }
        const entry = workflowStore.getCommit(roomId, rawRev)
        if (entry === null) {
          sendApi(res, err('not-found', `no committed revision ${String(rawRev)}`))
          return
        }
        const payload: LegCResponse<'workspace/history.get'> = entry
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/revert': {
        const roomId = stringParam(params, 'roomId')
        const rawRev = params['rev']
        if (roomId === undefined || typeof rawRev !== 'number' || !Number.isFinite(rawRev)) {
          sendApi(res, err('bad-request', 'roomId and rev are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not revert; host seat required`))
          return
        }
        const message = stringParam(params, 'message') ?? ''
        const record = workflowStore.revert(roomId, rawRev, principal.userId, message)
        if (record === null) {
          sendApi(res, err('not-found', `no committed revision ${String(rawRev)} to revert to`))
          return
        }
        broadcastWatch(roomId, { stage: 'reverted', workflow: record, by: principal.userId, fromRev: rawRev })
        const payload: LegCResponse<'workspace/revert'> = { workflow: record }
        sendApi(res, ok(payload))
        return
      }
      case 'workspace/list': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not list the workspace; room membership required'))
          return
        }
        const entries = workflowStore.listCommits(roomId).map((commit): string => commit.file)
        const payload: LegCResponse<'workspace/list'> = { entries }
        sendApi(res, ok(payload))
        return
      }
      case 'room/transferHost': {
        const roomId = stringParam(params, 'roomId')
        const targetUserId = stringParam(params, 'targetUserId')
        if (roomId === undefined || targetUserId === undefined) {
          sendApi(res, err('bad-request', 'roomId and targetUserId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not transfer the host seat; host seat required`))
          return
        }
        const host = await identity.transferHost(roomId, token, targetUserId)
        if (host === null) {
          sendApi(res, err('internal', 'the host transfer was rejected by the homeserver'))
          return
        }
        broadcastRoleChange(roomId, host)
        const payload: LegCResponse<'room/transferHost'> = { host }
        sendApi(res, ok(payload))
        return
      }
      case 'canvas/script': {
        // P3-M3: a POST triggers generation and returns a txnId; the script
        // itself is delivered over the `canvas/script` mux channel correlated by
        // that txnId (so a second browser tab cannot double-apply the same ops).
        const roomId = stringParam(params, 'roomId')
        const intent = stringParam(params, 'intent')
        if (roomId === undefined || intent === undefined) {
          sendApi(res, err('bad-request', 'roomId and intent are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not request canvas scripts; host seat required`))
          return
        }
        if (canvasAgent === undefined) {
          sendApi(res, err('unimplemented', 'canvas/script requires the agent runtime (not configured)'))
          return
        }
        const txnId = randomUUID()
        const currentGraph = workflowStore.getHead(roomId)?.graph ?? null
        const plan = canvasAgent.generate(roomId, intent, currentGraph)
        // Swallow the floating rejection; the mux stream re-awaits the same plan.
        void plan.catch((): void => {})
        canvasPlans.set(txnId, plan)
        canvasIntents.set(txnId, intent)
        // TTL sweep so an abandoned txn (client never opened the stream) frees.
        setTimeout(() => {
          canvasPlans.delete(txnId)
          canvasIntents.delete(txnId)
        }, 120_000)
        logger.info('[movie-gateway] canvas/script accepted txn=%s room=%s', txnId, roomId)
        const payload: LegCResponse<'canvas/script'> = { txnId, accepted: true }
        sendApi(res, ok(payload))
        return
      }
      case 'canvas/result': {
        // P3-M3: the client executor reports per-op outcomes; the host records
        // the last result per room (the observe/re-plan loop is P3-M4).
        const roomId = stringParam(params, 'roomId')
        const txnId = stringParam(params, 'txnId')
        if (roomId === undefined || txnId === undefined) {
          sendApi(res, err('bad-request', 'roomId and txnId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not report canvas results; room membership required'))
          return
        }
        const committed = params['committed'] === true
        const rawResults = params['opResults']
        const opResults = Array.isArray(rawResults) ? (rawResults as OpResult[]) : []
        lastCanvasResults.set(roomId, { txnId, committed, opResults })
        canvasResultsByTxn.set(txnId, { committed, opResults })
        logger.info('[movie-gateway] canvas/result room=%s txn=%s committed=%s ops=%d', roomId, txnId, String(committed), opResults.length)
        // Observe -> re-plan (design doc §5): a rolled-back txn or any failed op
        // triggers a corrective script the client pulls on the canvas/script mux
        // channel, bounded by MAX_REPLANS per original txn to avoid loops.
        const needsReplan = !committed || opResults.some((entry): boolean => !entry.ok)
        const replanTxnId = needsReplan ? beginReplan(roomId, txnId) : null
        const payload: LegCResponse<'canvas/result'> = replanTxnId === null
          ? { accepted: true }
          : { accepted: true, replanTxnId }
        sendApi(res, ok(payload))
        return
      }
      case 'canvas/replan': {
        // P3-M4: the client explicitly requests a corrective pass for a txn; the
        // fresh corrective txnId is pulled on the existing canvas/script mux.
        const roomId = stringParam(params, 'roomId')
        const txnId = stringParam(params, 'txnId')
        if (roomId === undefined || txnId === undefined) {
          sendApi(res, err('bad-request', 'roomId and txnId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not request a canvas re-plan; room membership required'))
          return
        }
        if (canvasAgent === undefined) {
          sendApi(res, err('unimplemented', 'canvas/replan requires the agent runtime (not configured)'))
          return
        }
        const replanTxnId = beginReplan(roomId, txnId)
        if (replanTxnId === null) {
          sendApi(res, err('conflict', `re-plan cap (${String(MAX_REPLANS)}) reached for txn ${txnId}`))
          return
        }
        const payload: LegCResponse<'canvas/replan'> = { txnId: replanTxnId, accepted: true }
        sendApi(res, ok(payload))
        return
      }
      case 'movie/run': {
        // P3-M4: a POST starts the six-step director pipeline and returns a
        // runId; incremental step progress is delivered over the `movie/run` mux
        // channel correlated by that runId (mirrors the canvas/script pattern).
        const roomId = stringParam(params, 'roomId')
        const intent = stringParam(params, 'intent')
        if (roomId === undefined || intent === undefined) {
          sendApi(res, err('bad-request', 'roomId and intent are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not run the movie pipeline; room membership required'))
          return
        }
        if (director === undefined) {
          sendApi(res, err('unimplemented', 'movie/run requires the agent runtime (not configured)'))
          return
        }
        const runId = randomUUID()
        const record: MovieRunRecord = {
          roomId,
          intent,
          pipeline: initialPipelineStatus(runId, roomId),
          subscribers: new Set<MovieRunListener>(),
          settled: false,
        }
        movieRuns.set(runId, record)
        const onStage: MovieRunListener = (stage): void => {
          if (stage.stage === 'step') {
            const index = record.pipeline.steps.findIndex((candidate): boolean => candidate.step === stage.step.step)
            if (index >= 0) record.pipeline.steps[index] = stage.step
          } else {
            record.pipeline = stage.pipeline
            record.settled = true
          }
          for (const subscriber of record.subscribers) subscriber(stage)
        }
        const run = director.run(roomId, runId, intent, onStage)
        // Swallow the floating rejection; the mux stream and movie/status read
        // the recorded pipeline. Mark settled so a late subscriber terminates.
        void run.catch((error: unknown): void => {
          logger.warn('[movie-gateway] movie/run %s failed: %s', runId, String(error))
          record.settled = true
        })
        // TTL sweep so an abandoned run (client never opened the stream) frees.
        setTimeout(() => movieRuns.delete(runId), 300_000)
        logger.info('[movie-gateway] movie/run accepted run=%s room=%s', runId, roomId)
        const payload: LegCResponse<'movie/run'> = { runId, accepted: true }
        sendApi(res, ok(payload))
        return
      }
      case 'movie/status': {
        const roomId = stringParam(params, 'roomId')
        const runId = stringParam(params, 'runId')
        if (roomId === undefined || runId === undefined) {
          sendApi(res, err('bad-request', 'roomId and runId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not read the movie pipeline; room membership required'))
          return
        }
        const record = movieRuns.get(runId)
        const payload: LegCResponse<'movie/status'> = { pipeline: record?.pipeline ?? null }
        sendApi(res, ok(payload))
        return
      }
      default:
        sendApi(res, err('unimplemented', `${method} is not implemented in M1`))
        return
    }
  }

  /* ----------------------------- Leg B routes ---------------------------- */

  async function handleLegB(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET' && pathname === '/health') {
      sendRaw(res, 200, { ok: true })
      return
    }
    if (method === 'GET' && pathname === '/object_info') {
      // Merged catalog: the six movie step nodes plus the canned bridge demo
      // nodes (P3-M4 executor registry). Keeping the demo nodes merged preserves
      // the `verify-comfy-bridge` contract.
      sendRaw(res, 200, objectInfoFromMovieNodes())
      return
    }
    if (method === 'GET' && pathname === '/system_stats') {
      sendRaw(res, 200, CANNED_SYSTEM_STATS)
      return
    }
    if (pathname === '/queue') {
      sendRaw(res, 200, { queue_running: [], queue_pending: [] })
      return
    }
    if (pathname === '/history') {
      sendRaw(res, 200, {})
      return
    }
    if (method === 'POST' && pathname === '/prompt') {
      await handlePromptPost(req, res)
      return
    }
    sendRaw(res, 404, { error: 'not-found' })
  }

  /* --------------------- ComfyUI frontend (/comfy/*) --------------------- */

  /** Accept a prompt graph and drive the shared execution-lifecycle socket. */
  async function submitPrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await handlePromptPost(req, res)
  }

  /**
   * Shared `POST /prompt` handler for both the Leg B surface (`/prompt`) and the
   * ComfyUI frontend (`/comfy/api/prompt`): parse -> validate (400 with
   * `node_errors`) -> topo-sort (400 on a cycle) -> schedule. When the executor
   * deps are present (`deps.jobs`) the graph runs as a `movie-exec` background
   * job that broadcasts the lifecycle in dependency order; otherwise — or if job
   * admission throws — it falls back to the canned lifecycle so
   * `verify-comfy-bridge` stays green. Always answers `{ prompt_id, number }`.
   * @param req - the POST request carrying `{ prompt }`.
   * @param res - the response to settle.
   */
  async function handlePromptPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let prompt: PromptGraph
    // The Leg B `/prompt` surface is room-agnostic; the client may optionally
    // thread the active room so D15 notices / D8 echoes land somewhere.
    let roomId = ''
    try {
      const params = await readParams(req)
      const raw = params['prompt']
      if (typeof raw !== 'object' || raw === null) {
        sendRaw(res, 400, { error: 'bad-request', message: 'prompt graph is required' })
        return
      }
      prompt = raw as PromptGraph
      roomId = stringParam(params, 'room_id') ?? stringParam(params, 'roomId') ?? ''
    } catch (error) {
      logger.warn('[movie-gateway] /prompt bad body: %s', String(error))
      sendRaw(res, 400, { error: 'bad-request', message: 'invalid JSON body' })
      return
    }

    const validation = validatePromptGraph(prompt)
    if (!validation.ok) {
      sendRaw(res, 400, { error: 'invalid_prompt', message: 'prompt graph failed validation', node_errors: validation.nodeErrors })
      return
    }
    const sorted = topoSort(prompt)
    if (!sorted.ok) {
      sendRaw(res, 400, {
        error: 'invalid_prompt',
        message: 'prompt graph has a cycle',
        node_errors: { '': { class_type: '', errors: [`cycle detected among nodes: ${sorted.cycle.join(', ')}`] } },
      })
      return
    }

    const promptId = randomUUID()
    const number = ++queueCounter

    if (jobs !== undefined) {
      try {
        startPromptJob({
          jobs,
          broadcast: broadcastExec,
          mediaProvider: mediaProvider ?? cannedMediaProvider,
          ...(stepText === undefined ? {} : { stepText }),
          ...(review === undefined ? {} : { review }),
          availability: executorAvailability,
          ...(roomId === '' ? {} : { roomId }),
          notifier,
          logger,
          promptId,
          number,
          label: `movie-exec prompt ${number}`,
        }, prompt, sorted.order)
        sendRaw(res, 200, { prompt_id: promptId, number })
        return
      } catch (error) {
        // Job admission can refuse (e.g. no attached controller); degrade to the
        // canned lifecycle rather than failing the submit.
        logger.warn('[movie-gateway] /prompt job admission failed, using canned lifecycle: %s', String(error))
      }
    }

    broadcastExec(cannedLifecycle(promptId, number, nodeIdsOf(prompt)))
    sendRaw(res, 200, { prompt_id: promptId, number })
  }

  /** Stream a file from disk with a MIME type, or 404 when absent. */
  function sendFile(res: ServerResponse, filePath: string): void {
    let isFile = false
    try {
      isFile = statSync(filePath).isFile()
    } catch {
      isFile = false
    }
    if (!isFile) {
      sendRaw(res, 404, { error: 'not-found' })
      return
    }
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    applyCors(res)
    res.writeHead(200, { 'Content-Type': type })
    createReadStream(filePath).pipe(res)
  }

  /**
   * The minimal ComfyUI backend-protocol subset the pinned frontend demands on
   * boot, served under `/comfy/api/*` (the frontend prefixes every REST call with
   * `{api_base}/api`, where `api_base` is `/comfy`). Optional cloud/agent/hub
   * features answer with empty defaults; unknown calls are logged and 404 so the
   * E2E pass reveals any remaining boot gap.
   */
  async function handleComfyApi(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (endpoint === '/prompt') {
      if (method === 'POST') await submitPrompt(req, res)
      else sendRaw(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (method !== 'GET' && method !== 'POST') {
      sendRaw(res, 405, { error: 'method-not-allowed' })
      return
    }
    switch (endpoint) {
      // Merged catalog (P5-M1): legacy step nodes + functional nodes + canned
      // demo nodes, same registry the Leg B validator/runner dispatch against.
      case '/object_info': sendRaw(res, 200, objectInfoFromMovieNodes()); return
      case '/system_stats': sendRaw(res, 200, CANNED_SYSTEM_STATS); return
      case '/extensions': sendRaw(res, 200, [BRIDGE_EXTENSION_URL]); return
      case '/queue': sendRaw(res, 200, { queue_running: [], queue_pending: [] }); return
      case '/history': sendRaw(res, 200, {}); return
      case '/settings': sendRaw(res, 200, {}); return
      case '/userdata': sendRaw(res, 200, []); return
      case '/user': sendRaw(res, 200, {}); return
      case '/users': sendRaw(res, 200, {}); return
      case '/i18n': sendRaw(res, 200, {}); return
      case '/features': sendRaw(res, 200, {}); return
      case '/node_replacements': sendRaw(res, 200, []); return
      case '/global_subgraphs': sendRaw(res, 200, []); return
      case '/folder_paths': sendRaw(res, 200, {}); return
      case '/workflow_templates': sendRaw(res, 200, []); return
      // The pinned frontend derives the queue FROM the Jobs API (`fetchQueue`
      // calls `fetchJobsRaw`), zod-parsing `{ jobs, pagination: { total, offset,
      // limit, has_more } }`. An empty-but-well-shaped answer silences both the
      // Jobs and "Failed to fetch queue" console errors.
      case '/jobs': sendRaw(res, 200, { jobs: [], pagination: { total: 0, offset: 0, limit: 200, has_more: false } }); return
      default: break
    }
    // A single job detail (`/jobs/{id}`) has no history in this prototype.
    if (endpoint.startsWith('/jobs/')) {
      sendRaw(res, 200, {})
      return
    }
    // Prefix families that must answer with benign empties to let boot proceed.
    if (endpoint.startsWith('/settings/')
      || endpoint.startsWith('/models')
      || endpoint.startsWith('/templates')
      || endpoint.startsWith('/embeddings')
      || endpoint.startsWith('/workflow_templates/')) {
      sendRaw(res, 200, [])
      return
    }
    if (endpoint.startsWith('/userdata/')) {
      if (method === 'POST') { sendRaw(res, 200, { ok: true }); return }
      sendRaw(res, 404, { error: 'not-found' })
      return
    }
    logger.warn('[movie-gateway] unhandled comfy api: %s %s', method, endpoint)
    sendRaw(res, 404, { error: 'not-found', endpoint })
  }

  /** Serve the pinned frontend build (and our bridge extension) under `/comfy/`. */
  function handleComfyStatic(res: ServerResponse, subPath: string): void {
    if (subPath === 'extensions/dsh-movie-bridge.js') {
      if (bridgeExtensionFile === undefined) { sendRaw(res, 404, { error: 'bridge-not-configured' }); return }
      sendFile(res, bridgeExtensionFile)
      return
    }
    if (staticDir === undefined) {
      sendRaw(res, 503, { error: 'comfy-frontend-not-fetched', hint: 'run server/scripts/fetch-comfy-frontend.ts' })
      return
    }
    const rel = subPath === '' ? 'index.html' : subPath
    const root = resolvePath(staticDir)
    const full = resolvePath(root, normalize(rel))
    if (full !== root && !full.startsWith(root + '/')) {
      sendRaw(res, 403, { error: 'forbidden' })
      return
    }
    if (existsSync(full) && statSync(full).isDirectory()) {
      sendFile(res, join(full, 'index.html'))
      return
    }
    sendFile(res, full)
  }

  /** Route a `/comfy/*` request to the API subset or the static build. */
  async function handleComfy(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const sub = pathname.slice('/comfy'.length)
    if (sub === '/api' || sub.startsWith('/api/')) {
      await handleComfyApi(req, res, sub.slice('/api'.length) || '/')
      return
    }
    handleComfyStatic(res, sub.replace(/^\//, ''))
  }

  /* ------------------------------ HTTP router ---------------------------- */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'OPTIONS') {
      applyCors(res)
      res.writeHead(204)
      res.end()
      return
    }
    if (pathname === '/comfy' || pathname.startsWith('/comfy/')) {
      await handleComfy(req, res, pathname)
      return
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname)
      return
    }
    await handleLegB(req, res, pathname)
  }

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.warn('[movie-gateway] handler failed: %s', String(error))
      if (!res.headersSent) sendApi(res, err('internal', 'gateway handler failed'))
      else res.end()
    })
  })

  /* --------------------------- WebSocket endpoints ----------------------- */

  const execWs = new WebSocketServer({ noServer: true })
  const muxWs = new WebSocketServer({ noServer: true })

  execWs.on('connection', (socket: WebSocket) => {
    execClients.add(socket)
    socket.on('close', () => execClients.delete(socket))
    socket.on('error', () => execClients.delete(socket))
    sendExec(socket, { type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } })
  })

  muxWs.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: RawData) => {
      let control: StreamControl
      try {
        control = JSON.parse(raw.toString()) as StreamControl
      } catch {
        sendFrame(socket, { stream: '', type: 'error', payload: { code: 'bad-request', message: 'invalid JSON frame' } })
        return
      }
      if (control.op === 'open') {
        const open = control as StreamOpen
        const stream = open.stream
        if (open.channel === 'canvas/script') {
          void handleCanvasScriptStream(socket, open).catch((error: unknown) => {
            logger.warn('[movie-gateway] canvas/script stream failed: %s', String(error))
            sendFrame(socket, { stream, type: 'error', payload: { code: 'internal', message: 'canvas script stream failed' } })
          })
          return
        }
        if (open.channel === 'movie/run') {
          void handleMovieRunStream(socket, open).catch((error: unknown) => {
            logger.warn('[movie-gateway] movie/run stream failed: %s', String(error))
            sendFrame(socket, { stream, type: 'error', payload: { code: 'internal', message: 'movie run stream failed' } })
          })
          return
        }
        if (open.channel === 'workflow/watch') {
          void handleWorkflowWatchStream(socket, open).catch((error: unknown) => {
            logger.warn('[movie-gateway] workflow/watch stream failed: %s', String(error))
            sendFrame(socket, { stream, type: 'error', payload: { code: 'internal', message: 'workflow watch stream failed' } })
          })
          return
        }
        if (open.channel === 'leg-b/exec') {
          const promptId = randomUUID()
          const params = open.params
          const requested = params?.['nodeIds']
          const nodeIds = Array.isArray(requested)
            ? requested.filter((id): id is string => typeof id === 'string')
            : ['1']
          for (const message of cannedLifecycle(promptId, 1, nodeIds)) {
            sendFrame(socket, { stream, type: 'data', payload: message })
          }
          sendFrame(socket, { stream, type: 'end' })
        } else {
          sendFrame(socket, { stream, type: 'error', payload: { code: 'unimplemented', message: `channel "${open.channel}" is not implemented in M1` } })
        }
        return
      }
      if (control.op === 'close') {
        sendFrame(socket, { stream: control.stream, type: 'end' })
      }
    })
  })

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (pathname === '/ws' || pathname === '/comfy/ws') {
      execWs.handleUpgrade(req, socket, head, (ws: WebSocket) => execWs.emit('connection', ws, req))
      return
    }
    if (pathname === '/api/ws') {
      muxWs.handleUpgrade(req, socket, head, (ws: WebSocket) => muxWs.emit('connection', ws, req))
      return
    }
    socket.destroy()
  })

  httpServer.on('close', () => {
    listening = false
  })
  httpServer.listen(port, '127.0.0.1', () => {
    listening = true
    logger.info('[movie-gateway] Leg B/C gateway on http://127.0.0.1:%d (exec /ws, mux /api/ws)', port)
  })

  const info: MovieGatewayInfo = {
    port,
    url: `http://127.0.0.1:${port}`,
    execWsUrl: `ws://127.0.0.1:${port}/ws`,
    muxWsUrl: `ws://127.0.0.1:${port}/api/ws`,
  }

  return {
    isListening(): boolean {
      return listening
    },
    info(): MovieGatewayInfo {
      return info
    },
    async stop(): Promise<void> {
      for (const client of execWs.clients) client.terminate()
      for (const client of muxWs.clients) client.terminate()
      execClients.clear()
      await new Promise<void>(resolveClose => execWs.close(() => resolveClose()))
      await new Promise<void>(resolveClose => muxWs.close(() => resolveClose()))
      await new Promise<void>(resolveClose => {
        httpServer.close(() => resolveClose())
        httpServer.closeAllConnections()
      })
      listening = false
    },
  }
}
