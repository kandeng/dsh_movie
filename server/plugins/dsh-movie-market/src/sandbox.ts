/**
 * The OS sandbox spawn wrapper (Phase-7 D3).
 *
 * DSH has no process-isolation facility (Cordis plugins are in-process), so
 * every external tool is launched as an OS-sandboxed child. This module turns a
 * {@link ResolvedSandboxPolicy} + spawn target into a concrete argv for one of
 * three backends and spawns it with piped stdio:
 *
 * - `systemd` (default): `systemd-run --user --scope` supplies the **cgroup**
 *   enforcement (`MemoryMax`, `CPUQuota`, `TasksMax`, `TimeoutStopSec`, and a
 *   best-effort `IPAddressAllow`/`IPAddressDeny` BPF filter), wrapping
 *   `bwrap` which supplies the **namespace** isolation (read-only root,
 *   private tmp, and a private network namespace that hard-denies all egress
 *   when the manifest declares no network). Verified on Ubuntu 22.04 / systemd
 *   249: `MemoryMax` OOM-kills a touching allocator (exit 137) through bwrap
 *   while the host stays alive, and `--unshare-net` reliably blocks egress.
 * - `bwrap` (fallback): bubblewrap alone — namespace isolation without cgroup
 *   caps — for hosts without a usable user systemd instance.
 * - `docker` (operator-selected): the strongest runtime; requires a preconfigured
 *   image (`policy.dockerImage`).
 * - `none`: a sentinel — {@link spawnSandboxed} refuses to run (R5: a tool that
 *   cannot be sandboxed stays disabled, never unsandboxed).
 *
 * Network model: bwrap/docker net isolation is all-or-nothing, so an **empty**
 * `networkAllowlist` gives a reliable deny-all (private netns / `--network=none`);
 * a **non-empty** list re-enables networking and layers the best-effort systemd
 * IP filter on top. Fine-grained per-IP allow-listing for networked tools is a
 * documented best-effort (phase-7 D3/R5), not an M2 guarantee.
 *
 * @module dsh-movie-market/sandbox
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { ToolManifest } from '@dsh-movie/protocol'
import type {
  MarketLogger, ResolvedSandboxPolicy, SandboxBackend, SandboxedChild, SpawnRequest,
} from './types.ts'

/** Ambient env vars a sandboxed node/python tool still needs to function. */
const AMBIENT_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
]

/**
 * Resolve a {@link ResolvedSandboxPolicy} from a tool manifest + defaults.
 * @param manifest - the tool's declared (non-secret) sandbox manifest.
 * @param defaults - supervisor defaults for anything the manifest omits.
 * @returns the fully resolved policy consumed by the argv builders.
 */
export function resolvePolicy(
  manifest: ToolManifest,
  defaults: {
    memoryMaxMb: number
    cpuQuotaPct: number
    tasksMax: number
    timeoutStopSec: number
  },
): ResolvedSandboxPolicy {
  const memoryMb = manifest.memoryMaxMb ?? defaults.memoryMaxMb
  const policy: ResolvedSandboxPolicy = {
    memoryMaxBytes: Math.max(1, Math.round(memoryMb)) * 1024 * 1024,
    // Always deny swap escape so `MemoryMax` is a true hard cap (see
    // ResolvedSandboxPolicy.memorySwapMaxBytes). Without this a runaway
    // allocator spills into the user slice's unlimited swap and survives.
    memorySwapMaxBytes: 0,
    cpuQuotaPct: manifest.cpuQuotaPct ?? defaults.cpuQuotaPct,
    tasksMax: defaults.tasksMax,
    networkAllowlist: [...manifest.networkAllowlist],
    timeoutStopSec: defaults.timeoutStopSec,
  }
  const image = process.env['DSH_MARKET_DOCKER_IMAGE']
  if (image !== undefined && image !== '') policy.dockerImage = image
  return policy
}

/**
 * Build a scrubbed child environment: an allow-listed slice of the ambient env
 * merged with the tool's own non-secret env. Credential *values* are injected
 * by the supervisor (from `server/.env`) into `toolEnv`, never hard-coded here.
 * @param toolEnv - the tool's env (already credential-resolved by the caller).
 * @returns the env object handed to `spawn`.
 */
export function scrubbedEnv(toolEnv: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of AMBIENT_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(toolEnv)) env[key] = value
  return env
}

/** Whether an executable is resolvable on PATH. */
function commandExists(command: string): boolean {
  const probe = spawnSync('which', [command], { stdio: 'ignore' })
  return probe.status === 0
}

/**
 * Probe whether a user systemd transient scope actually launches here (a user
 * manager + session D-Bus must be reachable). This is the real gate for the
 * `systemd` backend — accepting `--property=` syntactically is not enough.
 */
function systemdScopeUsable(): boolean {
  if (!commandExists('systemd-run')) return false
  const probe = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--quiet', '--collect', '--', '/bin/true'],
    { stdio: 'ignore' },
  )
  return probe.status === 0
}

/** Probe whether bubblewrap can create an isolated namespace here. */
function bwrapUsable(): boolean {
  if (!commandExists('bwrap')) return false
  const probe = spawnSync(
    'bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '--', '/bin/true'],
    { stdio: 'ignore' },
  )
  return probe.status === 0
}

/** Probe whether the docker daemon is reachable. */
function dockerUsable(): boolean {
  if (!commandExists('docker')) return false
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return probe.status === 0
}

/**
 * Detect the sandbox backend to use.
 * @param preferred - the operator preference (`auto` probes strongest-first).
 * @param logger - diagnostics sink.
 * @returns the resolved backend, or `none` when nothing is usable.
 */
export function detectBackend(preferred: SandboxBackend | 'auto', logger: MarketLogger): SandboxBackend {
  const order: readonly SandboxBackend[] = preferred === 'auto'
    ? ['systemd', 'bwrap', 'docker']
    : [preferred]
  for (const candidate of order) {
    const ok = candidate === 'systemd' ? systemdScopeUsable()
      : candidate === 'bwrap' ? bwrapUsable()
        : candidate === 'docker' ? dockerUsable()
          : false
    if (ok) {
      logger.info('[market:sandbox] backend selected: %s', candidate)
      return candidate
    }
    logger.warn('[market:sandbox] backend %s unavailable', candidate)
  }
  logger.error('[market:sandbox] no usable sandbox backend; tools will stay disabled (R5)')
  return 'none'
}

/** Build the bubblewrap isolation argv (used by both `bwrap` and `systemd`). */
function buildBwrapArgv(req: SpawnRequest): string[] {
  const argv: string[] = [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--unshare-all',
  ]
  // A non-empty allow-list means "this tool needs network": re-enable it.
  // bwrap networking is all-or-nothing, so per-IP filtering is delegated to the
  // systemd scope's best-effort IPAddressAllow when composed.
  if (req.policy.networkAllowlist.length > 0) argv.push('--share-net')
  argv.push('--die-with-parent', '--chdir', req.cwd)
  for (const [key, value] of Object.entries(req.env)) argv.push('--setenv', key, value)
  argv.push('--', req.command, ...req.args)
  return argv
}

/** Build the `systemd-run --user --scope` argv wrapping bwrap. */
function buildSystemdArgv(req: SpawnRequest): string[] {
  const p = req.policy
  const props: string[] = [
    `MemoryMax=${p.memoryMaxBytes}`,
    `MemorySwapMax=${p.memorySwapMaxBytes}`,
    `CPUQuota=${p.cpuQuotaPct}%`,
    `TasksMax=${p.tasksMax}`,
    `TimeoutStopSec=${p.timeoutStopSec}`,
  ]
  if (p.networkAllowlist.length > 0) {
    props.push(`IPAddressAllow=${p.networkAllowlist.join(' ')}`, 'IPAddressDeny=any')
  }
  const argv: string[] = ['systemd-run', '--user', '--scope', '--quiet', '--collect']
  for (const prop of props) argv.push(`--property=${prop}`)
  argv.push('--', ...buildBwrapArgv(req))
  return argv
}

/** Build the `docker run` argv. */
function buildDockerArgv(req: SpawnRequest): string[] {
  const p = req.policy
  const image = p.dockerImage ?? process.env['DSH_MARKET_DOCKER_IMAGE'] ?? 'node:24-slim'
  // docker's `--memory-swap` is memory+swap combined; setting it equal to
  // `--memory` disables swap, matching the cgroup `MemorySwapMax=0` intent.
  const argv: string[] = [
    'docker', 'run', '--rm', '-i',
    `--memory=${p.memoryMaxBytes}`,
    `--memory-swap=${p.memoryMaxBytes + p.memorySwapMaxBytes}`,
    `--cpus=${(p.cpuQuotaPct / 100).toFixed(2)}`,
    `--pids-limit=${p.tasksMax}`,
  ]
  if (p.networkAllowlist.length === 0) argv.push('--network=none')
  argv.push('--read-only', '--tmpfs', '/tmp', '--workdir', req.cwd)
  if (req.cwd !== '') argv.push('-v', `${req.cwd}:${req.cwd}:ro`)
  for (const [key, value] of Object.entries(req.env)) argv.push('-e', `${key}=${value}`)
  argv.push(image, req.command, ...req.args)
  return argv
}

/**
 * Build the full argv for a backend.
 * @param backend - the resolved backend (`none` throws).
 * @param req - the spawn request.
 * @returns the argv array (element 0 is the executable).
 */
export function buildSandboxArgv(backend: SandboxBackend, req: SpawnRequest): string[] {
  switch (backend) {
    case 'systemd':
      return buildSystemdArgv(req)
    case 'bwrap':
      return buildBwrapArgv(req)
    case 'docker':
      return buildDockerArgv(req)
    case 'none':
      throw new Error('no sandbox backend available; refusing to spawn a tool unsandboxed')
  }
}

/**
 * Spawn one sandboxed child with piped stdio.
 * @param backend - the resolved backend (`none` throws, R5).
 * @param req - the spawn request.
 * @returns the running child + the argv used.
 */
export function spawnSandboxed(backend: SandboxBackend, req: SpawnRequest): SandboxedChild {
  const argv = buildSandboxArgv(backend, req)
  const [exe, ...rest] = argv
  if (exe === undefined) throw new Error('empty sandbox argv')
  const child: ChildProcess = spawn(exe, rest, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: scrubbedEnv(req.env),
    cwd: req.cwd === '' ? process.cwd() : req.cwd,
  })
  return { child, backend, argv }
}
