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
 *    and slotCompatible honours subtyping, wildcard, and direction rules;
 *  - buildObjectInfo over the merged registry advertises all 21 class types,
 *    routes optional inputs to `input.optional`, and flags deprecated nodes;
 *  - templates: every class type is known, link endpoints exist, slot indices
 *    are in range, widget overrides match schema widgets, every link is
 *    type-compatible, movie-pipeline ends in SaveOutput, and the last step
 *    template is named Montage (D10).
 *
 * Run from the `server/` directory:
 *   node scripts/verify-node-registry.ts
 */

import {
  ANY_SLOT_TYPE,
  FUNCTIONAL_NODES,
  MEDIA_SLOT_TYPES,
  MOVIE_NODES,
  SUBTYPE_OF,
  WORKFLOW_TEMPLATES,
  buildObjectInfo,
  slotCompatible,
  templateById,
  type MovieNodeSchema,
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

// ── 4. object_info projection (D1/D2) ──

const info = buildObjectInfo(ALL_NODES)
check('object_info advertises all 21 class types', Object.keys(info).length === ALL_NODES.length, `got ${Object.keys(info).length}`)
check('object_info flags exactly the six legacy nodes deprecated', Object.entries(info).filter(([, entry]): boolean => entry.deprecated).length === 6)
check(
  'object_info routes optional inputs to input.optional',
  Object.keys(info['ImageGenerator']!.input.optional).sort().join(',') === 'image,prompt'
    && Object.keys(info['ImageGenerator']!.input.required).join(',') === 'mode',
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

process.stdout.write(failures === 0 ? '\nAll node-registry checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
