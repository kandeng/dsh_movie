/**
 * The host-authoritative in-memory workflow store (Phase-2 M6).
 *
 * One room-scoped {@link WorkflowRecord} per room, kept in a `Map` for the life
 * of the gateway process. It is deliberately volatile: the DSH host runs no
 * database for the prototype, so the graph survives across clients (and page
 * reloads) but resets on a gateway restart. Durable persistence and Matrix
 * room-state consensus are deferred to Phase 3.
 *
 * Writes use optimistic concurrency: a caller passes the `rev` it last saw as
 * `baseRev`; a mismatch means someone else wrote in between, so the store
 * refuses with a `conflict` result carrying the current record for resync.
 *
 * @module dsh-movie-gateway/workflow-store
 */

import type { MatrixUserId, WorkflowGraph, WorkflowRecord } from '@dsh-movie/protocol'

/** The outcome of a {@link WorkflowStore.put}. */
export type WorkflowPutResult =
  | { ok: true; record: WorkflowRecord }
  | { ok: false; reason: 'conflict'; current: WorkflowRecord }

/** The room-scoped workflow graph store. */
export interface WorkflowStore {
  /** Return the stored record for a room, or `null` when none exists. */
  get(roomId: string): WorkflowRecord | null
  /**
   * Persist a graph for a room, bumping its revision.
   * @param roomId - the owning room.
   * @param graph - the serialized editor graph.
   * @param updatedBy - the writing principal's Matrix user id.
   * @param baseRev - the revision the caller last saw (optimistic concurrency).
   * @returns the new record, or a `conflict` carrying the current record.
   */
  put(roomId: string, graph: WorkflowGraph, updatedBy: MatrixUserId | null, baseRev: number | undefined): WorkflowPutResult
}

/**
 * Create a fresh in-memory workflow store.
 * @returns a store backed by a per-process `Map`.
 */
export function createWorkflowStore(): WorkflowStore {
  const records = new Map<string, WorkflowRecord>()
  return {
    get(roomId: string): WorkflowRecord | null {
      return records.get(roomId) ?? null
    },
    put(roomId: string, graph: WorkflowGraph, updatedBy: MatrixUserId | null, baseRev: number | undefined): WorkflowPutResult {
      const current = records.get(roomId)
      const currentRev = current?.rev ?? 0
      if (baseRev !== undefined && baseRev !== currentRev && current !== undefined) {
        return { ok: false, reason: 'conflict', current }
      }
      const record: WorkflowRecord = {
        id: roomId,
        roomId,
        graph,
        rev: currentRev + 1,
        updatedAt: Date.now(),
        updatedBy,
      }
      records.set(roomId, record)
      return { ok: true, record }
    },
  }
}
