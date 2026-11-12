/**
 * Room-scoped committed-graph persistence over Leg C (Phase-2 M6, Phase-3 P3-M5).
 *
 * The DSH host is the graph authority: it keeps a file-backed per-room workspace
 * behind `workflow/get` (committed HEAD) + `workflow/put` (a host-only commit)
 * (see `server/plugins/dsh-movie-gateway/src/workspace-store.ts`). As of P3-M5
 * writes are host-exclusive and live convergence runs over the `workflow/watch`
 * mux channel (see `useRoomRole` / `useWorkspaceGraph`), so this composable is
 * now the narrow HEAD read + single atomic commit used by the AI op-script
 * executor (`useCanvasScript`) and the host's first-seed of an empty room.
 *
 * The caller's Matrix access token is read fresh per RPC from the auth store, so
 * a re-validated session propagates automatically (Leg C is stateless). The
 * optimistic-concurrency `conflict` path is retained for a stale host write.
 */

import { onScopeDispose, ref, type Ref } from "vue";
import { LegCError, RpcClient } from "@dsh-movie/sdk";
import type { WorkflowGraph, WorkflowRecord } from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";

/** Payload delivered to {@link WorkflowStoreHandle.onConflict} subscribers. */
export interface WorkflowConflictPayload {
  /** The room whose write was rejected. */
  roomId: string;
  /** The host's current record (the winning write) to resync against. */
  current: WorkflowRecord;
}

/** The persistence handle returned by {@link useWorkflowStore}. */
export interface WorkflowStoreHandle {
  /** The revision this client last saw from the host (0 = nothing loaded). */
  currentRev: Ref<number>;
  /** True while a `workflow/get` round-trip is in flight. */
  loading: Ref<boolean>;
  /** True while a `workflow/put` round-trip is in flight. */
  saving: Ref<boolean>;
  /** The last surfaced error message, or `null`. */
  lastError: Ref<string | null>;
  /** Fetch the persisted record for a room and resync {@link currentRev}. */
  load(roomId: string): Promise<WorkflowRecord | null>;
  /**
   * Persist a graph with optimistic concurrency.
   * @param roomId - the owning room.
   * @param graph - the serialized editor graph.
   * @param baseRev - the revision to assert; defaults to {@link currentRev} when
   *   non-zero (omitted entirely for the first write to an empty room).
   * @returns the host's new record on success.
   * @throws {LegCError} on `conflict` (after resync + notifying subscribers) or
   *   any other gateway error.
   */
  save(roomId: string, graph: WorkflowGraph, baseRev?: number): Promise<WorkflowRecord>;
  /** Subscribe to write conflicts (the host rejected a stale `baseRev`). */
  onConflict(cb: (payload: WorkflowConflictPayload) => void): void;
  /** Forget the loaded revision/error (e.g. when switching rooms). */
  reset(): void;
}

/** Turn an unknown throw into a short human-readable message. */
function describeError(error: unknown): string {
  if (error instanceof LegCError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create a Leg C workflow-persistence handle bound to the auth store.
 * @returns the {@link WorkflowStoreHandle}; no listeners outlive the scope.
 */
export function useWorkflowStore(): WorkflowStoreHandle {
  const auth = useAuthStore();
  const rpc = new RpcClient(sdkConfig, {
    getToken: () => auth.session?.accessToken ?? null,
  });

  const currentRev = ref(0);
  const loading = ref(false);
  const saving = ref(false);
  const lastError = ref<string | null>(null);
  const conflictHandlers: Array<(payload: WorkflowConflictPayload) => void> = [];

  async function load(roomId: string): Promise<WorkflowRecord | null> {
    loading.value = true;
    try {
      const res = await rpc.call("workflow/get", { roomId });
      currentRev.value = res.workflow?.rev ?? 0;
      lastError.value = null;
      return res.workflow;
    } catch (error) {
      lastError.value = describeError(error);
      throw error;
    } finally {
      loading.value = false;
    }
  }

  async function save(roomId: string, graph: WorkflowGraph, baseRev?: number): Promise<WorkflowRecord> {
    saving.value = true;
    // First write to an empty room: omit baseRev so the host seeds rev 1.
    const asserted = baseRev ?? (currentRev.value > 0 ? currentRev.value : undefined);
    try {
      const res = await rpc.call("workflow/put", { roomId, graph, baseRev: asserted });
      currentRev.value = res.workflow.rev;
      lastError.value = null;
      return res.workflow;
    } catch (error) {
      if (error instanceof LegCError && error.code === "conflict") {
        // Someone else wrote first: resync the revision and let the caller react.
        try {
          const resync = await rpc.call("workflow/get", { roomId });
          const current = resync.workflow;
          if (current !== null) {
            currentRev.value = current.rev;
            for (const handler of conflictHandlers) handler({ roomId, current });
          }
        } catch {
          // A failed resync must not mask the original conflict error.
        }
      }
      lastError.value = describeError(error);
      throw error;
    } finally {
      saving.value = false;
    }
  }

  function reset(): void {
    currentRev.value = 0;
    lastError.value = null;
  }

  onScopeDispose(() => {
    conflictHandlers.length = 0;
  });

  return {
    currentRev,
    loading,
    saving,
    lastError,
    load,
    save,
    onConflict: (cb) => {
      conflictHandlers.push(cb);
    },
    reset,
  };
}
