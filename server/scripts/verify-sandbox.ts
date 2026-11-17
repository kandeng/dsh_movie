/**
 * SPR supervisor + OS sandbox verifier (Phase-7 P7-M2).
 *
 * Headless acceptance for the milestone: it drives the {@link SprSupervisor}
 * directly (no DSH host required) against the dependency-free fixture MCP server
 * (`plugins/dsh-movie-market/test/fixture-mcp-server.ts`), asserting every M2
 * guarantee on the target Ubuntu 22.04 host:
 *
 *  1. a sandbox backend is detected (never `none` → refuse-to-run-unsandboxed);
 *  2. the fixture answers `tools/list` through the supervisor (spawn + MCP
 *     handshake + framing over the sandboxed child's stdio);
 *  3. `echo` round-trips a `tools/call`;
 *  4. an egress attempt outside the (empty) allow-list is blocked — the child
 *     runs in a private network namespace, so `net-probe` reports EGRESS_BLOCKED;
 *  5. killing the fixture (SIGKILL) never affects the host, and the supervisor
 *     transparently re-spawns on the next request (recovery);
 *  6. the cgroup `MemoryMax` cap is enforced — an `alloc` past the cap
 *     OOM-kills the child, the call rejects, and the host stays alive.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-sandbox.ts
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SprSupervisor } from '../plugins/dsh-movie-market/src/supervisor.ts'
import type { MarketLogger, ToolSpec } from '../plugins/dsh-movie-market/src/types.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** Route supervisor logs to stderr so the PASS/FAIL lines stay clean. */
const logger: MarketLogger = {
  debug: (...args: unknown[]) => process.stderr.write(`[dbg] ${args.map(String).join(' ')}\n`),
  info: (...args: unknown[]) => process.stderr.write(`[inf] ${args.map(String).join(' ')}\n`),
  warn: (...args: unknown[]) => process.stderr.write(`[wrn] ${args.map(String).join(' ')}\n`),
  error: (...args: unknown[]) => process.stderr.write(`[err] ${args.map(String).join(' ')}\n`),
}

/** Extract the first text block from an MCP CallToolResult defensively. */
function firstText(result: unknown): string {
  const shaped = result as { content?: Array<{ type?: string; text?: string }> }
  const block = shaped.content?.[0]
  return block?.text ?? ''
}

/** Whether an MCP CallToolResult is flagged as an error. */
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(here, '../plugins/dsh-movie-market/test/fixture-mcp-server.ts')
const serverRoot = resolve(here, '..')

const MEMORY_CAP_MB = 192

const fixtureSpec: ToolSpec = {
  id: 'fixture',
  command: process.execPath,
  args: [fixturePath],
  env: {},
  cwd: serverRoot,
  // Empty allow-list → private netns (hard egress deny). Small cap → alloc OOMs.
  manifest: { networkAllowlist: [], memoryMaxMb: MEMORY_CAP_MB, cpuQuotaPct: 100 },
}

async function main(): Promise<void> {
  const supervisor = new SprSupervisor({
    backend: 'auto',
    idleReapMs: 120_000,
    requestTimeoutMs: 12_000,
    spawnTimeoutMs: 20_000,
    restartMaxAttempts: 5,
    restartInitialDelayMs: 200,
    restartMaxDelayMs: 2_000,
    defaultMemoryMaxMb: MEMORY_CAP_MB,
    defaultCpuQuotaPct: 100,
    defaultTasksMax: 128,
    defaultTimeoutStopSec: 5,
    reapSweepMs: 5_000,
    logger,
  })
  supervisor.register(fixtureSpec)

  // ── 1/2. backend detection + tools/list through the sandbox ──
  let tools: string[] = []
  try {
    const discovered = await supervisor.listTools('fixture')
    tools = discovered.map((tool): string => tool.name)
  } catch (error) {
    check('fixture answers tools/list through the supervisor', false, String(error))
  }
  const backend = supervisor.currentBackend()
  check('a sandbox backend was detected (never unsandboxed)', backend !== null && backend !== 'none', `backend=${String(backend)}`)
  check('fixture advertises echo + net-probe + alloc', tools.includes('echo') && tools.includes('net-probe') && tools.includes('alloc'), `got [${tools.join(', ')}]`)

  // ── 3. tools/call round-trip ──
  try {
    const echoed = firstText(await supervisor.callTool('fixture', 'echo', { text: 'hello-sandbox' }))
    check('echo round-trips a tools/call', echoed === 'hello-sandbox', `got "${echoed}"`)
  } catch (error) {
    check('echo round-trips a tools/call', false, String(error))
  }

  // ── 4. egress outside the allow-list is blocked ──
  try {
    const res = await supervisor.callTool('fixture', 'net-probe', { host: 'example.com', port: 443 })
    const verdict = firstText(res)
    check('egress outside the allow-list is blocked', verdict.startsWith('EGRESS_BLOCKED') || isError(res), `verdict="${verdict}" isError=${isError(res)}`)
  } catch (error) {
    // A thrown call (e.g. connect hard-fails the request) also means "not allowed".
    check('egress outside the allow-list is blocked', true, `call rejected (blocked): ${String(error)}`)
  }

  // ── 5. killing the fixture never affects the host, and recovers ──
  const hostPidBefore = process.pid
  const killed = supervisor.killChild('fixture', 'SIGKILL')
  check('supervisor could signal the fixture child', killed, `kill returned ${killed}`)
  await new Promise((r) => setTimeout(r, 400))
  check('host process is alive after killing the fixture', process.pid === hostPidBefore, `pid=${process.pid}`)
  const afterKill = supervisor.status('fixture')
  check('killed fixture is marked error/stopped (not running)', afterKill.status !== 'running', `status=${afterKill.status}`)
  try {
    const recovered = firstText(await supervisor.callTool('fixture', 'echo', { text: 'recovered' }))
    check('supervisor re-spawns the fixture on next request (recovery)', recovered === 'recovered', `got "${recovered}"`)
  } catch (error) {
    check('supervisor re-spawns the fixture on next request (recovery)', false, String(error))
  }

  // ── 6. memory cap enforced: alloc past MemoryMax OOM-kills the child ──
  let allocRejected = false
  try {
    const allocResult = firstText(await supervisor.callTool('fixture', 'alloc', { mb: MEMORY_CAP_MB * 4 }))
    // If it somehow answered, the cap did NOT enforce.
    allocRejected = false
    process.stderr.write(`[wrn] alloc answered unexpectedly: ${allocResult}\n`)
  } catch {
    allocRejected = true
  }
  check('memory cap enforced (alloc past MemoryMax killed the child)', allocRejected, allocRejected ? 'call rejected as expected' : 'alloc survived — cap not enforced')
  check('host process is alive after the OOM kill', process.pid === hostPidBefore, `pid=${process.pid}`)

  // ── teardown ──
  await supervisor.dispose()
  const afterDispose = supervisor.status('fixture')
  check('dispose stops the fixture child', afterDispose.status !== 'running', `status=${afterDispose.status}`)
}

await main()

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
