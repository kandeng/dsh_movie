/**
 * Movie-step + functional node schema registry (Phase-2 M5, Phase-3 §2/§6,
 * Phase-5 D1/D2/D3).
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
  /** Whether a link into this input slot is optional (functional nodes). */
  optional?: boolean
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

/** The role a functional node plays in a graph (Phase-5 D3). */
export type NodeFamily = 'source' | 'generator' | 'reviewer' | 'combiner'

/** The media kind a functional node consumes/produces (Phase-5 D3). */
export type NodeModality = 'text' | 'image' | 'video' | 'audio'

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
  /** Pipeline order, 1..6, for legacy step nodes; absent on functional nodes. */
  step?: number
  /** Functional family (role); absent on legacy step nodes (Phase-5 D3). */
  family?: NodeFamily
  /** Functional modality; absent on legacy step nodes (Phase-5 D3). */
  modality?: NodeModality
  /** Whether the class type is deprecated (legacy step nodes, Phase-5 D1). */
  deprecated?: boolean
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
    deprecated: true,
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
    deprecated: true,
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
    deprecated: true,
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
    deprecated: true,
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
    deprecated: true,
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
    deprecated: true,
    inputs: [{ name: 'clip', type: 'CLIP' }],
    outputs: [{ name: 'movie', type: 'MOVIE' }],
    widgets: [],
    outputNode: true,
  },
]

/**
 * The functional node catalog (Phase-5 D3): role × modality primitives that are
 * the only forward registry primitives. Legacy step nodes above remain as
 * deprecated, still-executable aliases for one phase (D1).
 */
export const FUNCTIONAL_NODES: readonly MovieNodeSchema[] = [
  // ── sources: payload widget in, one typed artifact out ──
  {
    classType: 'TextInput',
    displayName: 'Text Input',
    description: 'Provide raw text (idea, request, script excerpt) to the graph.',
    category: 'movie/source',
    family: 'source',
    modality: 'text',
    inputs: [],
    outputs: [{ name: 'text', type: 'TEXT' }],
    widgets: [{ name: 'text', type: 'STRING', multiline: true, default: '' }],
  },
  {
    classType: 'ImageInput',
    displayName: 'Image Input',
    description: 'Provide a raw image (upload, annotated screenshot, asset reference).',
    category: 'movie/source',
    family: 'source',
    modality: 'image',
    inputs: [],
    outputs: [{ name: 'image', type: 'IMAGE' }],
    widgets: [{ name: 'image', type: 'STRING', default: '' }],
  },
  {
    classType: 'VideoInput',
    displayName: 'Video Input',
    description: 'Provide a raw video clip reference to the graph.',
    category: 'movie/source',
    family: 'source',
    modality: 'video',
    inputs: [],
    outputs: [{ name: 'video', type: 'VIDEO' }],
    widgets: [{ name: 'video', type: 'STRING', default: '' }],
  },
  {
    classType: 'AudioInput',
    displayName: 'Audio Input',
    description: 'Provide a raw audio (sound / BGM) reference to the graph.',
    category: 'movie/source',
    family: 'source',
    modality: 'audio',
    inputs: [],
    outputs: [{ name: 'audio', type: 'AUDIO' }],
    widgets: [{ name: 'audio', type: 'STRING', default: '' }],
  },
  // ── generators: optional typed inputs, one typed artifact out ──
  {
    classType: 'TextGenerator',
    displayName: 'Text Generator',
    description: 'Generate text (script, shot plan, review notes) from linked context and its prompt widget.',
    category: 'movie/generator',
    family: 'generator',
    modality: 'text',
    inputs: [{ name: 'context', type: 'TEXT', optional: true }],
    outputs: [{ name: 'text', type: 'TEXT' }],
    widgets: [{ name: 'prompt', type: 'STRING', multiline: true, default: '' }],
  },
  {
    classType: 'ImageGenerator',
    displayName: 'Image Generator',
    description: 'Generate an image from text (text_to_image) or modify a linked image (image_to_image).',
    category: 'movie/generator',
    family: 'generator',
    modality: 'image',
    inputs: [
      { name: 'prompt', type: 'TEXT', optional: true },
      { name: 'image', type: 'IMAGE', optional: true },
    ],
    outputs: [{ name: 'image', type: 'IMAGE' }],
    widgets: [
      { name: 'mode', type: 'COMBO', options: ['text_to_image', 'image_to_image'], default: 'text_to_image' },
    ],
  },
  {
    classType: 'VideoGenerator',
    displayName: 'Video Generator',
    description: 'Render a video clip from text (text_to_video) or from a linked storyboard image (image_to_video).',
    category: 'movie/generator',
    family: 'generator',
    modality: 'video',
    inputs: [
      { name: 'prompt', type: 'TEXT', optional: true },
      { name: 'image', type: 'IMAGE', optional: true },
    ],
    outputs: [{ name: 'clip', type: 'VIDEO' }],
    widgets: [
      { name: 'mode', type: 'COMBO', options: ['text_to_video', 'image_to_video'], default: 'image_to_video' },
      { name: 'duration', type: 'FLOAT', default: 4, min: 0.5, max: 60 },
    ],
  },
  {
    classType: 'AudioGenerator',
    displayName: 'Audio Generator',
    description: 'Generate sound effects or background music from a text description.',
    category: 'movie/generator',
    family: 'generator',
    modality: 'audio',
    inputs: [{ name: 'prompt', type: 'TEXT', optional: true }],
    outputs: [{ name: 'audio', type: 'AUDIO' }],
    widgets: [{ name: 'kind', type: 'COMBO', options: ['sound', 'music'], default: 'sound' }],
  },
  // ── reviewers: one required reviewed input, verdict + forwarded artifact out ──
  {
    classType: 'TextReviewer',
    displayName: 'Text Reviewer',
    description: 'Judge linked text against the criteria widget; emits a VERDICT and forwards the text on pass.',
    category: 'movie/reviewer',
    family: 'reviewer',
    modality: 'text',
    inputs: [{ name: 'text', type: 'TEXT' }],
    outputs: [
      { name: 'verdict', type: 'VERDICT' },
      { name: 'text', type: 'TEXT' },
    ],
    widgets: [{ name: 'criteria', type: 'STRING', multiline: true, default: '' }],
  },
  {
    classType: 'ImageReviewer',
    displayName: 'Image Reviewer',
    description: 'Judge a linked image against the criteria widget; emits a VERDICT and forwards the image on pass.',
    category: 'movie/reviewer',
    family: 'reviewer',
    modality: 'image',
    inputs: [{ name: 'image', type: 'IMAGE' }],
    outputs: [
      { name: 'verdict', type: 'VERDICT' },
      { name: 'image', type: 'IMAGE' },
    ],
    widgets: [{ name: 'criteria', type: 'STRING', multiline: true, default: '' }],
  },
  {
    classType: 'VideoReviewer',
    displayName: 'Video Reviewer',
    description: 'Judge a linked video clip against the criteria widget; emits a VERDICT and forwards the clip on pass.',
    category: 'movie/reviewer',
    family: 'reviewer',
    modality: 'video',
    inputs: [{ name: 'video', type: 'VIDEO' }],
    outputs: [
      { name: 'verdict', type: 'VERDICT' },
      { name: 'video', type: 'VIDEO' },
    ],
    widgets: [{ name: 'criteria', type: 'STRING', multiline: true, default: '' }],
  },
  {
    classType: 'AudioReviewer',
    displayName: 'Audio Reviewer',
    description: 'Judge linked audio against the criteria widget; emits a VERDICT and forwards the audio on pass.',
    category: 'movie/reviewer',
    family: 'reviewer',
    modality: 'audio',
    inputs: [{ name: 'audio', type: 'AUDIO' }],
    outputs: [
      { name: 'verdict', type: 'VERDICT' },
      { name: 'audio', type: 'AUDIO' },
    ],
    widgets: [{ name: 'criteria', type: 'STRING', multiline: true, default: '' }],
  },
  // ── combiners: deterministic, no model call ──
  {
    classType: 'TextMerge',
    displayName: 'Text Merge',
    description: 'Concatenate linked texts in slot order into one text artifact.',
    category: 'movie/combiner',
    family: 'combiner',
    modality: 'text',
    inputs: [
      { name: 'a', type: 'TEXT', optional: true },
      { name: 'b', type: 'TEXT', optional: true },
    ],
    outputs: [{ name: 'text', type: 'TEXT' }],
    widgets: [],
  },
  {
    classType: 'MediaConcat',
    displayName: 'Media Concat',
    description: 'Concatenate linked media of the same base type in slot order (clips into a reel, audio into a track).',
    category: 'movie/combiner',
    family: 'combiner',
    modality: 'video',
    inputs: [
      { name: 'a', type: '*', optional: true },
      { name: 'b', type: '*', optional: true },
    ],
    outputs: [{ name: 'media', type: '*' }],
    widgets: [],
  },
  {
    classType: 'SaveOutput',
    displayName: 'Save Output',
    description: 'Terminal node: persist the linked artifact as the run output.',
    category: 'movie/output',
    family: 'combiner',
    modality: 'video',
    inputs: [{ name: 'media', type: '*' }],
    outputs: [],
    widgets: [],
    outputNode: true,
  },
]

/** Base media slot types (Phase-5 D2). */
export const MEDIA_SLOT_TYPES: readonly string[] = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO']

/** Wildcard slot type: compatible with every media type in either direction. */
export const ANY_SLOT_TYPE = '*'

/**
 * Subtype assignability table (Phase-5 D2): legacy step artifact types (and the
 * reviewer verdict) are subtypes of their base media type. A link is compatible
 * when the source type equals the target type or is a subtype of it (never the
 * reverse), or when either side is {@link ANY_SLOT_TYPE}.
 */
export const SUBTYPE_OF: Readonly<Record<string, string>> = {
  SCRIPT: 'TEXT',
  SHOT_PLAN: 'TEXT',
  VERDICT: 'TEXT',
  ASSET: 'IMAGE',
  STORYBOARD: 'IMAGE',
  CLIP: 'VIDEO',
  MOVIE: 'VIDEO',
}

/**
 * Whether a link from an output of `sourceType` into an input declaring
 * `targetType` is type-compatible (Phase-5 D2).
 * @param sourceType - the producer slot's type.
 * @param targetType - the consumer slot's declared type.
 * @returns true when the link may carry the artifact.
 */
export function slotCompatible(sourceType: string, targetType: string): boolean {
  if (sourceType === ANY_SLOT_TYPE || targetType === ANY_SLOT_TYPE) return true
  let current: string | undefined = sourceType
  while (current !== undefined) {
    if (current === targetType) return true
    current = SUBTYPE_OF[current]
  }
  return false
}

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
    const optional: Record<string, unknown[]> = {}
    for (const widget of node.widgets) required[widget.name] = widgetInput(widget)
    for (const input of node.inputs) {
      if (input.optional === true) optional[input.name] = [input.type]
      else required[input.name] = [input.type]
    }
    info[node.classType] = {
      input: { required, optional },
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
      deprecated: node.deprecated === true,
      experimental: false,
      dev_only: false,
      api_node: false,
    }
  }
  return info
}
