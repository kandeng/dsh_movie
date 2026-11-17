/**
 * Plugins marketplace skill-search verifier (Phase-7 P7-M3).
 *
 * Headless acceptance for the milestone. It boots a real {@link SprSupervisor},
 * registers THREE live sandboxed skill-source tools — the two canned fixtures
 * (`fixture-source-a.ts`, `fixture-source-b.ts`) plus the real offline **curated**
 * adapter — and drives the host {@link SkillIndex} over them, asserting every M3
 * guarantee from the phase-7 doc:
 *
 *  1. `skills/search` for "literary script" and "shot plan" **fans out to ≥3
 *     tools** and returns **merged, ranked, deduped** profiles;
 *  2. trust levels are applied — a credential-shaped skill scans **orange**, a
 *     URL-bearing skill scans **yellow**, a blocklisted skill goes **red**, and a
 *     user flag raises then clears a level;
 *  3. per-tool **source status** is reported;
 *  4. a **rate-limited** source is handled **cache-first** (its skills survive
 *     from the host cache and the source is marked `degraded`) — the GitHub
 *     10 req/min cap path (R11);
 *  5. the real curated adapter answers `skills/profile` and `skills/download`
 *     end-to-end through the sandbox + MCP transport.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-plugins-search.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillProfile, SourceStatus, ToolRecord } from '@dsh-movie/protocol'
import { builtinToolDefs, type BuiltinToolDef } from '../plugins/dsh-movie-market/src/builtinTools.ts'
import { FlagStore } from '../plugins/dsh-movie-market/src/flagStore.ts'
import { ToolRegistry } from '../plugins/dsh-movie-market/src/registry.ts'
import { McpSourceClient, SkillIndex, type McpTextResult } from '../plugins/dsh-movie-market/src/skillIndex.ts'
import { SprSupervisor } from '../plugins/dsh-movie-market/src/supervisor.ts'
import { Blocklist } from '../plugins/dsh-movie-market/src/trust.ts'
import type { MarketLogger, ToolSpec } from '../plugins/dsh-movie-market/src/types.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** Route supervisor/index logs to stderr so the PASS/FAIL lines stay clean. */
const logger: MarketLogger = {
  debug: (...args: unknown[]) => process.stderr.write(`[dbg] ${args.map(String).join(' ')}\n`),
  info: (...args: unknown[]) => process.stderr.write(`[inf] ${args.map(String).join(' ')}\n`),
  warn: (...args: unknown[]) => process.stderr.write(`[wrn] ${args.map(String).join(' ')}\n`),
  error: (...args: unknown[]) => process.stderr.write(`[err] ${args.map(String).join(' ')}\n`),
}

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')
const marketRoot = resolve(serverRoot, 'plugins', 'dsh-movie-market')
const fixtureA = resolve(marketRoot, 'test', 'fixture-source-a.ts')
const fixtureB = resolve(marketRoot, 'test', 'fixture-source-b.ts')

/** Build a spawnable fixture tool definition (offline, small memory cap). */
function fixtureDef(id: string, name: string, provider: string, script: string): BuiltinToolDef {
  const manifest = { networkAllowlist: [] as readonly string[], memoryMaxMb: 192, cpuQuotaPct: 100 }
  const record: ToolRecord = {
    id,
    name,
    provider,
    kind: 'builtin',
    transport: 'mcp-stdio',
    manifest,
    installed: true,
    enabled: true,
    requiresCredentials: false,
    status: 'stopped',
    warningLevel: 'clean',
  }
  const spec: ToolSpec = { id, command: process.execPath, args: [script], env: {}, cwd: serverRoot, manifest }
  return { record, spec, tier: 'registry' }
}

/** Find the first profile matching a predicate. */
function findProfile(rows: SkillProfile[], pred: (p: SkillProfile) => boolean): SkillProfile | undefined {
  return rows.find(pred)
}

/** Decode the first text block of an MCP result as JSON. */
function decodeJson<T>(result: unknown): T | null {
  const shaped = result as McpTextResult
  const block = shaped.content?.find((c): boolean => c.type === 'text')
  const text = block?.text
  if (text === undefined || text === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const supervisor = new SprSupervisor({
    backend: 'auto',
    idleReapMs: 120_000,
    requestTimeoutMs: 15_000,
    spawnTimeoutMs: 25_000,
    restartMaxAttempts: 5,
    restartInitialDelayMs: 200,
    restartMaxDelayMs: 2_000,
    defaultMemoryMaxMb: 256,
    defaultCpuQuotaPct: 100,
    defaultTasksMax: 128,
    defaultTimeoutStopSec: 5,
    reapSweepMs: 5_000,
    logger,
  })

  // Three live tools: the real curated adapter + two canned fixtures.
  const curated = builtinToolDefs().find((d): boolean => d.record.id === 'curated')
  if (curated === undefined) {
    check('curated built-in tool is available', false, 'builtinToolDefs() had no "curated"')
    await supervisor.dispose()
    return
  }
  const defs: BuiltinToolDef[] = [
    curated,
    fixtureDef('source-a', 'Fixture Source A', 'Source A', fixtureA),
    fixtureDef('source-b', 'Fixture Source B', 'Source B', fixtureB),
  ]

  const registry = new ToolRegistry(
    (id: string) => {
      try {
        return supervisor.status(id)
      } catch {
        return null
      }
    },
    defs,
  )
  for (const spec of registry.specs()) supervisor.register(spec)

  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-market-verify-'))
  const flags = new FlagStore(join(dataDir, 'flags.json'), logger)
  // Seed the blocklist with the duplicated "Hero's Journey" slug so it must go red.
  const blocklist = new Blocklist([], [
    { id: 'a-heroes', reason: 'known-bad (test seed)' },
    { id: 'b-heroes', reason: 'known-bad (test seed)' },
  ])

  const client = new McpSourceClient(
    async (toolId: string, name: string, args: Readonly<Record<string, unknown>>): Promise<McpTextResult> =>
      (await supervisor.callTool(toolId, name, args)) as unknown as McpTextResult,
  )
  // ttlMs 0 → the cache is used only as a rate-limit/error fallback (never to
  // skip a fan-out), which is exactly what the cache-first test needs.
  const index = new SkillIndex(client, registry, flags, blocklist, {
    ttlMs: 0,
    perToolTimeoutMs: 12_000,
    logger,
  })

  // ── 1. "literary script": fan-out, merge, dedup, rank, trust ──
  const scriptRows = await index.search({ q: 'literary script' })
  const scriptProfiles = scriptRows.map((r): SkillProfile => r.profile)
  check('search "literary script" returns results', scriptProfiles.length > 0, `${scriptProfiles.length} profiles`)
  check(
    'curated adapter contributed a script skill (real spawn + MCP)',
    findProfile(scriptProfiles, (p): boolean => p.toolId === 'curated') !== undefined,
  )
  check(
    'fixture A contributed over MCP',
    findProfile(scriptProfiles, (p): boolean => p.id === 'source-a:a-literary-script') !== undefined,
  )
  const heroes = scriptProfiles.filter((p): boolean => p.title === "Hero's Journey Script")
  check('dedup collapses the duplicate provider::title to one row', heroes.length === 1, `got ${heroes.length}`)
  check(
    'a credential-shaped skill scans orange',
    findProfile(scriptProfiles, (p): boolean => p.id === 'source-a:a-cred')?.warningLevel === 'orange',
    `level=${String(findProfile(scriptProfiles, (p): boolean => p.id === 'source-a:a-cred')?.warningLevel)}`,
  )
  check(
    'a blocklisted skill is forced red',
    heroes.length === 1 && heroes[0]?.warningLevel === 'red',
    `level=${String(heroes[0]?.warningLevel)}`,
  )
  const scores = scriptRows.map((r): number => r.score)
  const sorted = scores.every((s, i): boolean => i === 0 || scores[i - 1]! >= s)
  check('results are ranked by descending score', sorted, `[${scores.map((s): string => s.toFixed(3)).join(', ')}]`)

  // ── 2. "shot plan": target-relevant skills + yellow (URL) scan ──
  const shotRows = await index.search({ q: 'shot plan' })
  const shotProfiles = shotRows.map((r): SkillProfile => r.profile)
  check('search "shot plan" returns results', shotProfiles.length > 0, `${shotProfiles.length} profiles`)
  check(
    'curated adapter contributed a shot-plan skill',
    findProfile(shotProfiles, (p): boolean => p.toolId === 'curated' && p.target === 'shot-plan') !== undefined,
  )
  check(
    'a URL-bearing skill scans yellow',
    findProfile(shotProfiles, (p): boolean => p.id === 'source-b:b-storyboard')?.warningLevel === 'yellow',
    `level=${String(findProfile(shotProfiles, (p): boolean => p.id === 'source-b:b-storyboard')?.warningLevel)}`,
  )

  // ── 3. per-tool source status: fanned out to ≥3 tools ──
  const statusRows: SourceStatus[] = index.sourcesStatus()
  check('sourcesStatus reports all three tools', statusRows.length === 3, `${statusRows.length} rows`)
  const responded = statusRows.filter((s): boolean => s.skillCount > 0)
  check('search fanned out to ≥3 tools that returned skills', responded.length >= 3, `${responded.length} responded`)
  const ids = statusRows.map((s): string => s.toolId).sort()
  check('the three tool ids are curated + source-a + source-b', ids.join(',') === 'curated,source-a,source-b', ids.join(','))

  // ── 4. flag raises a level, then a rate-limited source is served cache-first ──
  flags.set('source-a:a-literary-script', 'red', 'spam report', 'tester')
  // This is fixture B's 2nd call for "literary script" → it rate-limits; the host
  // must serve B's cached skills and mark B degraded (R11).
  const flaggedRows = await index.search({ q: 'literary script' })
  const flaggedProfiles = flaggedRows.map((r): SkillProfile => r.profile)
  check(
    'a user flag raises the warning level to red',
    findProfile(flaggedProfiles, (p): boolean => p.id === 'source-a:a-literary-script')?.warningLevel === 'red',
  )
  check(
    'cache-first: a rate-limited source still contributes skills from cache',
    findProfile(flaggedProfiles, (p): boolean => p.toolId === 'source-b') !== undefined,
  )
  const bStatus = index.sourcesStatus().find((s): boolean => s.toolId === 'source-b')
  check(
    'cache-first: the rate-limited source is marked degraded with a non-zero skill count',
    bStatus?.status === 'degraded' && (bStatus.skillCount ?? 0) > 0,
    `status=${String(bStatus?.status)} skillCount=${String(bStatus?.skillCount)}`,
  )

  // ── 5. clearing the flag restores the scanned level ──
  flags.clear('source-a:a-literary-script', 'tester')
  const clearedRows = await index.search({ q: 'literary script' })
  const clearedProfiles = clearedRows.map((r): SkillProfile => r.profile)
  check(
    'clearing the flag restores the heuristic level (clean)',
    findProfile(clearedProfiles, (p): boolean => p.id === 'source-a:a-literary-script')?.warningLevel === 'clean',
  )

  // ── 6. the real curated adapter answers skills/profile end-to-end ──
  const curatedProfile = await index.profile('curated:three-act-structure')
  check(
    'curated skills/profile round-trips through the sandbox',
    curatedProfile !== null && curatedProfile.title === 'Three-Act Structure' && curatedProfile.target === 'script',
    `title=${String(curatedProfile?.title)} target=${String(curatedProfile?.target)}`,
  )

  // ── 7. the real curated adapter answers skills/download end-to-end ──
  let downloadOk = false
  let downloadDetail = ''
  try {
    const raw = await supervisor.callTool('curated', 'skills/download', { slug: 'three-act-structure' })
    const payload = decodeJson<{ body?: string }>(raw)
    const body = payload?.body ?? ''
    downloadOk = body.startsWith('---') && body.includes('Three-Act Structure')
    downloadDetail = `${body.length} bytes`
  } catch (error) {
    downloadDetail = String(error)
  }
  check('curated skills/download returns the full SKILL.md body', downloadOk, downloadDetail)

  // ── teardown ──
  await supervisor.dispose()
  rmSync(dataDir, { recursive: true, force: true })
}

await main()

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
