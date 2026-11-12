/**
 * Movie-step node schema registry (Phase-2 M5, Phase-3 §2/§6).
 *
 * A single typed source of truth for the six movie-making step nodes plus the
 * artifact slot types they exchange. The registry feeds two consumers that must
 * agree exactly:
 *  1. the DSH host's `/object_info` generator (the ComfyUI boot protocol the
 *     pinned frontend demands) - see {@link buildObjectInfo}; and
 *  2. the in-iframe bridge extension's `LiteGraph.registerNodeType` calls, so a
 *     graph loaded from workflow JSON renders with the right slots/widgets.
 *
 * The DSH host runs no Python and defines no ComfyUI backend nodes; these are
 * pure editor/visualizer node types. All inference is delegated off-host.
 *
 * @module @dsh-movie/protocol/nodes
 */

/** A typed connection slot (input or output) on a movie node. */
export interface NodeSlotSchema {
  /** Slot name shown on the node. */
  name: string
  /** Slot data type, e.g. `SCRIPT`, `SHOT_PLAN`, `IMAGE`, `*`. */
  type: string
}

/** A widget (non-connection) field rendered inside the node body. */
export interface NodeWidgetSchema {
  /** Widget name (also the object_info input key). */
  name: string
  /** Widget primitive type: `STRING`, `INT`, `FLOAT`, `BOOLEAN`, or a COMBO. */
  type: string
  /** For COMBO widgets, the selectable options. */
  options?: readonly string[]
  /** Default value. */
  default?: string | number | boolean
  /** Whether a STRING widget is a multiline text box. */
  multiline?: boolean
  /** Numeric widget bounds. */
  min?: number
  /** Numeric widget bounds. */
  max?: number
}

/** One movie-step node type definition. */
export interface MovieNodeSchema {
  /** ComfyUI `class_type` and the LiteGraph registered type name. */
  classType: string
  /** Human-readable node title. */
  displayName: string
  /** Tooltip / description text. */
  description: string
  /** ComfyUI menu category, e.g. `movie/script`. */
  category: string
  /** Pipeline order, 1..6, used to lay the demo graph out left-to-right. */
  step: number
  /** Connection inputs. */
  inputs: readonly NodeSlotSchema[]
  /** Connection outputs. */
  outputs: readonly NodeSlotSchema[]
  /** Body widgets. */
  widgets: readonly NodeWidgetSchema[]
  /** Whether this node is a terminal output node. */
  outputNode?: boolean
}

/**
 * The six movie-making steps (Phase-3 §2): script, shot plan, character/scene
 * asset, storyboard, clip, assembled movie. Slot types chain the artifacts so a
 * graph wires step N's output into step N+1's input.
 */
export const MOVIE_NODES: readonly MovieNodeSchema[] = [
  {
    classType: 'MovieScript',
    displayName: 'Script',
    description: 'Generate the story script from a prompt.',
    category: 'movie/script',
    step: 1,
    inputs: [],
    outputs: [{ name: 'script', type: 'SCRIPT' }],
    widgets: [{ name: 'prompt', type: 'STRING', multiline: true, default: '' }],
  },
  {
    classType: 'MovieShotPlan',
    displayName: 'Shot Plan',
    description: 'Break the script into a shot-by-shot plan.',
    category: 'movie/shot-plan',
    step: 2,
    inputs: [{ name: 'script', type: 'SCRIPT' }],
    outputs: [{ name: 'shot_plan', type: 'SHOT_PLAN' }],
    widgets: [{ name: 'shots', type: 'INT', default: 6, min: 1, max: 64 }],
  },
  {
    classType: 'MovieAsset',
    displayName: 'Character / Scene Asset',
    description: 'Produce character, scene, or prop assets for the shots.',
    category: 'movie/asset',
    step: 3,
    inputs: [
      { name: 'script', type: 'SCRIPT' },
      { name: 'shot_plan', type: 'SHOT_PLAN' },
    ],
    outputs: [{ name: 'asset', type: 'ASSET' }],
    widgets: [
      { name: 'asset_kind', type: 'COMBO', options: ['character', 'scene', 'prop'], default: 'character' },
    ],
  },
  {
    classType: 'MovieStoryboard',
    displayName: 'Storyboard',
    description: 'Compose storyboard frames from the shot plan and assets.',
    category: 'movie/storyboard',
    step: 4,
    inputs: [
      { name: 'shot_plan', type: 'SHOT_PLAN' },
      { name: 'asset', type: 'ASSET' },
    ],
    outputs: [{ name: 'storyboard', type: 'STORYBOARD' }],
    widgets: [],
  },
  {
    classType: 'MovieClip',
    displayName: 'Clip',
    description: 'Render an animated clip from a storyboard frame.',
    category: 'movie/clip',
    step: 5,
    inputs: [{ name: 'storyboard', type: 'STORYBOARD' }],
    outputs: [{ name: 'clip', type: 'CLIP' }],
    widgets: [{ name: 'duration', type: 'FLOAT', default: 4, min: 0.5, max: 60 }],
  },
  {
    classType: 'MovieAssemble',
    displayName: 'Assembled Movie',
    description: 'Assemble the final movie from rendered clips.',
    category: 'movie/output',
    step: 6,
    inputs: [{ name: 'clip', type: 'CLIP' }],
    outputs: [{ name: 'movie', type: 'MOVIE' }],
    widgets: [],
    outputNode: true,
  },
]

/** The set of movie artifact slot type names (for validation / coloring). */
export const MOVIE_SLOT_TYPES: readonly string[] = [
  'SCRIPT',
  'SHOT_PLAN',
  'ASSET',
  'STORYBOARD',
  'CLIP',
  'MOVIE',
]

/** A ComfyUI `/object_info` entry for one node type. */
export interface ObjectInfoEntry {
  input: { required: Record<string, unknown[]>; optional: Record<string, unknown[]> }
  output: string[]
  output_is_list: boolean[]
  output_name: string[]
  name: string
  display_name: string
  description: string
  category: string
  output_node: boolean
  /** Duplicate of {@link ObjectInfoEntry.output_node} for the newer schema key. */
  is_output_node: boolean
  /**
   * Module the node def originates from. The pinned frontend does
   * `python_module.split('.')` (with no fallback) to decide core vs custom, so
   * this field is REQUIRED or node-def construction throws and `app.setup()`
   * aborts. These are host editor nodes - no Python runs on the DSH host - so we
   * use a dsh_movie pseudo-module the frontend treats as a custom node source.
   */
  python_module: string
  deprecated: boolean
  experimental: boolean
  dev_only: boolean
  api_node: boolean
}

/**
 * Pseudo Python module for the movie editor nodes. It is not a real importable
 * module (the DSH host runs no Python); the frontend only uses its first dotted
 * segment to classify the node as a custom (non-core) source.
 */
export const MOVIE_NODE_MODULE = 'dsh_movie.movie_nodes'

/** Translate one widget schema into its ComfyUI `[type, opts]` input tuple. */
function widgetInput(widget: NodeWidgetSchema): unknown[] {
  if (widget.type === 'COMBO') {
    return [widget.options ?? [], { default: widget.default ?? (widget.options?.[0] ?? '') }]
  }
  const opts: Record<string, unknown> = {}
  if (widget.default !== undefined) opts.default = widget.default
  if (widget.multiline === true) opts.multiline = true
  if (widget.min !== undefined) opts.min = widget.min
  if (widget.max !== undefined) opts.max = widget.max
  return [widget.type, opts]
}

/**
 * Generate the ComfyUI `/object_info` map from the movie node registry. The
 * pinned frontend calls `GET {api_base}/api/object_info` during boot to learn
 * the node catalog; this is the DSH host's answer (no Python node definitions).
 * @param nodes - the registry to render (defaults to {@link MOVIE_NODES}).
 * @returns a `class_type -> ObjectInfoEntry` record.
 */
export function buildObjectInfo(nodes: readonly MovieNodeSchema[] = MOVIE_NODES): Record<string, ObjectInfoEntry> {
  const info: Record<string, ObjectInfoEntry> = {}
  for (const node of nodes) {
    const required: Record<string, unknown[]> = {}
    for (const widget of node.widgets) required[widget.name] = widgetInput(widget)
    for (const input of node.inputs) required[input.name] = [input.type]
    info[node.classType] = {
      input: { required, optional: {} },
      output: node.outputs.map((slot): string => slot.type),
      output_is_list: node.outputs.map((): boolean => false),
      output_name: node.outputs.map((slot): string => slot.name),
      name: node.classType,
      display_name: node.displayName,
      description: node.description,
      category: node.category,
      output_node: node.outputNode === true,
      is_output_node: node.outputNode === true,
      python_module: MOVIE_NODE_MODULE,
      deprecated: false,
      experimental: false,
      dev_only: false,
      api_node: false,
    }
  }
  return info
}
