/**
 * Room role + live convergence subscription (Phase-3 P3-M5).
 *
 * The browser half of the host-exclusive collaboration model. It resolves the
 * caller's {@link RoomRole} for the active room (Leg C `auth/role`) and opens a
 * single `workflow/watch` mux subscription that:
 *
 *  1. delivers an initial `{stage:'snapshot'}` frame (committed HEAD + the
 *     caller's resolved role/host) on attach;
 *  2. fans out `{stage:'committed'}` / `{stage:'reverted'}` frames on every host
 *     write so viewers converge live;
 *  3. fans out a `{stage:'role'}` frame when the host seat transfers, refreshing
 *     `role` / `isHost` / `host` in place.
 *
 * The composable owns the socket; downstream consumers (e.g. the workspace-graph
 * composable) register via {@link RoomRoleHandle.onFrame} rather than opening a
 * second subscription. The room id is reactive: switching rooms closes the old
 * stream and re-subscribes.
 */

import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue";
import { LegCError, MuxSocket, RpcClient, type MuxStream } from "@dsh-movie/sdk";
import {
  isWorkflowWatchFrame,
  type MatrixUserId,
  type RoomRole,
  type WorkflowWatchFrame,
} from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";

/** The handle returned by {@link useRoomRole}. */
export interface RoomRoleHandle {
  /** The caller's resolved role in the active room. */
  role: Ref<RoomRole>;
  /** True when the caller currently holds the host seat. */
  isHost: ComputedRef<boolean>;
  /** The mxid of the current host, or `null` when unresolved. */
  host: Ref<MatrixUserId | null>;
  /** True while the `workflow/watch` stream is attached. */
  watching: Ref<boolean>;
  /** The last surfaced error message, or `null`. */
  error: Ref<string | null>;
  /** Register a handler for every watch frame (snapshot/committed/reverted/role). */
  onFrame(cb: (frame: WorkflowWatchFrame) => void): void;
  /** Re-resolve the role + host for the current room (e.g. after a transfer). */
  refresh(): Promise<void>;
  /**
   * Transfer the host seat to `targetUserId` (host-only). The gateway edits the
   * room's power levels and broadcasts a `{stage:'role'}` frame, which refreshes
   * `role` / `host` here automatically.
   * @returns true when the homeserver accepted the transfer.
   */
  transferHost(targetUserId: MatrixUserId): Promise<boolean>;
}

/** Turn an unknown throw into a short human-readable message. */
function describeError(error: unknown): string {
  if (error instanceof LegCError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create a room-role + watch handle bound to a reactive room id.
 * @param roomId - the active room (empty string disables the subscription).
 * @returns the {@link RoomRoleHandle}; the mux socket closes on scope dispose.
 */
export function useRoomRole(roomId: Ref<string>): RoomRoleHandle {
  const auth = useAuthStore();
  const getToken = (): string | null => auth.session?.accessToken ?? null;

  const rpc = new RpcClient(sdkConfig, { getToken });
  const mux = new MuxSocket(sdkConfig, { reconnect: true });

  const role = ref<RoomRole>("none");
  const host = ref<MatrixUserId | null>(null);
  const watching = ref(false);
  const error = ref<string | null>(null);
  const isHost = computed((): boolean => role.value === "host");

  const frameHandlers: Array<(frame: WorkflowWatchFrame) => void> = [];
  let stream: MuxStream | null = null;

  function emit(frame: WorkflowWatchFrame): void {
    for (const handler of frameHandlers) handler(frame);
  }

  /** Resolve the role over RPC (used before the watch snapshot lands). */
  async function resolveRole(id: string): Promise<void> {
    if (id === "") {
      role.value = "none";
      host.value = null;
      return;
    }
    try {
      const res = await rpc.call("auth/role", { token: getToken() ?? "", roomId: id });
      role.value = res.role;
      error.value = null;
    } catch (caught) {
      error.value = describeError(caught);
    }
  }

  function attach(id: string): void {
    stream?.close();
    stream = null;
    watching.value = false;
    if (id === "") return;
    const token = getToken() ?? "";
    stream = mux.open("workflow/watch", { roomId: id, token }, {
      onData(payload: unknown): void {
        if (!isWorkflowWatchFrame(payload)) return;
        watching.value = true;
        if (payload.stage === "snapshot") {
          role.value = payload.role;
          host.value = payload.host;
        } else if (payload.stage === "role") {
          role.value = payload.role;
          host.value = payload.host;
        }
        emit(payload);
      },
      onError(payload: unknown): void {
        error.value = (payload as { message?: string } | null)?.message ?? "workflow watch stream error";
        watching.value = false;
      },
      onEnd(): void {
        watching.value = false;
      },
    });
  }

  watch(
    roomId,
    (id) => {
      void resolveRole(id);
      attach(id);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    frameHandlers.length = 0;
    stream?.close();
    stream = null;
    mux.close();
  });

  return {
    role,
    isHost,
    host,
    watching,
    error,
    onFrame: (cb) => { frameHandlers.push(cb); },
    refresh: async () => { await resolveRole(roomId.value); },
    transferHost: async (targetUserId: MatrixUserId): Promise<boolean> => {
      const id = roomId.value;
      if (id === "" || !isHost.value) return false;
      try {
        const res = await rpc.call("room/transferHost", { roomId: id, targetUserId });
        host.value = res.host;
        role.value = res.host === auth.session?.userId ? "host" : "member";
        error.value = null;
        return true;
      } catch (caught) {
        error.value = describeError(caught);
        return false;
      }
    },
  };
}
