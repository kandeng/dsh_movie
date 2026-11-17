/**
 * Plugins marketplace skill-DOWNLOAD verifier (Phase-7 P7-M4).
 *
 * Headless acceptance for the milestone's two-trigger import (D7) + shared text
 * seam (D12). It boots a real {@link SprSupervisor} with the offline **curated**
 * skill source, drives the host {@link SkillIndex} download path through the
 * gateway's {@link createWorkspaceStore} + `skill-import` bridge, and asserts
 * every M4 guarantee from the phase-7 doc:
 *
 *  1. a mode-1 download writes the skill body into the room dir AND records one
 *     workspace-history commit (`skill import <id>`);
 *  2. a mode-2 run with the file deleted **re-fetches it before executing** and
 *     logs the remedy note;
 *  3. with the providing tool **disabled/stopped** the run proceeds skill-less
 *     (empty section + an "unavailable" note) and never recreates the file (R3);
 *  4. `MovieScript` consumes an imported skill **identically** to
 *     `TextGenerator` — both fold the same composed section through the single
 *     `buildTextPrompt` seam, differing only by the class-type token.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-plugins-download.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptGraphNode, SkillProfile } from '@dsh-movie/protocol'
import { builtinToolDefs, type BuiltinToolDef } from '../plugins/dsh-movie-market/src/builtinTools.ts'
import { FlagStore } from '../plugins/dsh-movie-market/src/flagStore.ts'
import { ToolRegistry } from '../plugins/dsh-movie-market/src/registry.ts'
import { McpSourceClient, SkillIndex, type McpTextResult } from '../plugins/dsh-movie-market/src/skillIndex.ts'
import { SprSupervisor } from '../plugins/dsh-movie-market/src/supervisor.ts'
import { Blocklist } from '../plugins/dsh-movie-market/src/trust.ts'
import type { MarketLogger } from '../plugins/dsh-movie-market/src/types.ts'
import { createWorkspaceStore } from '../plugins/dsh-movie-gateway/src/workspace-store.ts'
import {
  composeSkillSection,
  downloadSkillToRoom,
  resolveNodeSkills,
  type SkillMarket,
} from '../plugins/dsh-movie-gateway/src/skill-import.ts'
import { buildTextPrompt } from '../plugins/dsh-movie-gateway/src/movie-executor/llm-text.ts'

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

/** The curated skill exercised end-to-end (real spawn + MCP + sandbox). */
const SKILL_ID = 'curated:three-act-structure'
const ROOM_ID = '!verify-download:localhost'
const AUTHOR = '@host:localhost'

/**
 * Reconstruct a room's on-disk skill file path so the test can delete it and
 * prove the mode-2 re-fetch. Mirrors `workspace-store`'s `sanitizeRoom`.
 */
function roomFilePath(wsRoot: string, roomId: string, relPath: string): string {
  const safe = roomId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(wsRoot, `room-${safe}`, relPath)
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

  // One live tool: the real offline curated adapter (answers skills/download).
  const curated = builtinToolDefs().find((d): boolean => d.record.id === 'curated')
  if (curated === undefined) {
    check('curated built-in tool is available', false, 'builtinToolDefs() had no "curated"')
    await supervisor.dispose()
    return
  }
  const defs: BuiltinToolDef[] = [curated]
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

  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-market-dl-'))
  const flags = new FlagStore(join(dataDir, 'flags.json'), logger)
  const blocklist = new Blocklist()
  const client = new McpSourceClient(
    async (toolId: string, name: string, args: Readonly<Record<string, unknown>>): Promise<McpTextResult> =>
      (await supervisor.callTool(toolId, name, args)) as unknown as McpTextResult,
  )
  const index = new SkillIndex(client, registry, flags, blocklist, {
    ttlMs: 0,
    perToolTimeoutMs: 12_000,
    logger,
  })

  // The gateway-side seams: a real file-backed workspace + a market adapter over
  // the index's download path (exactly what `ctx.movieMarket` provides at run).
  const wsRoot = mkdtempSync(join(tmpdir(), 'dsh-movie-ws-'))
  const store = createWorkspaceStore(wsRoot)
  const market: SkillMarket = {
    downloadSkill: (id: string): Promise<{ body: string; profile: SkillProfile } | null> => index.download(id),
  }
  const bridge = { roomId: ROOM_ID, market, workspace: store }

  // ── 1. mode-1 download writes the body into the room dir + records a commit ──
  const dl = await downloadSkillToRoom(bridge, SKILL_ID, AUTHOR)
  if (!dl.ok) {
    check('mode-1 download succeeded', false, dl.reason)
    await supervisor.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wsRoot, { recursive: true, force: true })
    return
  }
  check('mode-1 download succeeded', true, dl.path)
  check('the skill body starts with SKILL.md front-matter', dl.body.startsWith('---'), `${dl.body.length} bytes`)
  check('the skill file exists in the room dir', store.hasSkill(ROOM_ID, dl.path), dl.path)
  check('the on-disk body matches the returned body', store.readSkill(ROOM_ID, dl.path) === dl.body)
  const commits = store.listCommits(ROOM_ID)
  check(
    'one workspace-history commit records the import',
    commits.some((c): boolean => c.message === `skill import ${SKILL_ID}`),
    `[${commits.map((c): string => c.message).join(' | ')}]`,
  )
  check(
    'the import commit is retrievable by revision',
    store.getCommit(ROOM_ID, commits[commits.length - 1]!.rev) !== null,
  )

  // The node a run would execute, carrying the recorded imported-skill ref.
  const node: PromptGraphNode = {
    class_type: 'MovieScript',
    inputs: { prompt: 'Write a short film about a lighthouse keeper.' },
    properties: { importedSkills: [dl.ref] },
  }

  // ── 2. mode-2: a deleted file is re-fetched before executing + logs the note ──
  const filePath = roomFilePath(wsRoot, ROOM_ID, dl.path)
  rmSync(filePath, { force: true })
  check('the skill file was deleted (simulating a stale/missing import)', !store.hasSkill(ROOM_ID, dl.path))
  const refetched = await resolveNodeSkills(bridge, node)
  check('mode-2 re-fetched the missing file before executing', store.hasSkill(ROOM_ID, dl.path))
  check(
    'mode-2 logged the re-fetch remedy note',
    refetched.notes.some((n): boolean => n.includes('re-fetched')),
    refetched.notes.join(' / '),
  )
  check(
    'mode-2 composed a non-empty framed Craft-skills section',
    refetched.section.includes('## Craft skills') && refetched.section.includes('UNTRUSTED'),
  )

  // ── 3. with the tool disabled/stopped the run proceeds skill-less (R3) ──
  registry.setEnabled('curated', false)
  await supervisor.stop('curated')
  rmSync(filePath, { force: true })
  const skillLess = await resolveNodeSkills(bridge, node)
  check('mode-2 proceeds skill-less when the tool is stopped', skillLess.section === '', `"${skillLess.section.slice(0, 40)}"`)
  check(
    'mode-2 logged an unavailable/skill-less note',
    skillLess.notes.some((n): boolean => n.includes('unavailable') && n.includes('without it')),
    skillLess.notes.join(' / '),
  )
  check('the missing file was NOT recreated from a stopped tool', !store.hasSkill(ROOM_ID, dl.path))

  // ── 4. MovieScript consumes an imported skill identically to TextGenerator ──
  const section = composeSkillSection([
    { id: SKILL_ID, title: 'Three-Act Structure', body: 'Setup, confrontation, resolution.\nBeat the turning points.' },
  ])
  const scriptPrompt = buildTextPrompt('MovieScript', { prompt: 'Write a short film.', skills: section })
  const textPrompt = buildTextPrompt('TextGenerator', { prompt: 'Write a short film.', skills: section })
  check('both text seams fold in the composed skill section', scriptPrompt.includes(section) && textPrompt.includes(section))
  check(
    'MovieScript and TextGenerator compose the skill identically (only the class-type token differs)',
    scriptPrompt.replace('MovieScript', '@') === textPrompt.replace('TextGenerator', '@'),
  )

  // ── teardown ──
  await supervisor.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(wsRoot, { recursive: true, force: true })
}

await main()

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
