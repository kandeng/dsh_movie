/**
 * `dsh-movie-market`: the Phase-7 plugins marketplace, exposed as the Cordis
 * service `ctx.movieMarket`.
 *
 * In P7-M2 this plugin hosts the **SPR supervisor** (`supervisor.ts`): every
 * external skill/tool source runs as an OS-sandboxed MCP stdio child, spawned
 * and lifecycle-managed entirely server-side (see `sandbox.ts`). P7-M3 layers on
 * the **server-global tool registry** (`registry.ts` + `builtinTools.ts`), the
 * **skill index** (`skillIndex.ts`: fan-out search, merge/dedup/rank, TTL
 * cache-first), and **trust** (`trust.ts` scanner + blocklist, `flagStore.ts`).
 * The Leg C `plugins/*` HTTP handlers are wired on top in P7-M4.
 *
 * Lifecycle is a reversible Cordis effect: activation constructs the supervisor
 * (which arms the idle-reap sweeper), disposal stops every sandboxed child, so a
 * host reload never leaks a tool process.
 *
 * @module dsh-movie-market
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SkillProfile, SourceStatus, ToolRecord, WarningLevel } from '@dsh-movie/protocol'
import { builtinToolDefs } from './builtinTools.ts'
import { FlagStore } from './flagStore.ts'
import { ToolRegistry } from './registry.ts'
import { McpSourceClient, SkillIndex, type McpTextResult } from './skillIndex.ts'
import { SprSupervisor } from './supervisor.ts'
import { Blocklist } from './trust.ts'
import type { MarketLogger, MarketService, MarketToolInfo, SandboxBackend, SkillSearchOptions, ToolSpec } from './types.ts'

export type { MarketService, MarketToolInfo, ToolSpec, ToolRuntimeStatus } from './types.ts'
export { ToolRegistry } from './registry.ts'
export { SkillIndex, McpSourceClient } from './skillIndex.ts'
export { FlagStore } from './flagStore.ts'
export { Blocklist, scanProfile, scanText, maxLevel } from './trust.ts'
export { builtinToolDefs, CURATED_SKILLS_DIR } from './builtinTools.ts'

/** Stable Loader identity. */
export const name = 'movie-market'

/** P7-M2 needs no injected host services; the supervisor is self-contained. */
export const inject: string[] = []

/** Plugin configuration. */
export interface Config {
  /** Sandbox backend: `auto` probes strongest-first (systemd → bwrap → docker). */
  sandbox: string
  /** Idle time (ms) after last use before a live child is reaped. */
  idleReapMs: number
  /** Per MCP request timeout (ms). */
  requestTimeoutMs: number
  /** Wall-clock budget for spawn + connect + health (ms). */
  spawnTimeoutMs: number
  /** Default memory cap (MB) when a manifest omits `memoryMaxMb`. */
  defaultMemoryMaxMb: number
  /** Default CPU quota percent when a manifest omits `cpuQuotaPct`. */
  defaultCpuQuotaPct: number
  /** Default `TasksMax` cgroup limit. */
  defaultTasksMax: number
  /** Default `TimeoutStopSec`. */
  defaultTimeoutStopSec: number
  /** Skill-index cache time-to-live (ms); a fresh entry skips a fan-out. */
  cacheTtlMs: number
  /** Per-tool fan-out timeout (ms); a slow tool degrades rather than blocks. */
  searchPerToolTimeoutMs: number
  /** Data dir for the flag store; `''` resolves to `<server>/.dsh/market`. */
  dataDir: string
}

/** Schemastery validation + defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  sandbox: z.string().default('auto'),
  idleReapMs: z.number().min(0).default(300_000),
  requestTimeoutMs: z.number().min(1).default(30_000),
  spawnTimeoutMs: z.number().min(1).default(20_000),
  defaultMemoryMaxMb: z.number().min(1).default(256),
  defaultCpuQuotaPct: z.number().min(1).default(100),
  defaultTasksMax: z.number().min(1).default(128),
  defaultTimeoutStopSec: z.number().min(1).default(10),
  cacheTtlMs: z.number().min(0).default(300_000),
  searchPerToolTimeoutMs: z.number().min(1).default(8_000),
  dataDir: z.string().default(''),
})

/** Coerce the free-form `sandbox` config into a {@link SandboxBackend} (or `auto`). */
function backendOf(value: string): SandboxBackend | 'auto' {
  switch (value) {
    case 'systemd':
    case 'bwrap':
    case 'docker':
    case 'none':
      return value
    default:
      return 'auto'
  }
}

/**
 * Activate the marketplace runtime: provide `ctx.movieMarket`, seed the built-in
 * tools, and arm the supervisor + flag store as reversible effects.
 * @param ctx - host context (logger source).
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const logger: MarketLogger = ctx.logger
  const envBackend = process.env['DSH_MARKET_SANDBOX']
  const preferred = backendOf(envBackend !== undefined && envBackend !== '' ? envBackend : config.sandbox)

  const supervisor = new SprSupervisor({
    backend: preferred,
    idleReapMs: config.idleReapMs,
    requestTimeoutMs: config.requestTimeoutMs,
    spawnTimeoutMs: config.spawnTimeoutMs,
    restartMaxAttempts: 5,
    restartInitialDelayMs: 500,
    restartMaxDelayMs: 30_000,
    defaultMemoryMaxMb: config.defaultMemoryMaxMb,
    defaultCpuQuotaPct: config.defaultCpuQuotaPct,
    defaultTasksMax: config.defaultTasksMax,
    defaultTimeoutStopSec: config.defaultTimeoutStopSec,
    reapSweepMs: Math.max(1_000, Math.floor(config.idleReapMs / 4)),
    logger,
  })

  // The server-global tool registry (D2/D4): seed the built-ins and register
  // every spawn spec with the supervisor (lazy — nothing spawns until first use).
  // `statusOf` merges the supervisor's live lifecycle onto each record.
  const registry = new ToolRegistry(
    (id: string) => {
      try {
        return supervisor.status(id)
      } catch {
        return null // not (yet) known to the supervisor
      }
    },
    builtinToolDefs(),
  )
  for (const spec of registry.specs()) supervisor.register(spec)

  // The flag store persists under `<server>/.dsh/market` (mirrors the gateway's
  // workspace-root resolution) unless an explicit dataDir is configured.
  const here = fileURLToPath(import.meta.url)
  const serverRoot = resolve(here, '..', '..', '..', '..')
  const dataDir = config.dataDir !== '' ? resolve(config.dataDir) : resolve(serverRoot, '.dsh', 'market')
  const flags = new FlagStore(resolve(dataDir, 'flags.json'), logger)
  const blocklist = new Blocklist()

  // The skill index fans out over the supervisor via the MCP source client.
  const sourceClient = new McpSourceClient(
    async (toolId: string, name: string, args: Readonly<Record<string, unknown>>): Promise<McpTextResult> =>
      (await supervisor.callTool(toolId, name, args)) as unknown as McpTextResult,
  )
  const index = new SkillIndex(sourceClient, registry, flags, blocklist, {
    ttlMs: config.cacheTtlMs,
    perToolTimeoutMs: config.searchPerToolTimeoutMs,
    logger,
  })

  const service: MarketService = {
    backend: () => supervisor.currentBackend(),
    registerTool: (spec: ToolSpec): void => supervisor.register(spec),
    ensureTool: async (id: string): Promise<void> => {
      await supervisor.ensureRunning(id)
    },
    listTools: async (id: string): Promise<MarketToolInfo[]> => {
      const tools = await supervisor.listTools(id)
      return tools.map((tool): MarketToolInfo => (
        tool.description === undefined
          ? { name: tool.name }
          : { name: tool.name, description: tool.description }
      ))
    },
    callTool: async (id: string, toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> =>
      supervisor.callTool(id, toolName, args),
    status: (id: string) => supervisor.status(id),
    ids: () => supervisor.ids(),
    stopTool: async (id: string): Promise<void> => supervisor.stop(id),

    /* --- P7-M3: registry, discovery, and trust --- */

    toolRecords: (): ToolRecord[] => registry.records(),
    searchSkills: async (options: SkillSearchOptions): Promise<SkillProfile[]> => {
      const ranked = await index.search(options)
      return ranked.map((row): SkillProfile => row.profile)
    },
    skillProfile: async (id: string): Promise<SkillProfile | null> => index.profile(id),
    sourcesStatus: async (): Promise<SourceStatus[]> => index.sourcesStatus(),
    flagSkill: async (id: string, level: WarningLevel, reason: string, actor: string): Promise<WarningLevel> => {
      if (level === 'clean') {
        flags.clear(id, actor)
      } else {
        flags.set(id, level, reason, actor)
      }
      // No cache invalidation is needed: the cache stores raw source records and
      // `warningLevel` is recomputed from the live flag store on every map, so a
      // flag change is reflected on the next search — and the rate-limit
      // fallback cache is preserved (R11).
      return flags.get(id)?.level ?? 'clean'
    },
  }

  ctx.provide('movieMarket', service)

  // Reversible lifecycle: dispose the supervisor (and every sandboxed child) on
  // deactivation so a host reload never leaks a tool process.
  ctx.effect(() => () => supervisor.dispose())
}
