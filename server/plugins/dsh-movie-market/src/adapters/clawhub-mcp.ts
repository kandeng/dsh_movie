/**
 * The ClawHub registry adapter (Phase-7 D4 source 1).
 *
 * ClawHub is the largest community SKILL.md registry (31k+ skills) and exposes a
 * REST API: `/api/v1/search` (semantic + keyword), `/api/v1/skills/{slug}`, and
 * `/api/v1/skills/{slug}/file?path=SKILL.md`. Egress is restricted by the tool
 * manifest to `clawhub.ai`.
 *
 * The upstream schema is versioned and may drift, so every field is read
 * tolerantly (several plausible key spellings) and any non-2xx or 429 degrades
 * rather than throwing — the host index then serves its cache (R11).
 *
 * @module dsh-movie-market/adapters/clawhub-mcp
 */

import type { SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord } from './contract.ts'
import { parseSkill, recordFromSkill } from './frontmatter.ts'
import { httpGet, isRateLimited, tryJson } from './http.ts'
import { runSourceServer } from './sourceAdapter.ts'

const PROVIDER = 'ClawHub'
const API = 'https://clawhub.ai/api/v1'

/** A ClawHub search/skill item (tolerant of schema drift). */
interface ClawItem {
  slug?: string
  id?: string
  name?: string
  title?: string
  description?: string
  summary?: string
  target?: string
  version?: string
  license?: string | null
  author?: string
  provider?: string
  score?: number
  relevance?: number
}

/** First defined string among candidate keys. */
function pick(item: ClawItem, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = (item as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Map a ClawHub item onto a source record (null when it has no slug). */
function toRecord(item: ClawItem): SourceSkillRecord | null {
  const slug = pick(item, ['slug', 'id'])
  if (slug === undefined) return null
  const record: SourceSkillRecord = {
    slug,
    title: pick(item, ['name', 'title']) ?? slug,
    description: pick(item, ['description', 'summary']) ?? '',
    target: pick(item, ['target']) ?? 'any',
    version: pick(item, ['version']) ?? '0.0.0',
    license: pick(item, ['license']) ?? null,
    provider: pick(item, ['author', 'provider']) ?? PROVIDER,
  }
  const relevance = typeof item.relevance === 'number' ? item.relevance : typeof item.score === 'number' ? item.score : undefined
  if (relevance !== undefined) record.relevance = Math.min(1, Math.max(0, relevance))
  return record
}

runSourceServer(
  { name: 'dsh-market-clawhub', version: '0.1.0', instructions: 'ClawHub community registry' },
  {
    async search(q: string): Promise<SourceSearchResult> {
      const url = `${API}/search?q=${encodeURIComponent(q)}&limit=20`
      const result = await httpGet(url, { timeoutMs: 9000 })
      if (isRateLimited(result)) {
        return { skills: [], rateLimited: true, message: 'ClawHub rate limit' }
      }
      if (result.status < 200 || result.status >= 300) {
        return { skills: [], degraded: true, message: `ClawHub search HTTP ${result.status}` }
      }
      const parsed = tryJson<{ results?: ClawItem[]; skills?: ClawItem[]; items?: ClawItem[] }>(result.body)
      const items = parsed?.results ?? parsed?.skills ?? parsed?.items ?? []
      const skills: SourceSkillRecord[] = []
      for (const item of items) {
        const record = toRecord(item)
        if (record !== null) skills.push(record)
      }
      return { skills }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      if (slug === '') return { skill: null }
      const result = await httpGet(`${API}/skills/${encodeURIComponent(slug)}`, { timeoutMs: 9000 })
      if (isRateLimited(result) || result.status < 200 || result.status >= 300) return { skill: null }
      const item = tryJson<ClawItem>(result.body)
      if (item === null) return { skill: null }
      return { skill: toRecord({ ...item, slug }) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      if (slug === '') throw new Error('empty slug')
      const url = `${API}/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`
      const result = await httpGet(url, { timeoutMs: 9000 })
      if (isRateLimited(result)) throw new Error('ClawHub rate limit')
      if (result.status < 200 || result.status >= 300) throw new Error(`ClawHub file HTTP ${result.status}`)
      const record = recordFromSkill(slug, parseSkill(result.body), PROVIDER)
      return { slug, version: record.version, body: result.body, license: record.license, provider: record.provider }
    },
  },
)
