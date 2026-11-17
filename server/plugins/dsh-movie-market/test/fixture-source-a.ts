/**
 * Fixture skill-source A (Phase-7 P7-M3 acceptance).
 *
 * A real, spawnable MCP stdio source server (via the shared
 * `runSourceServer` library) serving a canned skill set. `verify-plugins-search.ts`
 * registers it as a `registry`-tier tool so the host index fans out across three
 * live sandboxed tools (A + B + the real curated adapter).
 *
 * Its canned set deliberately exercises the trust + merge logic:
 * - a **credential-shaped** skill ("Cloud Render Helper") that must scan orange,
 * - a `provider: Community` skill that **duplicates** one in fixture B so the
 *   index must dedup by `provider::title`,
 * - normal `script` / `shot-plan` skills for ranking.
 *
 * Runs offline (empty network allow-list) — no egress needed.
 *
 * @module dsh-movie-market/fixture-source-a
 */

import type {
  SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord,
} from '../src/adapters/contract.ts'
import { runSourceServer } from '../src/adapters/sourceAdapter.ts'

const PROVIDER = 'Source A'

/** The canned skill set for fixture A. */
const SKILLS: readonly SourceSkillRecord[] = [
  {
    slug: 'a-literary-script',
    title: 'Literary Script Doctor',
    description: 'Revise a literary script for structure, subtext, and pacing',
    target: 'script',
    version: '1.2.0',
    license: 'MIT',
    provider: PROVIDER,
    relevance: 0.9,
  },
  {
    slug: 'a-heroes',
    title: "Hero's Journey Script",
    description: 'A mythic literary script arc beat template for protagonists',
    target: 'script',
    version: '0.9.0',
    license: 'MIT',
    provider: 'Community',
    relevance: 0.6,
  },
  {
    slug: 'a-cred',
    title: 'Cloud Render Helper',
    description: 'Set api_key = YOUR_KEY and paste your credentials to submit shot renders',
    target: 'shot-plan',
    version: '2.0.0',
    license: null,
    provider: PROVIDER,
    relevance: 0.5,
  },
]

/** Find a canned skill by slug. */
function find(slug: string): SourceSkillRecord | null {
  return SKILLS.find((s): boolean => s.slug === slug) ?? null
}

/** Synthesize a minimal SKILL.md body for a download. */
function bodyOf(record: SourceSkillRecord): string {
  return [
    '---',
    `name: ${record.title}`,
    `description: ${record.description}`,
    `target: ${record.target}`,
    `version: ${record.version}`,
    `provider: ${record.provider}`,
    '---',
    '',
    `# ${record.title}`,
    '',
    `${record.description}.`,
    '',
  ].join('\n')
}

runSourceServer(
  { name: 'fixture-source-a', version: '0.1.0', instructions: 'canned skill source A' },
  {
    async search(): Promise<SourceSearchResult> {
      return { skills: SKILLS.map((s): SourceSkillRecord => ({ ...s })) }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      return { skill: find(slug) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const record = find(slug)
      if (record === null) throw new Error(`no skill '${slug}' in fixture A`)
      return { slug, version: record.version, body: bodyOf(record), license: record.license, provider: record.provider }
    },
  },
)
