/**
 * Fixture skill-source B (Phase-7 P7-M3 acceptance).
 *
 * A real, spawnable MCP stdio source server serving a canned skill set. It adds
 * two behaviours the acceptance needs:
 *
 * - A **rate-limit simulator**: for any given query, the first `skills/search`
 *   answers normally and every subsequent call for that same query returns
 *   `rateLimited: true` with an empty list. This lets `verify-plugins-search.ts`
 *   prove the host index is **cache-first** (R11): the second search still
 *   returns B's skills from the host cache and marks B `degraded`.
 * - A skill whose description carries an **external URL** so the scanner must
 *   raise yellow, plus a `provider: Community` duplicate of fixture A's
 *   "Hero's Journey Script" so the index must dedup.
 *
 * Runs offline (empty network allow-list) — no egress needed.
 *
 * @module dsh-movie-market/fixture-source-b
 */

import type {
  SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord,
} from '../src/adapters/contract.ts'
import { runSourceServer } from '../src/adapters/sourceAdapter.ts'

const PROVIDER = 'Source B'

/** The canned skill set for fixture B. */
const SKILLS: readonly SourceSkillRecord[] = [
  {
    slug: 'b-shot-plan',
    title: 'Shot Plan Builder',
    description: 'Build a shot plan and shot list with framing, angles, and coverage',
    target: 'shot-plan',
    version: '1.0.0',
    license: 'MIT',
    provider: PROVIDER,
    relevance: 0.95,
  },
  {
    slug: 'b-heroes',
    title: "Hero's Journey Script",
    description: 'Community beat template for a mythic literary script arc',
    target: 'script',
    version: '0.8.0',
    license: 'MIT',
    provider: 'Community',
    relevance: 0.4,
  },
  {
    slug: 'b-storyboard',
    title: 'Storyboard Reference',
    description: 'Storyboard conventions guide, see https://example.com/storyboard for details',
    target: 'shot-plan',
    version: '1.1.0',
    license: null,
    provider: PROVIDER,
    relevance: 0.7,
  },
]

/** Per-query call counts, driving the rate-limit simulator. */
const callCounts = new Map<string, number>()

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
  { name: 'fixture-source-b', version: '0.1.0', instructions: 'canned skill source B (rate-limit simulator)' },
  {
    async search(q: string): Promise<SourceSearchResult> {
      const key = q.trim().toLowerCase()
      const count = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, count)
      if (count >= 2) {
        // Simulate an exhausted upstream budget on the 2nd+ call for a query.
        return { skills: [], rateLimited: true, message: 'fixture B rate limit (2nd call)' }
      }
      return { skills: SKILLS.map((s): SourceSkillRecord => ({ ...s })) }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      return { skill: find(slug) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const record = find(slug)
      if (record === null) throw new Error(`no skill '${slug}' in fixture B`)
      return { slug, version: record.version, body: bodyOf(record), license: record.license, provider: record.provider }
    },
  },
)
