/**
 * The skill index (Phase-7 D4/D8/D10/R11): fan-out search across every enabled
 * tool, then merge, dedup, scan, apply flags/blocklist, and rank.
 *
 * The index is **host-side and cache-first**: the sandboxed adapters stay
 * stateless (their `/tmp` is an ephemeral tmpfs, so nothing persists there),
 * and the host keeps the last-good results per `(tool, query, target)`. When a
 * tool rate-limits, times out, or errors, the index serves its cache and marks
 * the source `degraded` rather than failing the whole search (R11) — this is
 * exactly how the GitHub 10 req/min unauthenticated cap is absorbed.
 *
 * Trust layering (D8): `warningLevel = max(scanner(title+description),
 * blocklist→red, flagStore)`. Ranking (D10) blends source relevance, lexical
 * overlap, provenance trust, and generator-target match.
 *
 * Cordis-free and MCP-decoding-free: it depends on a small {@link SourceClient}
 * interface (implemented over the supervisor in `index.ts`) so it can be driven
 * by fixtures in `verify-plugins-search.ts`.
 *
 * @module dsh-movie-market/skillIndex
 */

import type { SkillProfile, SkillTarget, SourceStatus, ToolStatus, WarningLevel } from '@dsh-movie/protocol'
import type { SourceProfileResult, SourceSearchResult, SourceSkillRecord } from './adapters/contract.ts'
import { SOURCE_TOOL_NAMES } from './adapters/contract.ts'
import type { FlagStore } from './flagStore.ts'
import type { ToolRegistry } from './registry.ts'
import { Blocklist, maxLevel, scanProfile } from './trust.ts'
import type { IndexOptions, MarketLogger, RankedSkill, SkillSearchOptions, TrustTier } from './types.ts'

/** The source-facing search client (implemented over the supervisor). */
export interface SourceClient {
  /** Fan a query out to one tool's `skills/search`. */
  search(toolId: string, q: string, target?: string | undefined): Promise<SourceSearchResult>
  /** Fetch one skill's profile from one tool's `skills/profile`. */
  profile(toolId: string, slug: string): Promise<SourceProfileResult>
}

/** The valid `SkillTarget` strings (protocol union, mirrored for validation). */
const TARGETS: readonly SkillTarget[] = ['script', 'shot-plan', 'text', 'review', 'any']

/** Ranking blend weights (D10); they sum to 1. */
const WEIGHTS = { relevance: 0.35, lexical: 0.3, trust: 0.2, target: 0.15 } as const

/** One cached fan-out result for a `(tool, query, target)` key. */
interface CacheEntry {
  skills: SourceSkillRecord[]
  at: number
}

/** Per-tool health bookkeeping for `sourcesStatus`. */
interface SourceState {
  status: ToolStatus
  latencyMs?: number | undefined
  lastError?: string | undefined
  skillCount: number
}

/** Coerce a source's target string into a valid {@link SkillTarget}. */
function toTarget(value: string): SkillTarget {
  return (TARGETS as readonly string[]).includes(value) ? (value as SkillTarget) : 'any'
}

/** Tokenize free text into lowercase alphanumeric words. */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t): boolean => t !== '')
}

/** Fraction of query tokens present in the haystack (0..1). */
function lexicalMatch(query: string, haystack: string): number {
  const q = tokens(query)
  if (q.length === 0) return 0
  const hay = new Set(tokens(haystack))
  const hit = q.filter((t): boolean => hay.has(t)).length
  return hit / q.length
}

/**
 * The merged, ranked skill index with a TTL cache and trust layering.
 */
export class SkillIndex {
  private readonly client: SourceClient
  private readonly registry: ToolRegistry
  private readonly flags: FlagStore
  private readonly blocklist: Blocklist
  private readonly options: IndexOptions
  private readonly logger: MarketLogger
  private readonly cache = new Map<string, CacheEntry>()
  private readonly sources = new Map<string, SourceState>()

  /**
   * @param client - the source search client (over the supervisor).
   * @param registry - the tool registry (fan-out set + trust tiers).
   * @param flags - the server-global flag store.
   * @param blocklist - the seed blocklist.
   * @param options - TTL/timeout/logger tunables.
   */
  constructor(
    client: SourceClient,
    registry: ToolRegistry,
    flags: FlagStore,
    blocklist: Blocklist,
    options: IndexOptions,
  ) {
    this.client = client
    this.registry = registry
    this.flags = flags
    this.blocklist = blocklist
    this.options = options
    this.logger = options.logger
  }

  /** The global skill id for a source record (`<toolId>:<slug>`). */
  private static skillId(toolId: string, slug: string): string {
    return `${toolId}:${slug}`
  }

  /**
   * Compute a skill's warning level: `max(scanner, blocklist→red, flag)` (D8).
   * @param id - global skill id.
   * @param slug - source-local slug.
   * @param record - the source record (title/description scanned).
   */
  private levelOf(id: string, slug: string, record: SourceSkillRecord): WarningLevel {
    const scanned = scanProfile(record.title, record.description).level
    const flag = this.flags.get(id)?.level ?? 'clean'
    const blocked = this.blocklist.match(id, slug)
    let level = maxLevel(scanned, flag)
    if (blocked !== null) level = maxLevel(level, 'red')
    return level
  }

  /** Map a source record onto a protocol {@link SkillProfile}. */
  private toProfile(toolId: string, record: SourceSkillRecord, updatedAt: number): SkillProfile {
    const id = SkillIndex.skillId(toolId, record.slug)
    return {
      id,
      toolId,
      title: record.title,
      description: record.description,
      target: toTarget(record.target),
      version: record.version,
      license: record.license,
      provider: record.provider,
      warningLevel: this.levelOf(id, record.slug, record),
      updatedAt,
    }
  }

  /** Composite, query-aware ranking score for one candidate (D10). */
  private scoreOf(
    query: string,
    record: SourceSkillRecord,
    trustWeight: number,
    target: SkillTarget | undefined,
  ): number {
    const relevance = Math.min(1, Math.max(0, record.relevance ?? 0))
    const lexical = lexicalMatch(query, `${record.title} ${record.description}`)
    const trust = Math.min(1, Math.max(0, trustWeight))
    let targetMatch = 0.5
    if (target !== undefined) {
      const rt = toTarget(record.target)
      if (rt === target) targetMatch = 1
      else if (rt === 'any') targetMatch = 0.5
      else targetMatch = 0
    }
    return (
      relevance * WEIGHTS.relevance +
      lexical * WEIGHTS.lexical +
      trust * WEIGHTS.trust +
      targetMatch * WEIGHTS.target
    )
  }

  /** The cache key for a `(tool, query, target)` fan-out. */
  private static cacheKey(toolId: string, q: string, target?: string | undefined): string {
    return `${toolId}::${q.trim().toLowerCase()}::${target ?? '*'}`
  }

  /**
   * Fan out one tool's search with a per-tool timeout, cache-first on any
   * failure or rate-limit (R11). Updates the per-tool source state.
   */
  private async fanOut(toolId: string, q: string, target?: string | undefined): Promise<SourceSkillRecord[]> {
    const key = SkillIndex.cacheKey(toolId, q, target)
    const cached = this.cache.get(key)
    // Cache-first: a fresh entry is served without a fan-out (D10/R11).
    if (cached !== undefined && this.fresh(cached)) {
      this.markSource(toolId, 'running', cached.skills.length, 0)
      return cached.skills
    }
    const started = Date.now()
    try {
      const result = await this.withTimeout(
        this.client.search(toolId, q, target),
        this.options.perToolTimeoutMs,
        toolId,
      )
      const latencyMs = Date.now() - started
      if (result.rateLimited === true) {
        // Rate-limited: serve the last-good cache even when stale, and never
        // overwrite it with the empty rate-limited payload (R11).
        const skills = cached !== undefined ? cached.skills : result.skills
        this.markSource(toolId, 'degraded', skills.length, latencyMs, result.message ?? 'rate-limited')
        return skills
      }
      this.cache.set(key, { skills: result.skills, at: started })
      this.markSource(toolId, result.degraded === true ? 'degraded' : 'running', result.skills.length, latencyMs, result.message)
      return result.skills
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const latencyMs = Date.now() - started
      if (cached !== undefined) {
        // Serve stale on error: better a cached hit than a hole (R11).
        this.markSource(toolId, 'degraded', cached.skills.length, latencyMs, `${message} (served cache)`)
        this.logger.warn('[market:index] %s failed, served cache: %s', toolId, message)
        return cached.skills
      }
      this.markSource(toolId, 'error', 0, latencyMs, message)
      this.logger.warn('[market:index] %s failed with no cache: %s', toolId, message)
      return []
    }
  }

  /** True when a cache entry is within its TTL. */
  private fresh(entry: CacheEntry): boolean {
    return Date.now() - entry.at < this.options.ttlMs
  }

  /** Record per-tool health for `sourcesStatus`. */
  private markSource(toolId: string, status: ToolStatus, skillCount: number, latencyMs: number, lastError?: string | undefined): void {
    const state: SourceState = { status, skillCount, latencyMs }
    if (lastError !== undefined && lastError !== '') state.lastError = lastError
    this.sources.set(toolId, state)
  }

  /** Reject a promise after `ms`, labelling the timeout with the tool id. */
  private withTimeout<T>(promise: Promise<T>, ms: number, toolId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${toolId} fan-out timed out after ${ms}ms`)), ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  /**
   * Fan out across every enabled tool (or one, when `toolId` is set), then
   * merge, dedup, scan, flag, and rank.
   * @param options - the search request.
   * @returns merged, ranked skill rows (highest score first).
   */
  async search(options: SkillSearchOptions): Promise<RankedSkill[]> {
    const toolIds = options.toolId !== undefined && options.toolId !== ''
      ? [options.toolId]
      : this.registry.enabledSearchIds()
    const updatedAt = Date.now()

    const perTool = await Promise.all(
      toolIds.map(async (toolId): Promise<RankedSkill[]> => {
        const records = await this.fanOut(toolId, options.q, options.target)
        const trust = this.registry.trustWeight(toolId)
        const tier = this.registry.tier(toolId)
        return records.map((record): RankedSkill => ({
          profile: this.toProfile(toolId, record, updatedAt),
          score: this.scoreOf(options.q, record, trust, options.target),
          tier,
        }))
      }),
    )

    const merged = perTool.flat()
    const deduped = this.dedup(merged)
    deduped.sort((a, b): number => b.score - a.score || a.profile.title.localeCompare(b.profile.title))
    return deduped
  }

  /**
   * De-duplicate by `provider::title` (case-insensitive), keeping the
   * highest-scoring (then highest-tier) representative.
   */
  private dedup(rows: RankedSkill[]): RankedSkill[] {
    const best = new Map<string, RankedSkill>()
    for (const row of rows) {
      const key = `${row.profile.provider.toLowerCase()}::${row.profile.title.toLowerCase()}`
      const prior = best.get(key)
      if (prior === undefined || this.better(row, prior)) best.set(key, row)
    }
    return [...best.values()]
  }

  /** Ranking tiebreak: higher score, then stronger provenance tier. */
  private better(a: RankedSkill, b: RankedSkill): boolean {
    if (a.score !== b.score) return a.score > b.score
    return this.tierRank(a.tier) > this.tierRank(b.tier)
  }

  /** Numeric rank of a tier (curated strongest). */
  private tierRank(tier: TrustTier): number {
    return tier === 'curated' ? 2 : tier === 'registry' ? 1 : 0
  }

  /**
   * Resolve one skill profile by global id (`<toolId>:<slug>`).
   * @param id - the global skill id.
   * @returns the profile (with trust applied), or `null` when not found.
   */
  async profile(id: string): Promise<SkillProfile | null> {
    const sep = id.indexOf(':')
    if (sep <= 0) return null
    const toolId = id.slice(0, sep)
    const slug = id.slice(sep + 1)
    try {
      const result = await this.withTimeout(this.client.profile(toolId, slug), this.options.perToolTimeoutMs, toolId)
      if (result.skill === null) return null
      return this.toProfile(toolId, result.skill, Date.now())
    } catch (error) {
      this.logger.warn('[market:index] profile %s failed: %s', id, String(error))
      return null
    }
  }

  /**
   * Per-tool health rows for the badges/chips (D5), merging the registry's
   * lifecycle status with the last fan-out's latency/skillCount/error.
   */
  sourcesStatus(): SourceStatus[] {
    return this.registry.records().map((record): SourceStatus => {
      const state = this.sources.get(record.id)
      const status: ToolStatus = state?.status ?? record.status
      const row: SourceStatus = {
        toolId: record.id,
        status,
        skillCount: state?.skillCount ?? 0,
      }
      if (state?.latencyMs !== undefined) row.latencyMs = state.latencyMs
      const lastError = state?.lastError
      if (lastError !== undefined) row.lastError = lastError
      return row
    })
  }

  /** Drop every cache entry (used after a flag/blocklist change). */
  invalidate(): void {
    this.cache.clear()
  }
}

/* -------------------------------------------------------------------------- */
/* The MCP-backed SourceClient                                                 */
/* -------------------------------------------------------------------------- */

/** The minimal MCP `tools/call` result shape the decoder needs. */
export interface McpTextResult {
  content?: ReadonlyArray<{ type?: string; text?: string }>
  isError?: boolean
}

/** A caller into one tool's MCP server (satisfied by the SPR supervisor). */
export type ToolCaller = (
  toolId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<McpTextResult>

/** Pull the first text block out of an MCP result and JSON-decode it. */
function decodeJson<T>(result: McpTextResult, label: string): T {
  if (result.isError === true) throw new Error(`${label}: source reported an error`)
  const block = result.content?.find((c): boolean => c.type === 'text')
  const text = block?.text
  if (text === undefined || text === '') throw new Error(`${label}: empty text content`)
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`${label}: malformed JSON payload (${String(error)})`)
  }
}

/**
 * A {@link SourceClient} over the SPR supervisor: it calls each tool's MCP
 * `skills/search` / `skills/profile` and decodes the single JSON text block.
 */
export class McpSourceClient implements SourceClient {
  private readonly caller: ToolCaller

  /** @param caller - the supervisor-backed MCP caller. */
  constructor(caller: ToolCaller) {
    this.caller = caller
  }

  /** @inheritdoc */
  async search(toolId: string, q: string, target?: string | undefined): Promise<SourceSearchResult> {
    const args: Record<string, unknown> = { q }
    if (target !== undefined && target !== '') args['target'] = target
    const result = await this.caller(toolId, SOURCE_TOOL_NAMES.search, args)
    return decodeJson<SourceSearchResult>(result, `${toolId}.search`)
  }

  /** @inheritdoc */
  async profile(toolId: string, slug: string): Promise<SourceProfileResult> {
    const result = await this.caller(toolId, SOURCE_TOOL_NAMES.profile, { slug })
    return decodeJson<SourceProfileResult>(result, `${toolId}.profile`)
  }
}
