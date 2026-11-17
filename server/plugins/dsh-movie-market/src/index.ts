/**
 * `dsh-movie-market`: the Phase-7 plugins marketplace, exposed as the Cordis
 * service `ctx.movieMarket`.
 *
 * In P7-M2 this plugin hosts the **SPR supervisor** (`supervisor.ts`): every
 * external skill/tool source runs as an OS-sandboxed MCP stdio child, spawned
 * and lifecycle-managed entirely server-side (see `sandbox.ts`). The service
 * surface here is the tool lifecycle only; skill search/index/download and the
 * Leg C `plugins/*` handlers are layered on in P7-M3/M4.
 *
 * Lifecycle is a reversible Cordis effect: activation constructs the supervisor
 * (which arms the idle-reap sweeper), disposal stops every sandboxed child, so a
 * host reload never leaks a tool process.
 *
 * @module dsh-movie-market
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SprSupervisor } from './supervisor.ts'
import type { MarketService, MarketToolInfo, SandboxBackend, ToolSpec } from './types.ts'

export type { MarketService, MarketToolInfo, ToolSpec, ToolRuntimeStatus } from './types.ts'

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
 * Activate the marketplace runtime: provide `ctx.movieMarket` and arm the
 * supervisor as a reversible effect.
 * @param ctx - host context (logger source).
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
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
    logger: ctx.logger,
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
  }

  ctx.provide('movieMarket', service)

  // Reversible lifecycle: dispose the supervisor (and every sandboxed child) on
  // deactivation so a host reload never leaks a tool process.
  ctx.effect(() => () => supervisor.dispose())
}
