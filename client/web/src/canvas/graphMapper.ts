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
  MOVIE_NODES,
  type MovieNodeSchema,
  type WorkflowGraph,
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

/** The `data` payload carried by every Vue Flow movie node. */
export interface MovieNodeData {
  /** The ComfyUI `class_type` (a {@link MOVIE_NODES} key). */
  classType: string;
  /** Optional node title override. */
  title?: string;
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

/** `class_type` -> schema lookup built from {@link MOVIE_NODES}. */
const SCHEMA_BY_TYPE = new Map<string, MovieNodeSchema>(
  MOVIE_NODES.map((node): [string, MovieNodeSchema] => [node.classType, node]),
);

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
 * @returns the ComfyUI-style workflow graph.
 */
export function vueFlowToWorkflow(
  nodes: MovieFlowNode[],
  edges: MovieFlowEdge[],
  viewport: ViewportTransform,
  base?: WorkflowGraph,
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
    return workflowNode;
  });

  return {
    last_node_id: lastNodeId,
    last_link_id: lastLinkId,
    nodes: workflowNodes,
    links: linkTuples,
    groups: base?.groups ?? [],
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
