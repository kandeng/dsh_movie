/**
 * Plugins-marketplace contract verifier (Phase-7 P7-M1).
 *
 * Headless guard for the M1 protocol surface: the `plugins/*` Leg C namespace
 * must be typed and enumerated, the node registry must carry the additive
 * skill-import support flags WITHOUT any legacy deletion (D11), and the
 * `importedSkills` property reader must stay tolerant (D7 mode-2 re-fetch
 * never fails a run). Pure contract checks — no host required; the gateway
 * answers `unimplemented` for these methods until P7-M4.
 *
 * Asserts:
 *  - IMPLEMENTED_METHODS enumerates all ten `plugins/*` methods, and every
 *    entry is a valid `LegCMethod` (compile-time via the typed constant);
 *  - `methodFromApiPath` resolves the new namespace paths;
 *  - MOVIE_NODES still holds exactly the six deprecated legacy classes and
 *    FUNCTIONAL_NODES still holds 15 entries (no deletions, D11);
 *  - `supportsSkillImport` is flagged on exactly TextInput + the four
 *    generators + the six legacy classes (11), and on nothing else;
 *  - `buildObjectInfo` output is unchanged by the new schema field (it is not
 *    a widget/input and must not leak into `/object_info`);
 *  - `importedSkillsOf` tolerates undefined, non-array, and malformed
 *    entries, and preserves well-formed {@link ImportedSkillRef}s.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-plugins-contract.ts
 */

import {
  FUNCTIONAL_NODES,
  IMPLEMENTED_METHODS,
  IMPORTED_SKILLS_PROPERTY,
  MOVIE_NODES,
  buildObjectInfo,
  importedSkillsOf,
  methodFromApiPath,
  type ImportedSkillRef,
  type LegCMethod,
} from '../../protocol/src/index.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

// ── 1. the plugins/* namespace is typed and enumerated (D5) ──

const PLUGINS_METHODS: readonly LegCMethod[] = [
  'plugins/tools.list',
  'plugins/tools.install',
  'plugins/tools.uninstall',
  'plugins/tools.enable',
  'plugins/tools.status',
  'plugins/skills.search',
  'plugins/skills.profile',
  'plugins/skills.download',
  'plugins/skills.flag',
  'plugins/sources.status',
] as const

for (const method of PLUGINS_METHODS) {
  check(`IMPLEMENTED_METHODS enumerates "${method}"`, IMPLEMENTED_METHODS.includes(method))
}
check(
  'IMPLEMENTED_METHODS has exactly ten plugins/* entries',
  IMPLEMENTED_METHODS.filter((method): boolean => method.startsWith('plugins/')).length === PLUGINS_METHODS.length,
)
check(
  'the pre-phase-7 method list is untouched (22 entries)',
  IMPLEMENTED_METHODS.filter((method): boolean => !method.startsWith('plugins/')).length === 22,
  `got ${IMPLEMENTED_METHODS.filter((m): boolean => !m.startsWith('plugins/')).length}`,
)

// Path routing: POST /api/plugins/skills.search must resolve to the method
// name; the dotted two-segment convention keeps `methodFromApiPath` exact.
check(
  'methodFromApiPath resolves "/api/plugins/skills.search"',
  methodFromApiPath('/api/plugins/skills.search') === 'plugins/skills.search',
)
check(
  'methodFromApiPath resolves "plugins/tools.list" (no /api prefix)',
  methodFromApiPath('plugins/tools.list') === 'plugins/tools.list',
)

// ── 2. no legacy deletions (D11) ──

check('MOVIE_NODES still holds exactly six legacy classes', MOVIE_NODES.length === 6, `got ${MOVIE_NODES.length}`)
check(
  'every legacy class stays deprecated with step 1..6',
  MOVIE_NODES.every((node, index): boolean => node.deprecated === true && node.step === index + 1),
)
check('FUNCTIONAL_NODES still holds 15 entries', FUNCTIONAL_NODES.length === 15, `got ${FUNCTIONAL_NODES.length}`)

// ── 3. supportsSkillImport flags (D7: Text Input + generators + legacy six) ──

const EXPECTED_IMPORTERS: ReadonlySet<string> = new Set([
  'TextInput',
  'TextGenerator',
  'ImageGenerator',
  'VideoGenerator',
  'AudioGenerator',
  'MovieScript',
  'MovieShotPlan',
  'MovieAsset',
  'MovieStoryboard',
  'MovieClip',
  'MovieAssemble',
])
const ALL = [...MOVIE_NODES, ...FUNCTIONAL_NODES]
const flagged = ALL.filter((node): boolean => node.supportsSkillImport === true).map((node): string => node.classType)
check(
  `exactly ${EXPECTED_IMPORTERS.size} classes support skill import`,
  flagged.length === EXPECTED_IMPORTERS.size && flagged.every((classType): boolean => EXPECTED_IMPORTERS.has(classType)),
  `got [${flagged.join(', ')}]`,
)
check(
  'reviewers/combiners/other sources do NOT support skill import',
  ALL.filter((node): boolean => node.supportsSkillImport !== true)
    .every((node): boolean => !EXPECTED_IMPORTERS.has(node.classType)),
)

// ── 4. object_info is unaffected by the new schema field ──

const info = buildObjectInfo(ALL)
check('buildObjectInfo advertises all 21 class types', Object.keys(info).length === 21, `got ${Object.keys(info).length}`)
check(
  'supportsSkillImport never leaks into object_info entries',
  Object.values(info).every((entry): boolean => !JSON.stringify(entry).includes('supportsSkillImport')),
)

// ── 5. the importedSkills property reader stays tolerant (D7 mode 2) ──

const VALID: ImportedSkillRef = {
  id: 'curated:sw-mckee-story',
  toolId: 'builtin-curated',
  version: '1.2.0',
  path: 'skills/curated:sw-mckee-story.md',
  downloadedAt: 1_786_000_000_000,
}
check('importedSkillsOf(undefined) is empty', importedSkillsOf(undefined).length === 0)
check('importedSkillsOf({}) is empty', importedSkillsOf({}).length === 0)
check(
  'importedSkillsOf rejects a non-array property',
  importedSkillsOf({ [IMPORTED_SKILLS_PROPERTY]: 'nope' }).length === 0,
)
check(
  'importedSkillsOf drops malformed entries but keeps valid ones',
  (() => {
    const refs = importedSkillsOf({
      [IMPORTED_SKILLS_PROPERTY]: [null, 42, { id: 'x' }, { ...VALID }, { ...VALID, downloadedAt: 'later' }],
    })
    return refs.length === 1 && refs[0]!.id === VALID.id && refs[0]!.path === VALID.path
  })(),
)
check('IMPORTED_SKILLS_PROPERTY is "importedSkills"', IMPORTED_SKILLS_PROPERTY === 'importedSkills')

process.stdout.write(failures === 0 ? '\nverify-plugins-contract: ALL PASS\n' : `\nverify-plugins-contract: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
