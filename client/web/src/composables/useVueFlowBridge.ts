/**
 * Vue Flow-backed canvas bridge (Phase-4 P4-M2, Path B).
 *
 * The pinned ComfyUI iframe is replaced by an in-app Vue Flow editor. To keep
 * the whole 3-leg data layer (`useCanvasScript`, `useExecStatus`,
 * `useWorkspaceGraph`, `useMovieRun`, `useRoomRole`) working UNCHANGED, this
 * module implements the exact same {@link CanvasBridge} contract the iframe
 * bridge did - but the "wire" is now a shared Vue Flow store plus the pure
 * {@link graphMapper} instead of `postMessage`.
 *
 * Store sharing: `useVueFlow(id)` creates the store, registers it in Vue Flow's
 * global storage, and `provide`s it, so the descendant `<VueFlowCanvas>`'s
 * `<VueFlow>` injects the SAME instance. The bridge drives that store; the
 * canvas renders it.
 *
 * Command mapping (mirrors `comfy-bridge/bridge-extension.js` result shapes so
 * `useCanvasScript.postconditionOk` passes verbatim):
 *  - `node.add/remove/move/setWidget` + `edge.remove` -> `{ id }`
 *  - `edge.add` -> `{ link }`
 *  - `node.setStatus` -> `{ status }` (and emits `execPainted`)
 *  - `group.collapse` -> `{ title }`
 *  - `view.fit` -> `{}`
 *  - `graph.export` -> `{ graph }`
 *
 * @module @/composables/useVueFlowBridge
 */

import { nextTick, onScopeDispose, ref, watch, type Ref } from "vue";
import { useVueFlow, type Connection, type VueFlowStore } from "@vue-flow/core";
import type {
  BridgeCommandPayloads,
  BridgeCommandType,
  NodeRunStatus,
  WorkflowGraph,
} from "@dsh-movie/protocol";
import {
  inHandle,
  nextNodeId,
  outHandle,
  schemaFor,
  vueFlowToWorkflow,
  workflowToVueFlow,
  type MovieFlowEdge,
  type MovieFlowNode,
  type MovieNodeData,
  type NodeWidgetView,
} from "@/canvas/graphMapper";
import type {
  BridgeErrorPayload,
  CanvasBridge,
  CommandResultPayload,
  ExecPaintedPayload,
  GraphChangedPayload,
} from "@/composables/useCanvasBridge";

/** The bridge handle plus the shared Vue Flow store the canvas binds to. */
export interface VueFlowBridge extends CanvasBridge {
  /** The shared Vue Flow store instance (created + provided by this bridge). */
  flow: VueFlowStore;
  /** The shared store id (also usable as `<VueFlow :id>`). */
  flowId: string;
  /** The current multi-user read-only lock state. */
  readonly: Ref<boolean>;
}

/** Options for {@link useVueFlowBridge}. */
export interface UseVueFlowBridgeOptions {
  /** Shared Vue Flow store id; defaults to `movie-canvas`. */
  id?: string;
  /** Debounce (ms) coalescing edit-driven `graphChanged` emissions. */
  changeDebounceMs?: number;
  /** Suppression tail (ms) after a programmatic `graph.load`. */
  loadSuppressMs?: number;
}

/** Default node body size for freshly added nodes. */
const DEFAULT_SIZE: [number, number] = [230, 130];
/** Default shared store id. */
const DEFAULT_FLOW_ID = "movie-canvas";
/** Default `graphChanged` debounce. */
const DEFAULT_CHANGE_DEBOUNCE_MS = 200;
/** Default post-load suppression tail. */
const DEFAULT_LOAD_SUPPRESS_MS = 400;
/** Suppression tail around an ephemeral status-badge paint (not persisted). */
const STATUS_SUPPRESS_MS = 80;

/** Derive a widget's default value from its schema. */
function widgetDefault(widget: { type: string; default?: unknown; options?: readonly string[] }): unknown {
  if (widget.default !== undefined) return widget.default;
  if (widget.type === "COMBO") return widget.options?.[0] ?? "";
  if (widget.type === "STRING") return "";
  if (widget.type === "BOOLEAN") return false;
  return 0;
}

/** Build the `data` payload for a freshly added movie node. */
function buildNodeData(classType: string, order: number, props?: Record<string, unknown>): MovieNodeData {
  const schema = schemaFor(classType);
  const widgets: NodeWidgetView[] = (schema?.widgets ?? []).map((widget): NodeWidgetView => {
    const value = props !== undefined && widget.name in props ? props[widget.name] : widgetDefault(widget);
    const view: NodeWidgetView = { name: widget.name, type: widget.type, value };
    if (widget.options !== undefined) view.options = widget.options;
    if (widget.min !== undefined) view.min = widget.min;
    if (widget.max !== undefined) view.max = widget.max;
    if (widget.multiline !== undefined) view.multiline = widget.multiline;
    return view;
  });
  const data: MovieNodeData = {
    classType,
    widgets,
    widgetsValues: widgets.map((widget): unknown => widget.value),
    inputs: (schema?.inputs ?? []).map((slot) => ({ name: slot.name, type: slot.type, link: null })),
    outputs: (schema?.outputs ?? []).map((slot, index) => ({
      name: slot.name,
      type: slot.type,
      link: null,
      links: [],
      slot_index: index,
    })),
    size: [DEFAULT_SIZE[0], DEFAULT_SIZE[1]],
    mode: 0,
    flags: 0,
    order,
    properties: { "Node name for S&R": classType },
    status: "idle",
  };
  const title = schema?.displayName;
  if (title !== undefined) data.title = title;
  return data;
}

/**
 * Create a {@link CanvasBridge} backed by a shared Vue Flow store.
 *
 * Must be called during a component `setup()` that renders `<VueFlowCanvas>` as
 * a descendant, so the store is `provide`d to the `<VueFlow>` component.
 * @param options - shared id + debounce/suppression tuning.
 * @returns the {@link VueFlowBridge} (a superset of {@link CanvasBridge}).
 */
export function useVueFlowBridge(options: UseVueFlowBridgeOptions = {}): VueFlowBridge {
  const flowId = options.id ?? DEFAULT_FLOW_ID;
  const debounceMs = options.changeDebounceMs ?? DEFAULT_CHANGE_DEBOUNCE_MS;
  const loadSuppressMs = options.loadSuppressMs ?? DEFAULT_LOAD_SUPPRESS_MS;

  // Creates + registers + provides the shared store the canvas will inject.
  const flow = useVueFlow(flowId);

  const ready = ref(false);
  const readonly = ref(false);

  const readyHandlers: Array<() => void> = [];
  const selectHandlers: Array<(id: number | null) => void> = [];
  const graphChangedHandlers: Array<(payload: GraphChangedPayload) => void> = [];
  const execPaintedHandlers: Array<(payload: ExecPaintedPayload) => void> = [];
  const errorHandlers: Array<(payload: BridgeErrorPayload) => void> = [];
  const resultHandlers: Array<(payload: CommandResultPayload) => void> = [];

  /** The last loaded graph, preserved across exports (groups/config/version). */
  let baseGraph: WorkflowGraph | undefined;
  /** Monotonic graph revision for `graphChanged` payloads. */
  let rev = 0;
  /** Edits are ignored while a programmatic load settles. */
  let suppressUntil = 0;
  /** Coalescing timer for edit-driven `graphChanged`. */
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });

  function isSuppressed(): boolean {
    return Date.now() < suppressUntil;
  }

  /** Serialize the live store into a ComfyUI {@link WorkflowGraph}. */
  function snapshot(): WorkflowGraph {
    const graph = vueFlowToWorkflow(
      flow.getNodes.value as MovieFlowNode[],
      flow.getEdges.value as MovieFlowEdge[],
      flow.viewport.value,
      baseGraph,
    );
    baseGraph = graph;
    return graph;
  }

  /** Emit `graphChanged` (debounced, suppressed during programmatic loads). */
  function scheduleGraphChanged(): void {
    if (isSuppressed()) return;
    if (changeTimer !== null) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (isSuppressed()) return;
      rev += 1;
      const payload: GraphChangedPayload = { graph: snapshot(), rev };
      for (const handler of graphChangedHandlers) handler(payload);
    }, debounceMs);
  }

  /** Allocate the next free ComfyUI link id. */
  function allocateLinkId(): number {
    let max = baseGraph?.last_link_id ?? 0;
    for (const edge of flow.getEdges.value) {
      const linkId = Number((edge.data as { linkId?: unknown } | undefined)?.linkId);
      if (Number.isFinite(linkId)) max = Math.max(max, linkId);
    }
    return max + 1;
  }

  /** Apply the read-only lock to the store's interactivity. */
  function applyReadonly(value: boolean): void {
    readonly.value = value;
    flow.setInteractive(!value);
  }

  /** Paint a run-status badge onto a node (and echo `execPainted`). */
  function paintStatus(id: number, status: NodeRunStatus): void {
    // Status is view-only (never serialized back into the WorkflowGraph), so
    // suppress the resulting watch tick to avoid dirtying/autosaving the graph.
    suppressUntil = Math.max(suppressUntil, Date.now() + STATUS_SUPPRESS_MS);
    flow.updateNodeData(String(id), { status } as Partial<MovieNodeData>);
    const payload: ExecPaintedPayload = { id, status };
    for (const handler of execPaintedHandlers) handler(payload);
  }

  /**
   * Apply one bridge command to the store and return its `commandResult.data`.
   * @param type - the command discriminator.
   * @param payload - the command payload.
   * @returns the postcondition data (shapes documented in the module header).
   */
  function applyCommand(type: BridgeCommandType, payload: unknown): unknown {
    switch (type) {
      case "graph.load": {
        const graph = (payload as BridgeCommandPayloads["graph.load"]).graph;
        const mapped = workflowToVueFlow(graph);
        baseGraph = graph;
        suppressUntil = Date.now() + loadSuppressMs;
        flow.setNodes(mapped.nodes);
        flow.setEdges(mapped.edges);
        void flow.setViewport(mapped.viewport);
        return { ok: true };
      }
      case "graph.export":
        return { graph: snapshot() };
      case "node.add": {
        const p = payload as BridgeCommandPayloads["node.add"];
        const id = p.id ?? nextNodeId(flow.getNodes.value as MovieFlowNode[], baseGraph);
        const node: MovieFlowNode = {
          id: String(id),
          type: p.nodeType,
          position: { x: p.pos[0], y: p.pos[1] },
          data: buildNodeData(p.nodeType, flow.getNodes.value.length, p.props),
          style: { width: `${DEFAULT_SIZE[0]}px` },
        } as MovieFlowNode;
        flow.addNodes(node);
        return { id };
      }
      case "node.remove": {
        const id = Number((payload as BridgeCommandPayloads["node.remove"]).id);
        flow.removeNodes(String(id), true);
        return { id };
      }
      case "node.move": {
        const p = payload as BridgeCommandPayloads["node.move"];
        flow.updateNode(String(p.id), { position: { x: p.x, y: p.y } });
        return { id: p.id };
      }
      case "node.setWidget": {
        const p = payload as BridgeCommandPayloads["node.setWidget"];
        const node = flow.findNode(String(p.id));
        if (node !== undefined) {
          const data = node.data as MovieNodeData;
          const widgets = (data.widgets ?? []).map((widget): NodeWidgetView =>
            widget.name === p.key ? { ...widget, value: p.value } : widget,
          );
          flow.updateNodeData(String(p.id), {
            widgets,
            widgetsValues: widgets.map((widget): unknown => widget.value),
          } as Partial<MovieNodeData>);
        }
        return { id: p.id };
      }
      case "node.setStatus": {
        const p = payload as BridgeCommandPayloads["node.setStatus"];
        paintStatus(p.id, p.status);
        return { status: p.status };
      }
      case "edge.add": {
        const p = payload as BridgeCommandPayloads["edge.add"];
        const link = allocateLinkId();
        const edge: MovieFlowEdge = {
          id: `link-${link}`,
          source: String(p.fromId),
          target: String(p.toId),
          sourceHandle: outHandle(p.fromSlot),
          targetHandle: inHandle(p.toSlot),
          data: { linkId: link },
        } as MovieFlowEdge;
        flow.addEdges(edge);
        return { link };
      }
      case "edge.remove": {
        const id = Number((payload as BridgeCommandPayloads["edge.remove"]).id);
        const edge = flow.getEdges.value.find(
          (candidate) => Number((candidate.data as { linkId?: unknown } | undefined)?.linkId) === id,
        );
        if (edge !== undefined) flow.removeEdges(edge.id);
        else flow.removeEdges(`link-${id}`);
        return { id };
      }
      case "group.collapse": {
        const p = payload as BridgeCommandPayloads["group.collapse"];
        if (baseGraph?.groups !== undefined) {
          for (const group of baseGraph.groups) {
            if (group.title === p.title) group.collapsed = p.collapsed;
          }
        }
        return { title: p.title };
      }
      case "view.fit": {
        const ids = (payload as BridgeCommandPayloads["view.fit"]).ids;
        void flow.fitView(ids !== undefined && ids.length > 0 ? { nodes: ids.map(String) } : {});
        return {};
      }
      case "setReadonly": {
        applyReadonly((payload as BridgeCommandPayloads["setReadonly"]).readonly);
        return {};
      }
      default:
        return {};
    }
  }

  function settleResult(payload: CommandResultPayload): void {
    for (const handler of resultHandlers) handler(payload);
  }

  function sendCommand<K extends BridgeCommandType>(type: K, payload: BridgeCommandPayloads[K]): void {
    try {
      applyCommand(type, payload);
      if (type !== "graph.load" && type !== "node.setStatus") scheduleGraphChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bridgeError: BridgeErrorPayload = { code: type, message };
      for (const handler of errorHandlers) handler(bridgeError);
    }
  }

  function request<K extends BridgeCommandType>(
    type: K,
    payload: BridgeCommandPayloads[K],
    _timeoutMs?: number,
  ): Promise<unknown> {
    return readyPromise.then(() => {
      try {
        const data = applyCommand(type, payload);
        settleResult({ ok: true, data });
        return Promise.resolve(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settleResult({ ok: false, error: message });
        return Promise.reject(new Error(message));
      }
    });
  }

  // ── Live store wiring: selection, manual connections, and edit detection. ──
  const offPaneReady = flow.onPaneReady(() => {
    if (ready.value) return;
    ready.value = true;
    resolveReady();
    for (const handler of readyHandlers) handler();
  });

  const offNodeClick = flow.onNodeClick(({ node }) => {
    const id = Number(node.id);
    for (const handler of selectHandlers) handler(Number.isFinite(id) ? id : null);
  });

  const offPaneClick = flow.onPaneClick(() => {
    for (const handler of selectHandlers) handler(null);
  });

  const offConnect = flow.onConnect((connection: Connection) => {
    const link = allocateLinkId();
    const edge: MovieFlowEdge = {
      id: `link-${link}`,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? outHandle(0),
      targetHandle: connection.targetHandle ?? inHandle(0),
      data: { linkId: link },
    } as MovieFlowEdge;
    flow.addEdges(edge);
    scheduleGraphChanged();
  });

  // Deep-watch the store so drags, widget edits, and structural changes all
  // coalesce into a single debounced `graphChanged` (suppressed during loads).
  const stopWatch = watch(
    () => [flow.getNodes.value, flow.getEdges.value],
    () => { scheduleGraphChanged(); },
    { deep: true },
  );

  function dispose(): void {
    if (changeTimer !== null) clearTimeout(changeTimer);
    stopWatch();
    offPaneReady.off();
    offNodeClick.off();
    offPaneClick.off();
    offConnect.off();
  }
  onScopeDispose(dispose);

  return {
    flow,
    flowId,
    readonly,
    ready,
    iframeSrc: "",
    whenReady: (): Promise<void> => readyPromise,
    sendCommand,
    request,
    loadWorkflow: async (graph: WorkflowGraph): Promise<unknown> => {
      const data = await request("graph.load", { graph });
      await nextTick();
      return data;
    },
    exportGraph: async (): Promise<WorkflowGraph | null> => {
      const data = (await request("graph.export", {})) as { graph?: WorkflowGraph | null } | null;
      return data?.graph ?? null;
    },
    setNodeStatus: (id: number, status: NodeRunStatus): void => sendCommand("node.setStatus", { id, status }),
    setReadonly: (value: boolean): void => sendCommand("setReadonly", { readonly: value }),
    viewFit: (ids?: number[]): void => sendCommand("view.fit", ids !== undefined ? { ids } : {}),
    onReady: (cb: () => void): void => { readyHandlers.push(cb); },
    onNodeSelected: (cb: (id: number | null) => void): void => { selectHandlers.push(cb); },
    onGraphChanged: (cb: (payload: GraphChangedPayload) => void): void => { graphChangedHandlers.push(cb); },
    onExecPainted: (cb: (payload: ExecPaintedPayload) => void): void => { execPaintedHandlers.push(cb); },
    onBridgeError: (cb: (payload: BridgeErrorPayload) => void): void => { errorHandlers.push(cb); },
    onCommandResult: (cb: (payload: CommandResultPayload) => void): void => { resultHandlers.push(cb); },
  };
}
