/**
 * Plugins marketplace skill-EXECUTE verifier (Phase-7 P7-M6).
 *
 * Headless acceptance for the milestone's executable-skill path (D9). It boots a
 * real {@link SprSupervisor} with the offline executable fixture
 * (`fixture-source-exec.ts`, which advertises `skills/run`), drives the host
 * {@link SkillIndex}.run trust+consent gate through the gateway's
 * {@link createWorkspaceStore} + `skill-import` execution bridge, and asserts
 * every M6 guarantee from the phase-7 doc:
 *
 *  1. a **clean** executable skill runs in its sandbox and its output lands as
 *     run content AND a room artifact (`artifacts/<skill>/result.txt`);
 *  2. an **orange** skill is refused with `consent-required` until consent is
 *     recorded on the (server-global) consent store, after which it runs;
 *  3. a **red** skill is refused by BOTH triggers (card Run + director-agent);
 *  4. a **non-executable** skill returns `not-executable`;
 *  5. the director-agent trigger (executeNodeSkills) runs a clean skill
 *     automatically, skips an orange-without-consent skill WITH a note, skips a
 *     red skill WITH a note, and silently skips a non-executable one (R3);
 *  6. a **disabled/stopped** tool is an unavailable source → `not-found` (never
 *     re-spawned just to run).
 *
 * Run from the `server/` directory:
 *   node scripts/verify-plugins-execute.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ImportedSkillRef, PromptGraphNode, ToolRecord } from '@dsh-movie/protocol'
import { ConsentStore } from '../plugins/dsh-movie-market/src/consentStore.ts'
import { FlagStore } from '../plugins/dsh-movie-market/src/flagStore.ts'
import { ToolRegistry } from '../plugins/dsh-movie-market/src/registry.ts'
import { McpSourceClient, SkillIndex, type McpTextResult } from '../plugins/dsh-movie-market/src/skillIndex.ts'
import { SprSupervisor } from '../plugins/dsh-movie-market/src/supervisor.ts'
import { Blocklist } from '../plugins/dsh-movie-market/src/trust.ts'
import type { BuiltinToolDef } from '../plugins/dsh-movie-market/src/builtinTools.ts'
import type { MarketLogger, ToolSpec } from '../plugins/dsh-movie-market/src/types.ts'
import { createWorkspaceStore } from '../plugins/dsh-movie-gateway/src/workspace-store.ts'
import {
  artifactRelPath,
  executeNodeSkills,
  executeSkillToRoom,
  type SkillRunner,
} from '../plugins/dsh-movie-gateway/src/skill-import.ts'

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
const fixtureExec = resolve(marketRoot, 'test', 'fixture-source-exec.ts')

const TOOL_ID = 'source-exec'
const ROOM_ID = '!verify-execute:localhost'
const AUTHOR = '@host:localhost'

/** The four fixture skills under test. */
const CLEAN = `${TOOL_ID}:exec-clean`
const CRED = `${TOOL_ID}:exec-cred`
const BAD = `${TOOL_ID}:exec-bad`
const PLAIN = `${TOOL_ID}:exec-plain`

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

/** Build an imported-skill ref for a node's `properties.importedSkills`. */
function refOf(id: string): ImportedSkillRef {
  return { id, toolId: TOOL_ID, version: '1.0.0', path: `skills/${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`, downloadedAt: Date.now() }
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

  // One live tool: the offline executable fixture (answers skills/run).
  const defs: BuiltinToolDef[] = [fixtureDef(TOOL_ID, 'Exec Fixture', 'Exec Source', fixtureExec)]
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

  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-market-exec-'))
  const flags = new FlagStore(join(dataDir, 'flags.json'), logger)
  const consent = new ConsentStore(join(dataDir, 'consent.json'), logger)
  const blocklist = new Blocklist()
  const client = new McpSourceClient(
    async (toolId: string, name: string, args: Readonly<Record<string, unknown>>): Promise<McpTextResult> =>
      (await supervisor.callTool(toolId, name, args)) as unknown as McpTextResult,
  )
  const index = new SkillIndex(client, registry, flags, blocklist, {
    ttlMs: 0,
    perToolTimeoutMs: 12_000,
    logger,
  }, consent)

  // The gateway-side seams: a real file-backed workspace + a runner over the
  // index's run path (exactly what `ctx.movieMarket` provides at run time).
  const wsRoot = mkdtempSync(join(tmpdir(), 'dsh-movie-ws-exec-'))
  const store = createWorkspaceStore(wsRoot)
  const runner: SkillRunner = {
    runSkill: (id: string, args: Readonly<Record<string, unknown>>) => index.run(id, args),
  }
  const deps = { roomId: ROOM_ID, runner, workspace: store }

  // ── 1. a clean executable skill runs; its output + artifact land in the room ──
  const cleanRun = await executeSkillToRoom(deps, CLEAN, { input: 'lighthouse' })
  if (!cleanRun.ok) {
    check('clean skill ran (trigger a)', false, cleanRun.reason)
    await supervisor.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wsRoot, { recursive: true, force: true })
    return
  }
  check('clean skill ran (trigger a)', cleanRun.warningLevel === 'clean', `level=${cleanRun.warningLevel}`)
  check('the run content reflects the in-sandbox computation', cleanRun.content.includes('LIGHTHOUSE'), cleanRun.content)
  check('one artifact was returned', cleanRun.artifacts.length === 1, `${cleanRun.artifacts.length}`)
  const artifactPath = artifactRelPath(CLEAN, 'result.txt')
  check('the artifact path is room-relative + skill-scoped', artifactPath === 'artifacts/source-exec_exec-clean/result.txt', artifactPath)
  check('the artifact was written into the room dir', store.hasSkill(ROOM_ID, artifactPath), artifactPath)
  check('the on-disk artifact matches the returned body', store.readSkill(ROOM_ID, artifactPath) === cleanRun.artifacts[0]?.body)

  // ── 2. an orange skill is refused until consent is recorded ──
  const orangeRefused = await executeSkillToRoom(deps, CRED, {})
  check('orange skill is refused without consent', !orangeRefused.ok && orangeRefused.reason === 'consent-required', orangeRefused.ok ? 'ran' : orangeRefused.reason)
  check('the orange refusal wrote no artifact', !store.hasSkill(ROOM_ID, artifactRelPath(CRED, 'result.txt')))
  consent.set(CRED, true, AUTHOR)
  check('consent is now recorded on the server-global store', consent.granted(CRED))
  const orangeRun = await executeSkillToRoom(deps, CRED, { input: 'slate' })
  check('orange skill runs after consent is recorded', orangeRun.ok && orangeRun.warningLevel === 'orange', orangeRun.ok ? orangeRun.warningLevel : orangeRun.reason)
  check('the consented orange run landed its output', orangeRun.ok && orangeRun.content.includes('SLATE'), orangeRun.ok ? orangeRun.content : '')

  // ── 3. a red skill is refused by the explicit trigger ──
  flags.set(BAD, 'red', 'confirmed malicious (test)', AUTHOR)
  const redRun = await executeSkillToRoom(deps, BAD, {})
  check('red skill is refused by the explicit Run trigger', !redRun.ok && redRun.reason === 'blocked', redRun.ok ? 'ran' : redRun.reason)

  // ── 4. a non-executable skill is refused as not-executable ──
  const plainRun = await executeSkillToRoom(deps, PLAIN, {})
  check('non-executable skill returns not-executable', !plainRun.ok && plainRun.reason === 'not-executable', plainRun.ok ? 'ran' : plainRun.reason)

  // ── 5. the director-agent trigger (executeNodeSkills) honours every gate ──
  // (exec-cred consent was granted above; revoke it so the orange skip is tested.)
  consent.set(CRED, false, AUTHOR)
  const node: PromptGraphNode = {
    class_type: 'MovieScript',
    inputs: { prompt: 'Write a short film about a lighthouse keeper.' },
    properties: { importedSkills: [refOf(CLEAN), refOf(CRED), refOf(BAD), refOf(PLAIN)] },
  }
  const nodeRun = await executeNodeSkills(deps, node)
  check('the run section is framed as untrusted output', nodeRun.section.includes('## Skill executions') && nodeRun.section.includes('UNTRUSTED'))
  check('the clean skill auto-ran into the node section', nodeRun.section.includes('LIGHTHOUSE') || nodeRun.section.includes(CLEAN), nodeRun.section.slice(0, 60))
  check('the orange-without-consent skill was skipped WITH a note', nodeRun.notes.some((n): boolean => n.includes(CRED) && n.includes('consent')), nodeRun.notes.join(' / '))
  check('the red skill was skipped WITH a note', nodeRun.notes.some((n): boolean => n.includes(BAD) && n.includes('blocked')), nodeRun.notes.join(' / '))
  check('the red skill produced no run output in the section', !nodeRun.section.includes(BAD))
  check('the non-executable skill was skipped silently (no note)', !nodeRun.notes.some((n): boolean => n.includes(PLAIN)), nodeRun.notes.join(' / '))

  // ── 6. a disabled/stopped tool is an unavailable source → not-found ──
  registry.setEnabled(TOOL_ID, false)
  await supervisor.stop(TOOL_ID)
  const disabledRun = await executeSkillToRoom(deps, CLEAN, { input: 'lighthouse' })
  check('a disabled tool is not-found (never re-spawned to run)', !disabledRun.ok && disabledRun.reason === 'not-found', disabledRun.ok ? 'ran' : disabledRun.reason)

  // ── teardown ──
  await supervisor.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(wsRoot, { recursive: true, force: true })
}

await main()

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
