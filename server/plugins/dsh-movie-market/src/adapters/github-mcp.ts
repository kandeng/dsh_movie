/**
 * The GitHub skill-source adapter (Phase-7 D4 source 2).
 *
 * It searches GitHub for repositories that carry a root `SKILL.md` (topic
 * `agent-skills` plus the query), then resolves a skill's profile/body through
 * the contents API and `raw.githubusercontent.com`. Egress is restricted by the
 * tool manifest to `api.github.com`, `raw.githubusercontent.com`,
 * `objects.githubusercontent.com`, and `codeload.github.com`.
 *
 * The operator token (`GITHUB_TOKEN`) is **optional**: it only lifts the
 * 10 req/min unauthenticated cap. When the API answers 403/429 with an
 * exhausted budget, the adapter reports `rateLimited: true` and the host index
 * serves its last-good cache (R11) — this is the acceptance's "GitHub
 * rate-limit handled cache-first".
 *
 * @module dsh-movie-market/adapters/github-mcp
 */

import type { SourceDownloadResult, SourceProfileResult, SourceSearchResult, SourceSkillRecord } from './contract.ts'
import { parseSkill, recordFromSkill } from './frontmatter.ts'
import { httpGet, isRateLimited, tryJson } from './http.ts'
import { runSourceServer } from './sourceAdapter.ts'

const PROVIDER = 'GitHub'
const API = 'https://api.github.com'

/** The optional operator token (lifts the unauthenticated rate cap). */
const TOKEN = process.env['GITHUB_TOKEN'] ?? ''

/** Auth header, only when a token is configured. */
function authHeaders(): Record<string, string> {
  return TOKEN === '' ? {} : { authorization: `Bearer ${TOKEN}` }
}

/** One repository-search hit (the subset we use). */
interface RepoItem {
  full_name?: string
  name?: string
  description?: string | null
  topics?: string[]
  default_branch?: string
}

/** One contents-API response (the subset we use). */
interface ContentsItem {
  download_url?: string | null
  name?: string
}

/** Infer a generator target from a repo's topics + description. */
function inferTarget(topics: string[], description: string): string {
  const hay = `${topics.join(' ')} ${description}`.toLowerCase()
  if (/shot[- ]?(list|plan)|storyboard|ai-storyboard|cinematograph|camera|framing/.test(hay)) return 'shot-plan'
  if (/script|screenplay|screen-writing|storytelling|narrative|three-act/.test(hay)) return 'script'
  if (/review|critique|coverage|feedback/.test(hay)) return 'review'
  return 'any'
}

/** Split a `owner/repo/path` slug into the repo full-name and the file path. */
function splitSlug(slug: string): { fullName: string; path: string } | null {
  const parts = slug.split('/')
  if (parts.length < 3) return null
  const fullName = `${parts[0]}/${parts[1]}`
  const path = parts.slice(2).join('/')
  if (fullName === '/' || path === '') return null
  return { fullName, path }
}

/** Fetch + parse a repo's root SKILL.md into a record (null on any miss). */
async function repoSkill(item: RepoItem): Promise<SourceSkillRecord | null> {
  const fullName = item.full_name
  if (fullName === undefined) return null
  const slug = `${fullName}/SKILL.md`
  const description = item.description ?? ''
  const record: SourceSkillRecord = {
    slug,
    title: item.name ?? fullName,
    description,
    target: inferTarget(item.topics ?? [], description),
    version: item.default_branch ?? 'main',
    license: null,
    provider: fullName,
  }
  return record
}

runSourceServer(
  { name: 'dsh-market-github', version: '0.1.0', instructions: 'GitHub SKILL.md repository search' },
  {
    async search(q: string): Promise<SourceSearchResult> {
      const query = `topic:agent-skills ${q}`.trim()
      const url = `${API}/search/repositories?q=${encodeURIComponent(query)}&per_page=20`
      const result = await httpGet(url, { timeoutMs: 9000, headers: authHeaders() })
      if (isRateLimited(result)) {
        return { skills: [], rateLimited: true, message: 'GitHub rate limit exhausted (set GITHUB_TOKEN to raise it)' }
      }
      if (result.status < 200 || result.status >= 300) {
        return { skills: [], degraded: true, message: `GitHub search HTTP ${result.status}` }
      }
      const parsed = tryJson<{ items?: RepoItem[] }>(result.body)
      const items = parsed?.items ?? []
      const skills: SourceSkillRecord[] = []
      for (const item of items) {
        const record = await repoSkill(item)
        if (record !== null) skills.push(record)
      }
      return { skills }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      const split = splitSlug(slug)
      if (split === null) return { skill: null }
      const url = `${API}/repos/${split.fullName}/contents/${split.path}`
      const result = await httpGet(url, { timeoutMs: 9000, headers: authHeaders() })
      if (isRateLimited(result) || result.status < 200 || result.status >= 300) return { skill: null }
      const meta = tryJson<ContentsItem>(result.body)
      const downloadUrl = meta?.download_url
      if (downloadUrl === undefined || downloadUrl === null) return { skill: null }
      const raw = await httpGet(downloadUrl, { timeoutMs: 9000 })
      if (raw.status < 200 || raw.status >= 300) return { skill: null }
      return { skill: recordFromSkill(slug, parseSkill(raw.body), PROVIDER) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const split = splitSlug(slug)
      if (split === null) throw new Error(`bad GitHub slug '${slug}'`)
      const url = `${API}/repos/${split.fullName}/contents/${split.path}`
      const result = await httpGet(url, { timeoutMs: 9000, headers: authHeaders() })
      if (isRateLimited(result)) throw new Error('GitHub rate limit exhausted')
      if (result.status < 200 || result.status >= 300) throw new Error(`GitHub contents HTTP ${result.status}`)
      const meta = tryJson<ContentsItem>(result.body)
      const downloadUrl = meta?.download_url
      if (downloadUrl === undefined || downloadUrl === null) throw new Error('no download_url for SKILL.md')
      const raw = await httpGet(downloadUrl, { timeoutMs: 9000 })
      if (raw.status < 200 || raw.status >= 300) throw new Error(`GitHub raw HTTP ${raw.status}`)
      const record = recordFromSkill(slug, parseSkill(raw.body), PROVIDER)
      return { slug, version: record.version, body: raw.body, license: record.license, provider: record.provider }
    },
  },
)
