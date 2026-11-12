/**
 * Parent-side ComfyUI canvas bridge (Phase-2 M5, Phase-3 §3).
 *
 * Manages the same-origin iframe that hosts the pinned ComfyUI frontend and
 * speaks the versioned postMessage contract from `@dsh-movie/protocol/bridge`.
 * The parent never touches ComfyUI internals directly: it posts typed commands
 * (`graph.load`, `node.setStatus`, `setReadonly`, ...) and subscribes to typed
 * events (`ready`, `nodeSelected`, `graphChanged`, `execPainted`, `bridgeError`).
 *
 * A command carrying a `txn` correlation id is answered by a `commandResult`
 * event, which {@link CanvasBridge.request} surfaces as a Promise so callers can
 * await round-trips (e.g. graph export). Fire-and-forget helpers omit the txn.
 */

import { onScopeDispose, ref, watch, type Ref } from "vue";
import {
  BRIDGE_VERSION,
  bridgeCommand,
  isBridgeMessage,
  type BridgeCommandPayloads,
  type BridgeCommandType,
  type BridgeEvent,
  type NodeRunStatus,
  type WorkflowGraph,
} from "@dsh-movie/protocol";

/** Payload delivered to {@link CanvasBridge.onGraphChanged} subscribers. */
export interface GraphChangedPayload {
  graph: WorkflowGraph;
  rev: number;
}

/** Payload delivered to {@link CanvasBridge.onExecPainted} subscribers. */
export interface ExecPaintedPayload {
  id: number;
  status: NodeRunStatus;
}

/** Payload delivered to {@link CanvasBridge.onBridgeError} subscribers. */
export interface BridgeErrorPayload {
  code: string;
  message: string;
}

/** Payload delivered to {@link CanvasBridge.onCommandResult} subscribers. */
export interface CommandResultPayload {
  txn?: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

/** Options for {@link useCanvasBridge}. */
export interface UseCanvasBridgeOptions {
  /** iframe `src`; defaults to the same-origin `/comfy/index.html`. */
  iframeSrc?: string;
  /** Expected iframe origin for the postMessage guard; defaults to this window's origin. */
  targetOrigin?: string;
  /** Default timeout for {@link CanvasBridge.request}; defaults to 10s. */
  requestTimeoutMs?: number;
}

/** The bridge handle returned by {@link useCanvasBridge}. */
export interface CanvasBridge {
  /** True once the iframe has emitted `ready`. */
  ready: Ref<boolean>;
  /** The iframe `src` to bind in the template. */
  iframeSrc: string;
  /** Resolves on the first `ready` event (or immediately if already ready). */
  whenReady(): Promise<void>;
  /** Fire-and-forget a command (no `commandResult` correlation). */
  sendCommand<K extends BridgeCommandType>(type: K, payload: BridgeCommandPayloads[K], txn?: string): void;
  /** Send a command and await its `commandResult` reply. */
  request<K extends BridgeCommandType>(type: K, payload: BridgeCommandPayloads[K], timeoutMs?: number): Promise<unknown>;
  /** Replace the whole graph from workflow JSON (awaits the load result). */
  loadWorkflow(graph: WorkflowGraph): Promise<unknown>;
  /** Ask the iframe to serialize and return the current graph. */
  exportGraph(): Promise<WorkflowGraph | null>;
  /** Paint a run-status badge on a node. */
  setNodeStatus(id: number, status: NodeRunStatus): void;
  /** Toggle the multi-user edit lock. */
  setReadonly(readonly: boolean): void;
  /** Fit the view to the whole graph or the given node ids. */
  viewFit(ids?: number[]): void;
  /** Subscribe to the `ready` event. */
  onReady(cb: () => void): void;
  /** Subscribe to `nodeSelected` (id is null on deselect). */
  onNodeSelected(cb: (id: number | null) => void): void;
  /** Subscribe to `graphChanged` (manual edits inside the iframe). */
  onGraphChanged(cb: (payload: GraphChangedPayload) => void): void;
  /** Subscribe to `execPainted` (status badges driven by Leg B). */
  onExecPainted(cb: (payload: ExecPaintedPayload) => void): void;
  /** Subscribe to `bridgeError`. */
  onBridgeError(cb: (payload: BridgeErrorPayload) => void): void;
  /** Subscribe to every `commandResult`. */
  onCommandResult(cb: (payload: CommandResultPayload) => void): void;
}

const DEFAULT_IFRAME_SRC = "/comfy/index.html";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Create a canvas bridge bound to an iframe element ref.
 * @param iframeRef - template ref of the `<iframe>` hosting the ComfyUI frontend.
 * @param options - optional src/origin/timeout overrides.
 * @returns the {@link CanvasBridge} handle; listeners are removed on scope dispose.
 */
export function useCanvasBridge(
  iframeRef: Ref<HTMLIFrameElement | undefined>,
  options: UseCanvasBridgeOptions = {},
): CanvasBridge {
  const iframeSrc = options.iframeSrc ?? DEFAULT_IFRAME_SRC;
  const targetOrigin = options.targetOrigin ?? window.location.origin;
  const defaultTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const ready = ref(false);

  const readyHandlers: Array<() => void> = [];
  const selectHandlers: Array<(id: number | null) => void> = [];
  const graphChangedHandlers: Array<(payload: GraphChangedPayload) => void> = [];
  const execPaintedHandlers: Array<(payload: ExecPaintedPayload) => void> = [];
  const errorHandlers: Array<(payload: BridgeErrorPayload) => void> = [];
  const resultHandlers: Array<(payload: CommandResultPayload) => void> = [];

  interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, PendingRequest>();
  let txnCounter = 0;

  let resolveReady: () => void = () => {};
  let readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });

  function nextTxn(): string {
    txnCounter += 1;
    return `txn-${txnCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function post(message: unknown): void {
    const win = iframeRef.value?.contentWindow;
    if (!win) return;
    win.postMessage(message, targetOrigin);
  }

  function handshake(): void {
    // (Re)assert the version; the bridge answers with `ready` once it is live.
    ready.value = false;
    readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
    post(bridgeCommand("hello/version", { version: BRIDGE_VERSION }));
  }

  function settleResult(payload: CommandResultPayload): void {
    for (const handler of resultHandlers) handler(payload);
    const txn = payload.txn;
    if (txn === undefined) return;
    const entry = pending.get(txn);
    if (!entry) return;
    pending.delete(txn);
    clearTimeout(entry.timer);
    if (payload.ok) entry.resolve(payload.data ?? null);
    else entry.reject(new Error(payload.error ?? "bridge command failed"));
  }

  function onWindowMessage(event: MessageEvent): void {
    if (event.origin !== targetOrigin) return;
    if (!isBridgeMessage(event.data)) return;
    const message = event.data as BridgeEvent;
    switch (message.type) {
      case "ready":
        ready.value = true;
        resolveReady();
        for (const handler of readyHandlers) handler();
        break;
      case "nodeSelected":
        for (const handler of selectHandlers) handler(message.payload.id);
        break;
      case "graphChanged":
        for (const handler of graphChangedHandlers) handler(message.payload);
        break;
      case "execPainted":
        for (const handler of execPaintedHandlers) handler(message.payload);
        break;
      case "bridgeError":
        for (const handler of errorHandlers) handler(message.payload);
        break;
      case "commandResult":
        settleResult(message.payload);
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", onWindowMessage);

  // Handshake whenever the iframe (re)loads.
  function onIframeLoad(): void { handshake(); }
  const stopWatch = watch(
    iframeRef,
    (el, old) => {
      if (old) old.removeEventListener("load", onIframeLoad);
      if (el) {
        el.addEventListener("load", onIframeLoad);
        // If the iframe already finished loading before we attached, kick now.
        handshake();
      }
    },
    { immediate: true },
  );

  function sendCommand<K extends BridgeCommandType>(
    type: K,
    payload: BridgeCommandPayloads[K],
    txn?: string,
  ): void {
    post(bridgeCommand(type, payload, txn));
  }

  function request<K extends BridgeCommandType>(
    type: K,
    payload: BridgeCommandPayloads[K],
    timeoutMs = defaultTimeout,
  ): Promise<unknown> {
    const txn = nextTxn();
    return readyPromise.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(txn);
            reject(new Error(`bridge command "${type}" timed out`));
          }, timeoutMs);
          pending.set(txn, { resolve, reject, timer });
          sendCommand(type, payload, txn);
        }),
    );
  }

  function dispose(): void {
    stopWatch();
    window.removeEventListener("message", onWindowMessage);
    iframeRef.value?.removeEventListener("load", onIframeLoad);
    for (const [txn, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("canvas bridge disposed"));
      pending.delete(txn);
    }
  }
  onScopeDispose(dispose);

  return {
    ready,
    iframeSrc,
    whenReady: () => readyPromise,
    sendCommand,
    request,
    loadWorkflow: (graph) => request("graph.load", { graph }),
    exportGraph: async () => {
      const data = (await request("graph.export", {})) as { graph?: WorkflowGraph | null } | null;
      return data?.graph ?? null;
    },
    setNodeStatus: (id, status) => sendCommand("node.setStatus", { id, status }),
    setReadonly: (readonly) => sendCommand("setReadonly", { readonly }),
    viewFit: (ids) => sendCommand("view.fit", ids ? { ids } : {}),
    onReady: (cb) => { readyHandlers.push(cb); },
    onNodeSelected: (cb) => { selectHandlers.push(cb); },
    onGraphChanged: (cb) => { graphChangedHandlers.push(cb); },
    onExecPainted: (cb) => { execPaintedHandlers.push(cb); },
    onBridgeError: (cb) => { errorHandlers.push(cb); },
    onCommandResult: (cb) => { resultHandlers.push(cb); },
  };
}
