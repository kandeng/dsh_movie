/**
 * Vue Flow <-> ComfyUI WorkflowGraph mapper (Phase-4 P4-M2, Path B).
 *
 * The Studio canvas is a Vue Flow editor, but the server-authoritative graph
 * persisted over Leg C (`workflow/*`, `workspace/*`) and executed over Leg B is
 * the ComfyUI-style {@link WorkflowGraph} (numeric node ids, positional widget
 * values, link tuples, input/output slots). This module is the single, pure
 * translation layer between the two so the existing 3-leg composables
 * (`useWorkspaceGraph`, `useCanvasScript`, `useExecStatus`) keep speaking
 * `WorkflowGraph` while the view speaks Vue Flow.
 *
 * Conventions:
 *  - Vue Flow node id = `String(WorkflowNode.id)`; the ComfyUI id is numeric.
 *  - Vue Flow node `type` = the ComfyUI `class_type` (a {@link MOVIE_NODES} key).
 *  - Handle ids are `in-<slotIndex>` / `out-<slotIndex>`; a link tuple's
 *    `fromSlot`/`toSlot` are those slot indices.
 *  - Edge id = `link-<linkId>` and `edge.data.linkId` carries the ComfyUI link
 *    id so a round-trip preserves link identity.
 *  - The viewport is stored in `graph.extra.ds` (`{ scale, offset }`), matching
 *    the LiteGraph serialization the pinned frontend uses.
 *
 * @module @/canvas/graphMapper
 */

import type { Edge, Node, ViewportTransform } from "@vue-flow/core";
import {
  FUNCTIONAL_NODES,
  MOVIE_NODES,
  SUBTYPE_OF,
  type MovieNodeSchema,
  type PromptGraph,
  type PromptGraphNode,
  type WorkflowGraph,
  type WorkflowGroup,
  type WorkflowLinkTuple,
  type WorkflowNode,
  type WorkflowSlot,
} from "@dsh-movie/protocol";

/** A widget rendered inside a movie node body (schema + current value). */
export interface NodeWidgetView {
  /** Widget name (also the object_info input key). */
  name: string;
  /** Widget primitive type: STRING/INT/FLOAT/BOOLEAN/COMBO. */
  type: string;
  /** Current value. */
  value: unknown;
  /** COMBO options, when present. */
  options?: readonly string[];
  /** Numeric lower bound, when present. */
  min?: number;
  /** Numeric upper bound, when present. */
  max?: number;
  /** Whether a STRING widget is multiline. */
  multiline?: boolean;
}

/**
 * One content-reference shape for every provenance (Phase-6 D5). Upload, market
 * and chat all yield `uri` (+ meta; chat also records `msgId`); inline text-input
 * nodes yield `text`. It is persisted ADDITIVELY in `properties.contentRef` for
 * provenance, while the canonical content the runs execute and the card stub
 * renders stays in the node's modality widget — one source of truth, no
 * wire-shape surgery. A `chat`/`upload` `uri` is a resolved media URL and may go
 * stale (R8); consumers fall back to the modality glyph.
 */
export interface ContentRef {
  /** Where the content came from. */
  origin: "upload" | "market" | "chat" | "inline";
  /** Resolved media URL (upload/market/chat). */
  uri?: string;
  /** MIME type of the referenced media. */
  mime?: string;
  /** Display label / original filename. */
  name?: string;
  /** Literal text (inline text-input nodes). */
  text?: string;
  /** Source room message id (chat origin). */
  msgId?: string;
}

/** The `data` payload carried by every Vue Flow movie node. */
export interface MovieNodeData {
  /** The ComfyUI `class_type` (a {@link MOVIE_NODES} key). */
  classType: string;
  /** Optional node title override. */
  title?: string;
  /**
   * Optional user-written node description (Phase-6 D11), persisted inside
   * `properties.description` and shown as the card's text stub when present.
   * Never inferred from the schema blurb: empty means "no description".
   */
  description?: string;
  /**
   * Optional content provenance (Phase-6 D5), persisted inside
   * `properties.contentRef`. Records where a source node's content came from;
   * the content value itself lives in the modality widget.
   */
  contentRef?: ContentRef;
  /** Renderable widgets (schema zipped with current values). */
  widgets: NodeWidgetView[];
  /** Raw positional widget values (mirrors `widgets_values`). */
  widgetsValues: unknown[];
  /** Input slots (carried for unknown-type fallback). */
  inputs: WorkflowSlot[];
  /** Output slots (carried for unknown-type fallback). */
  outputs: WorkflowSlot[];
  /** Node body size `[width, height]`. */
  size: [number, number];
  /** LiteGraph mode (0 normal, 2 muted, 4 bypassed). */
  mode: number;
  /** LiteGraph flags bitmask. */
  flags: number;
  /** Execution order hint. */
  order: number;
  /** Arbitrary node properties. */
  properties: Record<string, unknown>;
  /** Run status badge (a `NodeRunStatus` string). */
  status: string;
  /**
   * Reviewer verdict line (Phase-5 D5), view-only: painted from the Leg B
   * `executed` output for `family === 'reviewer'` nodes and NEVER serialized
   * back into the {@link WorkflowGraph} (mirrors the `status` badge contract).
   */
  verdict?: string;
}

/** A Vue Flow node carrying {@link MovieNodeData}. */
export type MovieFlowNode = Node<MovieNodeData>;
/** A Vue Flow edge carrying its ComfyUI link id. */
export type MovieFlowEdge = Edge<{ linkId: number }>;

/** A Vue Flow graph: nodes, edges, and the viewport transform. */
export interface VueFlowGraph {
  /** The nodes. */
  nodes: MovieFlowNode[];
  /** The edges. */
  edges: MovieFlowEdge[];
  /** The viewport transform. */
  viewport: ViewportTransform;
}

/**
 * `class_type` -> schema lookup built from BOTH catalogs: the six deprecated
 * movie steps ({@link MOVIE_NODES}) and the Phase-5 functional primitives
 * ({@link FUNCTIONAL_NODES}). The two catalogs have disjoint class types, so
 * the merged map resolves legacy and functional nodes alike (D1/D3).
 */
const SCHEMA_BY_TYPE = new Map<string, MovieNodeSchema>(
  [...MOVIE_NODES, ...FUNCTIONAL_NODES].map((node): [string, MovieNodeSchema] => [node.classType, node]),
);

/**
 * Modality color table for slot handles / badges (Phase-5 §6). Keyed by the
 * four base media types; a legacy subtype (SCRIPT, CLIP, …) resolves to its
 * base color via {@link SUBTYPE_OF}, and the wildcard `*` gets a neutral hue.
 */
const BASE_SLOT_COLORS: Readonly<Record<string, string>> = {
  TEXT: "#409eff",
  IMAGE: "#52c41a",
  VIDEO: "#9254de",
  AUDIO: "#faad14",
};
/** Neutral color for the wildcard (`*`) and any unknown slot type. */
const ANY_SLOT_COLOR = "#909399";

/** Resolve a slot type to its base media type (SCRIPT -> TEXT, CLIP -> VIDEO). */
export function baseSlotType(type: string): string {
  let current = type;
  let guard = 0;
  while (SUBTYPE_OF[current] !== undefined && guard < 8) {
    current = SUBTYPE_OF[current];
    guard += 1;
  }
  return current;
}

/**
 * The display color for a slot type: its base media type's hue, or a neutral
 * color for the wildcard / unknown types.
 * @param type - the slot type string, e.g. `TEXT`, `SCRIPT`, `*`.
 * @returns a CSS color string.
 */
export function slotColor(type: string | undefined): string {
  if (type === undefined || type === "" || type === "*") return ANY_SLOT_COLOR;
  return BASE_SLOT_COLORS[baseSlotType(type)] ?? ANY_SLOT_COLOR;
}

/** Default node body size when a graph omits it. */
const DEFAULT_SIZE: [number, number] = [230, 130];

/** Build an input handle id from a slot index. */
export function inHandle(slot: number): string {
  return `in-${slot}`;
}

/** Build an output handle id from a slot index. */
export function outHandle(slot: number): string {
  return `out-${slot}`;
}

/** Parse a slot index back out of a handle id (`in-2`/`out-2` -> 2). */
export function parseHandle(handle: string | null | undefined): number {
  if (handle === null || handle === undefined || handle === "") return 0;
  const parsed = Number(handle.replace(/^(in|out)-/, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Read a node type's schema (undefined for non-movie/unknown types). */
export function schemaFor(classType: string): MovieNodeSchema | undefined {
  return SCHEMA_BY_TYPE.get(classType);
}

/** Zip positional widget values with a type's widget schema. */
function widgetsFromValues(classType: string, values: unknown[]): NodeWidgetView[] {
  const schema = schemaFor(classType);
  if (schema === undefined) return [];
  return schema.widgets.map((widget, index): NodeWidgetView => {
    const fallback = widget.default ?? (widget.type === "COMBO" ? widget.options?.[0] ?? "" : "");
    const view: NodeWidgetView = {
      name: widget.name,
      type: widget.type,
      value: values[index] ?? fallback,
    };
    if (widget.options !== undefined) view.options = widget.options;
    if (widget.min !== undefined) view.min = widget.min;
    if (widget.max !== undefined) view.max = widget.max;
    if (widget.multiline !== undefined) view.multiline = widget.multiline;
    return view;
  });
}

/** Read the LiteGraph viewport (`extra.ds`) from a workflow graph. */
function viewportFromGraph(graph: WorkflowGraph): ViewportTransform {
  const extra = graph.extra as { ds?: { scale?: number; offset?: [number, number] } } | undefined;
  const ds = extra?.ds;
  return {
    x: ds?.offset?.[0] ?? 0,
    y: ds?.offset?.[1] ?? 0,
    zoom: ds?.scale && ds.scale > 0 ? ds.scale : 1,
  };
}

/**
 * Translate a ComfyUI {@link WorkflowGraph} into a Vue Flow graph.
 * @param graph - the server-authoritative workflow graph.
 * @returns the Vue Flow nodes/edges/viewport for the editor.
 */
export function workflowToVueFlow(graph: WorkflowGraph): VueFlowGraph {
  const nodes: MovieFlowNode[] = (graph.nodes ?? []).map((node): MovieFlowNode => {
    const widgetsValues = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];
    const size = (Array.isArray(node.size) ? node.size : DEFAULT_SIZE) as [number, number];
    const data: MovieNodeData = {
      classType: node.type,
      widgets: widgetsFromValues(node.type, widgetsValues),
      widgetsValues,
      inputs: (node.inputs ?? []).map((slot): WorkflowSlot => ({ ...slot })),
      outputs: (node.outputs ?? []).map((slot): WorkflowSlot => ({ ...slot })),
      size: [size[0], size[1]],
      mode: node.mode ?? 0,
      flags: node.flags ?? 0,
      order: node.order ?? 0,
      properties: { ...(node.properties ?? {}) },
      status: "idle",
    };
    if (node.title !== undefined) data.title = node.title;
    const props = node.properties ?? {};
    if (typeof props.description === "string") data.description = props.description;
    if (typeof props.contentRef === "object" && props.contentRef !== null) {
      data.contentRef = props.contentRef as ContentRef;
    }
    return {
      id: String(node.id),
      type: node.type,
      position: { x: node.pos?.[0] ?? 0, y: node.pos?.[1] ?? 0 },
      data,
      style: { width: `${size[0]}px` },
    } as MovieFlowNode;
  });

  const edges: MovieFlowEdge[] = (graph.links ?? []).map((tuple): MovieFlowEdge => {
    const [linkId, fromNode, fromSlot, toNode, toSlot] = tuple as WorkflowLinkTuple;
    return {
      id: `link-${linkId}`,
      source: String(fromNode),
      target: String(toNode),
      sourceHandle: outHandle(Number(fromSlot)),
      targetHandle: inHandle(Number(toSlot)),
      data: { linkId: Number(linkId) },
    } as MovieFlowEdge;
  });

  return { nodes, edges, viewport: viewportFromGraph(graph) };
}

/**
 * Translate a Vue Flow graph back into a ComfyUI {@link WorkflowGraph}.
 *
 * Input/output slots and their `link` ids are reconstructed from the edges plus
 * each node's schema, so the result is a valid LiteGraph serialization the Leg B
 * executor and the P3-M5 workspace store accept unchanged.
 * @param nodes - the Vue Flow nodes.
 * @param edges - the Vue Flow edges.
 * @param viewport - the Vue Flow viewport.
 * @param base - the previously loaded graph, used to preserve groups/config/version.
 * @param groups - the live drawn group boxes (D13). When provided they replace
 *   `base.groups` so drawn/renamed/recolored rectangles persist on export; when
 *   omitted the previously loaded groups are preserved unchanged.
 * @returns the ComfyUI-style workflow graph.
 */
export function vueFlowToWorkflow(
  nodes: MovieFlowNode[],
  edges: MovieFlowEdge[],
  viewport: ViewportTransform,
  base?: WorkflowGraph,
  groups?: WorkflowGroup[],
): WorkflowGraph {
  let lastLinkId = base?.last_link_id ?? 0;
  const linkTuples: WorkflowLinkTuple[] = [];
  // `${nodeId}:in:${slot}` -> link id (an input takes a single link).
  const inputLink = new Map<string, number>();
  // `${nodeId}:out:${slot}` -> link ids (an output may fan out).
  const outputLinks = new Map<string, number[]>();

  for (const edge of edges) {
    const fromNode = Number(edge.source);
    const toNode = Number(edge.target);
    const fromSlot = parseHandle(edge.sourceHandle);
    const toSlot = parseHandle(edge.targetHandle);
    let linkId = edge.data?.linkId;
    if (typeof linkId !== "number" || linkId <= 0) {
      lastLinkId += 1;
      linkId = lastLinkId;
    } else {
      lastLinkId = Math.max(lastLinkId, linkId);
    }
    linkTuples.push([linkId, fromNode, fromSlot, toNode, toSlot]);
    inputLink.set(`${toNode}:in:${toSlot}`, linkId);
    const outKey = `${fromNode}:out:${fromSlot}`;
    const existing = outputLinks.get(outKey);
    if (existing === undefined) outputLinks.set(outKey, [linkId]);
    else existing.push(linkId);
  }

  let lastNodeId = base?.last_node_id ?? 0;
  const workflowNodes: WorkflowNode[] = nodes.map((node): WorkflowNode => {
    const id = Number(node.id);
    if (Number.isFinite(id)) lastNodeId = Math.max(lastNodeId, id);
    const classType = node.data?.classType ?? node.type ?? "";
    const schema = schemaFor(classType);
    const position = node.position ?? { x: 0, y: 0 };
    const size = (node.data?.size ?? DEFAULT_SIZE) as [number, number];

    const inputDefs = schema?.inputs ?? (node.data?.inputs ?? []).map((slot) => ({ name: slot.name ?? "", type: slot.type ?? "*" }));
    const inputs: WorkflowSlot[] = inputDefs.map((slot, index) => ({
      name: slot.name,
      type: slot.type,
      link: inputLink.get(`${id}:in:${index}`) ?? null,
    }));

    const outputDefs = schema?.outputs ?? (node.data?.outputs ?? []).map((slot) => ({ name: slot.name ?? "", type: slot.type ?? "*" }));
    const outputs: WorkflowSlot[] = outputDefs.map((slot, index) => {
      const links = outputLinks.get(`${id}:out:${index}`) ?? [];
      return {
        name: slot.name,
        type: slot.type,
        link: links[0] ?? null,
        links: links.length > 0 ? links : null,
        slot_index: index,
      };
    });

    const workflowNode: WorkflowNode = {
      id,
      type: classType,
      pos: [position.x, position.y],
      size: [size[0], size[1]],
      flags: node.data?.flags ?? 0,
      order: node.data?.order ?? 0,
      mode: node.data?.mode ?? 0,
      inputs,
      outputs,
      properties: { ...(node.data?.properties ?? {}) },
      widgets_values: [...(node.data?.widgetsValues ?? [])],
    };
    if (node.data?.title !== undefined) workflowNode.title = node.data.title;
    if (node.data?.description !== undefined || node.data?.contentRef !== undefined) {
      workflowNode.properties = {
        ...(workflowNode.properties ?? {}),
        ...(node.data.description !== undefined ? { description: node.data.description } : {}),
        ...(node.data.contentRef !== undefined ? { contentRef: node.data.contentRef } : {}),
      };
    }
    return workflowNode;
  });

  return {
    last_node_id: lastNodeId,
    last_link_id: lastLinkId,
    nodes: workflowNodes,
    links: linkTuples,
    groups: groups ?? base?.groups ?? [],
    config: base?.config ?? {},
    extra: { ...(base?.extra ?? {}), ds: { scale: viewport.zoom, offset: [viewport.x, viewport.y] } },
    version: base?.version ?? 0.4,
  };
}

/**
 * Allocate the next free numeric node id for a `node.add` without an explicit id.
 * @param nodes - the current Vue Flow nodes.
 * @param base - the previously loaded graph (for its `last_node_id`).
 * @returns the next id to use.
 */
export function nextNodeId(nodes: MovieFlowNode[], base?: WorkflowGraph): number {
  let max = base?.last_node_id ?? 0;
  for (const node of nodes) {
    const id = Number(node.id);
    if (Number.isFinite(id)) max = Math.max(max, id);
  }
  return max + 1;
}

/**
 * Flatten an editor {@link WorkflowGraph} into an execution {@link PromptGraph}
 * (Phase-5 P5-M3: the link/widget resolution the SDK's M1 skeleton defers to the
 * canvas milestone). This is the client counterpart to the server verifier's
 * hand-built join/fork prompts, so a wired canvas graph runs exactly as its
 * equivalent fixture.
 *
 * Each node becomes a prompt entry keyed by `String(id)`. A linked input resolves
 * to a `[sourceNodeId, sourceSlotIndex]` tuple named from the node's input-slot
 * schema; widget values are zipped positionally with the type's widget schema.
 * Unlinked optional inputs are omitted — the gateway validator reports any
 * missing required link in its `node_errors` shape (D2), and the D15 availability
 * gate handles an unbacked generator modality at run time.
 * @param graph - the editor workflow graph (the live canvas snapshot).
 * @returns the flattened prompt graph to `POST /comfy/api/prompt`.
 */
export function workflowToPrompt(graph: WorkflowGraph): PromptGraph {
  // `${toNode}:in:${toSlot}` -> `[sourceNodeId, sourceSlotIndex]`.
  const linkInputs = new Map<string, [string, number]>();
  for (const tuple of graph.links ?? []) {
    const [, fromNode, fromSlot, toNode, toSlot] = tuple as WorkflowLinkTuple;
    linkInputs.set(`${toNode}:in:${toSlot}`, [String(fromNode), Number(fromSlot)]);
  }

  const prompt: PromptGraph = {};
  for (const node of graph.nodes ?? []) {
    const schema = schemaFor(node.type);
    const inputs: Record<string, unknown> = {};

    // Linked inputs, named from the input-slot schema (fall back to the
    // serialized slot names for an unknown class type).
    const inputDefs: readonly { name: string }[] =
      schema?.inputs ?? (node.inputs ?? []).map((slot): { name: string } => ({ name: slot.name ?? "" }));
    inputDefs.forEach((slot, index) => {
      const link = linkInputs.get(`${node.id}:in:${index}`);
      if (link !== undefined && slot.name !== "") inputs[slot.name] = link;
    });

    // Widget values zipped positionally with the widget schema (a widget is never
    // a link target on the functional catalog, so the two input kinds stay distinct).
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    (schema?.widgets ?? []).forEach((widget, index) => {
      const fallback = widget.default ?? (widget.type === "COMBO" ? widget.options?.[0] ?? "" : "");
      inputs[widget.name] = values[index] ?? fallback;
    });

    const spec: PromptGraphNode = { class_type: node.type, inputs };
    if (node.title !== undefined) spec._meta = { title: node.title };
    prompt[String(node.id)] = spec;
  }
  return prompt;
}
