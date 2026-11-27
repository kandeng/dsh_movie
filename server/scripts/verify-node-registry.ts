/**
 * Node registry v2 conformance verifier (Phase-5 P5-M0).
 *
 * Headless guard for the two-layer palette decisions D1/D2/D3/D6/D10: the
 * functional catalog, the slot-type system, the object_info projection, and the
 * workflow templates must stay internally consistent, because the client
 * palette, the gateway validator, and the LiteGraph bridge all read the same
 * protocol constants. Pure registry checks — no host required.
 *
 * Asserts:
 *  - FUNCTIONAL_NODES: exactly 15 entries, each with family + modality, no
 *    step, covering the role × modality grid (4 sources / 4 generators /
 *    4 reviewers / 3 combiners);
 *  - MOVIE_NODES: the six legacy step nodes keep step 1..6, are all
 *    `deprecated: true`, and carry no family/modality;
 *  - slot system: SUBTYPE_OF is acyclic with base values in MEDIA_SLOT_TYPES,
 *    and slotCompatible honours subtyping, wildcard, direction rules, and the
 *    mixed-modality REF supertype;
 *  - buildObjectInfo over the merged registry advertises all 21 class types,
 *    routes optional inputs to `input.optional`, and flags deprecated nodes;
 *  - templates: every class type is known, link endpoints exist, slot indices
 *    are in range, widget overrides match schema widgets, every link is
 *    type-compatible, movie-pipeline ends in SaveOutput, and the last step
 *    template is named Montage (D10);
 *  - migrateGraph: legacy VideoGenerator graphs (two input slots) converge
 *    onto the unified REF slot, idempotently and without touching other nodes.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-node-registry.ts
 */

import {
  ANY_SLOT_TYPE,
  FUNCTIONAL_NODES,
  MEDIA_SLOT_TYPES,
  MOVIE_NODES,
  REF_SLOT_TYPE,
  SUBTYPE_OF,
  WORKFLOW_TEMPLATES,
  buildObjectInfo,
  migrateGraph,
  slotCompatible,
  templateById,
  type MovieNodeSchema,
  type WorkflowGraph,
} from '../../protocol/src/index.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

const ALL_NODES: readonly MovieNodeSchema[] = [...MOVIE_NODES, ...FUNCTIONAL_NODES]
const byClassType = new Map<string, MovieNodeSchema>(ALL_NODES.map((node): [string, MovieNodeSchema] => [node.classType, node]))

// ── 1. functional catalog: the 15-class role × modality grid (D3) ──

check('FUNCTIONAL_NODES has exactly 15 entries', FUNCTIONAL_NODES.length === 15, `got ${FUNCTIONAL_NODES.length}`)
check(
  'every functional node declares family + modality and no step',
  FUNCTIONAL_NODES.every((node): boolean => node.family !== undefined && node.modality !== undefined && node.step === undefined),
)
check(
  'functional class types are unique across the whole registry',
  new Set(ALL_NODES.map((node): string => node.classType)).size === ALL_NODES.length,
)

const GRID: Readonly<Record<string, number>> = { source: 4, generator: 4, reviewer: 4, combiner: 3 }
for (const [family, expected] of Object.entries(GRID)) {
  const members = FUNCTIONAL_NODES.filter((node): boolean => node.family === family)
  check(`family "${family}" has ${expected} classes`, members.length === expected, `got ${members.length}`)
}
const MODALITIES = ['text', 'image', 'video', 'audio'] as const
for (const family of ['source', 'generator', 'reviewer'] as const) {
  for (const modality of MODALITIES) {
    const hit = FUNCTIONAL_NODES.some((node): boolean => node.family === family && node.modality === modality)
    check(`grid cell ${family}/${modality} exists`, hit)
  }
}

// Reviewers: one required typed input, verdict + forwarded artifact out (D3).
for (const modality of MODALITIES) {
  const reviewer = FUNCTIONAL_NODES.find((node): boolean => node.family === 'reviewer' && node.modality === modality)
  const ok = reviewer !== undefined
    && reviewer.inputs.length === 1 && reviewer.inputs[0]!.optional !== true
    && reviewer.outputs.length === 2 && reviewer.outputs[0]!.type === 'VERDICT'
    && reviewer.outputs[1]!.type === reviewer.inputs[0]!.type
  check(`reviewer/${modality} shape (1 required in, verdict + passthrough out)`, ok)
}

// ── 2. legacy step nodes: deprecated but still executable aliases (D1) ──

check('MOVIE_NODES has the six legacy step nodes', MOVIE_NODES.length === 6, `got ${MOVIE_NODES.length}`)
check(
  'legacy nodes keep steps 1..6 and are all deprecated',
  MOVIE_NODES.every((node): boolean => node.step !== undefined && node.deprecated === true)
    && new Set(MOVIE_NODES.map((node): number => node.step!)).size === 6,
)
check(
  'legacy nodes carry no family/modality',
  MOVIE_NODES.every((node): boolean => node.family === undefined && node.modality === undefined),
)

// ── 3. slot-type system (D2) ──

check('SUBTYPE_OF parents are all base media types', Object.values(SUBTYPE_OF).every((parent): boolean => MEDIA_SLOT_TYPES.includes(parent)))
check(
  'SUBTYPE_OF is acyclic (chains terminate at a base type)',
  Object.keys(SUBTYPE_OF).every((type): boolean => {
    let current: string | undefined = type
    for (let depth = 0; depth < 8; depth += 1) {
      if (current === undefined) return true
      current = SUBTYPE_OF[current]
    }
    return false
  }),
)
check('base types are not subtypes of anything', MEDIA_SLOT_TYPES.every((type): boolean => SUBTYPE_OF[type] === undefined))
check('slotCompatible: SCRIPT → TEXT (subtype flows up)', slotCompatible('SCRIPT', 'TEXT'))
check('slotCompatible: TEXT → SCRIPT rejected (no widening to subtype)', !slotCompatible('TEXT', 'SCRIPT'))
check('slotCompatible: MOVIE → VIDEO', slotCompatible('MOVIE', 'VIDEO'))
check('slotCompatible: AUDIO → TEXT rejected (cross-modality)', !slotCompatible('AUDIO', 'TEXT'))
check(`slotCompatible: wildcard source ${ANY_SLOT_TYPE} → TEXT`, slotCompatible(ANY_SLOT_TYPE, 'TEXT'))
check(`slotCompatible: IMAGE → wildcard target ${ANY_SLOT_TYPE}`, slotCompatible('IMAGE', ANY_SLOT_TYPE))
check('slotCompatible: identity TEXT → TEXT', slotCompatible('TEXT', 'TEXT'))
check(`slotCompatible: TEXT → ${REF_SLOT_TYPE} (supertype widens to the text family)`, slotCompatible('TEXT', REF_SLOT_TYPE))
check(`slotCompatible: SHOT_PLAN → ${REF_SLOT_TYPE} (subtypes flow up transitively)`, slotCompatible('SHOT_PLAN', REF_SLOT_TYPE))
check(`slotCompatible: STORYBOARD → ${REF_SLOT_TYPE} (image family)`, slotCompatible('STORYBOARD', REF_SLOT_TYPE))
check(`slotCompatible: VIDEO → ${REF_SLOT_TYPE} rejected (a clip is never a generator input)`, !slotCompatible('VIDEO', REF_SLOT_TYPE))
check(`slotCompatible: ${REF_SLOT_TYPE} → TEXT rejected (no narrowing from the supertype)`, !slotCompatible(REF_SLOT_TYPE, 'TEXT'))
check(`slotCompatible: wildcard source ${ANY_SLOT_TYPE} → ${REF_SLOT_TYPE}`, slotCompatible(ANY_SLOT_TYPE, REF_SLOT_TYPE))

// ── 4. object_info projection (D1/D2) ──

const info = buildObjectInfo(ALL_NODES)
check('object_info advertises all 21 class types', Object.keys(info).length === ALL_NODES.length, `got ${Object.keys(info).length}`)
check('object_info flags exactly the six legacy nodes deprecated', Object.entries(info).filter(([, entry]): boolean => entry.deprecated).length === 6)
check(
  'object_info routes optional inputs to input.optional',
  // ImageGenerator carries the model-selector widgets (`variant` COMBO plus
  // the appended STRING `model`, both → input.required) and its optional
  // input slots (→ input.optional).
  Object.keys(info['ImageGenerator']!.input.optional).sort().join(',') === 'image,prompt,skill'
    && Object.keys(info['ImageGenerator']!.input.required).sort().join(',') === 'mode,model,variant',
)
check(
  'object_info: VideoGenerator advertises the unified REF slot and requires mode, duration and the appended model widget',
  Object.keys(info['VideoGenerator']!.input.optional).sort().join(',') === 'in'
    && Object.keys(info['VideoGenerator']!.input.required).sort().join(',') === 'duration,mode,model',
)
check(
  'object_info advertises the variant COMBO with its options and qwen default',
  JSON.stringify(info['ImageGenerator']!.input.required['variant'])
    === JSON.stringify([['sdxl', 'qwen', 'instantid'], { default: 'qwen' }]),
)
check(
  'object_info keeps required inputs in input.required',
  Object.keys(info['TextReviewer']!.input.required).join(',') === 'criteria,text'
    && Object.keys(info['TextReviewer']!.input.optional).length === 0,
)
check('object_info marks SaveOutput as output node', info['SaveOutput']!.output_node && info['SaveOutput']!.is_output_node)

// ── 5. templates (D6/D10) ──

check('WORKFLOW_TEMPLATES has 7 templates (6 steps + movie-pipeline)', WORKFLOW_TEMPLATES.length === 7, `got ${WORKFLOW_TEMPLATES.length}`)
check('template ids are unique', new Set(WORKFLOW_TEMPLATES.map((template): string => template.id)).size === WORKFLOW_TEMPLATES.length)
check('step-montage is named Montage (D10)', templateById('step-montage')?.displayName === 'Montage')

for (const template of WORKFLOW_TEMPLATES) {
  const keys = new Set(template.nodes.map((node): string => node.key))
  check(`template ${template.id}: node keys unique`, keys.size === template.nodes.length)

  const unknownClass = template.nodes.find((node): boolean => byClassType.get(node.classType) === undefined)
  check(`template ${template.id}: all class types known`, unknownClass === undefined, unknownClass?.classType ?? '')

  const badWidgets = template.nodes.filter((node): boolean => {
    const schema = byClassType.get(node.classType)
    if (schema === undefined || node.widgets === undefined) return false
    const names = new Set(schema.widgets.map((widget): string => widget.name))
    return Object.keys(node.widgets).some((key): boolean => !names.has(key))
  })
  check(`template ${template.id}: widget overrides match schema`, badWidgets.length === 0, badWidgets.map((node): string => node.key).join(','))

  const problems: string[] = []
  for (const link of template.links) {
    const source = byClassType.get(template.nodes.find((node): boolean => node.key === link.from)?.classType ?? '')
    const target = byClassType.get(template.nodes.find((node): boolean => node.key === link.to)?.classType ?? '')
    if (source === undefined || target === undefined) { problems.push(`${link.from}->${link.to}: unknown endpoint`); continue }
    const outSlot = source.outputs[link.fromSlot]
    const inSlot = target.inputs[link.toSlot]
    if (outSlot === undefined || inSlot === undefined) { problems.push(`${link.from}->${link.to}: slot out of range`); continue }
    if (!slotCompatible(outSlot.type, inSlot.type)) problems.push(`${link.from}->${link.to}: ${outSlot.type} incompatible with ${inSlot.type}`)
  }
  check(`template ${template.id}: links type-compatible and in range`, problems.length === 0, problems.join('; '))
}

const pipeline = templateById('movie-pipeline')
check('movie-pipeline exists', pipeline !== undefined)
if (pipeline !== undefined) {
  check('movie-pipeline has ≥7 nodes', pipeline.nodes.length >= 7, `got ${pipeline.nodes.length}`)
  const terminalKeys = new Set(pipeline.links.map((link): string => link.to))
  const sinks = pipeline.nodes.filter((node): boolean => !pipeline.links.some((link): boolean => link.from === node.key))
  check(
    'movie-pipeline ends in exactly one SaveOutput sink',
    sinks.length === 1 && sinks[0]!.classType === 'SaveOutput' && terminalKeys.has(sinks[0]!.key),
    sinks.map((node): string => node.classType).join(','),
  )
  check(
    'movie-pipeline has a fork (script feeds shot + asset)',
    pipeline.links.filter((link): boolean => link.from === 'script').length === 2,
  )
}

// ── 6. step-asset: the three-node titled asset template (Task 5) ──
// Two Text Inputs of the SAME class type must be told apart on the canvas, so the
// template carries `title` overrides; the skill wires into the generator's input
// slot 2 (`skill`) and the generator defaults to the qwen variant.
const asset = templateById('step-asset')
check('step-asset exists', asset !== undefined)
if (asset !== undefined) {
  check('step-asset drops three nodes', asset.nodes.length === 3, `got ${asset.nodes.length}`)
  const titled = asset.nodes.map((node): string => node.title ?? '(untitled)')
  check(
    'step-asset labels its two Text Inputs Prompt / Skill and leaves the generator untitled',
    titled.join(',') === 'Prompt,Skill,(untitled)',
    titled.join(','),
  )
  const assetGen = asset.nodes.find((node): boolean => node.key === 'gen')
  check(
    'step-asset generator defaults to the qwen variant',
    assetGen?.widgets?.variant === 'qwen',
    String(assetGen?.widgets?.variant),
  )
  const genInputs = assetGen === undefined ? [] : (byClassType.get(assetGen.classType)?.inputs ?? [])
  const skillLink = asset.links.find((link): boolean => link.toSlot === 2)
  check(
    'step-asset wires the Skill input into generator slot 2 (`skill`)',
    skillLink?.from === 'skill' && genInputs[2]?.name === 'skill',
    `${skillLink?.from ?? '?'} -> slot 2 (${genInputs[2]?.name ?? '?'})`,
  )
  const promptLink = asset.links.find((link): boolean => link.toSlot === 0)
  check(
    'step-asset wires the Prompt input into generator slot 0 (`prompt`)',
    promptLink?.from === 'in' && genInputs[0]?.name === 'prompt',
    `${promptLink?.from ?? '?'} -> slot 0 (${genInputs[0]?.name ?? '?'})`,
  )
}

// ── 7. unified REF slot + legacy-graph migration ──

const video = byClassType.get('VideoGenerator')
check(
  'VideoGenerator declares exactly one variadic REF input named `in`',
  video?.inputs.length === 1
    && video.inputs[0]!.name === 'in'
    && video.inputs[0]!.type === REF_SLOT_TYPE
    && video.inputs[0]!.variadic === true,
  (video?.inputs ?? []).map((slot): string => `${slot.name}:${slot.type}`).join(','),
)

const legacyGraph: WorkflowGraph = {
  last_node_id: 3,
  last_link_id: 2,
  nodes: [
    { id: 1, type: 'TextInput', pos: [0, 0], size: [230, 130], flags: 0, order: 0, mode: 0, outputs: [{ name: 'text', type: 'TEXT', link: 1, links: [1], slot_index: 0 }] },
    { id: 2, type: 'ImageGenerator', pos: [0, 150], size: [230, 130], flags: 0, order: 1, mode: 0, outputs: [{ name: 'image', type: 'IMAGE', link: 2, links: [2], slot_index: 0 }] },
    {
      id: 3,
      type: 'VideoGenerator',
      pos: [260, 70],
      size: [230, 130],
      flags: 0,
      order: 2,
      mode: 0,
      inputs: [
        { name: 'prompt', type: 'TEXT', link: 1 },
        { name: 'image', type: 'IMAGE', link: 2 },
      ],
      outputs: [{ name: 'clip', type: 'VIDEO', link: null }],
    },
  ],
  links: [
    [1, 1, 0, 3, 0],
    [2, 2, 0, 3, 1],
  ],
}
const migrated = migrateGraph(legacyGraph)
check(
  'migrateGraph folds legacy VideoGenerator slot-1 links onto the unified slot 0',
  migrated.links?.length === 2 && migrated.links.every((tuple): boolean => Number(tuple[4]) === 0),
  JSON.stringify(migrated.links),
)
const migratedVideo = migrated.nodes.find((node): boolean => node.type === 'VideoGenerator')
check(
  'migrateGraph rewrites the stored inputs to one REF slot whose primary link is the oldest',
  migratedVideo?.inputs?.length === 1
    && migratedVideo.inputs[0]!.name === 'in'
    && migratedVideo.inputs[0]!.type === REF_SLOT_TYPE
    && migratedVideo.inputs[0]!.link === 1,
  JSON.stringify(migratedVideo?.inputs),
)
check('migrateGraph is idempotent (re-running returns the same object)', migrateGraph(migrated) === migrated)
const untouched: WorkflowGraph = { nodes: [{ id: 1, type: 'TextInput', pos: [0, 0], size: [230, 130], flags: 0, order: 0, mode: 0 }], links: [] }
check('migrateGraph passes graphs without unified classes through unchanged', migrateGraph(untouched) === untouched)

process.stdout.write(failures === 0 ? '\nAll node-registry checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
