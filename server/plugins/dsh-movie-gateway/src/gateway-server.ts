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
  PromptGraphNode,
  SkillProfile,
  SkillRunOutcome,
  SkillTarget,
  SourceStatus,
  StreamControl,
  StreamFrame,
  StreamOpen,
  ToolInstallSpec,
  ToolRecord,
  WarningLevel,
  WorkflowGraph,
  WorkflowWatchFrame,
  MatrixUserId,
  RoomRole,
} from '@dsh-movie/protocol'
import { IMPLEMENTED_METHODS, methodFromApiPath, initialPipelineStatus, parseTxnNarration } from '@dsh-movie/protocol'
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
import { applyOpsToGraph } from './movie-executor/apply-ops.ts'
import { availabilityFromInventory, type ModelAvailability } from './movie-executor/model-catalog.ts'
import { downloadSkillToRoom, resolveNodeSkills, executeSkillToRoom, executeNodeSkills } from './skill-import.ts'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
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
  /**
   * Optional D7 intent-mining seam. When present (with {@link GatewayServerDeps.canvasAgent}),
   * each inbound human room utterance is classified/distilled into a graph-edit
   * intent; ordinary content discussion resolves to `null` and triggers nothing.
   * `LlmTextAgent.mineIntent` satisfies this structurally. Absent without a
   * Bailian-backed text seam, so D7 degrades to off (chat relay is unaffected).
   */
  intentMiner?: IntentMiner | undefined
  /**
   * Optional subscription to inbound human room messages (D7). Returns an
   * unsubscribe function; `ctx.on('matrix/room-message', …)` satisfies it. The
   * gateway registers the miner only when this AND {@link GatewayServerDeps.intentMiner}
   * AND {@link GatewayServerDeps.canvasAgent} are all present.
   */
  onRoomMessage?: RoomMessageSubscribe | undefined
  /**
   * Optional plugins-marketplace bridge (`ctx.movieMarket`, Phase-7 D5). When
   * present the Leg C `plugins/*` namespace is served and `POST /prompt` arms
   * the D7 mode-2 run-time skill resolver; when absent every `plugins/*` method
   * answers `unimplemented` and runs proceed skill-less.
   */
  movieMarket?: MarketBridge | undefined
  /**
   * Optional Phase-8 P8-M5 pre-run gate. When present, `POST /prompt` awaits it
   * before scheduling the job; a throw (e.g. the ComfyUI health probe failing
   * closed) rejects the submit with 503 so an unready backend never accepts
   * work. Absent → runs are admitted as before.
   */
  beforeRun?: (() => Promise<void>) | undefined
}

/**
 * The structural view of `ctx.movieMarket` the gateway drives for the Leg C
 * `plugins/*` namespace (Phase-7 D5). It mirrors `MarketService`'s method
 * signatures so the injected service is assignable WITHOUT the gateway taking a
 * hard runtime dependency on the market plugin (the type-only import in
 * `index.ts` supplies the Cordis service-key merge for `ctx.get`).
 */
export interface MarketBridge {
  /** All tool records (built-in + installed), with merged runtime status. */
  toolRecords(): ToolRecord[]
  /** Fan-out skill search (merge/dedup/rank/trust). */
  searchSkills(options: { q: string; target?: SkillTarget | undefined; toolId?: string | undefined }): Promise<SkillProfile[]>
  /** Resolve one skill profile by global id. */
  skillProfile(id: string): Promise<SkillProfile | null>
  /** Fetch one skill's body + trust-layered profile (D7 download). */
  downloadSkill(id: string): Promise<{ body: string; profile: SkillProfile } | null>
  /** Per-tool health rows (D5). */
  sourcesStatus(): Promise<SourceStatus[]>
  /** Raise/clear a server-global flag against a skill (D8). */
  flagSkill(id: string, level: WarningLevel, reason: string, actor: string): Promise<WarningLevel>
  /** Install a third-party/user tool (host-only, D2). */
  installTool(spec: ToolInstallSpec): Promise<ToolRecord>
  /** Uninstall a tool (built-ins refuse). */
  uninstallTool(toolId: string): Promise<boolean>
  /** Enable/disable a tool; `null` when unknown. */
  setToolEnabled(toolId: string, enabled: boolean): Promise<ToolRecord | null>
  /** One tool's health row, or `null` when unknown. */
  toolStatus(toolId: string): Promise<SourceStatus | null>
  /** Execute one skill's entrypoint (D9 run); trust + consent gated in the market. */
  runSkill(id: string, args: Readonly<Record<string, unknown>>): Promise<SkillRunOutcome>
  /** Record/revoke execution consent for an orange skill (D9); returns the state. */
  setSkillConsent(id: string, granted: boolean, actor: string): Promise<boolean>
  /** Whether execution consent is currently granted for a skill (D9). */
  skillConsent(id: string): Promise<boolean>
}

/** The D7 intent-mining seam: classify + distill one room utterance. */
export interface IntentMiner {
  /**
   * Decide whether an utterance asks to edit the canvas graph, and if so distill
   * it into one imperative intent.
   * @param utterance - the inbound human message body.
   * @returns the distilled intent, or `null` when no graph edit was requested.
   */
  mineIntent(utterance: string): Promise<string | null>
}

/**
 * The minimal inbound room-message shape the D7 miner consumes. Structurally
 * compatible with `dsh-matrix-chat`'s `RoomMessage` so `ctx.on('matrix/room-message')`
 * can feed it directly without the gateway importing the chat plugin's types.
 */
export interface RoomMessageLike {
  /** Room the message arrived in. */
  roomId: string
  /** Sender's Matrix user id. */
  senderId: string
  /** Sender's resolved display name. */
  senderName: string
  /** The message body. */
  body: string
  /** The Matrix event id, or `null`. */
  eventId: string | null
}

/**
 * Subscribe to inbound human room messages; returns an unsubscribe function.
 * `(handler) => ctx.on('matrix/room-message', handler)` satisfies this.
 */
export type RoomMessageSubscribe = (handler: (message: RoomMessageLike) => void) => () => void

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
  const { port, identity, logger, staticDir, bridgeExtensionFile, canvasAgent, jobs, mediaProvider, stepText, availability, matrixChat, director, workspaceRoot, intentMiner, onRoomMessage, movieMarket, beforeRun } = deps
  const execClients = new Set<WebSocket>()
  // P8-M6: cancel-on-disconnect. Bind each `/ws` exec client to the backend jobs
  // it submitted (ComfyUI-style `clientId`). When the client goes away its live
  // jobs are killed -> the provider aborts the remote job and releases the
  // in-flight semaphore slot, instead of orphaning it until the 900s server
  // deadline (which, with inflightMax=1, wedged the whole executor and forced a
  // gateway restart -- the deterministic S3-9 storyboard failure).
  const execClientIds = new Map<WebSocket, string>()
  const clientJobs = new Map<string, Set<JobId>>()

  /** Extract the ComfyUI-style clientId from a `/ws` upgrade request query. */
  function execClientIdFromReq(req: IncomingMessage | undefined): string {
    if (req === undefined) return ''
    const url = req.url ?? ''
    const q = url.indexOf('?')
    if (q < 0) return ''
    const params = new URLSearchParams(url.slice(q + 1))
    return params.get('clientId') ?? params.get('client_id') ?? ''
  }

  /** Register a freshly-started job against its submitting client (if any). */
  function trackClientJob(clientId: string, jobId: JobId): void {
    if (clientId === '') return
    let set = clientJobs.get(clientId)
    if (set === undefined) { set = new Set<JobId>(); clientJobs.set(clientId, set) }
    set.add(jobId)
  }

  /** Kill every live job submitted by a now-disconnected exec client. */
  function cancelClientJobs(clientId: string, reason: string): void {
    const set = clientJobs.get(clientId)
    if (set === undefined) return
    clientJobs.delete(clientId)
    if (jobs === undefined) return
    for (const jobId of set) {
      try {
        const state = jobs.kill(jobId, undefined, reason)
        logger.info('[movie-gateway] cancel-on-disconnect: job %s -> %s (client %s)', jobId, state, clientId)
      } catch (error) {
        logger.warn('[movie-gateway] cancel-on-disconnect: kill %s failed: %s', jobId, String(error))
      }
    }
  }
  // D15/D8: the model-availability gate. Degrades safely: no availability → a
  // conservative gate (text only when a text seam is wired).
  const executorAvailability: ModelAvailability = availability
    ?? availabilityFromInventory({ text: stepText !== undefined, video: false, image: false, audio: false })
  // P3-M5: the host-authoritative, file-backed per-room workspace replaces the
  // volatile in-memory store. When no root is injected (verifiers/tests), fall
  // back to a throwaway temp dir so the gateway still boots.
  const workflowStore = createWorkspaceStore(workspaceRoot ?? join(tmpdir(), 'dsh-movie-workspaces'))
  // D15/D8: the `customer_service` room notifier (posts the unavailable-model
  // notice and echoes executed artifacts). P8-M3: the workspace store doubles
  // as the artifact writer so generated media bytes land in <roomDir>/artifacts/.
  // Degrades safely: no matrixChat → log-only notices.
  const notifier = createRoomNotifier(matrixChat, logger, workflowStore)
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

  // ── Phase-5 D7: conversation → graph ──
  // Mine each inbound human room utterance for a graph-edit intent; when one
  // qualifies, run the canvas planner, apply its op-script to the committed HEAD
  // graph, commit, fan the new HEAD out to watchers, and narrate once (D9). The
  // bot's own messages (narration/echo/notice) never reach here — matrix-chat
  // filters them before emitting `matrix/room-message` — and we double-guard on
  // the narration sentinel so a commit can never re-trigger itself. Agent ops and
  // user ops thus share ONE txn/commit/fanout/undo pipeline (design doc D7/D9).
  /** Per-room serialization so concurrent utterances never interleave commits. */
  const d7Queues = new Map<string, Promise<void>>()

  /** Run one D7 mine → plan → apply → commit → narrate pass for a room. */
  async function runD7ForRoom(message: RoomMessageLike): Promise<void> {
    if (canvasAgent === undefined || intentMiner === undefined) return
    const body = message.body.trim()
    // Never mine our own narration (defensive; the bot is already filtered out).
    if (body === '' || parseTxnNarration(body) !== null) return
    const intent = await intentMiner.mineIntent(body)
    // ctx.logger.info is filtered at the default level, and a `NONE` classify is
    // otherwise completely silent, so trace the mine decision on stdout.
    console.log('[movie-gateway] D7 mine room=%s intent=%s', message.roomId, intent === null ? 'NONE' : JSON.stringify(intent))
    if (intent === null) return
    const roomId = message.roomId
    // Snapshot HEAD right before the (slow) planner turn so the ops are generated
    // against the graph we will apply to and commit over; a concurrent commit then
    // surfaces as a baseRev conflict and is dropped rather than clobbered (R5).
    const head = workflowStore.getHead(roomId)
    const baseGraph: WorkflowGraph = head?.graph
      ?? { last_node_id: 0, last_link_id: 0, nodes: [], links: [], groups: [], version: 0.4 }
    const baseRev = head?.rev
    console.log('[movie-gateway] D7 plan start room=%s headRev=%s', roomId, String(baseRev))
    const plan = await canvasAgent.generate(roomId, intent, head?.graph ?? null)
    console.log('[movie-gateway] D7 plan done room=%s ok=%s %s', roomId, String(plan.ok), plan.ok ? '' : `code=${plan.code} msg=${plan.message}`)
    if (!plan.ok) {
      logger.warn('[movie-gateway] D7 plan rejected room=%s: %s (%s)', roomId, plan.message, plan.code)
      return
    }
    const outcome = applyOpsToGraph(baseGraph, plan.script.ops)
    if (!outcome.committed) {
      const failed = outcome.results.find((entry): boolean => !entry.ok)
      logger.warn('[movie-gateway] D7 txn rolled back room=%s at op[%d]: %s', roomId, failed?.index ?? -1, failed?.error ?? 'unknown')
      return
    }
    const author: MatrixUserId = message.senderId
    const commit = workflowStore.putGraph(roomId, outcome.graph, author, baseRev, `D7: ${intent}`)
    if (!commit.ok) {
      logger.warn('[movie-gateway] D7 commit conflict room=%s (head rev %d)', roomId, commit.current.rev)
      return
    }
    broadcastWatch(roomId, { stage: 'committed', workflow: commit.record, by: author })
    await notifier.narrateTxn(roomId, outcome.summary)
    console.log('[movie-gateway] D7 applied room=%s rev=%d ops=%d intent="%s"', roomId, commit.record.rev, plan.script.ops.length, intent)
  }

  /** Enqueue one D7 pass behind the room's prior pass (never interleave). */
  function handleRoomMessage(message: RoomMessageLike): void {
    if (canvasAgent === undefined || intentMiner === undefined || onRoomMessage === undefined) return
    const roomId = message.roomId
    const prior = d7Queues.get(roomId) ?? Promise.resolve()
    const next = prior.then(
      (): Promise<void> => runD7ForRoom(message),
      (): Promise<void> => runD7ForRoom(message),
    )
    d7Queues.set(roomId, next.then((): void => undefined, (): void => undefined))
    void next.catch((error: unknown): void => {
      // console.log as well as logger.warn: the logger sink is filtered/redirected
      // per deployment, and a swallowed D7 failure is otherwise invisible.
      console.log('[movie-gateway] D7 handler failed room=%s: %s', roomId, error instanceof Error ? (error.stack ?? error.message) : String(error))
      logger.warn('[movie-gateway] D7 handler failed room=%s: %s', roomId, String(error))
    })
  }

  // Register the D7 listener only when the full seam is wired (planner + miner +
  // event source); the unsubscribe runs in `stop()` so a host reload never leaks.
  const unsubscribeRoomMessages =
    canvasAgent !== undefined && intentMiner !== undefined && onRoomMessage !== undefined
      ? onRoomMessage(handleRoomMessage)
      : undefined

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

  /**
   * Serve the Leg C `plugins/*` namespace (Phase-7 D5/D7).
   *
   * M4 governance: READS (`tools.list`/`tools.status`, `skills.search`/
   * `skills.profile`, `sources.status`) are open to any authenticated principal.
   * `skills.download` writes the room workspace + records an import commit, so it
   * is HOST-gated like every other room mutation. The server-GLOBAL writes
   * (`tools.install`/`uninstall`/`enable`, `skills.flag`) are authenticated-only
   * for M4 because the protocol exposes no global-admin primitive (`whoami`
   * carries no admin flag); the M5 Plugins page enforces guest read-only on top
   * of this transport-level policy.
   * @param method - the dispatched `plugins/*` method.
   * @param params - the parsed request body.
   * @param principal - the authenticated caller.
   * @param res - the response to settle.
   * @param market - the (defined) marketplace bridge.
   */
  async function handlePlugins(
    method: LegCMethod,
    params: Record<string, unknown>,
    principal: MatrixPrincipal,
    res: ServerResponse,
    market: MarketBridge,
  ): Promise<void> {
    switch (method) {
      case 'plugins/tools.list': {
        const payload: LegCResponse<'plugins/tools.list'> = { tools: market.toolRecords() }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/tools.install': {
        const rawSpec = params['spec']
        if (typeof rawSpec !== 'object' || rawSpec === null) {
          sendApi(res, err('bad-request', 'spec is required'))
          return
        }
        const spec = rawSpec as ToolInstallSpec
        if (typeof spec.name !== 'string' || spec.name === ''
          || typeof spec.command !== 'string' || spec.command === ''
          || typeof spec.manifest !== 'object' || spec.manifest === null) {
          sendApi(res, err('bad-request', 'spec.name, spec.command, and spec.manifest are required'))
          return
        }
        const tool = await market.installTool(spec)
        const payload: LegCResponse<'plugins/tools.install'> = { tool }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/tools.uninstall': {
        const toolId = stringParam(params, 'toolId')
        if (toolId === undefined) {
          sendApi(res, err('bad-request', 'toolId is required'))
          return
        }
        const removed = await market.uninstallTool(toolId)
        const payload: LegCResponse<'plugins/tools.uninstall'> = { removed }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/tools.enable': {
        const toolId = stringParam(params, 'toolId')
        const enabled = params['enabled']
        if (toolId === undefined || typeof enabled !== 'boolean') {
          sendApi(res, err('bad-request', 'toolId and a boolean enabled are required'))
          return
        }
        const tool = await market.setToolEnabled(toolId, enabled)
        if (tool === null) {
          sendApi(res, err('not-found', `unknown tool "${toolId}"`))
          return
        }
        const payload: LegCResponse<'plugins/tools.enable'> = { tool }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/tools.status': {
        const toolId = stringParam(params, 'toolId')
        if (toolId === undefined) {
          sendApi(res, err('bad-request', 'toolId is required'))
          return
        }
        const status = await market.toolStatus(toolId)
        const payload: LegCResponse<'plugins/tools.status'> = { status }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/skills.search': {
        // Empty q is a legitimate *browse* query (the curated source lists its
        // whole suite for q=''); only a missing/non-string q is a bad request.
        const qRaw = params['q']
        const q = typeof qRaw === 'string' ? qRaw : undefined
        if (q === undefined) {
          sendApi(res, err('bad-request', 'q is required'))
          return
        }
        const target = stringParam(params, 'target') as SkillTarget | undefined
        const toolId = stringParam(params, 'toolId')
        const skills = await market.searchSkills({
          q,
          ...(target === undefined ? {} : { target }),
          ...(toolId === undefined ? {} : { toolId }),
        })
        const payload: LegCResponse<'plugins/skills.search'> = { skills }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/skills.profile': {
        const id = stringParam(params, 'id')
        if (id === undefined) {
          sendApi(res, err('bad-request', 'id is required'))
          return
        }
        const skill = await market.skillProfile(id)
        const payload: LegCResponse<'plugins/skills.profile'> = { skill }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/skills.download': {
        // D7 mode 1: host-gated (it writes the room workspace + records a commit).
        const id = stringParam(params, 'id')
        const roomId = stringParam(params, 'roomId')
        if (id === undefined || roomId === undefined) {
          sendApi(res, err('bad-request', 'id and roomId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not import a skill; host seat required`))
          return
        }
        const result = await downloadSkillToRoom({ roomId, market, workspace: workflowStore }, id, principal.userId)
        if (!result.ok) {
          if (result.reason === 'blocked') {
            sendApi(res, err('forbidden', `skill "${id}" is blocked (red) and cannot be imported`))
            return
          }
          if (result.reason === 'path-escape') {
            sendApi(res, err('bad-request', `skill "${id}" resolved to an unsafe workspace path`))
            return
          }
          sendApi(res, err('not-found', `skill "${id}" was not found or its source is unavailable`))
          return
        }
        const payload: LegCResponse<'plugins/skills.download'> = {
          download: { path: result.path, body: result.body, profile: result.profile },
        }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/skills.flag': {
        const id = stringParam(params, 'id')
        const level = stringParam(params, 'level')
        const reason = stringParam(params, 'reason')
        if (id === undefined || level === undefined || reason === undefined) {
          sendApi(res, err('bad-request', 'id, level, and reason are required'))
          return
        }
        if (level !== 'clean' && level !== 'yellow' && level !== 'orange' && level !== 'red') {
          sendApi(res, err('bad-request', `unknown warning level "${level}"`))
          return
        }
        const warningLevel = await market.flagSkill(id, level, reason, principal.userId)
        const payload: LegCResponse<'plugins/skills.flag'> = { warningLevel }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/sources.status': {
        const sources = await market.sourcesStatus()
        const payload: LegCResponse<'plugins/sources.status'> = { sources }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/skills.run': {
        // D9a: host-gated (it writes run artifacts into the room workspace).
        const id = stringParam(params, 'id')
        const roomId = stringParam(params, 'roomId')
        if (id === undefined || roomId === undefined) {
          sendApi(res, err('bad-request', 'id and roomId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not run a skill; host seat required`))
          return
        }
        const rawArgs = params['args']
        const args = typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {}
        const result = await executeSkillToRoom({ roomId, runner: market, workspace: workflowStore }, id, args)
        if (!result.ok) {
          if (result.reason === 'path-escape') {
            sendApi(res, err('bad-request', `skill "${id}" produced an unsafe artifact path`))
            return
          }
          // consent-required / blocked / not-found / not-executable are typed
          // outcomes, not transport errors: the client switches on `status`.
          const refused: LegCResponse<'plugins/skills.run'> = { run: null, status: result.reason }
          sendApi(res, ok(refused))
          return
        }
        const payload: LegCResponse<'plugins/skills.run'> = {
          run: { content: result.content, artifacts: result.artifacts, warningLevel: result.warningLevel },
          status: 'ok',
        }
        sendApi(res, ok(payload))
        return
      }
      case 'plugins/skills.consent': {
        // D9: a server-GLOBAL write (like skills.flag) — authenticated-only.
        const id = stringParam(params, 'id')
        const granted = params['granted']
        if (id === undefined || typeof granted !== 'boolean') {
          sendApi(res, err('bad-request', 'id and a boolean granted are required'))
          return
        }
        const consented = await market.setSkillConsent(id, granted, principal.userId)
        const payload: LegCResponse<'plugins/skills.consent'> = { consented }
        sendApi(res, ok(payload))
        return
      }
      default:
        sendApi(res, err('unimplemented', `${method} is not implemented`))
        return
    }
  }

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

    // The `plugins/*` namespace (Phase-7 D5) is served by a dedicated handler so
    // the marketplace bridge is narrowed to defined ONCE here rather than in
    // every case. When it is absent the whole namespace answers `unimplemented`.
    if (method.startsWith('plugins/')) {
      if (movieMarket === undefined) {
        sendApi(res, err('unimplemented', 'the plugins marketplace is not available on this host'))
        return
      }
      await handlePlugins(method, params, principal, res, movieMarket)
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
      case 'cache/get': {
        // Cache cards: any room seat (host|member) may read; a non-member is
        // refused fail-closed, mirroring the workflow/get policy.
        const roomId = stringParam(params, 'roomId')
        const nodeId = stringParam(params, 'nodeId')
        if (roomId === undefined || nodeId === undefined) {
          sendApi(res, err('bad-request', 'roomId and nodeId are required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role === 'none') {
          sendApi(res, err('forbidden', 'role "none" may not read the cache; room membership required'))
          return
        }
        const payload: LegCResponse<'cache/get'> = { cards: workflowStore.getCacheCards(roomId, nodeId) }
        sendApi(res, ok(payload))
        return
      }
      case 'cache/reorder': {
        // Mutations are host-only, mirroring workflow/put.
        const roomId = stringParam(params, 'roomId')
        const nodeId = stringParam(params, 'nodeId')
        if (roomId === undefined || nodeId === undefined) {
          sendApi(res, err('bad-request', 'roomId and nodeId are required'))
          return
        }
        const rawOrder = params['order']
        if (!Array.isArray(rawOrder) || rawOrder.some((entry): boolean => typeof entry !== 'number' || !Number.isFinite(entry))) {
          sendApi(res, err('bad-request', 'order must be an array of seq numbers'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not reorder the cache; host seat required`))
          return
        }
        const order = rawOrder as number[]
        const payload: LegCResponse<'cache/reorder'> = { cards: workflowStore.reorderCacheCards(roomId, nodeId, order) }
        sendApi(res, ok(payload))
        return
      }
      case 'cache/delete': {
        const roomId = stringParam(params, 'roomId')
        const nodeId = stringParam(params, 'nodeId')
        if (roomId === undefined || nodeId === undefined) {
          sendApi(res, err('bad-request', 'roomId and nodeId are required'))
          return
        }
        const rawSeq = params['seq']
        if (typeof rawSeq !== 'number' || !Number.isFinite(rawSeq)) {
          sendApi(res, err('bad-request', 'seq is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not delete from the cache; host seat required`))
          return
        }
        const payload: LegCResponse<'cache/delete'> = { cards: workflowStore.deleteCacheCard(roomId, nodeId, rawSeq) }
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
    // P8-M6: the submitting exec client's id (matches its `/ws?clientId=`),
    // used to cancel this job if that client disconnects before it settles.
    let clientId = ''
    try {
      const params = await readParams(req)
      const raw = params['prompt']
      if (typeof raw !== 'object' || raw === null) {
        sendRaw(res, 400, { error: 'bad-request', message: 'prompt graph is required' })
        return
      }
      prompt = raw as PromptGraph
      roomId = stringParam(params, 'room_id') ?? stringParam(params, 'roomId') ?? ''
      clientId = stringParam(params, 'client_id') ?? stringParam(params, 'clientId') ?? ''
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

    // P8-M5: pre-run health gate (fail-closed). A throwing probe rejects the
    // submit with 503 rather than queueing work onto an unready GPU backend.
    if (beforeRun !== undefined) {
      try {
        await beforeRun()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[movie-gateway] /prompt refused by pre-run gate: %s', message)
        sendRaw(res, 503, { error: 'backend-unready', message })
        return
      }
    }

    // Phase-7 D7 mode-2: arm the run-time skill remedy only when a marketplace
    // bridge is wired AND the run carries a room (the skill files live in the
    // room's workspace dir). The closure re-fetches any missing imported skill
    // before its node executes; a stopped tool simply runs skill-less (R3).
    const resolveSkills = movieMarket !== undefined && roomId !== ''
      ? (node: PromptGraphNode): Promise<{ section: string; notes: string[] }> =>
          resolveNodeSkills({ roomId, market: movieMarket, workspace: workflowStore }, node)
      : undefined

    // Phase-7 D9b: arm the director-agent execution trigger under the same guard
    // (a market bridge + a room to write artifacts into). Each node's executable
    // imported skills are run (gated by warning level inside the market) before
    // the node executes; a skipped skill yields a note, never a failure (R3).
    const executeSkills = movieMarket !== undefined && roomId !== ''
      ? (node: PromptGraphNode): Promise<{ section: string; notes: string[] }> =>
          executeNodeSkills({ roomId, runner: movieMarket, workspace: workflowStore }, node)
      : undefined

    if (jobs !== undefined) {
      try {
        const jobId = startPromptJob({
          jobs,
          broadcast: broadcastExec,
          mediaProvider: mediaProvider ?? cannedMediaProvider,
          ...(stepText === undefined ? {} : { stepText }),
          ...(resolveSkills === undefined ? {} : { resolveSkills }),
          ...(executeSkills === undefined ? {} : { executeSkills }),
          availability: executorAvailability,
          ...(roomId === '' ? {} : { roomId }),
          cache: workflowStore,
          notifier,
          logger,
          promptId,
          number,
          label: `movie-exec prompt ${number}`,
        }, prompt, sorted.order)
        // P8-M6: bind the job to its submitting client so a disconnect cancels it.
        trackClientJob(clientId, jobId)
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

  execWs.on('connection', (socket: WebSocket, req?: IncomingMessage) => {
    execClients.add(socket)
    // P8-M6: bind this socket to its clientId so its jobs die with it.
    const clientId = execClientIdFromReq(req)
    if (clientId !== '') execClientIds.set(socket, clientId)
    const detach = (): void => {
      execClients.delete(socket)
      const cid = execClientIds.get(socket)
      execClientIds.delete(socket)
      if (cid !== undefined) cancelClientJobs(cid, 'exec client disconnected')
    }
    socket.on('close', detach)
    socket.on('error', detach)
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
      unsubscribeRoomMessages?.()
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
