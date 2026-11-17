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

import type {
  SkillProfile, SkillRunOutcome, SkillTarget, SourceStatus, ToolInstallSpec, ToolManifest, ToolRecord, ToolStatus, WarningLevel,
} from '@dsh-movie/protocol'

export type {
  SourceDownloadResult, SourceProfileResult, SourceRunFile, SourceRunResult, SourceSearchResult, SourceSkillRecord,
} from './adapters/contract.ts'

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

/* -------------------------------------------------------------------------- */
/* Trust: heuristic scanner + seed blocklist (Phase-7 D8)                      */
/* -------------------------------------------------------------------------- */

/** One heuristic reason contributing to a scan verdict. */
export interface ScanSignal {
  /** The level this signal alone implies. */
  level: Exclude<WarningLevel, 'clean'>
  /** Short human-readable reason (surfaced in the card tooltip / audit). */
  reason: string
}

/** The verdict of scanning a skill's profile (or downloaded body) text. */
export interface ScanResult {
  /** The highest level implied by the signals (`clean` when none). */
  level: WarningLevel
  /** Every signal found, highest-first. */
  signals: ScanSignal[]
}

/* -------------------------------------------------------------------------- */
/* Trust: the server-global flag store (Phase-7 D8)                            */
/* -------------------------------------------------------------------------- */

/** One persisted user/operator flag against a skill (server-global). */
export interface FlagRecord {
  /** The flagged skill id (`<toolId>:<slug>`). */
  id: string
  /** The flagged level. */
  level: WarningLevel
  /** Free-text reason. */
  reason: string
  /** Who raised it (Matrix user id, or `host`). */
  actor: string
  /** When it was raised (epoch ms). */
  flaggedAt: number
}

/** One append-only audit entry (last-write-wins + audit, R10). */
export interface FlagAuditEntry {
  /** The affected skill id. */
  id: string
  /** The action taken. */
  action: 'set' | 'clear'
  /** The level set (or the prior level on clear). */
  level: WarningLevel
  /** Who acted. */
  actor: string
  /** When (epoch ms). */
  at: number
}

/* -------------------------------------------------------------------------- */
/* Skill index: fan-out search + cache (Phase-7 D4/D10/R11)                    */
/* -------------------------------------------------------------------------- */

/** Provenance tier driving the ranking trust weight (D10). */
export type TrustTier = 'curated' | 'registry' | 'installed'

/** A search request as the host index understands it. */
export interface SkillSearchOptions {
  /** Free-text query (already intent-prefixed by the client, D10). */
  q: string
  /** Optional generator-target filter. */
  target?: SkillTarget | undefined
  /** Restrict the fan-out to one tool. */
  toolId?: string | undefined
}

/** Tunables for the skill index. */
export interface IndexOptions {
  /** Cache time-to-live (ms); a fresh entry is served without a fan-out. */
  ttlMs: number
  /** Per-tool fan-out timeout (ms); a slow tool degrades rather than blocks. */
  perToolTimeoutMs: number
  /** Logger. */
  logger: MarketLogger
}

/** One row of the merged, ranked search result (a profile + its score). */
export interface RankedSkill {
  /** The mapped protocol profile. */
  profile: SkillProfile
  /** The composite ranking score (higher = better). */
  score: number
  /** The provenance tier of the providing tool. */
  tier: TrustTier
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

  /* --- P7-M3: skill discovery, trust, and the server-global tool registry --- */

  /** All tool records (built-in + installed), with merged runtime status. */
  toolRecords(): ToolRecord[]
  /**
   * Fan out `skills/search` across every enabled tool, then merge, dedup, scan,
   * apply flags, and rank (D4/D8/D10). Cache-first: a rate-limited or failing
   * tool falls back to its last-good cache and is surfaced as `degraded` (R11).
   */
  searchSkills(options: SkillSearchOptions): Promise<SkillProfile[]>
  /** Resolve one skill profile by global id (`<toolId>:<slug>`). */
  skillProfile(id: string): Promise<SkillProfile | null>
  /** Per-tool health rows for the badges/chips (D5). */
  sourcesStatus(): Promise<SourceStatus[]>
  /** Raise/clear a server-global flag against a skill (D8); returns the level. */
  flagSkill(id: string, level: WarningLevel, reason: string, actor: string): Promise<WarningLevel>

  /* --- P7-M4: skill download + server-global tool lifecycle (Leg C handlers) --- */

  /**
   * Resolve one skill's full SKILL.md body + trust-layered profile by global id
   * (`<toolId>:<slug>`) for the D7 download path. The returned profile's
   * `warningLevel` already folds in the body scan + blocklist-with-body, so the
   * gateway only enforces the size cap / filename / red-block. `null` when the
   * skill is unknown or the source failed (the run-time remedy then proceeds
   * skill-less rather than failing, R3).
   */
  downloadSkill(id: string): Promise<{ body: string; profile: SkillProfile } | null>
  /**
   * Install a third-party/user tool from an install spec (host-only, D2) and
   * register its spawn spec with the supervisor (lazy — nothing spawns until
   * first use). Returns the created record.
   */
  installTool(spec: ToolInstallSpec): Promise<ToolRecord>
  /** Uninstall a tool (built-ins refuse); stops any live child first. */
  uninstallTool(toolId: string): Promise<boolean>
  /** Enable/disable a tool; disabling stops any live child. `null` when unknown. */
  setToolEnabled(toolId: string, enabled: boolean): Promise<ToolRecord | null>
  /** One tool's health row (D5), or `null` when the tool is unknown. */
  toolStatus(toolId: string): Promise<SourceStatus | null>

  /* --- P7-M6: executable-skill run + orange-consent gate (D9) --- */

  /**
   * Execute one skill's entrypoint by global id (`<toolId>:<slug>`) inside its
   * tool's already-sandboxed process (`tools/call`). Trust gates the call: red
   * is refused, orange requires recorded consent, clean/yellow run outright. The
   * returned outcome is discriminated so the gateway never string-matches.
   */
  runSkill(id: string, args: Readonly<Record<string, unknown>>): Promise<SkillRunOutcome>
  /**
   * Record (or revoke) execution consent for an orange skill (D9). Server-global
   * so a consent given on a card also covers the director-agent trigger (D9b).
   * @returns the resulting consent state.
   */
  setSkillConsent(id: string, granted: boolean, actor: string): Promise<boolean>
  /** Whether execution consent is currently granted for a skill. */
  skillConsent(id: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The plugins-marketplace runtime; see {@link MarketService}. */
    movieMarket: MarketService
  }
}
