/**
 * The skills-directory adapter (Phase-7 D4 source 3).
 *
 * It aggregates the public SKILL.md directories — `skills.sh` and LobeHub — by
 * probing their JSON search endpoints and merging the hits. Egress is restricted
 * by the tool manifest to `skills.sh`, `lobehub.com`, `api.github.com`, and
 * `raw.githubusercontent.com`.
 *
 * Directory schemas drift and are sometimes HTML-only, so each endpoint is read
 * tolerantly and any failure degrades that endpoint (not the whole tool): a
 * directory that answers contributes its skills, one that does not is skipped,
 * and the merged result is flagged `degraded` when at least one endpoint failed.
 *
 * @module dsh-movie-market/adapters/directory-mcp
 */

import type { SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord } from './contract.ts'
import { parseSkill, recordFromSkill } from './frontmatter.ts'
import { httpGet, isRateLimited, tryJson } from './http.ts'
import { runSourceServer } from './sourceAdapter.ts'

/** One directory endpoint: a label, a search URL builder, and a host tag. */
interface Directory {
  label: string
  searchUrl(q: string): string
  fileUrl(slug: string): string | null
}

/** A tolerant directory item. */
interface DirItem {
  slug?: string
  id?: string
  name?: string
  title?: string
  description?: string
  target?: string
  version?: string
  license?: string | null
  author?: string
  provider?: string
  url?: string
  raw?: string
}

/** The aggregated directories. */
const DIRECTORIES: readonly Directory[] = [
  {
    label: 'skills.sh',
    searchUrl: (q: string): string => `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=20`,
    fileUrl: (slug: string): string | null => `https://skills.sh/api/skills/${encodeURIComponent(slug)}/file`,
  },
  {
    label: 'lobehub.com',
    searchUrl: (q: string): string => `https://lobehub.com/api/skills?q=${encodeURIComponent(q)}`,
    fileUrl: (slug: string): string | null => `https://lobehub.com/api/skills/${encodeURIComponent(slug)}/raw`,
  },
]

/** First defined string among candidate keys. */
function pick(item: DirItem, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = (item as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Map a directory item onto a source record, namespacing the slug by directory. */
function toRecord(dir: Directory, item: DirItem): SourceSkillRecord | null {
  const base = pick(item, ['slug', 'id'])
  if (base === undefined) return null
  const record: SourceSkillRecord = {
    slug: `${dir.label}/${base}`,
    title: pick(item, ['name', 'title']) ?? base,
    description: pick(item, ['description']) ?? '',
    target: pick(item, ['target']) ?? 'any',
    version: pick(item, ['version']) ?? '0.0.0',
    license: pick(item, ['license']) ?? null,
    provider: pick(item, ['author', 'provider']) ?? dir.label,
  }
  return record
}

/** Split a `<dir>/<slug>` namespaced slug back into its parts. */
function splitSlug(slug: string): { dir: Directory; base: string } | null {
  const slash = slug.indexOf('/')
  if (slash <= 0) return null
  const label = slug.slice(0, slash)
  const dir = DIRECTORIES.find((d): boolean => d.label === label)
  if (dir === undefined) return null
  return { dir, base: slug.slice(slash + 1) }
}

runSourceServer(
  { name: 'dsh-market-directory', version: '0.1.0', instructions: 'skills.sh + LobeHub directory aggregator' },
  {
    async search(q: string): Promise<SourceSearchResult> {
      const skills: SourceSkillRecord[] = []
      let failures = 0
      for (const dir of DIRECTORIES) {
        try {
          const result = await httpGet(dir.searchUrl(q), { timeoutMs: 8000 })
          if (isRateLimited(result) || result.status < 200 || result.status >= 300) {
            failures += 1
            continue
          }
          const parsed = tryJson<{ results?: DirItem[]; skills?: DirItem[]; items?: DirItem[]; data?: DirItem[] }>(result.body)
          const items = parsed?.results ?? parsed?.skills ?? parsed?.items ?? parsed?.data ?? []
          for (const item of items) {
            const record = toRecord(dir, item)
            if (record !== null) skills.push(record)
          }
        } catch {
          failures += 1
        }
      }
      const out: SourceSearchResult = { skills }
      if (failures > 0) {
        out.degraded = true
        out.message = `${failures}/${DIRECTORIES.length} directories unavailable`
      }
      return out
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      const split = splitSlug(slug)
      if (split === null) return { skill: null }
      const fileUrl = split.dir.fileUrl(split.base)
      if (fileUrl === null) return { skill: null }
      try {
        const result = await httpGet(fileUrl, { timeoutMs: 8000 })
        if (isRateLimited(result) || result.status < 200 || result.status >= 300) return { skill: null }
        return { skill: recordFromSkill(slug, parseSkill(result.body), split.dir.label) }
      } catch {
        return { skill: null }
      }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const split = splitSlug(slug)
      if (split === null) throw new Error(`bad directory slug '${slug}'`)
      const fileUrl = split.dir.fileUrl(split.base)
      if (fileUrl === null) throw new Error('directory has no file endpoint')
      const result = await httpGet(fileUrl, { timeoutMs: 8000 })
      if (isRateLimited(result)) throw new Error(`${split.dir.label} rate limit`)
      if (result.status < 200 || result.status >= 300) throw new Error(`${split.dir.label} file HTTP ${result.status}`)
      const record = recordFromSkill(slug, parseSkill(result.body), split.dir.label)
      return { slug, version: record.version, body: result.body, license: record.license, provider: record.provider }
    },
  },
)
