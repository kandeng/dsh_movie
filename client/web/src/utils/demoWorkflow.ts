/**
 * Demo six-step movie workflow fixture (Phase-2 M5).
 *
 * Builds a ComfyUI-style editor {@link WorkflowGraph} and a flattened
 * {@link PromptGraph} directly from the shared protocol node registry
 * (`MOVIE_NODES`), so the Studio canvas prototype always renders the same
 * six chained steps (script -> shot plan -> asset -> storyboard -> clip ->
 * assembled movie) the decision gate evaluates. Artifact slot types drive the
 * wiring: each step's output feeds the next step's matching input.
 */

import {
  MOVIE_NODES,
  type MovieNodeSchema,
  type PromptGraph,
  type WorkflowGraph,
  type WorkflowGroup,
  type WorkflowLinkTuple,
  type WorkflowNode,
  type WorkflowSlot,
} from "@dsh-movie/protocol";

/** Left-to-right layout constants for the demo graph. */
const ORIGIN_X = 80;
const ORIGIN_Y = 160;
const COLUMN_GAP = 320;
const NODE_SIZE: [number, number] = [240, 140];

/** The six movie nodes ordered by pipeline step. */
function orderedNodes() {
  return [...MOVIE_NODES].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
}

/**
 * Look up a movie node schema by its `class_type`.
 * @param classType - the registered node type (e.g. `MovieClip`).
 * @returns the {@link MovieNodeSchema}, or `undefined` for a non-movie node.
 */
export function findMovieNode(classType: string): MovieNodeSchema | undefined {
  return MOVIE_NODES.find((node) => node.classType === classType);
}

/**
 * Resolve a graph node id to its movie schema (via its `type`).
 * @param graph - the editor graph the id belongs to.
 * @param id - the numeric node id.
 * @returns the {@link MovieNodeSchema}, or `undefined` when unresolved.
 */
export function nodeSchemaForId(graph: WorkflowGraph, id: number): MovieNodeSchema | undefined {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  return node ? findMovieNode(node.type) : undefined;
}

/** Derive a node's serialized `widgets_values` from its widget defaults. */
function widgetValues(schema: (typeof MOVIE_NODES)[number]): unknown[] {
  return schema.widgets.map((widget) => {
    if (widget.default !== undefined) return widget.default;
    if (widget.type === "COMBO") return widget.options?.[0] ?? "";
    if (widget.type === "STRING") return "";
    if (widget.type === "BOOLEAN") return false;
    return 0;
  });
}

/**
 * Build the demo editor workflow graph: six nodes laid out left-to-right, wired
 * by artifact type, each wrapped in a labelled step group.
 * @returns a {@link WorkflowGraph} loadable via the bridge `graph.load` command.
 */
export function buildDemoWorkflow(): WorkflowGraph {
  const ordered = orderedNodes();
  const nodes: WorkflowNode[] = [];
  const links: WorkflowLinkTuple[] = [];
  const groups: WorkflowGroup[] = [];
  /** First producer of each artifact slot type -> { node id, output slot index }. */
  const producer = new Map<string, { nodeId: number; slot: number }>();
  let lastLinkId = 0;

  ordered.forEach((schema, index) => {
    const id = index + 1;
    const x = ORIGIN_X + index * COLUMN_GAP;
    const y = ORIGIN_Y;

    const inputs: WorkflowSlot[] = schema.inputs.map((slot) => ({
      name: slot.name,
      type: slot.type,
      link: null,
    }));
    const outputs: WorkflowSlot[] = schema.outputs.map((slot, slotIndex) => ({
      name: slot.name,
      type: slot.type,
      link: null,
      links: [],
      slot_index: slotIndex,
    }));

    // Wire each input from the first upstream producer of its artifact type.
    schema.inputs.forEach((slot, inputIndex) => {
      const source = producer.get(slot.type);
      if (!source) return;
      lastLinkId += 1;
      links.push([lastLinkId, source.nodeId, source.slot, id, inputIndex, slot.type]);
      inputs[inputIndex].link = lastLinkId;
      const sourceNode = nodes.find((node) => node.id === source.nodeId);
      const sourceOutput = sourceNode?.outputs?.[source.slot];
      if (sourceOutput) {
        sourceOutput.links = [...(sourceOutput.links ?? []), lastLinkId];
      }
    });

    // Register this node's outputs as producers for downstream steps.
    schema.outputs.forEach((slot, slotIndex) => {
      if (!producer.has(slot.type)) producer.set(slot.type, { nodeId: id, slot: slotIndex });
    });

    const values = widgetValues(schema);
    nodes.push({
      id,
      type: schema.classType,
      pos: [x, y],
      size: NODE_SIZE,
      flags: 0,
      order: index,
      mode: 0,
      inputs: inputs.length > 0 ? inputs : undefined,
      outputs: outputs.length > 0 ? outputs : undefined,
      title: schema.displayName,
      properties: { "Node name for S&R": schema.classType },
      widgets_values: values.length > 0 ? values : undefined,
    });

    groups.push({
      title: `Step ${schema.step} · ${schema.displayName}`,
      bounding: [x - 24, y - 56, NODE_SIZE[0] + 48, NODE_SIZE[1] + 112],
      color: "3",
      collapsed: false,
    });
  });

  return {
    last_node_id: nodes.length,
    last_link_id: lastLinkId,
    nodes,
    links,
    groups,
    config: {},
    extra: { ds: { scale: 0.6, offset: [0, 0] } },
    version: 0.4,
  };
}

/**
 * Build the flattened execution prompt for the demo graph. Node keys match the
 * editor graph ids ("1".."6") so the Leg B lifecycle broadcasts paint status
 * badges on the corresponding canvas nodes.
 * @returns a {@link PromptGraph} to `POST /comfy/api/prompt`.
 */
export function buildDemoPrompt(): PromptGraph {
  const graph: PromptGraph = {};
  orderedNodes().forEach((schema, index) => {
    graph[String(index + 1)] = {
      class_type: schema.classType,
      inputs: {},
      _meta: { title: schema.displayName },
    };
  });
  return graph;
}
