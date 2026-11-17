/**
 * The Source-Plugin-Runtime (SPR) supervisor (Phase-7 D3).
 *
 * One supervisor owns every installed tool. Each tool is an MCP server that
 * runs as an OS-sandboxed child (see `sandbox.ts`); the supervisor attaches an
 * MCP `Client` to that child's stdio (see `transport.ts`) and exposes
 * lazy, health-checked, restart-gated, idle-reaped access to it.
 *
 * Design notes:
 * - **Lazy spawn.** A tool's child is created on first use (`ensureRunning`),
 *   not at registration, so an idle host pays no per-source process cost (R6).
 * - **Restart with backoff.** The model is re-spawn-on-demand rather than a
 *   proactive restart loop: an unexpected child exit flips status to `error`
 *   and the *next* request re-spawns, gated by an exponential backoff so a
 *   crash-looping tool cannot spin. A connection that stays healthy resets the
 *   budget. Killing a child never touches the host (verified in M2).
 * - **Idle reap.** A sweeper stops children idle past `idleReapMs`; the next
 *   request transparently re-spawns.
 * - **Refuse-to-run-unsandboxed.** If no backend is available, spawn throws and
 *   the tool stays `error` (R5) — never unsandboxed.
 *
 * This class is Cordis-free; `index.ts` wraps it as `ctx.movieMarket`.
 *
 * @module dsh-movie-market/supervisor
 */

import { Client, type CallToolResult, type ListToolsResult, type Tool } from '@modelcontextprotocol/client'
import type { ToolStatus } from '@dsh-movie/protocol'
import { detectBackend, resolvePolicy, spawnSandboxed } from './sandbox.ts'
import { McpChildTransport } from './transport.ts'
import type {
  MarketLogger, SandboxBackend, SupervisorOptions, ToolRuntimeStatus, ToolSpec,
} from './types.ts'

/** Internal per-tool runtime state. */
interface ManagedTool {
  spec: ToolSpec
  status: ToolStatus
  child: import('node:child_process').ChildProcess | null
  client: Client | null
  transport: McpChildTransport | null
  backend: SandboxBackend
  argv: readonly string[]
  lastUsedAt: number | null
  lastError: string | null
  consecutiveFailures: number
  lastFailureAt: number
  /** True while an intentional stop/dispose is in flight (suppresses restart). */
  stopping: boolean
}

/** Resolve a promise-or-reject against a wall-clock deadline. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
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

/** The SPR supervisor: sandboxed MCP tool lifecycle management. */
export class SprSupervisor {
  private readonly options: SupervisorOptions
  private readonly logger: MarketLogger
  private readonly tools = new Map<string, ManagedTool>()
  private activeBackend: SandboxBackend | null = null
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  /**
   * @param options - supervisor tunables + logger.
   */
  constructor(options: SupervisorOptions) {
    this.options = options
    this.logger = options.logger
    this.reapTimer = setInterval(() => {
      this.sweepIdle().catch((error: unknown) => {
        this.logger.warn('[market:spr] idle sweep failed: %s', String(error))
      })
    }, options.reapSweepMs)
    // Do not keep the host alive merely for the sweeper.
    this.reapTimer.unref?.()
  }

  /** The backend in use (probed lazily); `null` until the first spawn. */
  currentBackend(): SandboxBackend | null {
    return this.activeBackend
  }

  /**
   * Register a tool spec. Idempotent by id; does not spawn (lazy).
   * @param spec - the tool to register.
   */
  register(spec: ToolSpec): void {
    const existing = this.tools.get(spec.id)
    if (existing !== undefined) {
      existing.spec = spec
      return
    }
    this.tools.set(spec.id, {
      spec,
      status: 'stopped',
      child: null,
      client: null,
      transport: null,
      backend: 'none',
      argv: [],
      lastUsedAt: null,
      lastError: null,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      stopping: false,
    })
    this.logger.info('[market:spr] registered tool %s (%s)', spec.id, spec.command)
  }

  /**
   * Ensure a tool's sandboxed child is running and connected, spawning lazily.
   * @param id - the tool id.
   * @returns the connected MCP client.
   */
  async ensureRunning(id: string): Promise<Client> {
    const t = this.require(id)
    if (this.disposed) throw new Error('supervisor disposed')
    if (t.status === 'disabled') throw new Error(`tool ${id} is disabled`)
    if (t.client !== null && t.child !== null && t.child.exitCode === null && t.child.signalCode === null) {
      t.lastUsedAt = Date.now()
      return t.client
    }
    this.assertBackoffAllows(t)
    if (this.activeBackend === null) {
      this.activeBackend = detectBackend(this.options.backend, this.logger)
    }
    if (this.activeBackend === 'none') {
      t.status = 'error'
      t.lastError = 'no usable sandbox backend'
      throw new Error(t.lastError)
    }

    const policy = resolvePolicy(t.spec.manifest, {
      memoryMaxMb: this.options.defaultMemoryMaxMb,
      cpuQuotaPct: this.options.defaultCpuQuotaPct,
      tasksMax: this.options.defaultTasksMax,
      timeoutStopSec: this.options.defaultTimeoutStopSec,
    })
    let child: import('node:child_process').ChildProcess
    let argv: readonly string[]
    try {
      const spawned = spawnSandboxed(this.activeBackend, {
        command: t.spec.command,
        args: t.spec.args,
        env: t.spec.env,
        cwd: t.spec.cwd,
        policy,
      })
      child = spawned.child
      argv = spawned.argv
    } catch (error) {
      this.recordFailure(t, error)
      throw error instanceof Error ? error : new Error(String(error))
    }

    t.child = child
    t.argv = argv
    t.backend = this.activeBackend
    t.status = 'running'
    t.lastError = null
    t.stopping = false
    child.stderr?.on('data', (chunk: Buffer): void => {
      const text = chunk.toString().trim()
      if (text !== '') this.logger.debug('[market:%s] %s', id, text)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null): void => {
      this.onChildExit(id, code, signal)
    })

    const transport = new McpChildTransport(child)
    const client = new Client(
      { name: 'dsh-market-supervisor', version: '0.1.0' },
      { capabilities: {} },
    )
    try {
      await withTimeout(client.connect(transport), this.options.spawnTimeoutMs, `connect ${id}`)
      // Health check: a successful tools/list proves the handshake + framing.
      await withTimeout(client.listTools(), this.options.requestTimeoutMs, `health ${id}`)
    } catch (error) {
      await this.teardown(id)
      this.recordFailure(t, error)
      throw error instanceof Error ? error : new Error(String(error))
    }

    t.client = client
    t.transport = transport
    t.consecutiveFailures = 0
    t.lastUsedAt = Date.now()
    this.logger.info('[market:spr] tool %s running (backend=%s pid=%s)', id, t.backend, String(child.pid ?? '?'))
    return client
  }

  /**
   * List a tool's MCP tools, spawning it if needed.
   * @param id - the tool id.
   * @returns the discovered tools.
   */
  async listTools(id: string): Promise<Tool[]> {
    const client = await this.ensureRunning(id)
    const result = await withTimeout<ListToolsResult>(client.listTools(), this.options.requestTimeoutMs, `tools/list ${id}`)
    this.touch(id)
    return result.tools
  }

  /**
   * Call one MCP tool, spawning the provider if needed.
   * @param id - the tool id.
   * @param name - the upstream MCP tool name.
   * @param args - the call arguments.
   * @returns the MCP call result.
   */
  async callTool(id: string, name: string, args: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    const client = await this.ensureRunning(id)
    const result = await withTimeout<CallToolResult>(
      client.callTool({ name, arguments: args }),
      this.options.requestTimeoutMs,
      `tools/call ${id}.${name}`,
    )
    this.touch(id)
    return result
  }

  /** A lifecycle snapshot for one tool. */
  status(id: string): ToolRuntimeStatus {
    const t = this.require(id)
    return {
      id,
      status: t.status,
      backend: t.backend,
      pid: t.child?.pid ?? null,
      lastError: t.lastError,
      lastUsedAt: t.lastUsedAt,
    }
  }

  /** All registered tool ids. */
  ids(): string[] {
    return [...this.tools.keys()]
  }

  /**
   * Send a signal directly to a tool's child (test/diagnostic hook). This is how
   * the M2 acceptance asserts "killing a tool never affects the host".
   * @param id - the tool id.
   * @param signal - the signal to send.
   */
  killChild(id: string, signal: NodeJS.Signals = 'SIGKILL'): boolean {
    const t = this.require(id)
    if (t.child === null) return false
    return t.child.kill(signal)
  }

  /**
   * Stop a tool: tear down its child/client and mark it `stopped`. The spec is
   * retained so a later request re-spawns it.
   * @param id - the tool id.
   */
  async stop(id: string): Promise<void> {
    const t = this.tools.get(id)
    if (t === undefined) return
    t.stopping = true
    await this.teardown(id)
    if (t.status !== 'error') t.status = 'stopped'
  }

  /** Stop every tool and clear the sweeper. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    for (const id of [...this.tools.keys()]) {
      await this.stop(id)
    }
  }

  /** Look up a managed tool or throw. */
  private require(id: string): ManagedTool {
    const t = this.tools.get(id)
    if (t === undefined) throw new Error(`unknown tool ${id}`)
    return t
  }

  /** Mark a tool freshly used (delays idle reap). */
  private touch(id: string): void {
    const t = this.tools.get(id)
    if (t !== undefined) t.lastUsedAt = Date.now()
  }

  /** Record a spawn/connect failure for backoff bookkeeping. */
  private recordFailure(t: ManagedTool, error: unknown): void {
    t.consecutiveFailures += 1
    t.lastFailureAt = Date.now()
    t.status = 'error'
    t.lastError = error instanceof Error ? error.message : String(error)
    this.logger.warn('[market:spr] tool %s failed (%d consecutive): %s', t.spec.id, t.consecutiveFailures, t.lastError)
  }

  /** Throw when a crash-looping tool is still inside its backoff window. */
  private assertBackoffAllows(t: ManagedTool): void {
    const max = this.options.restartMaxAttempts
    if (t.consecutiveFailures < max) return
    const delay = Math.min(
      this.options.restartMaxDelayMs,
      this.options.restartInitialDelayMs * 2 ** (t.consecutiveFailures - max),
    )
    const elapsed = Date.now() - t.lastFailureAt
    if (elapsed < delay) {
      throw new Error(`tool ${t.spec.id} is backing off after ${t.consecutiveFailures} failures (retry in ${delay - elapsed}ms)`)
    }
  }

  /** React to a child exiting: clear refs, classify status. */
  private onChildExit(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const t = this.tools.get(id)
    if (t === undefined) return
    t.client = null
    t.transport = null
    t.child = null
    if (t.stopping || this.disposed) {
      t.status = 'stopped'
      return
    }
    // Unexpected exit (crash, OOM kill, external SIGKILL): record for backoff so
    // the next request re-spawns under the gate; the host is unaffected.
    t.consecutiveFailures += 1
    t.lastFailureAt = Date.now()
    t.status = 'error'
    t.lastError = `child exited unexpectedly (code=${String(code)} signal=${String(signal)})`
    this.logger.warn('[market:spr] tool %s %s', id, t.lastError)
  }

  /** Close client/transport and terminate the child for one tool. */
  private async teardown(id: string): Promise<void> {
    const t = this.tools.get(id)
    if (t === undefined) return
    const client = t.client
    const transport = t.transport
    const child = t.child
    t.client = null
    t.transport = null
    t.child = null
    if (client !== null) {
      try {
        await client.close()
      } catch {
        // Already gone.
      }
    }
    if (transport !== null) {
      try {
        await transport.close()
      } catch {
        // Already gone.
      }
    }
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
  }

  /** Reap children idle past the TTL. */
  private async sweepIdle(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    for (const [id, t] of this.tools) {
      if (t.child === null || t.lastUsedAt === null) continue
      if (now - t.lastUsedAt >= this.options.idleReapMs) {
        this.logger.info('[market:spr] reaping idle tool %s', id)
        await this.stop(id)
      }
    }
  }
}
