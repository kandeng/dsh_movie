/**
 * Workspace + version-history contracts (Phase-3 P3-M5).
 *
 * P3-M5 reshapes canvas collaboration around a host-exclusive write model with
 * a file-backed per-room workspace on the DSH host:
 *
 *  - The room `host` (whoever holds the top Matrix power level; see
 *    `matrix-identity`) is the ONLY seat that may mutate the graph. Members are
 *    read-only viewers who converge live via the `workflow/watch` mux channel.
 *  - The host's UNCOMMITTED working copy is the `draft`, autosaved server-side
 *    with an undo/redo snapshot stack (view-state per room, host-scoped).
 *  - Each COMMIT appends an immutable, full-fledged snapshot of the graph to an
 *    append-only history (GitHub-style). `revert` is a FORWARD commit that
 *    restores an old snapshot (history is never rewritten). There is no diff
 *    view; every version is a whole graph file.
 *
 * These are pure contract types shared by the gateway (which serves them) and
 * the browser client (which renders them); no runtime logic lives here beyond
 * tiny guards.
 *
 * @module @dsh-movie/protocol/workspace
 */

import type { MatrixRoomId, MatrixUserId, RoomRole } from './principal.ts'
import type { WorkflowGraph } from './leg-b.ts'
import type { WorkflowRecord } from './leg-c.ts'

/**
 * Metadata for one committed revision in a room's append-only history. The
 * graph itself lives in a full snapshot file (`history/<rev>.json`) on the host;
 * `file` is the host-relative path of that snapshot (informational).
 */
export interface CommitMeta {
  /** Monotonic revision number (1-based; HEAD is the largest). */
  rev: number
  /** The principal that created this commit, when known. */
  author: MatrixUserId | null
  /** Commit timestamp (epoch ms). */
  timestamp: number
  /** Human-supplied commit message (may be empty). */
  message: string
  /** Host-relative path of the full snapshot file for this revision. */
  file: string
}

/** The shape returned by draft/undo/redo operations: the working graph + stack depths. */
export interface DraftState {
  /** The current uncommitted working graph (or the committed HEAD when no draft exists). */
  graph: WorkflowGraph
  /** True when a distinct uncommitted draft exists (false = draft equals HEAD). */
  hasDraft: boolean
  /** Number of undo steps available. */
  undoDepth: number
  /** Number of redo steps available. */
  redoDepth: number
}

/* -------------------------------------------------------------------------- */
/* `workflow/watch` mux frames (live multi-user convergence)                    */
/* -------------------------------------------------------------------------- */

/**
 * Frames streamed on the `workflow/watch` mux channel. A subscriber receives a
 * `snapshot` on attach (the committed HEAD plus its resolved role/host), then a
 * `committed` / `reverted` frame on every host write, and a `role` frame when
 * the host seat transfers. Members apply HEAD via `graph.load` and stay
 * read-only; the host's own echo is suppressed client-side by matching `by`.
 */
export type WorkflowWatchFrame =
  | { stage: 'snapshot'; workflow: WorkflowRecord | null; role: RoomRole; host: MatrixUserId | null }
  | { stage: 'committed'; workflow: WorkflowRecord; by: MatrixUserId | null }
  | { stage: 'reverted'; workflow: WorkflowRecord; by: MatrixUserId | null; fromRev: number }
  | { stage: 'role'; host: MatrixUserId | null; role: RoomRole }

/**
 * Narrow an unknown mux frame to a {@link WorkflowWatchFrame}.
 * @param value - the parsed frame payload.
 * @returns true when the payload carries a known `stage` discriminator.
 */
export function isWorkflowWatchFrame(value: unknown): value is WorkflowWatchFrame {
  if (typeof value !== 'object' || value === null) return false
  const stage = (value as { stage?: unknown }).stage
  return stage === 'snapshot' || stage === 'committed' || stage === 'reverted' || stage === 'role'
}

/** The room id a workspace operation targets (alias for readability). */
export type WorkspaceRoomId = MatrixRoomId
