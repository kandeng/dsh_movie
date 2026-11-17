/**
 * Fixture executable skill-source (Phase-7 P7-M6 acceptance).
 *
 * A real, spawnable MCP stdio source server (via the shared `runSourceServer`
 * library) that ALSO implements the optional `run` handler, so it advertises the
 * `skills/run` executable entrypoint (D9). `verify-plugins-execute.ts` registers
 * it as a tool and drives the full run + trust + consent matrix against it.
 *
 * Its canned set deliberately exercises every D9 gate:
 * - `exec-clean`  — executable, clean profile → runs outright (auto).
 * - `exec-cred`   — executable, credential-shaped profile → scans **orange**, so
 *   it requires recorded consent before it will run.
 * - `exec-bad`    — executable, clean profile, but the verify flags it **red**
 *   (blocklist/report path) → refused by both triggers.
 * - `exec-plain`  — NOT executable → the run path returns `not-executable`.
 *
 * The `run` handler does a trivial, hermetic computation (upper-cases an input
 * string and folds in the sandbox pid) so the acceptance can assert that real
 * in-sandbox output lands in the node + a room artifact, with no egress.
 *
 * Runs offline (empty network allow-list) — no egress needed.
 *
 * @module dsh-movie-market/fixture-source-exec
 */

import type {
  SourceDownloadResult, SourceProfileResult, SourceRunResult, SourceSearchResult, SourceSkillRecord,
} from '../src/adapters/contract.ts'
import { runSourceServer } from '../src/adapters/sourceAdapter.ts'

const PROVIDER = 'Exec Source'

/** The canned executable skill set for the fixture. */
const SKILLS: readonly SourceSkillRecord[] = [
  {
    slug: 'exec-clean',
    title: 'Title Case Helper',
    description: 'Transform input text into an upper-case title for a shot slate',
    target: 'text',
    version: '1.0.0',
    license: 'MIT',
    provider: PROVIDER,
    relevance: 0.9,
    executable: true,
    entrypoint: 'skills/run',
  },
  {
    slug: 'exec-cred',
    title: 'Cloud Slate Renderer',
    description: 'Set api_key = YOUR_KEY and paste your credentials to render slates',
    target: 'text',
    version: '1.0.0',
    license: null,
    provider: PROVIDER,
    relevance: 0.5,
    executable: true,
    entrypoint: 'skills/run',
  },
  {
    slug: 'exec-bad',
    title: 'Innocuous Note Formatter',
    description: 'Format a short production note into tidy plain text',
    target: 'text',
    version: '1.0.0',
    license: 'MIT',
    provider: PROVIDER,
    relevance: 0.4,
    executable: true,
    entrypoint: 'skills/run',
  },
  {
    slug: 'exec-plain',
    title: 'Three Act Outline',
    description: 'A plain craft outline template with no executable entrypoint',
    target: 'script',
    version: '1.0.0',
    license: 'MIT',
    provider: PROVIDER,
    relevance: 0.3,
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
    record.executable === true ? 'executable: true' : '',
    '---',
    '',
    `# ${record.title}`,
    '',
    `${record.description}.`,
    '',
  ].filter((line): boolean => line !== '').join('\n')
}

runSourceServer(
  { name: 'fixture-source-exec', version: '0.1.0', instructions: 'canned executable skill source' },
  {
    async search(): Promise<SourceSearchResult> {
      return { skills: SKILLS.map((s): SourceSkillRecord => ({ ...s })) }
    },
    async profile(slug: string): Promise<SourceProfileResult> {
      return { skill: find(slug) }
    },
    async download(slug: string): Promise<SourceDownloadResult> {
      const record = find(slug)
      if (record === null) throw new Error(`no skill '${slug}' in exec fixture`)
      return { slug, version: record.version, body: bodyOf(record), license: record.license, provider: record.provider }
    },
    // The D9 executable entrypoint: a trivial, hermetic in-sandbox computation.
    async run(slug: string, args: Readonly<Record<string, unknown>>): Promise<SourceRunResult> {
      const record = find(slug)
      if (record === null) throw new Error(`no skill '${slug}' in exec fixture`)
      if (record.executable !== true) throw new Error(`skill '${slug}' is not executable`)
      const input = typeof args['input'] === 'string' ? (args['input'] as string) : 'dsh movie'
      const content = `[${slug}] ${input.toUpperCase()} (pid ${process.pid})`
      return { slug, content, files: [{ name: 'result.txt', body: `${content}\n` }] }
    },
  },
)
