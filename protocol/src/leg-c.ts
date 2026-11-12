/**
 * Leg C contract: the direct browser-to-host RPC channel.
 *
 * Leg C carries everything Matrix chat and the ComfyUI execution channel do
 * not: agent control, asset repository CRUD, registry manifests, workspace
 * files, and quota. In Phase 1 we proved DSH's native Typert `@Remote` gateway
 * cannot be fed by an out-of-tree from-source plugin, so Leg C is served by a
 * plugin-owned HTTP + WS gateway that generalizes the Phase-1 `/auth` listener.
 *
 * Wire shape:
 * - Request/response: `POST /api/<namespace>/<method>` with a JSON params body,
 *   returning an {@link ApiResult} (tagged `ok`/`error`). Every call carries the
 *   caller's Matrix access token (Authorization header) which the host maps to a
 *   {@link Principal} via cached `whoami`.
 * - Streams: a multiplexed WebSocket at `/ws` carrying {@link StreamFrame}s,
 *   each tagged with a `stream` id so many logical streams share one socket.
 *
 * The namespace method maps below are the single source of truth shared by the
 * host gateway (which dispatches on `<ns>/<method>`) and the browser SDK (which
 * exposes one typed method per entry). Phase 2 M1 ships `auth`, `registry`, and
 * `assets` (the latter two as stubs); `agent`, `workspace`, and `quota` are
 * typed now and implemented later.
 *
 * @module @dsh-movie/protocol/leg-c
 */

import type { MatrixRoomId, MatrixUserId, Principal, RoomRole } from './principal.ts'
import type { WorkflowGraph } from './leg-b.ts'
import type { OpResult } from './op-script.ts'
import type { MoviePipelineStatus } from './movie.ts'
import type { CommitMeta, DraftState } from './workspace.ts'

/* -------------------------------------------------------------------------- */
/* Request / response envelope                                                 */
/* -------------------------------------------------------------------------- */

/** A successful API result carrying the method's response payload. */
export interface ApiOk<R> {
  ok: true
  result: R
}

/** A machine-readable error code used across Leg C. */
export type ApiErrorCode =
  | 'bad-request'
  | 'missing-token'
  | 'invalid-token'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'unimplemented'
  | 'internal'

/** A failed API result. */
export interface ApiError {
  ok: false
  error: { code: ApiErrorCode; message: string }
}

/** The response envelope returned by every `POST /api/<ns>/<method>` call. */
export type ApiResult<R> = ApiOk<R> | ApiError

/**
 * Narrow an unknown response body to a successful {@link ApiOk} result.
 * @param value - the parsed response body.
 * @returns true when the body is an `ok` result.
 */
export function isApiOk<R>(value: ApiResult<R>): value is ApiOk<R> {
  return value.ok === true
}

/* -------------------------------------------------------------------------- */
/* WebSocket stream mux                                                        */
/* -------------------------------------------------------------------------- */

/** A frame on the multiplexed `/ws` stream socket. */
export interface StreamFrame {
  /** Logical stream id this frame belongs to. */
  stream: string
  /** Frame kind: payload, normal end, or terminal error. */
  type: 'data' | 'end' | 'error'
  /** Frame payload (`data`), or an error descriptor (`error`). */
  payload?: unknown
}

/** Client -> server control message to open a stream on the mux. */
export interface StreamOpen {
  /** Request to subscribe to a named stream. */
  op: 'open'
  /** Logical stream id chosen by the client. */
  stream: string
  /** The server channel to open, e.g. `leg-b/exec` or `agent/events`. */
  channel: string
  /** Optional channel parameters (e.g. `{ roomId }`). */
  params?: Record<string, unknown>
}

/** Client -> server control message to close a stream on the mux. */
export interface StreamClose {
  /** Request to unsubscribe from a stream. */
  op: 'close'
  /** Logical stream id to close. */
  stream: string
}

/** Any client -> server control message on the mux. */
export type StreamControl = StreamOpen | StreamClose

/* -------------------------------------------------------------------------- */
/* Namespace method contracts                                                  */
/* -------------------------------------------------------------------------- */

/** A method contract: its request params and its response payload. */
export interface Method<Req, Res> {
  req: Req
  res: Res
}

/** `auth.*` - principal introspection and room-role resolution. */
export interface AuthNamespace {
  'auth/principal': Method<{ token: string }, { principal: Principal; principalId: string }>
  'auth/role': Method<{ token: string; roomId: MatrixRoomId }, { role: RoomRole }>
}

/** A registry manifest entry (node/tool/plugin descriptors for the canvas). */
export interface RegistryEntry {
  /** Stable entry id. */
  id: string
  /** Human-readable label. */
  name: string
  /** Entry category, e.g. `node`, `tool`, `model`. */
  kind: string
  /** Schema/version for the entry payload. */
  version: string
  /** The entry descriptor (ComfyUI `/object_info`-style for nodes). */
  data: Record<string, unknown>
}

/** `registry.*` - read-only manifests the canvas/agent surface consumes. */
export interface RegistryNamespace {
  'registry/list': Method<{ kind?: string }, { entries: RegistryEntry[] }>
  'registry/get': Method<{ id: string }, { entry: RegistryEntry | null }>
}

/** An asset-repository record (media/artifacts with lineage). */
export interface AssetRecord {
  /** Stable asset id. */
  id: string
  /** Owning room, when the asset is room-scoped. */
  roomId: MatrixRoomId | null
  /** Asset media kind. */
  kind: 'image' | 'video' | 'audio' | 'file'
  /** `mxc://` uri or an https URL. */
  uri: string
  /** Display label / filename. */
  name: string
  /** Producing principal, when known. */
  createdBy: MatrixUserId | null
  /** Creation timestamp (epoch ms). */
  createdAt: number
  /** Free-form lineage/provenance metadata. */
  meta: Record<string, unknown>
}

/** `assets.*` - asset repository CRUD (Phase 2 M1 ships read stubs). */
export interface AssetsNamespace {
  'assets/list': Method<{ roomId?: MatrixRoomId }, { assets: AssetRecord[] }>
  'assets/get': Method<{ id: string }, { asset: AssetRecord | null }>
}

/**
 * A persisted workflow graph (Phase-2 M6): one room-scoped editor graph plus
 * its optimistic-concurrency revision and last-writer lineage. The host is the
 * authority; the browser saves/loads through `workflow/put` + `workflow/get`.
 */
export interface WorkflowRecord {
  /** Stable record id (currently the room id). */
  id: string
  /** The room this graph belongs to. */
  roomId: MatrixRoomId
  /** The serialized ComfyUI-style editor graph. */
  graph: WorkflowGraph
  /** Monotonic revision; a stale `baseRev` on put is rejected `conflict`. */
  rev: number
  /** Last-write timestamp (epoch ms). */
  updatedAt: number
  /** Last writer, when known. */
  updatedBy: MatrixUserId | null
}

/** `workflow.*` - the room-scoped workflow graph store (Phase-2 M6).
 *
 * P3-M5 makes the graph host-authoritative in the strict sense: `workflow/get`
 * reads the committed HEAD (any room seat), while `workflow/put` is the host-only
 * commit primitive (a non-host writer is refused `forbidden`). The richer draft /
 * undo-redo / history / revert surface lives in {@link WorkspaceNamespace}; live
 * convergence is pushed on the `workflow/watch` mux channel (see
 * `@dsh-movie/protocol/workspace` {@link WorkflowWatchFrame}).
 */
export interface WorkflowNamespace {
  'workflow/get': Method<{ roomId: MatrixRoomId }, { workflow: WorkflowRecord | null }>
  'workflow/put': Method<
    { roomId: MatrixRoomId; graph: WorkflowGraph; baseRev?: number | undefined },
    { workflow: WorkflowRecord }
  >
}

/**
 * `workspace.*` - the host-owned per-room workspace (Phase-3 P3-M5): an
 * uncommitted `draft` with a server-side undo/redo snapshot stack, plus an
 * append-only committed history of full-fledged graph snapshots (GitHub-style).
 *
 * Write operations (`draft.put`, `undo`, `redo`, `commit`, `revert`) are
 * host-only; reads (`draft.get`, `history.list`, `history.get`) are open to any
 * room seat. `commit` promotes the current draft (or an explicit graph) to a new
 * revision; `revert` is a FORWARD commit restoring an old snapshot.
 */
export interface WorkspaceNamespace {
  'workspace/draft.get': Method<{ roomId: MatrixRoomId }, DraftState>
  'workspace/draft.put': Method<{ roomId: MatrixRoomId; graph: WorkflowGraph }, DraftState>
  'workspace/undo': Method<{ roomId: MatrixRoomId }, DraftState>
  'workspace/redo': Method<{ roomId: MatrixRoomId }, DraftState>
  'workspace/commit': Method<
    { roomId: MatrixRoomId; message?: string | undefined },
    { workflow: WorkflowRecord }
  >
  'workspace/history.list': Method<{ roomId: MatrixRoomId }, { commits: CommitMeta[] }>
  'workspace/history.get': Method<{ roomId: MatrixRoomId; rev: number }, { commit: CommitMeta; graph: WorkflowGraph }>
  'workspace/revert': Method<
    { roomId: MatrixRoomId; rev: number; message?: string | undefined },
    { workflow: WorkflowRecord }
  >
  /** Per-room workspace file listing (typed stub; not yet implemented). */
  'workspace/list': Method<{ roomId: MatrixRoomId; path?: string }, { entries: string[] }>
}

/**
 * `room.*` - room-seat governance (Phase-3 P3-M5). `room/transferHost` lets the
 * current host hand the host seat to another member by editing the room's
 * `m.room.power_levels` (successor -> 100, prior host -> 50) using the caller's
 * own token; the gateway then broadcasts the new host on `workflow/watch`.
 */
export interface RoomNamespace {
  'room/transferHost': Method<{ roomId: MatrixRoomId; targetUserId: MatrixUserId }, { host: MatrixUserId }>
}

/**
 * `canvas.*` - the agent op-script channel (Phase-3 P3-M3). `canvas/script`
 * submits a natural-language intent; the server agent generates a validated
 * {@link CanvasScript} and streams it back on the `canvas/script` mux channel
 * (the POST only acknowledges acceptance with the transaction id). The client
 * executor applies it and reports per-op outcomes via `canvas/result`.
 *
 * P3-M4 adds the observe->re-plan loop: when a transaction did not commit (or
 * any op failed), `canvas/result` may carry a fresh `replanTxnId` for a
 * corrective script the client pulls on the same `canvas/script` mux channel;
 * `canvas/replan` lets the client request that corrective pass explicitly.
 */
export interface CanvasNamespace {
  'canvas/script': Method<{ roomId: MatrixRoomId; intent: string }, { txnId: string; accepted: boolean }>
  'canvas/result': Method<
    { roomId: MatrixRoomId; txnId: string; committed: boolean; opResults: OpResult[] },
    { accepted: boolean; replanTxnId?: string | undefined }
  >
  'canvas/replan': Method<{ roomId: MatrixRoomId; txnId: string }, { txnId: string; accepted: boolean }>
}

/**
 * `movie.*` - the six-step movie pipeline channel (Phase-3 P3-M4). `movie/run`
 * submits an intent; the director agent runs the script->shot-plan->asset->
 * storyboard->clip->assemble pipeline (real Bailian text for the text steps,
 * canned media for the rest) and streams step progress on the `movie/run` mux
 * channel. The POST only acknowledges acceptance with the run id; `movie/status`
 * reads the last {@link MoviePipelineStatus} for a run.
 */
export interface MovieNamespace {
  'movie/run': Method<{ roomId: MatrixRoomId; intent: string }, { runId: string; accepted: boolean }>
  'movie/status': Method<{ roomId: MatrixRoomId; runId: string }, { pipeline: MoviePipelineStatus | null }>
}

/** `agent.*` - steer/stop/approve a running room agent (typed now, impl later). */
export interface AgentNamespace {
  'agent/status': Method<{ roomId: MatrixRoomId }, { running: boolean; turn?: string }>
  'agent/stop': Method<{ roomId: MatrixRoomId }, { stopped: boolean }>
  'agent/steer': Method<{ roomId: MatrixRoomId; message: string }, { accepted: boolean }>
}

/** `quota.*` - usage/quota reporting (typed now, impl later). */
export interface QuotaNamespace {
  'quota/get': Method<{ userId?: MatrixUserId }, { used: number; limit: number }>
}

/** Every Leg C namespace method map, keyed by namespace. */
export interface LegCNamespaces extends AuthNamespace, RegistryNamespace, AssetsNamespace, WorkflowNamespace, WorkspaceNamespace, RoomNamespace, CanvasNamespace, MovieNamespace, AgentNamespace, QuotaNamespace {}

/** Every Leg C method name (`<namespace>/<method>`). */
export type LegCMethod = keyof LegCNamespaces

/** The request params type for a given Leg C method. */
export type LegCRequest<M extends LegCMethod> = LegCNamespaces[M]['req']

/** The response payload type for a given Leg C method. */
export type LegCResponse<M extends LegCMethod> = LegCNamespaces[M]['res']

/** The Leg C methods implemented by the Phase-2 M1 gateway (others are stubs). */
export const IMPLEMENTED_METHODS: readonly LegCMethod[] = [
  'auth/principal',
  'auth/role',
  'registry/list',
  'registry/get',
  'assets/list',
  'assets/get',
  'workflow/get',
  'workflow/put',
  'workspace/draft.get',
  'workspace/draft.put',
  'workspace/undo',
  'workspace/redo',
  'workspace/commit',
  'workspace/history.list',
  'workspace/history.get',
  'workspace/revert',
  'room/transferHost',
  'canvas/script',
  'canvas/result',
  'canvas/replan',
  'movie/run',
  'movie/status',
] as const

/**
 * Split a `POST /api/<ns>/<method>` path into its namespace and method parts.
 * @param path - the URL path (with or without a leading `/api/`).
 * @returns the method name `<ns>/<method>`, or `null` when the path is malformed.
 */
export function methodFromApiPath(path: string): LegCMethod | null {
  const trimmed = path.replace(/^\/+/, '')
  const withoutApi = trimmed.startsWith('api/') ? trimmed.slice(4) : trimmed
  const parts = withoutApi.split('/').filter((p): boolean => p !== '')
  if (parts.length < 2) return null
  const candidate = `${parts[0]}/${parts[1]}` as LegCMethod
  return candidate
}
