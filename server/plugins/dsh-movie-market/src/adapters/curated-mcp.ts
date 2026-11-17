/**
 * The curated craft-suite adapter (Phase-7 D4/D13) — the offline, zero-config
 * floor of the marketplace.
 *
 * It serves the vendored first-party SKILL.md suite from
 * `DSH_CURATED_SKILLS_DIR` (set by `builtinTools.ts` to the plugin's `skills/`
 * dir, an absolute host path that stays valid inside the bwrap `--ro-bind / /`
 * sandbox). The tool runs with an **empty** network allow-list, so it is spawned
 * in a private netns with hard egress deny — it can only ever read its own
 * bundled files.
 *
 * Because the suite is first-party and offline, its records earn the `curated`
 * trust tier (weight 1.0) at the host index; this adapter stays stateless and
 * never assigns ids or warning levels (the host does).
 *
 * @module dsh-movie-market/adapters/curated-mcp
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord } from './contract.ts'
import { parseSkill, recordFromSkill } from './frontmatter.ts'
import { runSourceServer } from './sourceAdapter.ts'

/** The vendored suite dir (injected by the spawn spec). */
const SKILLS_DIR = process.env['DSH_CURATED_SKILLS_DIR'] ?? ''
/** Provider label for records whose front-matter omits one. */
const PROVIDER = 'dsh_movie curated'

/** Tokenize free text into lowercase alphanumeric words. */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t): boolean => t !== '')
}

/** Fraction of query tokens present in the haystack (0..1). */
function relevance(query: string, record: SourceSkillRecord): number {
  const q = tokens(query)
  if (q.length === 0) return 0.5 // empty query → neutral, still list the suite
  const hay = new Set(tokens(`${record.title} ${record.description}`))
  const hit = q.filter((t): boolean => hay.has(t)).length
  return hit / q.length
}

/** Read + parse every vendored `*.md` into records (slug = filename stem). */
function loadAll(): SourceSkillRecord[] {
  if (SKILLS_DIR === '') return []
  let names: string[]
  try {
    names = readdirSync(SKILLS_DIR)
  } catch {
    return []
  }
  const records: SourceSkillRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const slug = name.slice(0, -3)
    try {
      const raw = readFileSync(join(SKILLS_DIR, name), 'utf8')
      records.push(recordFromSkill(slug, parseSkill(raw), PROVIDER))
    } catch {
      // Skip an unreadable file rather than fail the whole suite.
    }
  }
  return records
}

/** Read one vendored skill's raw document by slug. */
function readRaw(slug: string): string | null {
  if (SKILLS_DIR === '' || slug === '' || slug.includes('/') || slug.includes('..')) return null
  try {
    return readFileSync(join(SKILLS_DIR, `${slug}.md`), 'utf8')
  } catch {
    return null
  }
}

runSourceServer(
  { name: 'dsh-market-curated', version: '0.1.0', instructions: 'offline first-party craft suite' },
  {
    async search(q: string, target?: string | undefined): Promise<SourceSearchResult> {
      const all = loadAll()
      const scored = all
        .filter((record): boolean => {
          if (target === undefined || target === '' || target === 'any') return true
          return record.target === target || record.target === 'any'
        })
        .map((record): { record: SourceSkillRecord; score: number } => {
          const clone: SourceSkillRecord = { ...record, relevance: relevance(q, record) }
          return { record: clone, score: clone.relevance ?? 0 }
        })
        .filter((row): boolean => q.trim() === '' || row.score > 0)
      scored.sort((a, b): number => b.score - a.score || a.record.title.localeCompare(b.record.title))
      return { skills: scored.map((row): SourceSkillRecord => row.record) }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      const raw = readRaw(slug)
      if (raw === null) return { skill: null }
      return { skill: recordFromSkill(slug, parseSkill(raw), PROVIDER) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const raw = readRaw(slug)
      if (raw === null) throw new Error(`no curated skill '${slug}'`)
      const record = recordFromSkill(slug, parseSkill(raw), PROVIDER)
      return { slug, version: record.version, body: raw, license: record.license, provider: record.provider }
    },
  },
)
