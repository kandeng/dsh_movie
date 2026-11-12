/**
 * Parent-side Leg B execution status (Phase-2 M6).
 *
 * The Studio iframe runs its own ComfyUI socket to paint node badges, but the
 * parent also needs live per-node status + the last `executed` output to drive
 * the artifact inspector. This composable opens an independent Leg B `/ws`
 * execution-lifecycle socket (the gateway keeps every client in one shared
 * `execClients` set, so both sockets receive the same canned lifecycle) and
 * folds {@link ExecMessage}s into two reactive maps keyed by node id.
 *
 * Node ids on the wire are strings ("1".."6"); the demo graph uses matching
 * numeric ids, so we normalize with `Number(node)` and ignore non-numeric ids.
 */

import { onScopeDispose, ref, type Ref } from "vue";
import { connectExecSocket, type ExecSocket } from "@dsh-movie/sdk";
import type { ExecMessage, NodeRunStatus } from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";

/** The handle returned by {@link useExecStatus}. */
export interface ExecStatusHandle {
  /** True while the Leg B socket is open. */
  connected: Ref<boolean>;
  /** Per-node run status, keyed by numeric node id. */
  statusById: Ref<Map<number, NodeRunStatus>>;
  /** Per-node last `executed` output payload, keyed by numeric node id. */
  outputById: Ref<Map<number, unknown>>;
  /** Read a node's status (defaults to `idle`). */
  statusOf(id: number): NodeRunStatus;
  /** Read a node's last output (or `undefined`). */
  outputOf(id: number): unknown;
  /** Clear every tracked status/output (e.g. before a fresh run). */
  reset(): void;
  /** Open the socket (idempotent). */
  connect(): void;
  /** Close the socket. */
  disconnect(): void;
}

/**
 * Track Leg B execution status on a parent-side socket.
 *
 * The socket connects immediately (unless `autoConnect` is false) and is closed
 * on scope dispose. Status/output maps are replaced wholesale on each update so
 * Vue reactivity fires for template consumers.
 * @param options - `{ autoConnect?: boolean }` (defaults to connecting at once).
 * @returns the {@link ExecStatusHandle}.
 */
export function useExecStatus(options: { autoConnect?: boolean } = {}): ExecStatusHandle {
  const autoConnect = options.autoConnect ?? true;

  const connected = ref(false);
  const statusById = ref<Map<number, NodeRunStatus>>(new Map());
  const outputById = ref<Map<number, unknown>>(new Map());
  let socket: ExecSocket | null = null;

  function setStatus(id: number, status: NodeRunStatus): void {
    const next = new Map(statusById.value);
    next.set(id, status);
    statusById.value = next;
  }

  function setOutput(id: number, output: unknown): void {
    const next = new Map(outputById.value);
    next.set(id, output);
    outputById.value = next;
  }

  /** Normalize a wire node id ("3") to a numeric canvas id, or null. */
  function nodeId(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  }

  function handleMessage(message: ExecMessage): void {
    switch (message.type) {
      case "executing": {
        // `node: null` signals the prompt drained; otherwise the node is running.
        const id = nodeId(message.data.node);
        if (id !== null) setStatus(id, "running");
        break;
      }
      case "progress": {
        const id = nodeId(message.data.node);
        if (id !== null) setStatus(id, "progress");
        break;
      }
      case "executed": {
        const id = nodeId(message.data.node);
        if (id !== null) {
          setStatus(id, "success");
          setOutput(id, message.data.output);
        }
        break;
      }
      case "execution_error": {
        const id = nodeId(message.data.node_id);
        if (id !== null) setStatus(id, "error");
        break;
      }
      case "execution_interrupted": {
        const id = nodeId(message.data.node_id);
        if (id !== null) setStatus(id, "error");
        break;
      }
      case "execution_cached": {
        for (const raw of message.data.nodes) {
          const id = nodeId(raw);
          if (id !== null) setStatus(id, "success");
        }
        break;
      }
      default:
        // status / queued / execution_start / preview / execution_success carry
        // no per-node badge transition for the inspector.
        break;
    }
  }

  function connect(): void {
    if (socket !== null) return;
    socket = connectExecSocket(
      sdkConfig,
      {
        onMessage: handleMessage,
        onOpen: () => {
          connected.value = true;
        },
        onClose: () => {
          connected.value = false;
        },
        onError: () => {
          connected.value = false;
        },
      },
      // M7 hardening: survive a gateway restart with capped exponential backoff.
      { reconnect: true },
    );
  }

  function disconnect(): void {
    socket?.close();
    socket = null;
    connected.value = false;
  }

  function reset(): void {
    statusById.value = new Map();
    outputById.value = new Map();
  }

  if (autoConnect) connect();
  onScopeDispose(disconnect);

  return {
    connected,
    statusById,
    outputById,
    statusOf: (id) => statusById.value.get(id) ?? "idle",
    outputOf: (id) => outputById.value.get(id),
    reset,
    connect,
    disconnect,
  };
}
