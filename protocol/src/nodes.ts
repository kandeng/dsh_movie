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

import type { ImportedSkillRef } from './leg-c.ts'

/** A typed connection slot (input or output) on a movie node. */
export interface NodeSlotSchema {
  /** Slot name shown on the node. */
  name: string
  /** Slot data type, e.g. `SCRIPT`, `SHOT_PLAN`, `IMAGE`, `*`. */
  type: string
  /** Whether a link into this input slot is optional (functional nodes). */
  optional?: boolean
  /**
   * Whether this slot carries SEVERAL values.
   * INPUT: accepts several simultaneous links (variadic). Every linked value
   * resolves in link-creation order and the family adapter composes the
   * ordered list (TEXT slots join with `\n\n`). Single-link slots instead
   * retire the old edge when a new one connects (replace-on-connect).
   * OUTPUT: the slot's artifact is an ordered LIST (the Cache node replays
   * every stored card through its variadic `media` slot); downstream input
   * resolution splices the list elements into the consumer's ordered value
   * list, so one edge can deliver many artifacts.
   */
  variadic?: boolean
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
export type NodeFamily = 'source' | 'generator' | 'combiner'

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
  /**
   * Whether the node supports skill imports (Phase-7 D7): the editor card
   * shows the Import button and persists `properties.importedSkills`
   * ({@link ImportedSkillRef}[]). Flagged on Text Input, the four generators,
   * and the six legacy step classes (kept as newbie shortcuts, D11).
   */
  supportsSkillImport?: boolean
  /**
   * Whether the canvas presents this node's several input slots as ONE visible
   * drop handle (a single "drop zone"). The slots stay distinct in the schema,
   * storage, and executor; only the rendering merges them. On connect the bridge
   * auto-routes each edge to the first input slot whose type is compatible with
   * the source output (TEXT -> `prompt`, IMAGE -> `image`, ...), so the user never
   * picks a port by hand. Also honored on a SINGLE-input node (the Video
   * Generator's unified REF slot): the merged render hides the per-port name
   * label, keeping the generator family's one-dot look consistent.
   */
  mergeInputs?: boolean
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
    supportsSkillImport: true,
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
    supportsSkillImport: true,
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
    supportsSkillImport: true,
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
    supportsSkillImport: true,
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
    supportsSkillImport: true,
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
    supportsSkillImport: true,
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
    description: 'Provide raw text (idea, request, script excerpt; markdown supported) to the graph.',
    category: 'movie/source',
    family: 'source',
    modality: 'text',
    supportsSkillImport: true,
    // Sources are the graph's ultimate roots: no input slots, so nothing can be
    // linked INTO a Text Input. (The phase-1 optional variadic `ref` slot was
    // removed once variadic TEXT inputs on generators made upstream chaining
    // into a source redundant.)
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
    supportsSkillImport: true,
    // Phase-2 vision: an IMAGE slot so an Image Input (or any IMAGE / ASSET /
    // STORYBOARD output) can be linked into the generator; the executor admits
    // the fetched bytes into the attachment store and sends them as image
    // blocks beside the prompt. `mergeInputs` collapses the two slots into ONE
    // canvas drop handle and auto-routes by type (TEXT -> context, IMAGE ->
    // image). The slot is APPENDED after `context` so saved graphs keep order.
    mergeInputs: true,
    inputs: [
      { name: 'context', type: 'TEXT', optional: true, variadic: true },
      { name: 'image', type: 'IMAGE', optional: true, variadic: true },
    ],
    outputs: [{ name: 'text', type: 'TEXT' }],
    // `model` is APPENDED (never inserted before `prompt`): saved graphs zip
    // widgets_values positionally, so prepending would shift every stored value.
    // Empty string = the executor's default model selection. The Studio editor
    // renders it as a top-of-card selector row (pick-mode jump), not a text box.
    widgets: [
      { name: 'prompt', type: 'STRING', multiline: true, default: '' },
      { name: 'model', type: 'STRING', default: '' },
    ],
  },
  {
    classType: 'ImageGenerator',
    displayName: 'Image Generator',
    description: 'Generate an image from text (text_to_image) or modify a linked image (image_to_image).',
    category: 'movie/generator',
    family: 'generator',
    modality: 'image',
    supportsSkillImport: true,
    mergeInputs: true,
    inputs: [
      { name: 'prompt', type: 'TEXT', optional: true, variadic: true },
      // Variadic: an Image Generator accepts SEVERAL reference images at once
      // (no more replace-on-connect dropping the second). They resolve to an
      // ORDERED array of refs; the active ComfyUI variant consumes the first as
      // its img2img init / face reference (the bundled templates each take one).
      { name: 'image', type: 'IMAGE', optional: true, variadic: true },
      // A craft skill wired in from an upstream Text Input (as opposed to one
      // imported onto the node, which the runner injects as `inputs.skills`).
      // APPENDED at index 2 so slot 0 (`prompt`) and slot 1 (`image`) keep their
      // meaning in every saved graph.
      { name: 'skill', type: 'TEXT', optional: true, variadic: true },
    ],
    outputs: [{ name: 'image', type: 'IMAGE' }],
    widgets: [
      { name: 'mode', type: 'COMBO', options: ['text_to_image', 'image_to_image'], default: 'text_to_image' },
      // Which installed image model runs the step. Each option is a whole
      // validated model bundle (weights + its paired VAE), never a raw
      // checkpoint name - see `comfy-templates.ts` `meta.vae`. `qwen` is the
      // default: Qwen-Image 20B is the strongest installed image model (and
      // handles typography/posters), while `sdxl` is the fast fallback and
      // `instantid` locks a face to a reference portrait.
      { name: 'variant', type: 'COMBO', options: ['sdxl', 'qwen', 'instantid'], default: 'qwen' },
      // Phase-3 image model selector: the pinned model id (a Plugins-catalog
      // checkpoint filename, e.g. `qwen_image_20B_*.safetensors`) picked via the
      // Studio editor's Select button. The executor maps it onto the bundled
      // template whose primary weight it is (`templateByModelFile`), so the
      // paired VAE travels with it; empty = the `variant` widget's bundle.
      // The editor hides `mode` (auto-derived from the linked reference) and
      // `variant` (superseded by this selector). APPENDED last so saved graphs'
      // positional `widgets_values` keep their meaning.
      { name: 'model', type: 'STRING', default: '' },
    ],
  },
  {
    classType: 'VideoGenerator',
    displayName: 'Video Generator',
    description: 'Render a video clip from text (text_to_video) or from a linked storyboard image (image_to_video).',
    category: 'movie/generator',
    family: 'generator',
    modality: 'video',
    supportsSkillImport: true,
    // Merged rendering (one centered dot, no port-name label) so the Video
    // Generator matches the other generators' single drop-zone look; the REF
    // slot accepts TEXT- and IMAGE-family links and routes by source type.
    mergeInputs: true,
    inputs: [
      // ONE mixed-modality reference slot: accepts any TEXT-family or
      // IMAGE-family link (supertype `REF`, special-cased in slotCompatible).
      // The gateway adapter routes each resolved link by its SOURCE output
      // type — text elements join into the `prompt` key, image elements
      // collect into the `image` key (exactly what the media providers
      // consume), so clip mode (t2v/i2v) still follows the wired storyboard
      // frame just like the old two-slot (`prompt` + `image`) layout.
      { name: 'in', type: 'REF', optional: true, variadic: true },
    ],
    outputs: [{ name: 'clip', type: 'VIDEO' }],
    widgets: [
      { name: 'mode', type: 'COMBO', options: ['text_to_video', 'image_to_video'], default: 'image_to_video' },
      // Clip length in seconds: 6 s default, 15 s ceiling. The ceiling is the
      // Wan frame budget (16 fps, 4n+1): 15 s = 241 frames, which the bundled
      // 832x480 Wan templates render frame-accurately on the H20 pool; the
      // Bailian video seam sends no duration at all (model-decided length).
      { name: 'duration', type: 'FLOAT', default: 6, min: 0.5, max: 15 },
      // Model selector (parity with the Image Generator): the pinned
      // Plugins-catalog weight filename picked via the Studio editor's Select
      // button. The executor maps it onto the bundled video template whose
      // primary weight it is, provided it agrees with the auto-derived mode
      // (the editor hides `mode`: a linked storyboard frame means i2v).
      // APPENDED last so saved graphs' positional `widgets_values` keep meaning.
      { name: 'model', type: 'STRING', default: '' },
    ],
  },
  {
    classType: 'AudioGenerator',
    displayName: 'Audio Generator',
    description: 'Generate sound effects or background music from a text description.',
    category: 'movie/generator',
    family: 'generator',
    modality: 'audio',
    supportsSkillImport: true,
    // Merged rendering (one centered dot, no port-name label) so the Audio
    // Generator matches the other generators' single drop-zone look.
    mergeInputs: true,
    inputs: [{ name: 'prompt', type: 'TEXT', optional: true, variadic: true }],
    outputs: [{ name: 'audio', type: 'AUDIO' }],
    widgets: [
      // Kept in the schema (saved graphs' positional `widgets_values` keep their
      // meaning) but hidden from the editor: the sound/music flavor follows the
      // pinned model and the prompt, so a selector would only compete with them.
      { name: 'kind', type: 'COMBO', options: ['sound', 'music'], default: 'sound' },
      // Model selector (parity with the other generators): the pinned
      // Plugins-catalog weight filename picked via the Studio editor's Select
      // button; the executor maps it onto the bundled Stable Audio template
      // whose primary weight it is. APPENDED last so saved graphs' positional
      // `widgets_values` keep their meaning.
      { name: 'model', type: 'STRING', default: '' },
    ],
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
    displayName: 'Effect',
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
  {
    classType: 'Cache',
    displayName: 'Cache',
    description:
      'Record every arriving upstream artifact as a persistent card (accumulated across runs, editable in the node editor); replay all cards downstream in card order.',
    category: 'movie/combiner',
    family: 'combiner',
    modality: 'video',
    // Same single drop-zone look as the Video Generator: one merged, variadic
    // wildcard input that accepts an edge from EVERY node with an output slot
    // (Save Output has none, so it is excluded by construction).
    mergeInputs: true,
    inputs: [{ name: 'in', type: '*', optional: true, variadic: true }],
    // Variadic OUTPUT: the slot's artifact is the ordered list of every stored
    // card's pieces; downstream resolution splices the list (see the Cache
    // branch in the combiner adapter).
    outputs: [{ name: 'media', type: '*', variadic: true }],
    widgets: [],
  },
]

/** Base media slot types (Phase-5 D2). */
export const MEDIA_SLOT_TYPES: readonly string[] = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO']

/** Wildcard slot type: compatible with every media type in either direction. */
export const ANY_SLOT_TYPE = '*'

/**
 * Mixed-modality reference supertype: a slot declaring `REF` accepts any
 * TEXT-family or IMAGE-family link (subtypes flow up: SCRIPT, SHOT_PLAN,
 * ASSET, STORYBOARD), letting ONE variadic input serve as a combined
 * prompt + reference-image port (the Video Generator's unified `in` slot).
 * Deliberately NOT an entry in {@link SUBTYPE_OF}: that table is
 * single-parent, and re-parenting TEXT/IMAGE under REF would reroute
 * `baseSlotType` (and with it slot coloring / modality inference) for every
 * text and image slot in the catalog. {@link slotCompatible} special-cases
 * the supertype instead.
 */
export const REF_SLOT_TYPE = 'REF'

/**
 * Subtype assignability table (Phase-5 D2): legacy step artifact types are
 * subtypes of their base media type. A link is compatible
 * when the source type equals the target type or is a subtype of it (never the
 * reverse), or when either side is {@link ANY_SLOT_TYPE}.
 */
export const SUBTYPE_OF: Readonly<Record<string, string>> = {
  SCRIPT: 'TEXT',
  SHOT_PLAN: 'TEXT',
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
  if (targetType === REF_SLOT_TYPE) {
    // The REF supertype widens to the TEXT and IMAGE families only; a VIDEO or
    // AUDIO source is rejected (a clip is a product, never a generator input).
    return sourceType === REF_SLOT_TYPE || slotCompatible(sourceType, 'TEXT') || slotCompatible(sourceType, 'IMAGE')
  }
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

/**
 * The `WorkflowNode.properties` key holding {@link ImportedSkillRef} entries
 * (Phase-7 D7). Additive persistence, same pattern as the phase-6 `contentRef`.
 */
export const IMPORTED_SKILLS_PROPERTY = 'importedSkills'

/**
 * Read a node's imported-skill refs out of arbitrary `properties` (Phase-7
 * D7). Tolerant reader for the runner's mode-2 re-fetch: malformed entries are
 * dropped instead of throwing, so a corrupted graph never fails a run.
 * @param properties - the node's `WorkflowNode.properties` bag.
 * @returns the well-formed {@link ImportedSkillRef} entries.
 */
export function importedSkillsOf(properties: Record<string, unknown> | undefined): ImportedSkillRef[] {
  const raw = properties?.[IMPORTED_SKILLS_PROPERTY]
  if (!Array.isArray(raw)) return []
  const refs: ImportedSkillRef[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as Record<string, unknown>
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.toolId !== 'string'
      || typeof candidate.version !== 'string'
      || typeof candidate.path !== 'string'
      || typeof candidate.downloadedAt !== 'number'
    ) continue
    refs.push({
      id: candidate.id,
      toolId: candidate.toolId,
      version: candidate.version,
      path: candidate.path,
      downloadedAt: candidate.downloadedAt,
    })
  }
  return refs
}

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
