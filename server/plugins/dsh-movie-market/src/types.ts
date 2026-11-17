/**
 * Shared types for the `dsh-movie-market` plugin (Phase-7 P7-M2).
 *
 * Everything here is deliberately framework-light and Cordis-free so the SPR
 * supervisor and the sandbox spawn wrapper can be exercised headlessly by
 * `server/scripts/verify-sandbox.ts` without booting a DSH host. The public
 * protocol types (`ToolManifest`, `ToolStatus`, `SourceStatus`, …) are re-used
 * verbatim from `@dsh-movie/protocol` so the wire contract and the runtime
 * never drift.
 *
 * @module dsh-movie-market/types
 */

import type { ToolManifest, ToolStatus } from '@dsh-movie/protocol'

/**
 * The minimal structured logger the supervisor/sandbox need. `ctx.logger`
 * (consola) satisfies this structurally; the verify script passes a console
 * shim. Signatures are `(...args)` so any logger is assignable.
 */
export interface MarketLogger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * OS sandbox backend (Phase-7 D3). `auto` probes the host at supervisor start
 * and picks the strongest available; `none` is a sentinel meaning "no backend
 * could be found" — the supervisor refuses to spawn rather than run a tool
 * unsandboxed (R5).
 */
export type SandboxBackend = 'systemd' | 'bwrap' | 'docker' | 'none'

/**
 * A fully resolved, non-secret sandbox policy derived from a
 * {@link ToolManifest} plus supervisor defaults. This is what the argv builders
 * consume; it never carries credential *values* (only the ambient env the
 * supervisor injects).
 */
export interface ResolvedSandboxPolicy {
  /** Hard memory cap in bytes (cgroup `MemoryMax`). */
  memoryMaxBytes: number
  /**
   * Hard swap cap in bytes (cgroup `MemorySwapMax`). Defaults to `0`: verified
   * on Ubuntu 22.04 / systemd 249 that `MemoryMax` alone only caps *RAM* — with
   * the user slice's `memory.swap.max=max` a runaway allocator spills into swap
   * and survives (800 MB touched under a 192 MB cap). `MemorySwapMax=0` closes
   * that escape so the cap OOM-kills (exit 137), including through
   * `bwrap --unshare-all`.
   */
  memorySwapMaxBytes: number
  /** CPU quota as a percentage of one core (`100` = one full core). */
  cpuQuotaPct: number
  /** Max concurrent tasks/processes in the cgroup (`TasksMax`). */
  tasksMax: number
  /**
   * Egress allow-list (IP/CIDR entries). An **empty** list means "deny all
   * egress": the sandbox runs the child in a private network namespace
   * (bwrap `--unshare-net`) with no interfaces, which is enforced reliably.
   * A **non-empty** list re-enables networking (`--share-net`) and layers a
   * best-effort systemd `IPAddressAllow`/`IPAddressDeny=any` cgroup-BPF filter
   * on top (per-IP filtering is best-effort; see the phase-7 doc D3/R5).
   */
  networkAllowlist: readonly string[]
  /** Grace period before a stopping child is SIGKILLed (systemd `TimeoutStopSec`). */
  timeoutStopSec: number
  /** docker image, only meaningful for the `docker` backend. */
  dockerImage?: string | undefined
}

/** A request to spawn one sandboxed child process. */
export interface SpawnRequest {
  /** The tool executable (e.g. `node`). */
  command: string
  /** Arguments passed verbatim (no shell interpolation). */
  args: readonly string[]
  /** Non-secret environment merged over a scrubbed ambient env. */
  env: Readonly<Record<string, string>>
  /** Working directory for the child. */
  cwd: string
  /** The resolved sandbox policy to enforce. */
  policy: ResolvedSandboxPolicy
}

/** A running sandboxed child plus the metadata the supervisor tracks. */
export interface SandboxedChild {
  /** The Node child process (the outermost wrapper: systemd-run/bwrap/docker). */
  child: import('node:child_process').ChildProcess
  /** The backend actually used to spawn it. */
  backend: SandboxBackend
  /** The exact argv used, for diagnostics/logs. */
  argv: readonly string[]
}

/**
 * One registered tool = one sandboxed MCP server (Phase-7 D2). The supervisor
 * owns the spec; installation/registry persistence lands in P7-M3.
 */
export interface ToolSpec {
  /** Stable tool id. */
  id: string
  /** The tool executable (e.g. `node`). */
  command: string
  /** Arguments. */
  args: readonly string[]
  /** Non-secret env. */
  env: Readonly<Record<string, string>>
  /** Working directory. */
  cwd: string
  /** The non-secret sandbox manifest declared by the tool. */
  manifest: ToolManifest
}

/** Tunables for the SPR supervisor. */
export interface SupervisorOptions {
  /** Preferred backend; `auto` probes and picks the strongest available. */
  backend: SandboxBackend | 'auto'
  /** Idle time after last use before a live child is reaped (ms). */
  idleReapMs: number
  /** Per MCP request timeout (health ping, tools/list, tools/call) in ms. */
  requestTimeoutMs: number
  /** Wall-clock budget for spawn + connect + health before giving up (ms). */
  spawnTimeoutMs: number
  /** Consecutive failed spawn attempts per outage before backing off hard. */
  restartMaxAttempts: number
  /** First restart delay (ms); doubles per consecutive failure. */
  restartInitialDelayMs: number
  /** Restart-delay ceiling (ms); also the uptime that resets the attempt budget. */
  restartMaxDelayMs: number
  /** Default memory cap (MB) when a manifest omits `memoryMaxMb`. */
  defaultMemoryMaxMb: number
  /** Default CPU quota percent when a manifest omits `cpuQuotaPct`. */
  defaultCpuQuotaPct: number
  /** Default `TasksMax` cgroup limit. */
  defaultTasksMax: number
  /** Default `TimeoutStopSec`. */
  defaultTimeoutStopSec: number
  /** Interval of the idle-reap sweeper (ms). */
  reapSweepMs: number
  /** Logger. */
  logger: MarketLogger
}

/** A per-tool lifecycle snapshot surfaced to callers/tests. */
export interface ToolRuntimeStatus {
  /** Tool id. */
  id: string
  /** Lifecycle state (mirrors the protocol `ToolStatus`). */
  status: ToolStatus
  /** Backend the tool is currently (or was last) spawned under. */
  backend: SandboxBackend
  /** Live child pid, when running. */
  pid: number | null
  /** Last error message, when degraded/errored. */
  lastError: string | null
  /** Epoch ms of the last successful use (drives idle reap). */
  lastUsedAt: number | null
}

/** A minimal tool descriptor (name + optional description), MCP-type-free. */
export interface MarketToolInfo {
  /** The upstream MCP tool name. */
  name: string
  /** The upstream description, when present. */
  description?: string | undefined
}

/**
 * The `ctx.movieMarket` service surface (Phase-7 D3). In P7-M2 this is the tool
 * lifecycle only; skill search/index/download and the Leg C `plugins/*`
 * handlers are layered on in P7-M3/M4.
 */
export interface MarketService {
  /** The sandbox backend in use (probed lazily); `null` before first spawn. */
  backend(): SandboxBackend | null
  /** Register a tool spec (idempotent; does not spawn — spawn is lazy). */
  registerTool(spec: ToolSpec): void
  /** Ensure a tool's sandboxed child is running and connected. */
  ensureTool(id: string): Promise<void>
  /** List a tool's MCP tools. */
  listTools(id: string): Promise<MarketToolInfo[]>
  /** Call one MCP tool inside the tool's sandbox. */
  callTool(id: string, name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>
  /** A lifecycle snapshot for one tool. */
  status(id: string): ToolRuntimeStatus
  /** All registered tool ids. */
  ids(): string[]
  /** Stop a tool (retain its spec for lazy re-spawn). */
  stopTool(id: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The plugins-marketplace runtime; see {@link MarketService}. */
    movieMarket: MarketService
  }
}
