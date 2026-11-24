/**
 * Episode-clip driver (live simulation of one movie-pipeline run).
 *
 * Drives the RUNNING DSH-Movie stack exactly like a logged-in host browser,
 * but headlessly, against room `dsh_demo_20261116`:
 *
 *  1. brokers a Matrix token for the room host (`@dsh_demo.19r4u2n:localhost`);
 *  2. posts the creative decisions into the room chat (m.text);
 *  3. CLEARS the room canvas and rebuilds it from scratch with one host-gated
 *     `workflow/put` commit (full-snapshot semantics): TextInput -> ImageGenerator
 *     -> VideoGenerator -> SaveOutput; every connected Studio client converges
 *     live over the `workflow/watch` mux (broadcastWatch);
 *  4. submits the mirrored Leg B `POST /prompt` graph (room_id threaded so the
 *     D8 notifier echoes artifacts into the room) and observes the execution
 *     lifecycle over `/comfy/ws` (executing / progress / executed / success);
 *  5. narrates every stage into the room chat and, on success, commits a second
 *     snapshot whose node titles/properties carry the produced image + clip
 *     references ("populate the nodes").
 *
 * No product API changes are required: workflow/put + /prompt + the Matrix
 * client API cover the whole job.
 *
 * Run from the `server/` directory:
 *   node --experimental-strip-types scripts/drive-episode-clip.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brokerToken, type MatrixEndpoint } from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'
import type { PromptGraph, WorkflowGraph } from '../../protocol/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')

/** Load `server/.env` into process.env (existing keys win). */
function loadDotEnv(): void {
  let text: string
  try {
    text = readFileSync(resolve(serverRoot, '.env'), 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = val
  }
}

loadDotEnv()

const logger = {
  info(message: string, ...args: unknown[]): void {
    process.stdout.write(`${message} ${args.map(String).join(' ')}\n`)
  },
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
}

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
const WS_BASE = GATEWAY.replace(/^http/, 'ws')
const SYNAPSE = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
const SERVER_NAME = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
const ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
const HOST_USER = process.env.DRIVE_HOST_USER ?? `@dsh_demo.19r4u2n:${SERVER_NAME}`
const ROOM_ID = process.env.DRIVE_ROOM_ID ?? '!kSVxAPSTOJeHPiOPIh:localhost'

// ── the creative decisions (authored here, posted to the room as we go) ──
const EPISODE_SCRIPT = [
  'EPISODE — "The Vanguard Signature", climax (one clip, ~4s).',
  'Detroit, November 1949, night. Rain sheets the windows of Michigan Central',
  'Station. Under the vaulted Guastavino tile ceiling of the concourse, a single',
  'work lamp burns on a bench: HELEN BRADDOCK (40s, trench coat, fedora, war-widow',
  'calm) spreads the recovered Kessler contract pages beside a U.S. patent',
  'certificate. Film-noir lighting, wet marble reflections, steam in the air,',
  'deep shadows, one warm pool of light. Camera: slow push-in on Helen and the',
  'documents; the vast empty concourse looms behind her.',
].join(' ')

const T2I_PROMPT = [
  '1949 film-noir night scene inside Michigan Central Station concourse, Detroit:',
  'vaulted Guastavino tile ceiling, towering arched windows streaked with rain,',
  'wet reflective marble floor, drifting steam; one warm work lamp on a wooden',
  'bench where a woman in a trench coat and fedora spreads patent documents and',
  'contract pages; deep shadows, single warm light pool, cinematic noir grading,',
  '35mm film grain, wide establishing composition.',
].join(' ')

const I2V_DURATION = 4

/** Post one m.text message into the room as the host. */
async function say(body: string): Promise<void> {
  const txn = `drive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const resp = await fetch(
    `${SYNAPSE}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/send/m.room.message/${txn}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    },
  )
  if (!resp.ok) logger.warn('room post failed: HTTP %d %s', resp.status, body.slice(0, 80))
  else logger.info('[room] %s', body.slice(0, 110))
}

/** Leg C call with the host bearer token. */
async function legC(method: string, params: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const resp = await fetch(`${GATEWAY}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
    body: JSON.stringify(params),
  })
  return { status: resp.status, body: (await resp.json()) as any }
}

let hostToken = ''

/** Build the cleared-and-rebuilt editor graph (full snapshot replaces HEAD). */
function buildGraph(): WorkflowGraph {
  const size: [number, number] = [260, 150]
  const node = (
    id: number,
    type: string,
    title: string,
    pos: [number, number],
    inputs: { name: string; type: string; link: number | null }[],
    outputs: { name: string; type: string; links: number[] }[],
    widgets: unknown[],
  ): any => ({
    id,
    type,
    pos,
    size,
    flags: 0,
    order: id - 1,
    mode: 0,
    inputs,
    outputs: outputs.map((out, index) => ({ name: out.name, type: out.type, link: out.links[0] ?? null, links: out.links, slot_index: index })),
    title,
    properties: { 'Node name for S&R': type },
    widgets_values: widgets,
  })
  const nodes = [
    node(1, 'TextInput', 'Episode Script', [60, 120], [], [{ name: 'text', type: 'TEXT', links: [1, 2] }], [EPISODE_SCRIPT]),
    node(2, 'ImageGenerator', 'Storyboard Frame (t2i)', [420, 40], [
      { name: 'prompt', type: 'TEXT', link: 1 },
      { name: 'image', type: 'IMAGE', link: null },
    ], [{ name: 'image', type: 'IMAGE', links: [3] }], ['text_to_image']),
    node(3, 'VideoGenerator', 'Episode Clip (i2v)', [780, 120], [
      { name: 'prompt', type: 'TEXT', link: 2 },
      { name: 'image', type: 'IMAGE', link: 3 },
    ], [{ name: 'clip', type: 'VIDEO', links: [4] }], ['image_to_video', I2V_DURATION]),
    node(4, 'SaveOutput', 'Save Episode Clip', [1140, 160], [{ name: 'media', type: '*', link: 4 }], [], []),
  ]
  const links: any[] = [
    [1, 1, 0, 2, 0, 'TEXT'],
    [2, 1, 0, 3, 0, 'TEXT'],
    [3, 2, 0, 3, 1, 'IMAGE'],
    [4, 3, 0, 4, 0, 'VIDEO'],
  ]
  return {
    last_node_id: 4,
    last_link_id: 4,
    nodes,
    links,
    groups: [{ title: 'Vanguard Signature · episode clip', bounding: [30, 0, 1400, 380], color: '0', collapsed: false }],
    config: {},
    extra: { ds: { scale: 0.7, offset: [0, 0] } },
    version: 0.4,
  } as WorkflowGraph
}

/** Mirror of the editor graph in Leg B execution form. */
function buildPrompt(): PromptGraph {
  return {
    '1': { class_type: 'TextInput', inputs: { text: T2I_PROMPT }, _meta: { title: 'Episode Script' } },
    '2': { class_type: 'ImageGenerator', inputs: { prompt: ['1', 0], mode: 'text_to_image' }, _meta: { title: 'Storyboard Frame (t2i)' } },
    '3': { class_type: 'VideoGenerator', inputs: { prompt: ['1', 0], image: ['2', 0], mode: 'image_to_video', duration: I2V_DURATION }, _meta: { title: 'Episode Clip (i2v)' } },
    '4': { class_type: 'SaveOutput', inputs: { media: ['3', 0] }, _meta: { title: 'Save Episode Clip' } },
  }
}

interface ExecutedInfo {
  node: string
  artifact: string
  media: string
  contentRef?: string
}

/** Observe the Leg B lifecycle over an already-open /comfy/ws socket. */
function observeLifecycle(socket: WebSocket, promptId: string): Promise<{ ok: boolean; executed: ExecutedInfo[]; error: string }> {
  return new Promise((resolveObs) => {
    const executed: ExecutedInfo[] = []
    let lastPercent = -1
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* ignore */ }
      resolveObs({ ok: false, executed, error: 'lifecycle timed out (15 min)' })
    }, 900_000)
    const finish = (ok: boolean, error = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* ignore */ }
      resolveObs({ ok, executed, error })
    }
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let msg: any
      try { msg = JSON.parse(text) } catch { return }
      if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return
      const data = msg.data ?? {}
      if (data.prompt_id !== undefined && String(data.prompt_id) !== promptId) return
      if (msg.type === 'executing') {
        logger.info('[exec] node %s executing', String(data.node))
        void say(`▶ executing node #${String(data.node)} …`)
      } else if (msg.type === 'progress') {
        const percent = Math.round((Number(data.value) / Math.max(1, Number(data.max))) * 100)
        if (percent - lastPercent >= 25) {
          lastPercent = percent
          logger.info('[exec] node %s progress %d%%', String(data.node), percent)
          void say(`… node #${String(data.node)} sampling ${percent}%`)
        }
      } else if (msg.type === 'executed') {
        const output = data.output ?? {}
        const info: ExecutedInfo = {
          node: String(data.node),
          artifact: String(output.artifact ?? ''),
          media: String(output.media ?? ''),
          ...(typeof output.contentRef === 'string' ? { contentRef: output.contentRef } : {}),
        }
        executed.push(info)
        logger.info('[exec] node %s executed media=%s artifact=%s', info.node, info.media, info.artifact.slice(0, 120))
        void say(`✔ node #${info.node} produced [${info.media}] ${info.artifact.slice(0, 160)}`)
      } else if (msg.type === 'execution_success') {
        logger.info('[exec] execution_success prompt=%s', promptId)
        finish(true)
      } else if (msg.type === 'execution_error') {
        const message = String(data.exception_message ?? data.message ?? 'execution error')
        logger.warn('[exec] execution_error: %s', message)
        void say(`✘ execution failed: ${message}`)
        finish(false, message)
      }
    })
    socket.addEventListener('error', () => finish(false, 'websocket error'))
  })
}

async function main(): Promise<void> {
  if (ADMIN_TOKEN === '') {
    logger.warn('SYNAPSE_ADMIN_TOKEN missing; cannot broker the host token')
    process.exit(1)
  }
  const endpoint: MatrixEndpoint = { baseUrl: SYNAPSE, serverName: SERVER_NAME, adminToken: ADMIN_TOKEN }
  const creds = await brokerToken(endpoint, logger, HOST_USER)
  if (creds === null) {
    logger.warn('could not broker a token for %s', HOST_USER)
    process.exit(1)
  }
  hostToken = creds.accessToken
  logger.info('brokered host token for %s; room %s', HOST_USER, ROOM_ID)

  await say('🎬 Episode-clip run (driver): producing ONE clip from "The Vanguard Signature" — the Michigan Central Station climax. Clearing the canvas and rebuilding the graph from scratch.')
  await say(`DECISION 1 — episode extracted: the concourse confrontation (single location, single character, one visual idea). Script widget carries the scene text.`)

  // 1) clear + rebuild the canvas with one host commit (full snapshot).
  const graph = buildGraph()
  const put = await legC('workflow/put', { roomId: ROOM_ID, graph })
  if (put.status !== 200 || put.body?.ok !== true) {
    logger.warn('workflow/put failed: HTTP %d %j', put.status, put.body)
    await say(`✘ canvas commit failed (HTTP ${put.status})`)
    process.exit(1)
  }
  const rev = put.body.result?.workflow?.rev
  logger.info('canvas committed rev=%s (4 nodes, 4 links)', String(rev))
  await say(`DECISION 2 — graph rebuilt from scratch (commit rev ${String(rev)}): TextInput → ImageGenerator(t2i) → VideoGenerator(i2v, ${I2V_DURATION}s) → SaveOutput. Your Studio canvas converges live.`)
  await say(`DECISION 3 — visual prompt for the storyboard frame: "${T2I_PROMPT.slice(0, 200)}…"`)

  // 2) open the exec socket FIRST, then submit, so no lifecycle frame is missed.
  const execSocket = new WebSocket(`${WS_BASE}/comfy/ws`)
  await new Promise<void>((resolveOpen, rejectOpen) => {
    execSocket.addEventListener('open', (): void => resolveOpen(), { once: true })
    execSocket.addEventListener('error', (): void => rejectOpen(new Error('/comfy/ws connect failed')), { once: true })
  })
  const prompt = buildPrompt()
  const submitted = await fetch(`${GATEWAY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, room_id: ROOM_ID }),
  })
  const submittedBody = (await submitted.json()) as { prompt_id?: string; error?: string }
  if (!submitted.ok || submittedBody.prompt_id === undefined) {
    logger.warn('/prompt rejected: HTTP %d %j', submitted.status, submittedBody)
    await say(`✘ run submission failed (HTTP ${submitted.status}): ${submittedBody.error ?? 'unknown'}`)
    process.exit(1)
  }
  const promptId = String(submittedBody.prompt_id)
  logger.info('run submitted prompt_id=%s', promptId)
  await say(`▶ run ${promptId} submitted to the H20 engine (SDXL/Qwen-Image t2i, then Wan 2.2 i2v — expect a few minutes).`)

  // The socket is open before the job starts, so every frame for this
  // prompt_id is delivered from the very first `executing`.
  const outcome = await observeLifecycle(execSocket, promptId)
  if (!outcome.ok) {
    logger.warn('run did not succeed: %s', outcome.error)
    process.exit(1)
  }

  // 3) populate the nodes with the produced artifacts and commit again.
  const imageInfo = outcome.executed.find((entry) => entry.node === '2')
  const clipInfo = outcome.executed.find((entry) => entry.node === '3')
  const populated = buildGraph()
  const nodes = (populated as any).nodes as any[]
  if (imageInfo !== undefined) {
    nodes[1].title = `Storyboard Frame · ${imageInfo.contentRef ?? imageInfo.artifact.slice(0, 60)}`
    nodes[1].properties = { ...nodes[1].properties, artifact: imageInfo.artifact, ...(imageInfo.contentRef ? { contentRef: imageInfo.contentRef } : {}) }
  }
  if (clipInfo !== undefined) {
    nodes[2].title = `Episode Clip · ${clipInfo.contentRef ?? clipInfo.artifact.slice(0, 60)}`
    nodes[2].properties = { ...nodes[2].properties, artifact: clipInfo.artifact, ...(clipInfo.contentRef ? { contentRef: clipInfo.contentRef } : {}) }
  }
  const put2 = await legC('workflow/put', { roomId: ROOM_ID, graph: populated })
  const rev2 = put2.body?.result?.workflow?.rev
  logger.info('populate commit rev=%s', String(rev2))
  await say(`🏁 Run ${promptId} complete. Nodes populated (commit rev ${String(rev2)}): storyboard frame = ${imageInfo?.contentRef ?? imageInfo?.artifact ?? '-'}; episode clip = ${clipInfo?.contentRef ?? clipInfo?.artifact ?? '-'}. Artifacts also echoed above and stored under the room workspace artifacts/.`)
  process.exit(0)
}

void main()
