/**
 * Host-owned workspace graph + version history (Phase-3 P3-M5).
 *
 * The browser half of the file-backed per-room workspace. It replaces the old
 * "autosave every edit through `workflow/put`" model with the host-exclusive
 * draft/commit flow:
 *
 *  - the HOST autosaves its uncommitted working copy to the server-side draft
 *    (`workspace/draft.put`, debounced), with server-side undo/redo stacks;
 *  - the HOST commits (`workspace/commit`) to append a full snapshot to the
 *    room's history, and may `revert(rev)` (a forward commit restoring an old
 *    snapshot);
 *  - VIEWERS (non-hosts) are read-only and converge live: every `committed` /
 *    `reverted` / `snapshot` frame from {@link useRoomRole}'s `workflow/watch`
 *    subscription that was authored by someone else is applied to the canvas.
 *
 * Read-only enforcement is role-driven: `bridge.setReadonly(!isHost)` is
 * re-asserted whenever the host seat changes. Programmatic canvas loads run
 * inside a suppress guard so they never re-trigger the host's autosave.
 */

import { onScopeDispose, ref, watch, type Ref } from "vue";
import { LegCError, RpcClient } from "@dsh-movie/sdk";
import type { CommitMeta, WorkflowGraph, WorkflowRecord } from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";
import type { CanvasBridge } from "@/composables/useCanvasBridge";
import type { RoomRoleHandle } from "@/composables/useRoomRole";

/** One committed revision + its full graph snapshot (from `history.get`). */
export interface HistoryEntry {
  commit: CommitMeta;
  graph: WorkflowGraph;
}

/** The handle returned by {@link useWorkspaceGraph}. */
export interface WorkspaceGraphHandle {
  /** The committed HEAD revision this client last saw (0 = nothing committed). */
  rev: Ref<number>;
  /** True when a distinct uncommitted host draft exists. */
  hasDraft: Ref<boolean>;
  /** Server-side undo steps available for the host draft. */
  undoDepth: Ref<number>;
  /** Server-side redo steps available for the host draft. */
  redoDepth: Ref<number>;
  /** The room's committed history index (oldest first). */
  commits: Ref<CommitMeta[]>;
  /** True while a workspace round-trip is in flight. */
  busy: Ref<boolean>;
  /** The last surfaced error message, or `null`. */
  lastError: Ref<string | null>;
  /** Enter the autosave-suppress guard (used around programmatic loads). */
  beginSuppress(): void;
  /** Leave the autosave-suppress guard after a short tail. */
  endSuppress(delayMs?: number): void;
  /** Load a graph into the canvas under the suppress guard. */
  applyGraph(graph: WorkflowGraph): Promise<void>;
  /** Host-only debounced draft autosave (no-op for viewers / while suppressed). */
  autosave(graph: WorkflowGraph): void;
  /** Host-only server-side undo; applies the resulting draft to the canvas. */
  undo(): Promise<void>;
  /** Host-only server-side redo; applies the resulting draft to the canvas. */
  redo(): Promise<void>;
  /** Host-only commit of the current draft; returns the new HEAD record. */
  commit(message: string): Promise<WorkflowRecord | null>;
  /** Host-only forward-commit restoring `rev`; applies it to the canvas. */
  revert(rev: number, message?: string): Promise<WorkflowRecord | null>;
  /** Refresh the committed history index. */
  loadHistory(): Promise<void>;
  /** Read one committed revision's metadata + full graph. */
  getCommit(rev: number): Promise<HistoryEntry | null>;
  /** Load the canvas graph from the server (host draft, else committed HEAD). */
  hydrate(): Promise<WorkflowGraph | null>;
  /** Clear all tracked state (e.g. when switching rooms). */
  reset(): void;
}

/** Debounce for the host draft autosave (coalesces rapid `graphChanged`). */
const AUTOSAVE_DEBOUNCE_MS = 500;
/** Tail kept on the suppress guard to cover the iframe's 400ms debounce echo. */
const SUPPRESS_TAIL_MS = 600;

/** Turn an unknown throw into a short human-readable message. */
function describeError(error: unknown): string {
  if (error instanceof LegCError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create a workspace-graph handle bound to a room, canvas bridge, and role.
 * @param roomId - the active room (empty string disables server round-trips).
 * @param bridge - the canvas bridge driving the live iframe.
 * @param role - the room-role handle owning the `workflow/watch` subscription.
 * @returns the {@link WorkspaceGraphHandle}; timers clear on scope dispose.
 */
export function useWorkspaceGraph(
  roomId: Ref<string>,
  bridge: CanvasBridge,
  role: RoomRoleHandle,
): WorkspaceGraphHandle {
  const auth = useAuthStore();
  const rpc = new RpcClient(sdkConfig, { getToken: () => auth.session?.accessToken ?? null });

  const rev = ref(0);
  const hasDraft = ref(false);
  const undoDepth = ref(0);
  const redoDepth = ref(0);
  const commits = ref<CommitMeta[]>([]);
  const busy = ref(false);
  const lastError = ref<string | null>(null);

  let suppress = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  function selfId(): string {
    return auth.session?.userId ?? "";
  }

  function beginSuppress(): void {
    suppress = true;
    if (suppressTimer !== null) { clearTimeout(suppressTimer); suppressTimer = null; }
  }

  function endSuppress(delayMs = SUPPRESS_TAIL_MS): void {
    if (suppressTimer !== null) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppress = false; suppressTimer = null; }, delayMs);
  }

  async function applyGraph(graph: WorkflowGraph): Promise<void> {
    beginSuppress();
    try {
      await bridge.loadWorkflow(graph);
    } finally {
      endSuppress();
    }
  }

  /** Fold a `DraftState` response into the tracked depths. */
  function applyDraftState(state: { hasDraft: boolean; undoDepth: number; redoDepth: number }): void {
    hasDraft.value = state.hasDraft;
    undoDepth.value = state.undoDepth;
    redoDepth.value = state.redoDepth;
  }

  async function putDraft(graph: WorkflowGraph): Promise<void> {
    const id = roomId.value;
    if (id === "" || !role.isHost.value) return;
    try {
      const res = await rpc.call("workspace/draft.put", { roomId: id, graph });
      applyDraftState(res);
      lastError.value = null;
    } catch (caught) {
      lastError.value = describeError(caught);
    }
  }

  function autosave(graph: WorkflowGraph): void {
    if (suppress || !role.isHost.value) return;
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { autosaveTimer = null; void putDraft(graph); }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Re-read the draft depths from the server (after commit/revert clear it). */
  async function syncDraftState(): Promise<void> {
    const id = roomId.value;
    if (id === "") return;
    try {
      const res = await rpc.call("workspace/draft.get", { roomId: id });
      applyDraftState(res);
    } catch {
      // Depth sync is best-effort; a failure leaves the last known depths.
    }
  }

  async function loadHistory(): Promise<void> {
    const id = roomId.value;
    if (id === "") { commits.value = []; return; }
    busy.value = true;
    try {
      const res = await rpc.call("workspace/history.list", { roomId: id });
      commits.value = res.commits;
      lastError.value = null;
    } catch (caught) {
      lastError.value = describeError(caught);
    } finally {
      busy.value = false;
    }
  }

  async function getCommit(targetRev: number): Promise<HistoryEntry | null> {
    const id = roomId.value;
    if (id === "") return null;
    try {
      const res = await rpc.call("workspace/history.get", { roomId: id, rev: targetRev });
      lastError.value = null;
      return { commit: res.commit, graph: res.graph };
    } catch (caught) {
      lastError.value = describeError(caught);
      return null;
    }
  }

  async function undo(): Promise<void> {
    const id = roomId.value;
    if (id === "" || !role.isHost.value) return;
    try {
      const res = await rpc.call("workspace/undo", { roomId: id });
      applyDraftState(res);
      await applyGraph(res.graph);
      lastError.value = null;
    } catch (caught) {
      lastError.value = describeError(caught);
    }
  }

  async function redo(): Promise<void> {
    const id = roomId.value;
    if (id === "" || !role.isHost.value) return;
    try {
      const res = await rpc.call("workspace/redo", { roomId: id });
      applyDraftState(res);
      await applyGraph(res.graph);
      lastError.value = null;
    } catch (caught) {
      lastError.value = describeError(caught);
    }
  }

  async function commit(message: string): Promise<WorkflowRecord | null> {
    const id = roomId.value;
    if (id === "" || !role.isHost.value) return null;
    busy.value = true;
    try {
      const res = await rpc.call("workspace/commit", { roomId: id, message });
      rev.value = res.workflow.rev;
      hasDraft.value = false;
      await syncDraftState();
      void loadHistory();
      lastError.value = null;
      return res.workflow;
    } catch (caught) {
      lastError.value = describeError(caught);
      return null;
    } finally {
      busy.value = false;
    }
  }

  async function revert(targetRev: number, message?: string): Promise<WorkflowRecord | null> {
    const id = roomId.value;
    if (id === "" || !role.isHost.value) return null;
    busy.value = true;
    try {
      const res = await rpc.call("workspace/revert", { roomId: id, rev: targetRev, message });
      rev.value = res.workflow.rev;
      await applyGraph(res.workflow.graph);
      await syncDraftState();
      void loadHistory();
      lastError.value = null;
      return res.workflow;
    } catch (caught) {
      lastError.value = describeError(caught);
      return null;
    } finally {
      busy.value = false;
    }
  }

  async function hydrate(): Promise<WorkflowGraph | null> {
    const id = roomId.value;
    if (id === "") return null;
    busy.value = true;
    try {
      // Always anchor the committed HEAD revision + history index first, for BOTH
      // seats. `reset()` runs just before hydrate() (studio canvas-ready path) and
      // the `workflow/watch` snapshot frame can arrive BEFORE the iframe is ready,
      // so relying on that frame alone leaves the host badge stuck at r0 and the
      // history panel empty. workflow/get is host+member readable.
      const head = await rpc.call("workflow/get", { roomId: id });
      rev.value = head.workflow?.rev ?? 0;
      void loadHistory();
      if (role.isHost.value) {
        // The host renders its uncommitted draft when one exists, else the HEAD;
        // an empty room (no draft, no HEAD) yields null so the studio seeds demo.
        const draft = await rpc.call("workspace/draft.get", { roomId: id });
        applyDraftState(draft);
        lastError.value = null;
        return draft.hasDraft ? draft.graph : (head.workflow?.graph ?? null);
      }
      lastError.value = null;
      return head.workflow?.graph ?? null;
    } catch (caught) {
      lastError.value = describeError(caught);
      return null;
    } finally {
      busy.value = false;
    }
  }

  function reset(): void {
    rev.value = 0;
    hasDraft.value = false;
    undoDepth.value = 0;
    redoDepth.value = 0;
    commits.value = [];
    lastError.value = null;
  }

  // Read-only is role-driven: viewers are locked, the host is editable.
  watch(
    () => role.isHost.value,
    (isHostNow) => { bridge.setReadonly(!isHostNow); },
    { immediate: true },
  );

  // Live convergence: apply remote writes; refresh depths/history on our own.
  role.onFrame((frame) => {
    if (frame.stage === "snapshot") {
      rev.value = frame.workflow?.rev ?? 0;
      if (!role.isHost.value && frame.workflow !== null) void applyGraph(frame.workflow.graph);
      void loadHistory();
      return;
    }
    if (frame.stage === "committed" || frame.stage === "reverted") {
      rev.value = frame.workflow.rev;
      if (frame.by !== selfId()) void applyGraph(frame.workflow.graph);
      void loadHistory();
      if (role.isHost.value) void syncDraftState();
    }
  });

  onScopeDispose(() => {
    if (suppressTimer !== null) clearTimeout(suppressTimer);
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    suppressTimer = null;
    autosaveTimer = null;
  });

  return {
    rev,
    hasDraft,
    undoDepth,
    redoDepth,
    commits,
    busy,
    lastError,
    beginSuppress,
    endSuppress,
    applyGraph,
    autosave,
    undo,
    redo,
    commit,
    revert,
    loadHistory,
    getCommit,
    hydrate,
    reset,
  };
}
