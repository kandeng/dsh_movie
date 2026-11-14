/**
 * Workflow templates (Phase-5 D6/D10): pre-wired functional subgraphs that the
 * client palette's Templates branch (and the one-click pipeline button) expands
 * at drop time into fresh node ids.
 *
 * A template is pure data: local node keys, class types from the functional
 * catalog, canvas layout offsets, widget overrides, and internal links. After
 * expansion the inserted nodes are ordinary graph nodes — the server never sees
 * templates (D6), so nothing here affects validation, topo order, or execution.
 *
 * @module @dsh-movie/protocol/templates
 */

/** One node of a template, keyed locally; expansion assigns real graph ids. */
export interface TemplateNodeSpec {
  /** Template-local key referenced by {@link TemplateLinkSpec}. */
  key: string
  /** Functional catalog `class_type` to instantiate. */
  classType: string
  /** Canvas position offset in pixels, relative to the drop origin. */
  pos: [number, number]
  /** Widget values overriding the class defaults. */
  widgets?: Record<string, string | number | boolean>
}

/** One internal link of a template, between template-local node keys. */
export interface TemplateLinkSpec {
  /** Source node key. */
  from: string
  /** Source output slot index (0-based). */
  fromSlot: number
  /** Target node key. */
  to: string
  /** Target input slot index (0-based). */
  toSlot: number
}

/** A pre-wired functional subgraph the palette can drop onto the canvas. */
export interface WorkflowTemplate {
  /** Stable template id, e.g. `step-script`, `movie-pipeline`. */
  id: string
  /** Human-readable palette label (D10: the last step is named Montage). */
  displayName: string
  /** Tooltip / description text. */
  description: string
  /** The nodes to instantiate. */
  nodes: readonly TemplateNodeSpec[]
  /** The internal links to wire after instantiation. */
  links: readonly TemplateLinkSpec[]
}

/** The six movie steps as single-purpose templates over functional nodes. */
export const STEP_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'step-script',
    displayName: 'Script',
    description: 'Text input → text generator: write the story script from a prompt.',
    nodes: [
      { key: 'in', classType: 'TextInput', pos: [0, 0] },
      { key: 'gen', classType: 'TextGenerator', pos: [260, 0] },
    ],
    links: [{ from: 'in', fromSlot: 0, to: 'gen', toSlot: 0 }],
  },
  {
    id: 'step-shot-plan',
    displayName: 'Shot Plan',
    description: 'Text input → text generator: break the script into a shot-by-shot plan.',
    nodes: [
      { key: 'in', classType: 'TextInput', pos: [0, 0] },
      {
        key: 'gen',
        classType: 'TextGenerator',
        pos: [260, 0],
        widgets: { prompt: 'Break the linked script into a shot-by-shot plan.' },
      },
    ],
    links: [{ from: 'in', fromSlot: 0, to: 'gen', toSlot: 0 }],
  },
  {
    id: 'step-asset',
    displayName: 'Character / Scene Asset',
    description: 'Text input → image generator: produce character, scene, or prop assets.',
    nodes: [
      { key: 'in', classType: 'TextInput', pos: [0, 0] },
      {
        key: 'gen',
        classType: 'ImageGenerator',
        pos: [260, 0],
        widgets: { mode: 'text_to_image' },
      },
    ],
    links: [{ from: 'in', fromSlot: 0, to: 'gen', toSlot: 0 }],
  },
  {
    id: 'step-storyboard',
    displayName: 'Storyboard',
    description: 'Shot-plan text + asset image → image generator: compose storyboard frames.',
    nodes: [
      { key: 'plan', classType: 'TextInput', pos: [0, 0] },
      { key: 'asset', classType: 'ImageInput', pos: [0, 150] },
      {
        key: 'gen',
        classType: 'ImageGenerator',
        pos: [260, 70],
        widgets: { mode: 'image_to_image' },
      },
    ],
    links: [
      { from: 'plan', fromSlot: 0, to: 'gen', toSlot: 0 },
      { from: 'asset', fromSlot: 0, to: 'gen', toSlot: 1 },
    ],
  },
  {
    id: 'step-clip',
    displayName: 'Clip',
    description: 'Storyboard image + shot text → video generator: render an animated clip.',
    nodes: [
      { key: 'shot', classType: 'TextInput', pos: [0, 0] },
      { key: 'board', classType: 'ImageInput', pos: [0, 150] },
      {
        key: 'gen',
        classType: 'VideoGenerator',
        pos: [260, 70],
        widgets: { mode: 'image_to_video', duration: 4 },
      },
    ],
    links: [
      { from: 'shot', fromSlot: 0, to: 'gen', toSlot: 0 },
      { from: 'board', fromSlot: 0, to: 'gen', toSlot: 1 },
    ],
  },
  {
    id: 'step-montage',
    displayName: 'Montage',
    description: 'Two clips → media concat → save: assemble the final movie.',
    nodes: [
      { key: 'a', classType: 'VideoInput', pos: [0, 0] },
      { key: 'b', classType: 'VideoInput', pos: [0, 150] },
      { key: 'concat', classType: 'MediaConcat', pos: [260, 70] },
      { key: 'save', classType: 'SaveOutput', pos: [520, 70] },
    ],
    links: [
      { from: 'a', fromSlot: 0, to: 'concat', toSlot: 0 },
      { from: 'b', fromSlot: 0, to: 'concat', toSlot: 1 },
      { from: 'concat', fromSlot: 0, to: 'save', toSlot: 0 },
    ],
  },
]

/**
 * The full movie pipeline as one template (the one-click 一键生成 expansion):
 * prompt → script → shot plan → assets → storyboard → clip → montage → save.
 */
export const MOVIE_PIPELINE_TEMPLATE: WorkflowTemplate = {
  id: 'movie-pipeline',
  displayName: 'Movie Pipeline',
  description: 'The complete six-step movie pipeline as a pre-wired functional graph.',
  nodes: [
    { key: 'prompt', classType: 'TextInput', pos: [0, 70] },
    { key: 'script', classType: 'TextGenerator', pos: [260, 70] },
    {
      key: 'shot',
      classType: 'TextGenerator',
      pos: [520, 70],
      widgets: { prompt: 'Break the linked script into a shot-by-shot plan.' },
    },
    {
      key: 'asset',
      classType: 'ImageGenerator',
      pos: [780, 0],
      widgets: { mode: 'text_to_image' },
    },
    {
      key: 'board',
      classType: 'ImageGenerator',
      pos: [1040, 70],
      widgets: { mode: 'image_to_image' },
    },
    {
      key: 'clip',
      classType: 'VideoGenerator',
      pos: [1300, 70],
      widgets: { mode: 'image_to_video', duration: 4 },
    },
    { key: 'montage', classType: 'MediaConcat', pos: [1560, 70] },
    { key: 'save', classType: 'SaveOutput', pos: [1820, 70] },
  ],
  links: [
    { from: 'prompt', fromSlot: 0, to: 'script', toSlot: 0 },
    { from: 'script', fromSlot: 0, to: 'shot', toSlot: 0 },
    { from: 'script', fromSlot: 0, to: 'asset', toSlot: 0 },
    { from: 'shot', fromSlot: 0, to: 'board', toSlot: 0 },
    { from: 'asset', fromSlot: 0, to: 'board', toSlot: 1 },
    { from: 'shot', fromSlot: 0, to: 'clip', toSlot: 0 },
    { from: 'board', fromSlot: 0, to: 'clip', toSlot: 1 },
    { from: 'clip', fromSlot: 0, to: 'montage', toSlot: 0 },
    { from: 'montage', fromSlot: 0, to: 'save', toSlot: 0 },
  ],
}

/** Every palette template: the six steps plus the full pipeline. */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  ...STEP_TEMPLATES,
  MOVIE_PIPELINE_TEMPLATE,
]

/**
 * Look up a template by id.
 * @param id - the template id, e.g. `movie-pipeline`.
 * @returns the template, or `undefined` when unknown.
 */
export function templateById(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template): boolean => template.id === id)
}
