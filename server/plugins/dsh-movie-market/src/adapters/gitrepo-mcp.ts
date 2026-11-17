/**
 * The git-repo SKILL.md suite adapter (Phase-7 D4 source 4).
 *
 * A generic "clone a SKILL.md suite" tool parameterized by an operator-set
 * `DSH_GIT_REPO` (`owner/repo[@branch]`, branch defaults to `main`). It reads a
 * `skills/index.json` manifest from the repo over `raw.githubusercontent.com`
 * and serves each listed skill's `SKILL.md` from the same host. Egress is
 * restricted by the tool manifest to `raw.githubusercontent.com`,
 * `codeload.github.com`, and `github.com`.
 *
 * When `DSH_GIT_REPO` is unset the tool answers with an empty, `degraded` result
 * (it needs operator configuration) rather than throwing — the host index then
 * simply contributes no skills from it.
 *
 * @module dsh-movie-market/adapters/gitrepo-mcp
 */

import type { SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord } from './contract.ts'
import { parseSkill, recordFromSkill } from './frontmatter.ts'
import { httpGet, isRateLimited, tryJson } from './http.ts'
import { runSourceServer } from './sourceAdapter.ts'

const PROVIDER = 'git-repo'
const RAW = 'https://raw.githubusercontent.com'

/** One entry of the repo's `skills/index.json`. */
interface IndexEntry {
  slug?: string
  path?: string
  title?: string
  name?: string
  description?: string
  target?: string
  version?: string
  license?: string | null
  provider?: string
}

/** The parsed `DSH_GIT_REPO` target. */
interface RepoTarget {
  owner: string
  repo: string
  branch: string
}

/** Parse `owner/repo[@branch]`; null when unset or malformed. */
function parseRepo(): RepoTarget | null {
  const raw = process.env['DSH_GIT_REPO'] ?? ''
  if (raw.trim() === '') return null
  const at = raw.indexOf('@')
  const spec = at >= 0 ? raw.slice(0, at) : raw
  const branch = at >= 0 ? raw.slice(at + 1) : 'main'
  const parts = spec.split('/')
  const owner = parts[0]
  const repo = parts[1]
  if (parts.length !== 2 || owner === undefined || repo === undefined || owner === '' || repo === '') return null
  return { owner, repo, branch: branch === '' ? 'main' : branch }
}

/** The raw URL for a path in the configured repo. */
function rawUrl(target: RepoTarget, path: string): string {
  return `${RAW}/${target.owner}/${target.repo}/${target.branch}/${path.replace(/^\/+/, '')}`
}

/** Fetch + parse the repo's `skills/index.json` (empty on any miss). */
async function loadIndex(target: RepoTarget): Promise<IndexEntry[]> {
  const result = await httpGet(rawUrl(target, 'skills/index.json'), { timeoutMs: 9000 })
  if (isRateLimited(result) || result.status < 200 || result.status >= 300) return []
  const parsed = tryJson<{ skills?: IndexEntry[] } | IndexEntry[]>(result.body)
  if (Array.isArray(parsed)) return parsed
  return parsed?.skills ?? []
}

/** Map an index entry onto a source record (null when it lacks slug/path). */
function toRecord(entry: IndexEntry): SourceSkillRecord | null {
  const slug = entry.slug
  const path = entry.path
  if (slug === undefined || slug === '' || path === undefined || path === '') return null
  const record: SourceSkillRecord = {
    slug,
    title: entry.title ?? entry.name ?? slug,
    description: entry.description ?? '',
    target: entry.target ?? 'any',
    version: entry.version ?? '0.0.0',
    license: entry.license ?? null,
    provider: entry.provider ?? PROVIDER,
  }
  return record
}

/** Look up one index entry's path by slug. */
async function pathFor(target: RepoTarget, slug: string): Promise<string | null> {
  const index = await loadIndex(target)
  const entry = index.find((e): boolean => e.slug === slug)
  return entry?.path ?? null
}

runSourceServer(
  { name: 'dsh-market-gitrepo', version: '0.1.0', instructions: 'generic git SKILL.md suite (DSH_GIT_REPO)' },
  {
    async search(q: string): Promise<SourceSearchResult> {
      const target = parseRepo()
      if (target === null) {
        return { skills: [], degraded: true, message: 'DSH_GIT_REPO not configured (owner/repo[@branch])' }
      }
      const index = await loadIndex(target)
      const needle = q.trim().toLowerCase()
      const skills: SourceSkillRecord[] = []
      for (const entry of index) {
        const record = toRecord(entry)
        if (record === null) continue
        if (needle === '' || `${record.title} ${record.description}`.toLowerCase().includes(needle)) {
          skills.push(record)
        }
      }
      return { skills }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      const target = parseRepo()
      if (target === null) return { skill: null }
      const path = await pathFor(target, slug)
      if (path === null) return { skill: null }
      const result = await httpGet(rawUrl(target, path), { timeoutMs: 9000 })
      if (result.status < 200 || result.status >= 300) return { skill: null }
      return { skill: recordFromSkill(slug, parseSkill(result.body), PROVIDER) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const target = parseRepo()
      if (target === null) throw new Error('DSH_GIT_REPO not configured')
      const path = await pathFor(target, slug)
      if (path === null) throw new Error(`no skill '${slug}' in repo index`)
      const result = await httpGet(rawUrl(target, path), { timeoutMs: 9000 })
      if (isRateLimited(result)) throw new Error('git host rate limit')
      if (result.status < 200 || result.status >= 300) throw new Error(`raw fetch HTTP ${result.status}`)
      const record = recordFromSkill(slug, parseSkill(result.body), PROVIDER)
      return { slug, version: record.version, body: result.body, license: record.license, provider: record.provider }
    },
  },
)
