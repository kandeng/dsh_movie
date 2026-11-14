/**
 * Demo workflow fixture (Phase-2 M5, rebuilt on functional nodes for Phase-5).
 *
 * Phase-5 D11 removed auto-seeding: a fresh room now opens on an EMPTY canvas,
 * so this module is no longer loaded on hydrate. It survives as the Studio
 * "reload demo" / "run demo lifecycle" affordance and as a client-side fixture
 * that exercises a NON-LINEAR JOIN in functional nodes (D3): two sources
 * (`TextInput` + `ImageInput`) converge on one `ImageGenerator` whose two typed
 * inputs (`prompt: TEXT`, `image: IMAGE`) are fed by the respective sources.
 *
 * The flattened {@link PromptGraph} mirrors the server verifier's join graph
 * (`verify-movie-executor.ts`), so the client demo and the Leg B lifecycle test
 * exercise the same shape.
 */

import {
  FUNCTIONAL_NODES,
  MOVIE_NODES,
  type MovieNodeSchema,
  type PromptGraph,
  type WorkflowGraph,
  type WorkflowGroup,
  type WorkflowLinkTuple,
  type WorkflowNode,
  type WorkflowSlot,
} from "@dsh-movie/protocol";

/**
 * Look up a node schema by its `class_type` across BOTH catalogs: the Phase-5
 * functional primitives ({@link FUNCTIONAL_NODES}) first, then the six deprecated
 * movie steps ({@link MOVIE_NODES}). The two catalogs are disjoint, so the merged
 * lookup resolves legacy and functional nodes alike (D1/D3).
 * @param classType - the registered node type (e.g. `ImageGenerator`, `MovieClip`).
 * @returns the {@link MovieNodeSchema}, or `undefined` for an unknown node.
 */
export function findMovieNode(classType: string): MovieNodeSchema | undefined {
  return (
    FUNCTIONAL_NODES.find((node) => node.classType === classType)
    ?? MOVIE_NODES.find((node) => node.classType === classType)
  );
}

/**
 * Resolve a graph node id to its schema (via its `type`), searching both catalogs.
 * @param graph - the editor graph the id belongs to.
 * @param id - the numeric node id.
 * @returns the {@link MovieNodeSchema}, or `undefined` when unresolved.
 */
export function nodeSchemaForId(graph: WorkflowGraph, id: number): MovieNodeSchema | undefined {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  return node ? findMovieNode(node.type) : undefined;
}

/** Canvas positions for the three join-graph nodes. */
const POS_IMAGE_INPUT: [number, number] = [80, 260];
const POS_TEXT_INPUT: [number, number] = [80, 80];
const POS_IMAGE_GEN: [number, number] = [420, 160];
const NODE_SIZE: [number, number] = [240, 140];

/** Widget payloads for the demo sources / generator. */
const IMAGE_INPUT_VALUE = "asset-ref.png";
const TEXT_INPUT_VALUE = "make the sky teal";
const IMAGE_GEN_MODE = "image_to_image";

/** Build an unconnected output slot. */
function outSlot(name: string, type: string, index: number, links: number[] = []): WorkflowSlot {
  return { name, type, link: links[0] ?? null, links: links.length > 0 ? links : [], slot_index: index };
}

/** Build an input slot, optionally carrying its link id. */
function inSlot(name: string, type: string, link: number | null): WorkflowSlot {
  return { name, type, link };
}

/**
 * Build the demo editor workflow graph: a functional join (image input + text
 * input → image generator), wrapped in one labelled group.
 * @returns a {@link WorkflowGraph} loadable via the bridge `graph.load` command.
 */
export function buildDemoWorkflow(): WorkflowGraph {
  // Link 1: TextInput (#2) out0 → ImageGenerator (#3) in0 (prompt: TEXT).
  // Link 2: ImageInput (#1) out0 → ImageGenerator (#3) in1 (image: IMAGE).
  const links: WorkflowLinkTuple[] = [
    [1, 2, 0, 3, 0, "TEXT"],
    [2, 1, 0, 3, 1, "IMAGE"],
  ];

  const nodes: WorkflowNode[] = [
    {
      id: 1,
      type: "ImageInput",
      pos: POS_IMAGE_INPUT,
      size: NODE_SIZE,
      flags: 0,
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [outSlot("image", "IMAGE", 0, [2])],
      title: "Image Input",
      properties: { "Node name for S&R": "ImageInput" },
      widgets_values: [IMAGE_INPUT_VALUE],
    },
    {
      id: 2,
      type: "TextInput",
      pos: POS_TEXT_INPUT,
      size: NODE_SIZE,
      flags: 0,
      order: 1,
      mode: 0,
      inputs: [],
      outputs: [outSlot("text", "TEXT", 0, [1])],
      title: "Text Input",
      properties: { "Node name for S&R": "TextInput" },
      widgets_values: [TEXT_INPUT_VALUE],
    },
    {
      id: 3,
      type: "ImageGenerator",
      pos: POS_IMAGE_GEN,
      size: NODE_SIZE,
      flags: 0,
      order: 2,
      mode: 0,
      inputs: [inSlot("prompt", "TEXT", 1), inSlot("image", "IMAGE", 2)],
      outputs: [outSlot("image", "IMAGE", 0)],
      title: "Image Generator",
      properties: { "Node name for S&R": "ImageGenerator" },
      widgets_values: [IMAGE_GEN_MODE],
    },
  ];

  const groups: WorkflowGroup[] = [
    { title: "Demo · Join", bounding: [40, 20, 660, 420], color: "0", collapsed: false },
  ];

  return {
    last_node_id: 3,
    last_link_id: 2,
    nodes,
    links,
    groups,
    config: {},
    extra: { ds: { scale: 0.7, offset: [0, 0] } },
    version: 0.4,
  };
}

/**
 * Build the flattened execution prompt for the demo join graph. Node keys match
 * the editor graph ids ("1".."3") and linked inputs are `[sourceId, slotIndex]`
 * tuples, so the Leg B lifecycle broadcasts paint status badges on the matching
 * canvas nodes and the executor resolves the join.
 * @returns a {@link PromptGraph} to `POST /comfy/api/prompt`.
 */
export function buildDemoPrompt(): PromptGraph {
  return {
    "1": { class_type: "ImageInput", inputs: { image: IMAGE_INPUT_VALUE }, _meta: { title: "Image Input" } },
    "2": { class_type: "TextInput", inputs: { text: TEXT_INPUT_VALUE }, _meta: { title: "Text Input" } },
    "3": {
      class_type: "ImageGenerator",
      inputs: { prompt: ["2", 0], image: ["1", 0], mode: IMAGE_GEN_MODE },
      _meta: { title: "Image Generator" },
    },
  };
}
