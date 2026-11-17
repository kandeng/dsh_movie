/**
 * The skill-source adapter wire contract (Phase-7 P7-M3).
 *
 * Every built-in tool (and any third-party skill source) is an MCP stdio server
 * that exposes three tools — `skills/search`, `skills/profile`, `skills/download`
 * — whose results are JSON-encoded into a single MCP text content block. This
 * module defines those payload shapes.
 *
 * It is deliberately **dependency-free** (no `@dsh-movie/protocol` import): the
 * adapter scripts run as OS-sandboxed children (see `sandbox.ts`) and must stay
 * hermetic, so they import only `node:*` and this file. The host side
 * (`src/types.ts`) re-exports these shapes and maps them onto the protocol
 * `SkillProfile`, keeping one source of truth without coupling the sandbox to
 * the wire protocol package.
 *
 * @module dsh-movie-market/adapters/contract
 */

/**
 * One skill as a source reports it (its SKILL.md front-matter profile). The
 * source never assigns a warning level or a global id — the host index does
 * (`id = <toolId>:<slug>`, `warningLevel` from the scanner + flag store).
 */
export interface SourceSkillRecord {
  /** Source-local skill id (unique within the tool). */
  slug: string
  /** Front-matter `name`. */
  title: string
  /** Front-matter `description` (one line). */
  description: string
  /** Generator target as a string; the host validates it into `SkillTarget`. */
  target: string
  /** Upstream version string. */
  version: string
  /** SPDX-style license label, when known. */
  license: string | null
  /** Provider/author display name. */
  provider: string
  /** Registry-provided relevance score (e.g. ClawHub semantic), when any. */
  relevance?: number | undefined
  /** True when the skill declares executable entrypoints (Phase-7 D9). */
  executable?: boolean | undefined
}

/** The `skills/search` payload. */
export interface SourceSearchResult {
  /** Matched skills, most-relevant first (source ordering). */
  skills: SourceSkillRecord[]
  /** True when the upstream registry rate-limited this query (host serves cache). */
  rateLimited?: boolean | undefined
  /** True when the source answered from a partial/degraded path. */
  degraded?: boolean | undefined
  /** Human-readable note for the degraded/rate-limited case. */
  message?: string | undefined
}

/** The `skills/profile` payload. */
export interface SourceProfileResult {
  /** The skill profile, or `null` when the source has no such slug. */
  skill: SourceSkillRecord | null
}

/** The `skills/download` payload (full SKILL.md body). */
export interface SourceDownloadResult {
  /** Source-local skill id. */
  slug: string
  /** Version pinned at download time. */
  version: string
  /** The full SKILL.md body (front-matter included). */
  body: string
  /** SPDX-style license label, when known. */
  license: string | null
  /** Provider/author display name (kept for attribution). */
  provider: string
}

/** The three MCP tool names every skill-source adapter must expose. */
export const SOURCE_TOOL_NAMES = {
  search: 'skills/search',
  profile: 'skills/profile',
  download: 'skills/download',
} as const
