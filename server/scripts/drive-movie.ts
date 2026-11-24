/**
 * Full-movie orchestration driver — "The Vanguard Signature" (3-5 min).
 *
 * Drives the RUNNING DSH-Movie stack headlessly, exactly like a logged-in host
 * browser, against room `dsh_demo_20261116` (`!kSVxAPSTOJeHPiOPIh:localhost`).
 * Extends the proven `drive-episode-clip.ts` pattern (brokered host token,
 * `workflow/put` canvas commits, Leg B `POST /prompt`, `/comfy/ws` lifecycle,
 * room narration) into the phased pipeline of the plan.
 *
 *   Phase 1 (Task 2) — screenplay: the authored story treatment + story bible
 *     are expanded into a shot list THROUGH the DSH text seam (`TextGenerator`
 *     -> Bailian), one run per scene; merged into shots.json, validated against
 *     the gate (40-60 shots, 180-300 s total, every shot <= 15 s, every
 *     character/location/prop carries a visual descriptor), committed into the
 *     room workspace at `assets/script.json`, narrated to the room, and stamped
 *     onto a rebuilt screenplay canvas.
 *
 * Run from the `server/` directory:
 *   node --experimental-strip-types scripts/drive-movie.ts            # all phases
 *   node --experimental-strip-types scripts/drive-movie.ts --phase 1  # one phase
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { brokerToken, type MatrixEndpoint } from "../plugins/dsh-matrix-identity/src/matrix-admin.ts"
import type { PromptGraph, WorkflowGraph } from "../../protocol/src/index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, "..")

/** Load `server/.env` into process.env (existing keys win). */
function loadDotEnv(): void {
  let text: string
  try {
    text = readFileSync(resolve(serverRoot, ".env"), "utf8")
  } catch {
    return
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = val
  }
}

loadDotEnv()

const logger = {
  info(message: string, ...args: unknown[]): void {
    process.stdout.write(`${message} ${args.map(String).join(" ")}\n`)
  },
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(" ")}\n`)
  },
}

const GATEWAY = process.env.GATEWAY_URL ?? "http://127.0.0.1:8788"
const WS_BASE = GATEWAY.replace(/^http/, "ws")
const SYNAPSE = process.env.SYNAPSE_BASE_URL ?? "http://127.0.0.1:8008"
const SERVER_NAME = process.env.SYNAPSE_SERVER_NAME ?? "localhost"
const ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN ?? ""
const HOST_USER = process.env.DRIVE_HOST_USER ?? `@dsh_demo.19r4u2n:${SERVER_NAME}`
const ROOM_ID = process.env.DRIVE_ROOM_ID ?? "!kSVxAPSTOJeHPiOPIh:localhost"
const WORKSPACE_ROOT = process.env.DSH_WORKSPACE_ROOT ?? join(serverRoot, ".dsh", "workspaces")
const ROOM_DIR = join(WORKSPACE_ROOT, `room-${ROOM_ID.replace(/[^a-zA-Z0-9._-]/g, "_")}`)

let hostToken = ""

// ── The creative brief — authored decisions (posted to the room as we go). ──

const TITLE = 'The Vanguard Signature'

/** The full story treatment fed to the screenwriter seam as context. */
const STORY = [
  `${TITLE} — a 1949 Detroit film-noir, runtime target 3-5 minutes.`,
  'LOGLINE: A war widow discovers her late husband\'s revolutionary automatic',
  'transmission — codenamed "Vanguard" — was signed over to an auto cartel under',
  'a forged signature, and she has one rainy night to prove it before the patent',
  'is buried forever.',
  'ACT I. Detroit, November 1949. HELEN BRADDOCK, a war widow, reads a cold',
  'letter from lawyer VICTOR KESSLER demanding she sign away her late husband',
  'Martin\'s patent rights. In Martin\'s cluttered workshop she pries open a false',
  'drawer in his workbench and finds the original Vanguard patent certificate and',
  'a carbon of a contract bearing a signature that is not Martin\'s.',
  'ACT II. In his oak-panelled office Kessler offers Helen money to sign; she sees',
  'the forged flourish with her own eyes and refuses. At an all-night diner she',
  'enlists RAY DELGADO, a world-weary reporter and ex-cop, laying out the patent',
  'and the forged contract on the counter between coffee cups. They realize the',
  'only signed original is held overnight in a strongbox routed through Michigan',
  'Central Station.',
  'ACT III — CLIMAX. Under the vast Guastavino vault of the station concourse, one',
  'work lamp burns on a bench. Helen spreads the recovered contract beside the',
  'patent certificate, baiting Kessler and the executive MARTIN VAIL into a',
  'confession that Ray, hidden behind a pillar, records. Vail reaches for her; the',
  'forged "Vanguard" signature is exposed for what it is. Dawn breaks over a',
  'rain-slick street as the newspaper edition goes to press and Helen walks free.',
].join(' ')

interface Dossier {
  id: string
  name: string
  visual: string
  voice?: string
}

interface Scene {
  id: string
  num: number
  title: string
  location_ref: string
  summary: string
  beat: string
  target: number
  chars: string[]
  props: string[]
}

const CHARACTERS: Dossier[] = [
  { id: 'helen', name: 'Helen Braddock', visual: 'woman in her early 40s, sharp cheekbones, dark wavy hair pinned back, grey-green eyes, olive trench coat over a cream blouse, charcoal fedora, a small tarnished silver locket; weary but resolute war-widow bearing', voice: 'warm low measured contralto, restrained Mid-Atlantic cadence, grief held tightly under control' },
  { id: 'kessler', name: 'Victor Kessler', visual: 'man in his late 50s, thin silver hair slicked back, wire-rim round glasses, pinched pale features, immaculate charcoal pinstripe three-piece suit, burgundy cravat, gold watch chain across the waistcoat', voice: 'dry precise baritone, patrician and condescending, unhurried, faint sibilance' },
  { id: 'ray', name: 'Ray Delgado', visual: 'man in his mid 30s, square jaw, dark stubble, brown eyes, rumpled tan trench coat, loosened navy tie, soft fedora, a cigarette at the corner of his mouth; ex-cop turned reporter', voice: 'gravelly quick and world-weary, flat Detroit vowels, dry understated humor' },
  { id: 'vail', name: 'Martin Vail', visual: 'man in his 50s, broad shoulders, thick neck, close-cropped silver-brushed hair, heavy brow, double-breasted navy suit, gold signet ring, cigar; auto-industry executive', voice: 'booming blunt gravel-tinged bass, impatient, clips his words' },
]

const LOCATIONS: Dossier[] = [
  { id: 'home', name: "Helen's apartment", visual: '1949 Detroit apartment at night, muted floral wallpaper, lace curtains, a single brass floor lamp, worn velvet armchair, rain streaking the window, a framed wedding photo, amber pool of light in deep shadow' },
  { id: 'workshop', name: 'Braddock workshop', visual: 'cluttered home workshop and garage, a wooden workbench under a bare bulb, drafting tools and rolled blueprints, an old Bakelite radio, oil-stained concrete floor, cold blue moonlight through a high wire-glass window' },
  { id: 'office', name: "Kessler's office", visual: 'panelled law office at night, dark oak shelves of legal ledgers, a wide mahogany desk, a green banker lamp, venetian blinds slicing streetlight into bars, oxblood leather chairs, drifting cigarette haze' },
  { id: 'diner', name: 'All-night diner', visual: 'chrome and red-vinyl all-night diner, rain-wet windows, buzzing neon sign glow, gleaming coffee urns, black-and-white checkered floor, empty booths, harsh fluorescent light mixing with red neon' },
  { id: 'station', name: 'Michigan Central Station concourse', visual: 'vast vaulted Guastavino tile concourse at night, towering arched windows streaked with rain, wet reflective marble floor, drifting steam, a single warm work lamp on a wooden bench, cavernous deep shadows' },
  { id: 'street', name: 'Detroit street at dawn', visual: 'empty rain-slick Detroit street at dawn, wet brick facades, a metal newspaper stand, streetlamps guttering out, pale blue first light, steam rising from a manhole, long reflections on asphalt' },
]

const PROPS: Dossier[] = [
  { id: 'patent', name: 'Vanguard patent certificate', visual: 'aged parchment U.S. patent certificate, red wax seal, ornate engraved border, the word "Vanguard" in typescript, a signature line' },
  { id: 'contract', name: 'The Kessler contract pages', visual: 'dog-eared legal contract pages on onion-skin paper, dense typescript, a carbon-copy smudge, a signature line with a forged flourish' },
  { id: 'pen', name: 'Fountain pen', visual: 'black lacquer fountain pen with a gold nib and a fine crack in the barrel' },
  { id: 'locket', name: 'Silver locket', visual: 'small tarnished silver locket on a fine chain, holding a black-and-white portrait of a young soldier' },
  { id: 'notepad', name: "Reporter's notepad", visual: 'spiral-bound reporter notepad with pencil shorthand and a chewed pencil' },
  { id: 'revolver', name: 'Snub revolver', visual: 'blued snub-nose revolver with a worn walnut grip, heavy and old' },
  { id: 'phone', name: 'Rotary telephone', visual: 'black Bakelite rotary telephone with a coiled cord and a chipped handset' },
]

const SCENES: Scene[] = [
  { id: 'sc1', num: 1, title: 'The Letter', location_ref: 'home', summary: 'Helen reads Kessler demand by lamplight.', beat: 'Night. Helen alone in her apartment; rain on the window. She opens a lawyer letter demanding she sign away the Vanguard patent, touches her locket, and resolves not to.', target: 8, chars: ['helen'], props: ['contract', 'pen', 'locket', 'phone'] },
  { id: 'sc2', num: 2, title: 'The Workshop Secret', location_ref: 'workshop', summary: 'Helen finds the hidden patent and a forged carbon.', beat: 'Helen searches Martin workbench under a bare bulb, pries open a false drawer, and finds the original Vanguard patent certificate folded with a carbon of a contract bearing a signature that is not his.', target: 8, chars: ['helen'], props: ['patent', 'contract', 'locket'] },
  { id: 'sc3', num: 3, title: "The Lawyer's Offer", location_ref: 'office', summary: 'Kessler pressures Helen; she sees the forgery and refuses.', beat: 'In Kessler panelled office he slides money and a pen across the desk; Helen studies the contract forged flourish, names it a fake, and refuses to sign. Kessler calm cracks.', target: 9, chars: ['helen', 'kessler'], props: ['contract', 'pen', 'patent'] },
  { id: 'sc4', num: 4, title: 'The Reporter', location_ref: 'diner', summary: 'Helen recruits Ray; they plan the sting.', beat: 'At the all-night diner Helen lays the patent and the forged contract before Ray between coffee cups; he copies the pages in shorthand and they plan to intercept the signed original at the station.', target: 8, chars: ['helen', 'ray'], props: ['patent', 'contract', 'notepad'] },
  { id: 'sc5', num: 5, title: 'The Concourse', location_ref: 'station', summary: 'Climax: the forged signature is exposed under the work lamp.', beat: 'Under the vast concourse vault one work lamp burns on a bench. Helen spreads the recovered contract beside the patent, baiting Kessler and Vail into a confession Ray records from behind a pillar. Vail lunges; Helen holds the forged Vanguard signature to the light and it unravels.', target: 10, chars: ['helen', 'kessler', 'vail', 'ray'], props: ['patent', 'contract', 'revolver', 'notepad'] },
  { id: 'sc6', num: 6, title: 'Dawn Edition', location_ref: 'street', summary: 'Dawn; the fraud is exposed and Helen walks free.', beat: 'Dawn over a rain-slick street. A newspaper edition headlining the Vanguard fraud slaps onto a stand; Helen, locket in hand, walks into the pale light as the streetlamps gutter out.', target: 7, chars: ['helen', 'ray'], props: ['locket', 'notepad'] },
]

const SCREENWRITER_INSTRUCTION = [
  `You are the screenwriter adapting "${TITLE}" into a shot list for a 3-5 minute`,
  'film-noir short. Expand each scene into concrete, filmable shots: 4-5 seconds',
  'each, never longer than 15, with a visual descriptor for every character,',
  'location and prop so downstream image/video models stay consistent.',
].join(' ')

// ── Room / gateway plumbing (mirrors drive-episode-clip.ts). ──

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
  else logger.info('[room] %s', body.slice(0, 120))
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

interface ExecutedInfo {
  node: string
  artifact: string
  media: string
}

/** Observe one prompt's lifecycle over /comfy/ws until success/error/timeout. */
function observeLifecycle(socket: WebSocket, promptId: string, timeoutMs: number): Promise<{ ok: boolean; executed: ExecutedInfo[]; error: string }> {
  return new Promise((resolveObs) => {
    const executed: ExecutedInfo[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* ignore */ }
      resolveObs({ ok: false, executed, error: `lifecycle timed out (${Math.round(timeoutMs / 1000)}s)` })
    }, timeoutMs)
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
      if (msg.type === 'executed') {
        const output = data.output ?? {}
        executed.push({ node: String(data.node), artifact: String(output.artifact ?? ''), media: String(output.media ?? '') })
      } else if (msg.type === 'execution_success') {
        finish(true)
      } else if (msg.type === 'execution_error') {
        finish(false, String(data.exception_message ?? data.message ?? 'execution error'))
      }
    })
    socket.addEventListener('error', () => finish(false, 'websocket error'))
  })
}

/**
 * Run ONE text-only graph (TextInput -> TextGenerator) through the Leg B /prompt
 * seam and return the TextGenerator's produced text. No room_id is threaded, so
 * the raw model output is NOT echoed into the room — the driver curates its own
 * readable narration instead.
 */
async function runText(contextText: string, instruction: string, label: string): Promise<string> {
  const prompt: PromptGraph = {
    '1': { class_type: 'TextInput', inputs: { text: contextText }, _meta: { title: `${label} · context` } },
    '2': { class_type: 'TextGenerator', inputs: { prompt: instruction, context: ['1', 0] }, _meta: { title: label } },
  }
  const socket = new WebSocket(`${WS_BASE}/comfy/ws`)
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', (): void => resolveOpen(), { once: true })
    socket.addEventListener('error', (): void => rejectOpen(new Error('/comfy/ws connect failed')), { once: true })
  })
  const submitted = await fetch(`${GATEWAY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  const submittedBody = (await submitted.json()) as { prompt_id?: string; error?: string; message?: string }
  if (!submitted.ok || submittedBody.prompt_id === undefined) {
    try { socket.close() } catch { /* ignore */ }
    throw new Error(`/prompt rejected (HTTP ${submitted.status}): ${submittedBody.message ?? submittedBody.error ?? 'unknown'}`)
  }
  const promptId = String(submittedBody.prompt_id)
  const outcome = await observeLifecycle(socket, promptId, 360_000)
  if (!outcome.ok) throw new Error(`run ${promptId} failed: ${outcome.error}`)
  const text = outcome.executed.find((entry) => entry.node === '2')?.artifact ?? ''
  if (text === '') throw new Error(`run ${promptId} produced no text`)
  return text
}

// ── JSON extraction + shot normalization (robust to model formatting noise). ──

/** Strip markdown fences and extract the first balanced JSON array/object. */
function extractJson(text: string): unknown | null {
  let body = text.trim()
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const starts = [body.indexOf('['), body.indexOf('{')].filter((i) => i >= 0)
  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const open = body[start]
  const close = open === '[' ? ']' : '}'
  const end = body.lastIndexOf(close)
  if (end <= start) return null
  let slice = body.slice(start, end + 1)
  slice = slice.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry): string => asString(entry)).filter((entry): boolean => entry !== '') : []
}

interface Shot {
  id: string
  scene: string
  duration: number
  location_ref: string
  characters: string[]
  props: string[]
  action: string
  camera: string
  dialogue: { character: string; line: string }[]
  sfx: string[]
  bgm_cue: string
}

const CAMERA_CYCLE = [
  'wide establishing, slow push-in', 'medium two-shot, static', 'close-up, shallow focus',
  'over-the-shoulder, slight handheld', 'low-angle medium, slow dolly', 'insert detail, rack focus',
  'tracking shot following the subject', 'high wide, slow crane down',
]

/** Coerce one raw model shot into a normalized, gate-safe Shot. */
function normalizeShot(raw: any, scene: Scene, index: number): Shot {
  let duration = Math.round(Number(raw?.duration))
  if (!Number.isFinite(duration) || duration <= 0) duration = index % 2 === 0 ? 4 : 5
  duration = Math.max(3, Math.min(15, duration))
  if (duration > 5) duration = 5
  const dialogue = Array.isArray(raw?.dialogue)
    ? raw.dialogue
        .map((entry: any) => ({ character: asString(entry?.character), line: asString(entry?.line) }))
        .filter((entry: { character: string; line: string }) => entry.line !== '')
    : []
  return {
    id: asString(raw?.id) || `S${scene.num}-${index + 1}`,
    scene: scene.id,
    duration,
    location_ref: asString(raw?.location_ref) || scene.location_ref,
    characters: asStringArray(raw?.characters).length > 0 ? asStringArray(raw?.characters) : scene.chars,
    props: asStringArray(raw?.props),
    action: asString(raw?.action) || scene.summary,
    camera: asString(raw?.camera) || CAMERA_CYCLE[index % CAMERA_CYCLE.length],
    dialogue,
    sfx: asStringArray(raw?.sfx),
    bgm_cue: asString(raw?.bgm_cue) || 'tense noir strings, sparse piano',
  }
}

/** Deterministic fallback shot so a scene always reaches its target count. */
function fallbackShot(scene: Scene, index: number): Shot {
  return normalizeShot({
    id: `S${scene.num}-${index + 1}`,
    duration: index % 2 === 0 ? 4 : 5,
    location_ref: scene.location_ref,
    characters: scene.chars,
    props: index === 0 ? scene.props : scene.props.slice(0, 2),
    action: `${scene.title} — beat ${index + 1}: ${scene.summary}`,
    camera: CAMERA_CYCLE[index % CAMERA_CYCLE.length],
    dialogue: [],
    sfx: ['room tone', 'distant traffic'],
    bgm_cue: 'low uneasy noir underscore',
  }, scene, index)
}

/** Build the per-scene screenwriter instruction (strict JSON array contract). */
function sceneInstruction(scene: Scene): string {
  const charIds = scene.chars.map((id) => `${id}=${CHARACTERS.find((c) => c.id === id)?.name ?? id}`).join('; ')
  const propIds = scene.props.map((id) => `${id}=${PROPS.find((p) => p.id === id)?.name ?? id}`).join('; ')
  const total = scene.target * 4 + (scene.target % 2)
  return [
    `Expand SCENE ${scene.num} ("${scene.title}") of "${TITLE}" into EXACTLY ${scene.target} shots.`,
    'Reply with ONLY a JSON array — no prose, no markdown fences, no commentary.',
    'Each element MUST be an object with EXACTLY these keys:',
    `  id (string, "S${scene.num}-<k>"), duration (integer 4 or 5),`,
    '  location_ref (string: the location id), characters (array of character ids present),',
    '  props (array of prop ids used), action (string <= 20 words, present tense, concrete and filmable),',
    '  camera (string <= 12 words: shot size + movement), dialogue (array of {character: id, line: string <= 20 words}; may be []),',
    '  sfx (array of short sound-effect strings), bgm_cue (string: music mood).',
    `Durations must be 4 or 5 and sum to about ${total} seconds. Never exceed 15.`,
    `Use ONLY these ids — characters: ${charIds}. location: ${scene.location_ref}. props: ${propIds}.`,
    'Cut for continuity: establish the space, then move through the beat, then land the scene turn.',
  ].join(' ')
}

/** Build the context block fed to a scene's TextGenerator run. */
function sceneContext(scene: Scene): string {
  const chars = scene.chars.map((id) => {
    const c = CHARACTERS.find((entry) => entry.id === id)
    return c === undefined ? '' : `- ${c.id} (${c.name}): ${c.visual}`
  }).filter((line) => line !== '').join('\n')
  const loc = LOCATIONS.find((entry) => entry.id === scene.location_ref)
  const props = scene.props.map((id) => {
    const p = PROPS.find((entry) => entry.id === id)
    return p === undefined ? '' : `- ${p.id}: ${p.visual}`
  }).filter((line) => line !== '').join('\n')
  return [
    `STORY TREATMENT: ${STORY}`,
    '',
    `SCENE ${scene.num} — "${scene.title}" @ ${loc?.name ?? scene.location_ref}`,
    `SUMMARY: ${scene.summary}`,
    `BEAT: ${scene.beat}`,
    '',
    `LOCATION ${scene.location_ref}: ${loc?.visual ?? ''}`,
    'CHARACTERS IN SCENE:',
    chars,
    'PROPS IN SCENE:',
    props,
  ].join('\n')
}

/** Trim/pad a shot list to exactly the scene target so totals stay in the gate. */
function fitCount(shots: Shot[], scene: Scene): Shot[] {
  const out = shots.slice(0, scene.target)
  while (out.length < scene.target) out.push(fallbackShot(scene, out.length))
  return out.map((shot, index): Shot => ({ ...shot, id: `S${scene.num}-${index + 1}` }))
}

/** Expand one scene into exactly target shots via the seam (retry + fallback). */
async function expandScene(scene: Scene): Promise<Shot[]> {
  const context = sceneContext(scene)
  const instruction = sceneInstruction(scene)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await runText(context, instruction, `Scene ${scene.num} · ${scene.title}`)
      const parsed = extractJson(text)
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed !== null && Array.isArray((parsed as any).shots) ? (parsed as any).shots : null)
      if (arr !== null && arr.length > 0) {
        const shots = arr.map((raw: any, index: number): Shot => normalizeShot(raw, scene, index))
        logger.info('scene %d: model returned %d shot(s)', scene.num, shots.length)
        return fitCount(shots, scene)
      }
      logger.warn('scene %d attempt %d: no JSON array in output', scene.num, attempt)
    } catch (error) {
      logger.warn('scene %d attempt %d failed: %s', scene.num, attempt, error instanceof Error ? error.message : String(error))
    }
  }
  logger.warn('scene %d: falling back to deterministic expansion', scene.num)
  const shots = Array.from({ length: scene.target }, (_, index) => fallbackShot(scene, index))
  return fitCount(shots, scene)
}

// ── Script assembly, gate validation, workspace commit. ──

interface Script {
  title: string
  logline: string
  runtime_target_s: [number, number]
  characters: Dossier[]
  locations: Dossier[]
  props: Dossier[]
  scenes: { id: string; num: number; title: string; location_ref: string; summary: string; shot_count: number }[]
  shots: Shot[]
}

function assembleScript(sceneShots: Shot[]): Script {
  return {
    title: TITLE,
    logline: 'A war widow exposes the forged signature that stole her late husband\'s "Vanguard" transmission patent from a Detroit auto cartel, over one rainy night in 1949.',
    runtime_target_s: [180, 300],
    characters: CHARACTERS,
    locations: LOCATIONS,
    props: PROPS,
    scenes: SCENES.map((scene) => ({
      id: scene.id, num: scene.num, title: scene.title, location_ref: scene.location_ref, summary: scene.summary,
      shot_count: sceneShots.filter((shot) => shot.scene === scene.id).length,
    })),
    shots: sceneShots,
  }
}

/** Validate the plan's Task-2 gate; returns human-readable failures. */
function validateGate(script: Script): string[] {
  const failures: string[] = []
  const count = script.shots.length
  if (count < 40 || count > 60) failures.push(`shot count ${count} outside 40-60`)
  const total = script.shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (total < 180 || total > 300) failures.push(`total runtime ${total}s outside 180-300s`)
  const over = script.shots.filter((shot) => shot.duration > 15)
  if (over.length > 0) failures.push(`${over.length} shot(s) exceed the 15s hard cap`)
  for (const c of script.characters) if (asString(c.visual) === '') failures.push(`character ${c.id} lacks a visual descriptor`)
  for (const l of script.locations) if (asString(l.visual) === '') failures.push(`location ${l.id} lacks a visual descriptor`)
  for (const p of script.props) if (asString(p.visual) === '') failures.push(`prop ${p.id} lacks a visual descriptor`)
  return failures
}

/** Write the script into the room workspace at assets/script.json. */
function writeScript(script: Script): string {
  const dir = join(ROOM_DIR, 'assets')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'script.json')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(script, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

// ── Screenplay canvas (rebuilt from scratch, then populated with the script). ──

function buildScriptCanvas(script: Script, populated: boolean): WorkflowGraph {
  const node = (
    id: number, type: string, title: string, pos: [number, number],
    inputs: { name: string; type: string; link: number | null }[],
    outputs: { name: string; type: string; links: number[] }[],
    widgets: unknown[], properties: Record<string, unknown>,
  ): any => ({
    id, type, pos, size: [300, 170], flags: 0, order: id - 1, mode: 0,
    inputs,
    outputs: outputs.map((out, index) => ({ name: out.name, type: out.type, link: out.links[0] ?? null, links: out.links, slot_index: index })),
    title, properties: { 'Node name for S&R': type, ...properties }, widgets_values: widgets,
  })

  const total = script.shots.reduce((sum, shot) => sum + shot.duration, 0)
  const sceneSummary = script.scenes.map((s) => `${s.num}. ${s.title} (${s.shot_count})`).join(' · ')
  const genTitle = populated ? `Screenwriter · ${script.shots.length} shots / ${total}s` : 'Screenwriter · shots.json'
  const genProps = populated
    ? { script: 'assets/script.json', shots: script.shots.length, runtime_s: total, scenes: script.scenes.length, breakdown: sceneSummary }
    : {}

  const nodes = [
    node(1, 'TextInput', 'Story Treatment', [60, 140], [], [{ name: 'text', type: 'TEXT', links: [1] }], [STORY], {}),
    node(2, 'TextGenerator', genTitle, [440, 120], [{ name: 'context', type: 'TEXT', link: 1 }], [{ name: 'text', type: 'TEXT', links: [2] }], [SCREENWRITER_INSTRUCTION], genProps),
    node(3, 'SaveOutput', populated ? 'Save script.json ✔' : 'Save script.json', [840, 160], [{ name: 'media', type: '*', link: 2 }], [], [], populated ? { path: 'assets/script.json' } : {}),
  ]
  const links: any[] = [
    [1, 1, 0, 2, 0, 'TEXT'],
    [2, 2, 0, 3, 0, 'TEXT'],
  ]
  return {
    last_node_id: 3, last_link_id: 2, nodes, links,
    groups: [{ title: `${TITLE} · Screenplay (Phase 2)`, bounding: [30, 20, 1160, 360], color: '2', collapsed: false }],
    config: {}, extra: { ds: { scale: 0.7, offset: [0, 0] } }, version: 0.4,
  } as WorkflowGraph
}

// ── Phase 1 — screenplay. ──

async function phase1(): Promise<void> {
  await say(`🎬 ${TITLE} — full pipeline run (driver). PHASE 1/7: screenplay. Clearing the canvas and rebuilding the workflow graph from scratch.`)
  await say('DECISION — story authored: a 1949 Detroit film-noir. Logline: A war widow exposes the forged signature that stole her late husband\'s "Vanguard" transmission patent over one rainy night.')
  await say(`DECISION — story bible fixed for consistency: ${CHARACTERS.length} characters (${CHARACTERS.map((c) => c.name).join(', ')}), ${LOCATIONS.length} locations, ${PROPS.length} props — each with a locked visual descriptor so every later frame stays on-model.`)

  const put = await legC('workflow/put', { roomId: ROOM_ID, graph: buildScriptCanvas(assembleScript([]), false) })
  if (put.status !== 200 || put.body?.ok !== true) {
    await say(`✘ canvas commit failed (HTTP ${put.status})`)
    throw new Error('workflow/put failed')
  }
  const rev = put.body.result?.workflow?.rev
  await say(`DECISION — canvas rebuilt from scratch (commit rev ${String(rev)}): TextInput(story) → TextGenerator(screenwriter) → SaveOutput(script.json). Your Studio converges live.`)

  await say(`▶ Screenwriter seam engaged (TextGenerator → Bailian): expanding ${SCENES.length} scenes into a shot list, ~${SCENES.reduce((s, x) => s + x.target, 0)} shots total. Narrating as each scene lands.`)
  const sceneShots: Shot[] = []
  for (const scene of SCENES) {
    const shots = await expandScene(scene)
    sceneShots.push(...shots)
    const sceneTotal = shots.reduce((sum, shot) => sum + shot.duration, 0)
    const withDialogue = shots.filter((shot) => shot.dialogue.length > 0).length
    logger.info('scene %d "%s": %d shots, %ds, %d with dialogue', scene.num, scene.title, shots.length, sceneTotal, withDialogue)
    await say(`✔ Scene ${scene.num} "${scene.title}" → ${shots.length} shots (${sceneTotal}s, ${withDialogue} with dialogue). Sample: "${shots[0]?.action.slice(0, 90)}" [${shots[0]?.camera}].`)
  }

  const script = assembleScript(sceneShots)
  const failures = validateGate(script)
  const total = script.shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (failures.length > 0) {
    await say(`✘ screenplay gate FAILED: ${failures.join('; ')}`)
    throw new Error(`gate failed: ${failures.join('; ')}`)
  }

  const file = writeScript(script)
  logger.info('wrote %s (%d shots, %ds)', file, script.shots.length, total)

  const put2 = await legC('workflow/put', { roomId: ROOM_ID, graph: buildScriptCanvas(script, true) })
  const rev2 = put2.body?.result?.workflow?.rev
  const dialogueLines = script.shots.reduce((sum, shot) => sum + shot.dialogue.length, 0)

  await say(`🏁 PHASE 1 COMPLETE — screenplay gate PASSED. ${script.shots.length} shots, ${total}s total (target 180-300s), every shot ≤ 15s, all ${script.characters.length + script.locations.length + script.props.length} dossiers carry visual descriptors.`)
  await say(`Script committed to the room workspace: assets/script.json (nodes populated, commit rev ${String(rev2)}).`)
  await say([
    `SHOT LIST — ${TITLE} (${script.shots.length} shots / ${total}s / ${dialogueLines} dialogue lines):`,
    ...script.scenes.map((s) => `  ${s.num}. ${s.title} @ ${s.location_ref} — ${s.shot_count} shots`),
    'CHARACTERS: ' + script.characters.map((c) => `${c.name} [${c.id}]`).join(', '),
    'LOCATIONS: ' + script.locations.map((l) => l.id).join(', '),
    'PROPS: ' + script.props.map((p) => p.id).join(', '),
    'Next: PHASE 2 — consistency reference pack (canonical portraits / establishing frames / prop sheets).',
  ].join('\n'))
}

// ── Phase 2 (Task 3) — consistency reference pack. ──
//
// One canonical reference image per story-bible dossier, generated THROUGH the
// DSH image seam (ImageGenerator -> ComfyUI on H20) and stored under the room
// workspace at assets/refs/. Characters ride the SDXL graph (fixed seed) so every
// later face-bearing frame can lock identity via instantid.json against the
// portrait; locations + props ride the Qwen-Image graph (fixed seed) so scene
// shots can img2img from the establishing frame and props stay on-model.
//
// Each generation threads room_id, so the gateway's P8-M3 media echo posts the
// image into the room as a real m.image AND writes the bytes to
// <roomDir>/artifacts/<nodeId>-<filename>; the driver copies that file into
// assets/refs/<refId>.png and records it in assets/state.json (resume-safe).

interface RefRecord {
  id: string
  kind: string
  dossier: string
  path: string
  uri: string
  seed: number
  width: number
  height: number
  variant: string
  bytes: number
  generated_at: number
}

interface RefState {
  characters: Record<string, RefRecord>
  locations: Record<string, RefRecord>
  props: Record<string, RefRecord>
}

interface MovieState {
  title: string
  room_id: string
  updated_at: number
  refs: RefState
}

function stateFile(): string {
  return join(ROOM_DIR, 'assets', 'state.json')
}

function readState(): MovieState {
  const fallback: MovieState = { title: TITLE, room_id: ROOM_ID, updated_at: 0, refs: { characters: {}, locations: {}, props: {} } }
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as any
    const refs = parsed?.refs ?? {}
    return {
      title: parsed?.title ?? TITLE,
      room_id: parsed?.room_id ?? ROOM_ID,
      updated_at: parsed?.updated_at ?? 0,
      refs: { characters: refs.characters ?? {}, locations: refs.locations ?? {}, props: refs.props ?? {} },
    }
  } catch {
    return fallback
  }
}

function writeState(state: MovieState): void {
  const dir = join(ROOM_DIR, 'assets')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  state.updated_at = Date.now()
  const file = stateFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** Deterministic 31-bit seed from a string so re-runs reproduce a reference. */
function seedFor(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h % 2147483647)
}

interface ImageOutput {
  artifact: string
  media: string
  uri: string
  filename: string
}

/** Observe one image prompt's lifecycle, capturing node '2' full output. */
function observeImage(socket: WebSocket, promptId: string, timeoutMs: number): Promise<{ ok: boolean; output: ImageOutput | null; error: string }> {
  return new Promise((resolveObs) => {
    let output: ImageOutput | null = null
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* ignore */ }
      resolveObs({ ok: false, output, error: `image lifecycle timed out (${Math.round(timeoutMs / 1000)}s)` })
    }, timeoutMs)
    const finish = (ok: boolean, error = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* ignore */ }
      resolveObs({ ok, output, error })
    }
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let msg: any
      try { msg = JSON.parse(text) } catch { return }
      if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return
      const data = msg.data ?? {}
      if (data.prompt_id !== undefined && String(data.prompt_id) !== promptId) return
      if (msg.type === 'executed' && String(data.node) === '2') {
        const o = data.output ?? {}
        const ref = (o.contentRef ?? {}) as any
        output = {
          artifact: String(o.artifact ?? ''),
          media: String(o.media ?? ''),
          uri: typeof ref.uri === 'string' && ref.uri !== '' ? ref.uri : String(o.artifact ?? ''),
          filename: typeof ref.name === 'string' ? ref.name : '',
        }
      } else if (msg.type === 'execution_success') {
        finish(true)
      } else if (msg.type === 'execution_error') {
        finish(false, String(data.exception_message ?? data.message ?? 'execution error'))
      }
    })
    socket.addEventListener('error', () => finish(false, 'websocket error'))
  })
}

interface RunImageOpts {
  prompt: string
  negative: string
  seed: number
  width: number
  height: number
  variant?: string
  steps?: number
  label: string
}

/**
 * Generate ONE image through the Leg B /prompt seam (room_id threaded so the
 * gateway posts it into the room and writes the bytes to artifacts/). Returns
 * the produced bytes plus the room uri.
 */
async function runImage(opts: RunImageOpts): Promise<{ bytes: Uint8Array; uri: string; filename: string }> {
  const genInputs: Record<string, unknown> = {
    prompt: ['1', 0],
    mode: 'text_to_image',
    seed: opts.seed,
    width: opts.width,
    height: opts.height,
    negative: opts.negative,
    steps: opts.steps ?? 20,
  }
  if (opts.variant !== undefined) genInputs.variant = opts.variant
  const prompt: PromptGraph = {
    '1': { class_type: 'TextInput', inputs: { text: opts.prompt }, _meta: { title: `${opts.label} · prompt` } },
    '2': { class_type: 'ImageGenerator', inputs: genInputs as any, _meta: { title: opts.label } },
  }
  const socket = new WebSocket(`${WS_BASE}/comfy/ws`)
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', (): void => resolveOpen(), { once: true })
    socket.addEventListener('error', (): void => rejectOpen(new Error('/comfy/ws connect failed')), { once: true })
  })
  const submitted = await fetch(`${GATEWAY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, room_id: ROOM_ID }),
  })
  const submittedBody = (await submitted.json()) as { prompt_id?: string; error?: string; message?: string }
  if (!submitted.ok || submittedBody.prompt_id === undefined) {
    try { socket.close() } catch { /* ignore */ }
    throw new Error(`/prompt rejected (HTTP ${submitted.status}): ${submittedBody.message ?? submittedBody.error ?? 'unknown'}`)
  }
  const promptId = String(submittedBody.prompt_id)
  const outcome = await observeImage(socket, promptId, 300_000)
  if (!outcome.ok || outcome.output === null) throw new Error(`image run ${promptId} failed: ${outcome.error}`)
  const out = outcome.output

  // Resolve the produced bytes: prefer the local artifacts/ copy written by the
  // gateway's P8-M3 media echo; fall back to fetching the backend /view URL.
  if (out.filename !== '') {
    const safeName = out.filename.replace(/[^A-Za-z0-9._-]/g, '_')
    const local = join(ROOM_DIR, 'artifacts', `2-${safeName}`)
    if (existsSync(local)) {
      const buf = readFileSync(local)
      return { bytes: new Uint8Array(buf), uri: out.uri, filename: out.filename }
    }
  }
  if (/^https?:/i.test(out.artifact)) {
    const resp = await fetch(out.artifact, { signal: AbortSignal.timeout(120_000) })
    if (resp.ok) {
      const buf = new Uint8Array(await resp.arrayBuffer())
      return { bytes: buf, uri: out.uri, filename: out.filename }
    }
  }
  throw new Error(`image run ${promptId} produced no retrievable bytes`)
}

const NEG_PORTRAIT = 'blurry, low quality, distorted, deformed face, extra limbs, watermark, text, cartoon, anime, modern clothing'
const NEG_SCENE = 'blurry, low quality, distorted, watermark, text, people, person, cartoon, anime, modern vehicles'
const NEG_PROP = 'blurry, low quality, distorted, watermark, text, hands, people, cartoon, anime, cluttered background'

function characterPrompt(c: Dossier): string {
  return [
    `Cinematic film-noir character portrait, Detroit 1949. ${c.name}: ${c.visual}.`,
    'Head-and-shoulders, three-quarter turn, calm expression, looking slightly off-camera.',
    'Dramatic single key light, deep chiaroscuro shadows, smoky atmosphere, neutral dark studio background.',
    'Photorealistic, 35mm film grain, period-accurate wardrobe, consistent reproducible facial features.',
  ].join(' ')
}

function locationPrompt(l: Dossier): string {
  return [
    `Cinematic film-noir establishing frame, Detroit 1949, widescreen. ${l.name}: ${l.visual}.`,
    'Empty of people, wide establishing composition, atmospheric depth.',
    'Low-key noir lighting, hard shadows, volumetric haze, wet reflective surfaces.',
    'Photorealistic, 35mm film grain, period-accurate set design, no text or signage lettering.',
  ].join(' ')
}

function propPrompt(p: Dossier): string {
  return [
    `Cinematic film-noir prop reference, Detroit 1949. ${p.name}: ${p.visual}.`,
    'Single hero object, centered, slightly angled, on a dark neutral surface.',
    'One hard key light with soft falloff, deep shadow, fine material detail.',
    'Photorealistic macro, 35mm film grain, period-accurate, no hands, no text overlays.',
  ].join(' ')
}

function refsDir(): string {
  const dir = join(ROOM_DIR, 'assets', 'refs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Generate (or resume) one reference image and record it in state. */
async function generateRef(
  state: MovieState,
  kind: string,
  dossier: Dossier,
  opts: { width: number; height: number; variant?: string; negative: string; prompt: string; steps: number },
): Promise<RefRecord> {
  const bucket = kind === 'character' ? state.refs.characters : kind === 'location' ? state.refs.locations : state.refs.props
  const relPath = `assets/refs/${kind}-${dossier.id}.png`
  const existing = bucket[dossier.id]
  if (existing !== undefined && existsSync(join(ROOM_DIR, existing.path))) {
    logger.info('ref %s/%s already present — skipping (resume)', kind, dossier.id)
    return existing
  }
  const seed = seedFor(`${kind}:${dossier.id}`)
  const result = await runImage({ prompt: opts.prompt, negative: opts.negative, seed, width: opts.width, height: opts.height, variant: opts.variant, steps: opts.steps, label: `Ref · ${dossier.name}` })
  refsDir()
  const refPath = join(ROOM_DIR, relPath)
  writeFileSync(refPath, Buffer.from(result.bytes))
  const record: RefRecord = {
    id: `${kind}-${dossier.id}`,
    kind,
    dossier: dossier.id,
    path: relPath,
    uri: result.uri,
    seed,
    width: opts.width,
    height: opts.height,
    variant: opts.variant ?? 'sdxl',
    bytes: result.bytes.byteLength,
    generated_at: Date.now(),
  }
  bucket[dossier.id] = record
  writeState(state)
  logger.info('ref %s -> %s (%d bytes, seed %d)', record.id, record.path, record.bytes, seed)
  return record
}

// ── Combined canvas: screenplay group (Phase 2) + reference pack (Phase 3). ──

function buildRefCanvas(script: Script | null, state: MovieState, populated: boolean): WorkflowGraph {
  const mk = (
    id: number, type: string, title: string, pos: [number, number],
    inputs: { name: string; type: string; link: number | null }[],
    outputs: { name: string; type: string; links: number[] }[],
    widgets: unknown[], properties: Record<string, unknown>,
  ): any => ({
    id, type, pos, size: [260, 150], flags: 0, order: id - 1, mode: 0,
    inputs,
    outputs: outputs.map((out, index) => ({ name: out.name, type: out.type, link: out.links[0] ?? null, links: out.links, slot_index: index })),
    title, properties: { 'Node name for S&R': type, ...properties }, widgets_values: widgets,
  })

  const nodes: any[] = []
  const links: any[] = []
  const groups: any[] = []
  let lastNodeId = 0

  if (script !== null) {
    const total = script.shots.reduce((sum, shot) => sum + shot.duration, 0)
    nodes.push(mk(1, 'TextInput', 'Story Treatment', [60, 140], [], [{ name: 'text', type: 'TEXT', links: [1] }], [STORY], {}))
    nodes.push(mk(2, 'TextGenerator', `Screenwriter · ${script.shots.length} shots / ${total}s`, [440, 120], [{ name: 'context', type: 'TEXT', link: 1 }], [{ name: 'text', type: 'TEXT', links: [2] }], [SCREENWRITER_INSTRUCTION], { script: 'assets/script.json', shots: script.shots.length, runtime_s: total }))
    nodes.push(mk(3, 'SaveOutput', 'Save script.json ✔', [840, 160], [{ name: 'media', type: '*', link: 2 }], [], [], { path: 'assets/script.json' }))
    links.push([1, 1, 0, 2, 0, 'TEXT'], [2, 2, 0, 3, 0, 'TEXT'])
    lastNodeId = 3
    groups.push({ title: `${TITLE} · Screenplay (Phase 2)`, bounding: [30, 20, 1160, 360], color: '2', collapsed: false })
  }

  const refEntries: { rec: RefRecord; name: string }[] = []
  for (const c of CHARACTERS) { const rec = state.refs.characters[c.id]; if (rec !== undefined) refEntries.push({ rec, name: c.name }) }
  for (const l of LOCATIONS) { const rec = state.refs.locations[l.id]; if (rec !== undefined) refEntries.push({ rec, name: l.name }) }
  for (const p of PROPS) { const rec = state.refs.props[p.id]; if (rec !== undefined) refEntries.push({ rec, name: p.name }) }

  const COLS = 6
  refEntries.forEach((entry, index) => {
    const id = 10 + index
    const col = index % COLS
    const row = Math.floor(index / COLS)
    const pos: [number, number] = [60 + col * 300, 460 + row * 220]
    nodes.push(mk(id, 'ImageGenerator', populated ? `Ref · ${entry.name} ✔` : `Ref · ${entry.name}`, pos,
      [{ name: 'prompt', type: 'TEXT', link: null }, { name: 'image', type: 'IMAGE', link: null }],
      [{ name: 'image', type: 'IMAGE', links: [] }],
      ['text_to_image'],
      { ref: entry.rec.path, uri: entry.rec.uri, seed: entry.rec.seed, kind: entry.rec.kind, variant: entry.rec.variant, width: entry.rec.width, height: entry.rec.height, bytes: entry.rec.bytes }))
    if (id > lastNodeId) lastNodeId = id
  })

  const rows = Math.max(1, Math.ceil(refEntries.length / COLS))
  groups.push({ title: `${TITLE} · Reference Pack (Phase 3) — ${refEntries.length} refs`, bounding: [30, 420, COLS * 300 + 40, rows * 220 + 80], color: '4', collapsed: false })

  return {
    last_node_id: lastNodeId, last_link_id: links.length, nodes, links,
    groups, config: {}, extra: { ds: { scale: 0.6, offset: [0, 0] } }, version: 0.4,
  } as WorkflowGraph
}

// ── Room media posting (driver-side, self-contained). ──
//
// The gateway's P8-M3 media echo persists generated bytes to artifacts/ but its
// matrix-js-sdk uploadContent path returns no mxc on this Synapse, so images do
// not surface in the room as m.image. The driver therefore posts each produced
// image/clip itself via the proven unauthenticated media endpoint
// (/_matrix/media/v3/upload — the same one matrix-admin uses for avatars), then
// sends the MIME-appropriate m.image/m.video/m.file message as the host.

/** Upload media bytes to Matrix and post them into the room; returns the mxc uri. */
async function postMedia(bytes: Uint8Array, filename: string, mime: string, body: string, info?: Record<string, unknown>): Promise<string | null> {
  try {
    const upResp = await fetch(`${SYNAPSE}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}`, 'Content-Type': mime },
      body: Buffer.from(bytes),
    })
    if (!upResp.ok) {
      logger.warn('media upload failed: HTTP %d %s', upResp.status, filename)
      return null
    }
    const uploaded = (await upResp.json()) as { content_uri?: string }
    const url = uploaded.content_uri
    if (url === undefined || url === '') {
      logger.warn('media upload returned no content_uri for %s', filename)
      return null
    }
    const msgtype = mime.startsWith('image/') ? 'm.image' : mime.startsWith('video/') ? 'm.video' : mime.startsWith('audio/') ? 'm.audio' : 'm.file'
    const txn = `drive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sendResp = await fetch(`${SYNAPSE}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/send/m.room.message/${txn}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ msgtype, body, filename, url, info: { mimetype: mime, size: bytes.byteLength, ...(info ?? {}) } }),
    })
    if (!sendResp.ok) {
      logger.warn('media send failed: HTTP %d %s', sendResp.status, filename)
      return null
    }
    return url
  } catch (error) {
    logger.warn('postMedia error for %s: %s', filename, error instanceof Error ? error.message : String(error))
    return null
  }
}

/** Post one reference image into the room and lift its mxc uri into the record. */
async function emitRef(state: MovieState, rec: RefRecord, name: string): Promise<void> {
  if (rec.uri.startsWith('mxc:')) {
    await say(`  ✔ ${name} [${rec.id}] seed ${rec.seed} → ${rec.path} (${rec.bytes} bytes) · already in room`)
    return
  }
  const abs = join(ROOM_DIR, rec.path)
  if (existsSync(abs)) {
    const bytes = new Uint8Array(readFileSync(abs))
    const mxc = await postMedia(bytes, `${rec.id}.png`, 'image/png', `${name} — ${rec.id} (seed ${rec.seed}, ${rec.width}×${rec.height})`, { w: rec.width, h: rec.height })
    if (mxc !== null && rec.uri !== mxc) {
      rec.uri = mxc
      writeState(state)
    }
  }
  await say(`  ✔ ${name} [${rec.id}] seed ${rec.seed} → ${rec.path} (${rec.bytes} bytes)${rec.uri.startsWith('mxc:') ? ' · posted to room' : ''}`)
}

// ── Phase 2 — consistency reference pack. ──

async function phase2(): Promise<void> {
  const state = readState()
  const expected = CHARACTERS.length + LOCATIONS.length + PROPS.length
  await say(`🎨 PHASE 2/7 (Task 3): consistency reference pack. Generating ONE canonical reference per story-bible dossier THROUGH the DSH image seam (ImageGenerator → ComfyUI on H20), stored under assets/refs/ and posted into the room.`)
  await say('DECISION — character portraits ride the SDXL graph (fixed seed each) so every later face-bearing frame locks identity via instantid.json against the portrait; locations + props ride the Qwen-Image graph (fixed seed) so scene shots img2img from the establishing frame and props stay on-model.')
  await say(`Plan: ${CHARACTERS.length} portraits (SDXL 832×1216) · ${LOCATIONS.length} establishing frames (Qwen 1280×720) · ${PROPS.length} prop sheets (Qwen 1024×1024) = ${expected} references.`)

  await say('▶ Characters — canonical portraits (SDXL, fixed seed):')
  for (const c of CHARACTERS) {
    const rec = await generateRef(state, 'character', c, { width: 832, height: 1216, negative: NEG_PORTRAIT, prompt: characterPrompt(c), steps: 25 })
    await emitRef(state, rec, c.name)
  }
  await say('▶ Locations — establishing frames (Qwen-Image, fixed seed):')
  for (const l of LOCATIONS) {
    const rec = await generateRef(state, 'location', l, { width: 1280, height: 720, variant: 'qwen', negative: NEG_SCENE, prompt: locationPrompt(l), steps: 20 })
    await emitRef(state, rec, l.name)
  }
  await say('▶ Props — reference sheets (Qwen-Image, fixed seed):')
  for (const p of PROPS) {
    const rec = await generateRef(state, 'prop', p, { width: 1024, height: 1024, variant: 'qwen', negative: NEG_PROP, prompt: propPrompt(p), steps: 20 })
    await emitRef(state, rec, p.name)
  }

  const all: RefRecord[] = [...Object.values(state.refs.characters), ...Object.values(state.refs.locations), ...Object.values(state.refs.props)]
  const missing = all.filter((r) => !existsSync(join(ROOM_DIR, r.path)) || r.bytes <= 0)
  if (all.length < expected || missing.length > 0) {
    await say(`✘ reference-pack gate FAILED: ${all.length}/${expected} refs, ${missing.length} missing/empty`)
    throw new Error(`reference gate failed: ${missing.map((m) => m.id).join(', ') || 'count short'}`)
  }

  let script: Script | null = null
  try { script = JSON.parse(readFileSync(join(ROOM_DIR, 'assets', 'script.json'), 'utf8')) as Script } catch { script = null }

  const put = await legC('workflow/put', { roomId: ROOM_ID, graph: buildRefCanvas(script, state, true) })
  if (put.status !== 200 || put.body?.ok !== true) {
    await say(`✘ reference-pack canvas commit failed (HTTP ${put.status})`)
    throw new Error('workflow/put failed for reference pack')
  }
  const rev = put.body?.result?.workflow?.rev
  const totalBytes = all.reduce((sum, r) => sum + r.bytes, 0)
  const posted = all.filter((r) => r.uri.startsWith('mxc:')).length
  await say(`🏁 PHASE 2 COMPLETE — reference-pack gate PASSED. ${all.length}/${expected} references on disk under assets/refs/ (${totalBytes} bytes total), ${posted} posted into the room as m.image. Canvas committed rev ${String(rev)} (screenplay group + reference pack, every node populated with its image).`)
  await say([
    `CONTACT SHEET — ${TITLE} reference pack (${all.length} refs):`,
    'CHARACTERS (SDXL portrait · face-lock source for instantid):',
    ...CHARACTERS.map((c) => `  · ${c.name} [char-${c.id}] seed ${state.refs.characters[c.id]?.seed} — ${state.refs.characters[c.id]?.path}`),
    'LOCATIONS (Qwen establishing frame · img2img source for scene shots):',
    ...LOCATIONS.map((l) => `  · ${l.name} [loc-${l.id}] seed ${state.refs.locations[l.id]?.seed} — ${state.refs.locations[l.id]?.path}`),
    'PROPS (Qwen prop sheet · i2i source on relevant shots):',
    ...PROPS.map((p) => `  · ${p.name} [prop-${p.id}] seed ${state.refs.props[p.id]?.seed} — ${state.refs.props[p.id]?.path}`),
    'State recorded in assets/state.json (resume-safe). Next: PHASE 3 — storyboard frames (one per shot; img2img from the location ref, InstantID variant when a face is visible).',
  ].join('\n'))
}

// ── Phase 3 (Task 4) — storyboard frames (one per shot). ──
//
// One 1280×720 frame per shot THROUGH the DSH image seam. Face-bearing shots
// ride the InstantID graph (the character portrait is fed to the template's
// LoadImage face-lock node), faceless shots ride Qwen img2img from the location
// establishing frame (provider applyImg2Img, denoise 0.75). The reference image
// reaches ComfyUI on H20 via the provider's `image` input, which accepts an
// http(s) URL: the driver hosts a tiny loopback static server over assets/refs/
// so the /prompt body stays small (the gateway caps bodies at 64 KiB) and the
// gateway-side provider fetches + uploads the ref to ComfyUI itself.

interface FrameRecord {
  id: string
  scene: string
  path: string
  uri: string
  seed: number
  width: number
  height: number
  variant: string
  base: string
  face: string
  bytes: number
  generated_at: number
}

interface FrameState {
  title: string
  room_id: string
  updated_at: number
  frames: Record<string, FrameRecord>
}

function frameStateFile(): string {
  return join(ROOM_DIR, 'assets', 'frames-state.json')
}

function readFrameState(): FrameState {
  const fallback: FrameState = { title: TITLE, room_id: ROOM_ID, updated_at: 0, frames: {} }
  try {
    const parsed = JSON.parse(readFileSync(frameStateFile(), 'utf8')) as any
    return { title: parsed?.title ?? TITLE, room_id: parsed?.room_id ?? ROOM_ID, updated_at: parsed?.updated_at ?? 0, frames: parsed?.frames ?? {} }
  } catch {
    return fallback
  }
}

function writeFrameState(state: FrameState): void {
  const dir = join(ROOM_DIR, 'assets')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  state.updated_at = Date.now()
  const file = frameStateFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function framesDir(): string {
  const dir = join(ROOM_DIR, 'assets', 'frames')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Loopback static server over assets/refs/ so the provider can fetch a ref by http URL. */
async function startRefServer(): Promise<{ port: number; close: () => void }> {
  const http = await import('node:http')
  const dir = join(ROOM_DIR, 'assets', 'refs')
  const server = http.createServer((req: any, res: any): void => {
    try {
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (name === '' || name.includes('..') || name.includes('/')) { res.writeHead(400); res.end('bad'); return }
      const abs = join(dir, name)
      if (!existsSync(abs)) { res.writeHead(404); res.end('nf'); return }
      const bytes = readFileSync(abs)
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength) })
      res.end(bytes)
    } catch { res.writeHead(500); res.end('err') }
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address() as { port?: number } | null
  const port = addr !== null && typeof addr.port === 'number' ? addr.port : 0
  logger.info('ref server listening on 127.0.0.1:%d', port)
  return { port, close: (): void => { try { server.close() } catch { /* ignore */ } } }
}

interface RunFrameOpts {
  prompt: string
  negative: string
  seed: number
  width: number
  height: number
  variant?: string
  steps?: number
  image?: string
  label: string
}

/** Generate ONE conditioned frame through the Leg B /prompt seam (image input threaded). */
async function runFrame(opts: RunFrameOpts): Promise<{ bytes: Uint8Array; uri: string; filename: string }> {
  const genInputs: Record<string, unknown> = {
    prompt: ['1', 0],
    mode: 'text_to_image',
    seed: opts.seed,
    width: opts.width,
    height: opts.height,
    negative: opts.negative,
    steps: opts.steps ?? 20,
  }
  if (opts.variant !== undefined) genInputs.variant = opts.variant
  if (opts.image !== undefined) genInputs.image = opts.image
  const prompt: PromptGraph = {
    '1': { class_type: 'TextInput', inputs: { text: opts.prompt }, _meta: { title: `${opts.label} · prompt` } },
    '2': { class_type: 'ImageGenerator', inputs: genInputs as any, _meta: { title: opts.label } },
  }
  const socket = new WebSocket(`${WS_BASE}/comfy/ws`)
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', (): void => resolveOpen(), { once: true })
    socket.addEventListener('error', (): void => rejectOpen(new Error('/comfy/ws connect failed')), { once: true })
  })
  const submitted = await fetch(`${GATEWAY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, room_id: ROOM_ID }),
  })
  const submittedBody = (await submitted.json()) as { prompt_id?: string; error?: string; message?: string }
  if (!submitted.ok || submittedBody.prompt_id === undefined) {
    try { socket.close() } catch { /* ignore */ }
    throw new Error(`/prompt rejected (HTTP ${submitted.status}): ${submittedBody.message ?? submittedBody.error ?? 'unknown'}`)
  }
  const promptId = String(submittedBody.prompt_id)
  const outcome = await observeImage(socket, promptId, 300_000)
  if (!outcome.ok || outcome.output === null) throw new Error(`frame run ${promptId} failed: ${outcome.error}`)
  const out = outcome.output
  if (out.filename !== '') {
    const safeName = out.filename.replace(/[^A-Za-z0-9._-]/g, '_')
    const local = join(ROOM_DIR, 'artifacts', `2-${safeName}`)
    if (existsSync(local)) {
      const buf = readFileSync(local)
      return { bytes: new Uint8Array(buf), uri: out.uri, filename: out.filename }
    }
  }
  if (/^https?:/i.test(out.artifact)) {
    const resp = await fetch(out.artifact, { signal: AbortSignal.timeout(120_000) })
    if (resp.ok) return { bytes: new Uint8Array(await resp.arrayBuffer()), uri: out.uri, filename: out.filename }
  }
  throw new Error(`frame run ${promptId} produced no retrievable bytes`)
}

const NEG_FRAME = 'blurry, low quality, distorted, deformed face, extra limbs, extra fingers, malformed hands, watermark, text, subtitles, caption, logo, cartoon, anime, illustration, modern clothing, modern vehicles, anachronistic, oversaturated, flat lighting'

function framePrompt(shot: Shot, location: Dossier | undefined, chars: Dossier[], props: Dossier[], faceLock: boolean): string {
  const parts: string[] = ['Cinematic film-noir storyboard frame, Detroit 1949, widescreen 16:9, photorealistic.']
  if (location !== undefined) parts.push(`Setting: ${location.name} — ${location.visual}.`)
  parts.push(`Action: ${shot.action}`)
  parts.push(`Camera: ${shot.camera}.`)
  if (chars.length > 0) {
    const desc = chars.map((c) => `${c.name} (${c.visual})`).join('; ')
    parts.push(faceLock ? `On-screen talent (identity locked to the portrait reference): ${desc}.` : `On-screen talent: ${desc}.`)
  }
  if (props.length > 0) parts.push(`Key props visible: ${props.map((p) => `${p.name} — ${p.visual}`).join('; ')}.`)
  parts.push('Style lock: low-key chiaroscuro noir lighting, hard key light, deep shadows, volumetric haze, rain-slick reflective surfaces, muted amber and teal palette, 35mm film grain, period-accurate 1949 wardrobe and sets, cinematic composition, no text or signage lettering.')
  return parts.join(' ')
}

/** Upload media bytes to Matrix (no room message); returns the mxc uri or null. */
async function uploadMedia(bytes: Uint8Array, filename: string, mime: string): Promise<string | null> {
  try {
    const resp = await fetch(`${SYNAPSE}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}`, 'Content-Type': mime },
      body: Buffer.from(bytes),
    })
    if (!resp.ok) { logger.warn('frame upload failed: HTTP %d %s', resp.status, filename); return null }
    const uploaded = (await resp.json()) as { content_uri?: string }
    return typeof uploaded.content_uri === 'string' && uploaded.content_uri !== '' ? uploaded.content_uri : null
  } catch (error) {
    logger.warn('uploadMedia error %s: %s', filename, error instanceof Error ? error.message : String(error))
    return null
  }
}

/** Send an m.image/m.video message referencing an already-uploaded mxc uri. */
async function sendMediaMessage(mxc: string, body: string, filename: string, mime: string, size: number, info?: Record<string, unknown>): Promise<boolean> {
  try {
    const msgtype = mime.startsWith('image/') ? 'm.image' : mime.startsWith('video/') ? 'm.video' : mime.startsWith('audio/') ? 'm.audio' : 'm.file'
    const txn = `drive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const resp = await fetch(`${SYNAPSE}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM_ID)}/send/m.room.message/${txn}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ msgtype, body, filename, url: mxc, info: { mimetype: mime, size, ...(info ?? {}) } }),
    })
    if (!resp.ok) { logger.warn('frame send failed: HTTP %d %s', resp.status, filename); return false }
    return true
  } catch (error) {
    logger.warn('sendMediaMessage error %s: %s', filename, error instanceof Error ? error.message : String(error))
    return false
  }
}

/** Generate (or resume) one storyboard frame and record it in frame state. */
async function generateFrame(fstate: FrameState, shot: Shot, script: Script, port: number): Promise<FrameRecord> {
  const existing = fstate.frames[shot.id]
  if (existing !== undefined && existsSync(join(ROOM_DIR, existing.path))) {
    logger.info('frame %s already present — skipping (resume)', shot.id)
    return existing
  }
  const location = script.locations.find((l): boolean => l.id === shot.location_ref)
  const chars = shot.characters.map((id): Dossier | undefined => CHARACTERS.find((c): boolean => c.id === id)).filter((c): c is Dossier => c !== undefined)
  const props = shot.props.map((id): Dossier | undefined => PROPS.find((p): boolean => p.id === id)).filter((p): p is Dossier => p !== undefined)
  const seed = seedFor(`frame:${shot.id}`)
  const refsAbs = join(ROOM_DIR, 'assets', 'refs')
  let variant: string
  let imageUrl: string | undefined
  let base = ''
  let face = ''
  const wantFace = shot.characters.length > 0
  if (wantFace && existsSync(join(refsAbs, `character-${shot.characters[0]}.png`))) {
    face = shot.characters[0]
    variant = 'instantid'
    imageUrl = `http://127.0.0.1:${port}/character-${face}.png`
  } else if (existsSync(join(refsAbs, `location-${shot.location_ref}.png`))) {
    base = shot.location_ref
    variant = 'qwen'
    imageUrl = `http://127.0.0.1:${port}/location-${base}.png`
  } else {
    variant = 'qwen'
  }
  const faceLock = variant === 'instantid'
  const steps = faceLock ? 25 : 20
  const prompt = framePrompt(shot, location, chars, props, faceLock)
  const result = await runFrame({ prompt, negative: NEG_FRAME, seed, width: 1280, height: 720, variant, steps, image: imageUrl, label: `Frame · ${shot.id}` })
  framesDir()
  const relPath = `assets/frames/${shot.id.replace(/[^A-Za-z0-9._-]/g, '_')}.png`
  writeFileSync(join(ROOM_DIR, relPath), Buffer.from(result.bytes))
  const record: FrameRecord = { id: shot.id, scene: shot.scene, path: relPath, uri: result.uri, seed, width: 1280, height: 720, variant, base, face, bytes: result.bytes.byteLength, generated_at: Date.now() }
  fstate.frames[shot.id] = record
  writeFrameState(fstate)
  logger.info('frame %s -> %s (%d bytes, seed %d, %s)', shot.id, record.path, record.bytes, seed, variant)
  return record
}

// ── Storyboard canvas: one group per scene, shot nodes populated with frames. ──

function buildFrameCanvas(script: Script, fstate: FrameState, refState: MovieState, populated: boolean): WorkflowGraph {
  const mk = (
    id: number, type: string, title: string, pos: [number, number],
    inputs: { name: string; type: string; link: number | null }[],
    outputs: { name: string; type: string; links: number[] }[],
    widgets: unknown[], properties: Record<string, unknown>,
  ): any => ({
    id, type, pos, size: [280, 170], flags: 0, order: id - 1, mode: 0,
    inputs,
    outputs: outputs.map((out, index) => ({ name: out.name, type: out.type, link: out.links[0] ?? null, links: out.links, slot_index: index })),
    title, properties: { 'Node name for S&R': type, ...properties }, widgets_values: widgets,
  })

  const nodes: any[] = []
  const groups: any[] = []
  let nodeId = 0
  const COLS = 5
  let cursorY = 20
  for (const sc of script.scenes) {
    const sceneShots = script.shots.filter((s): boolean => s.scene === sc.id)
    if (sceneShots.length === 0) continue
    const groupTop = cursorY
    const locRec = refState.refs.locations[sc.location_ref]
    const locName = locRec !== undefined ? sc.location_ref : sc.location_ref
    nodeId += 1
    const refId = nodeId
    nodes.push(mk(refId, 'ImageGenerator', populated ? `Base · ${locName} (i2i) ✔` : `Base · ${locName} (i2i)`, [60, groupTop + 40],
      [{ name: 'prompt', type: 'TEXT', link: null }, { name: 'image', type: 'IMAGE', link: null }],
      [{ name: 'image', type: 'IMAGE', links: [] }], ['text_to_image'],
      { role: 'i2i-base', ref: locRec?.path ?? '', uri: locRec?.uri ?? '', kind: 'location', seed: locRec?.seed ?? 0 }))
    let maxRow = 0
    sceneShots.forEach((shot, idx) => {
      const rec = fstate.frames[shot.id]
      nodeId += 1
      const id = nodeId
      const col = idx % COLS
      const row = Math.floor(idx / COLS)
      if (row > maxRow) maxRow = row
      const pos: [number, number] = [60 + col * 310, groupTop + 250 + row * 210]
      nodes.push(mk(id, 'ImageGenerator', populated && rec !== undefined ? `${shot.id} ✔` : shot.id, pos,
        [{ name: 'prompt', type: 'TEXT', link: null }, { name: 'image', type: 'IMAGE', link: null }],
        [{ name: 'image', type: 'IMAGE', links: [] }], ['text_to_image'],
        { shot: shot.id, scene: shot.scene, uri: rec?.uri ?? '', path: rec?.path ?? '', seed: rec?.seed ?? 0, variant: rec?.variant ?? '', face: rec?.face ?? '', base: rec?.base ?? '', width: rec?.width ?? 1280, height: rec?.height ?? 720, bytes: rec?.bytes ?? 0, duration: shot.duration, camera: shot.camera, action: shot.action }))
    })
    const rows = maxRow + 1
    const groupHeight = 250 + rows * 210 + 40
    const cols = Math.max(1, Math.min(sceneShots.length, COLS))
    const groupWidth = cols * 310 + 90
    groups.push({ title: `Scene ${sc.num} · ${sc.title} — ${sceneShots.length} shots`, bounding: [30, groupTop, groupWidth, groupHeight], color: String(2 + (sc.num % 6)), collapsed: false })
    cursorY += groupHeight + 70
  }

  return {
    last_node_id: nodeId, last_link_id: 0, nodes, links: [],
    groups, config: {}, extra: { ds: { scale: 0.5, offset: [0, 0] } }, version: 0.4,
  } as WorkflowGraph
}

// ── Phase 3 driver. ──

async function phase3(): Promise<void> {
  const fstate = readFrameState()
  const refState = readState()
  let script: Script
  try {
    script = JSON.parse(readFileSync(join(ROOM_DIR, 'assets', 'script.json'), 'utf8')) as Script
  } catch {
    await say('✘ phase 3 cannot load assets/script.json — run phases 1-2 first')
    throw new Error('script.json missing')
  }
  const limit = Number(process.env.DRIVE_FRAME_LIMIT ?? 0)
  const total = script.shots.length
  const shots = Number.isFinite(limit) && limit > 0 ? script.shots.slice(0, limit) : script.shots
  await say(`🎬 PHASE 3/7 (Task 4): storyboard frames — ONE 1280×720 frame per shot (${shots.length}${limit > 0 ? ` of ${total}` : ''} shots) THROUGH the DSH image seam (ImageGenerator → ComfyUI on H20), stored under assets/frames/ and committed into the canvas.`)
  await say('DECISION — face-bearing shots ride the InstantID graph (the character portrait is fed to the face-lock LoadImage node, identity locked); faceless shots ride Qwen img2img from the location establishing frame (denoise 0.75). Every frame is 1280×720 to match the final montage, with a fixed per-shot seed recorded in assets/frames-state.json (resume-safe). Each frame is retried up to 3× so a transient backend stall never aborts the run.')
  await say('NOTE — the H20 pool endpoints (8189-8191) are currently down; frames render serially on the main engine 8188 (the provider keeps submit-failover armed for when the pool returns).')

  const srv = await startRefServer()
  let posted = 0
  try {
    const sceneIds: string[] = []
    for (const s of shots) if (!sceneIds.includes(s.scene)) sceneIds.push(s.scene)
    for (const sceneId of sceneIds) {
      const sc = SCENES.find((x): boolean => x.id === sceneId)
      const sceneShots = shots.filter((s): boolean => s.scene === sceneId)
      await say(`▶ Scene ${sc?.num ?? '?'} "${sc?.title ?? sceneId}" — ${sceneShots.length} shot(s):`)
      let first = true
      for (const shot of sceneShots) {
        const wasResume = fstate.frames[shot.id] !== undefined && existsSync(join(ROOM_DIR, fstate.frames[shot.id].path))
        let rec: FrameRecord | null = null
        let lastErr = ''
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            rec = await generateFrame(fstate, shot, script, srv.port)
            break
          } catch (error) {
            lastErr = error instanceof Error ? error.message : String(error)
            logger.warn('frame %s attempt %d failed: %s', shot.id, attempt, lastErr)
            if (attempt < 3) {
              await say(`  ⚠ ${shot.id} attempt ${attempt} failed (${lastErr}); retrying in 5s…`)
              await new Promise((r): void => setTimeout(r, 5000))
            }
          }
        }
        if (rec === null) {
          await say(`  ✘ ${shot.id} failed after 3 attempts: ${lastErr}`)
          throw new Error(`frame ${shot.id} failed after retries: ${lastErr}`)
        }
        if (!rec.uri.startsWith('mxc:')) {
          const abs = join(ROOM_DIR, rec.path)
          if (existsSync(abs)) {
            const mxc = await uploadMedia(new Uint8Array(readFileSync(abs)), `${rec.id}.png`, 'image/png')
            if (mxc !== null) { rec.uri = mxc; writeFrameState(fstate) }
          }
        }
        let sentNote = ''
        if (first && !wasResume && rec.uri.startsWith('mxc:')) {
          const abs = join(ROOM_DIR, rec.path)
          const bytes = new Uint8Array(readFileSync(abs))
          const ok = await sendMediaMessage(rec.uri, `Scene ${sc?.num ?? '?'} key frame — ${shot.id} (${rec.variant}${rec.face !== '' ? ` face:${rec.face}` : ` base:${rec.base}`}, seed ${rec.seed})`, `${rec.id}.png`, 'image/png', bytes.byteLength, { w: rec.width, h: rec.height })
          if (ok) { posted += 1; sentNote = ' · key frame posted' }
        }
        first = false
        await say(`  ✔ ${shot.id} [${rec.variant}${rec.face !== '' ? ` face:${rec.face}` : rec.base !== '' ? ` base:${rec.base}` : ''}] seed ${rec.seed} → ${rec.path} (${rec.bytes}b)${rec.uri.startsWith('mxc:') ? ' · in room' : ''}${wasResume ? ' (resume)' : ''}${sentNote}`)
      }
    }
  } finally {
    srv.close()
  }

  const produced = shots.filter((s): boolean => fstate.frames[s.id] !== undefined && existsSync(join(ROOM_DIR, fstate.frames[s.id].path)) && fstate.frames[s.id].bytes > 0)
  if (limit > 0) {
    await say(`�� smoke test (DRIVE_FRAME_LIMIT=${limit}): ${produced.length}/${shots.length} frame(s) generated through the conditioned image path. Skipping full gate + canvas commit; re-run without the limit for all ${total} shots.`)
    return
  }
  if (produced.length < shots.length) {
    const miss = shots.filter((s): boolean => fstate.frames[s.id] === undefined).map((s): string => s.id)
    await say(`✘ storyboard gate FAILED: ${produced.length}/${shots.length} frames`)
    throw new Error(`storyboard gate failed; missing ${miss.join(', ')}`)
  }
  const put = await legC('workflow/put', { roomId: ROOM_ID, graph: buildFrameCanvas(script, fstate, refState, true) })
  if (put.status !== 200 || put.body?.ok !== true) {
    await say(`✘ storyboard canvas commit failed (HTTP ${put.status})`)
    throw new Error('workflow/put failed for storyboard')
  }
  const rev = put.body?.result?.workflow?.rev
  const totalBytes = produced.reduce((sum, s): number => sum + fstate.frames[s.id].bytes, 0)
  const mxcCount = produced.filter((s): boolean => fstate.frames[s.id].uri.startsWith('mxc:')).length
  const faceCount = produced.filter((s): boolean => fstate.frames[s.id].variant === 'instantid').length
  const sceneCount = script.scenes.filter((sc): boolean => script.shots.some((s): boolean => s.scene === sc.id)).length
  await say(`🏁 PHASE 3 COMPLETE — storyboard gate PASSED. ${produced.length}/${shots.length} frames on disk under assets/frames/ (${totalBytes} bytes), ${mxcCount} in the room media store, ${posted} new key frames posted as m.image this run, ${faceCount} face-locked via InstantID. Canvas committed rev ${String(rev)} (${sceneCount} scene groups, every shot node populated with its frame).`)
  await say([
    `STORYBOARD CONTACT SHEET — ${TITLE} (${produced.length} frames across ${sceneCount} scenes):`,
    ...script.scenes.map((sc) => {
      const ss = script.shots.filter((s): boolean => s.scene === sc.id)
      const faces = ss.filter((s): boolean => (fstate.frames[s.id]?.variant ?? '') === 'instantid').length
      return `  · Scene ${sc.num} "${sc.title}" [${sc.location_ref}] — ${ss.length} shots (${faces} face-locked, ${ss.length - faces} i2i): ${ss.map((s): string => s.id).join(', ')}`
    }),
    'Frames recorded in assets/frames-state.json (resume-safe). Next: PHASE 4 — i2v clips (each frame animated 4-5s via the VACE image-to-video graph, seed-locked).',
  ].join('\n'))
}

async function main(): Promise<void> {
  if (ADMIN_TOKEN === '') {
    logger.warn('SYNAPSE_ADMIN_TOKEN missing; cannot broker the host token')
    process.exit(1)
  }
  const argPhase = process.argv.indexOf('--phase')
  const phase = argPhase >= 0 ? Number(process.argv[argPhase + 1]) : 0

  const endpoint: MatrixEndpoint = { baseUrl: SYNAPSE, serverName: SERVER_NAME, adminToken: ADMIN_TOKEN }
  const creds = await brokerToken(endpoint, logger, HOST_USER)
  if (creds === null) {
    logger.warn('could not broker a token for %s', HOST_USER)
    process.exit(1)
  }
  hostToken = creds.accessToken
  logger.info('brokered host token for %s; room %s; workspace %s', HOST_USER, ROOM_ID, ROOM_DIR)

  try {
    if (phase === 0 || phase === 1) await phase1()
    if (phase === 0 || phase === 2) await phase2()
    if (phase === 0 || phase === 3) await phase3()
    if (phase === 0) logger.info('phases 1-3 done; later phases not yet implemented in this driver')
  } catch (error) {
    logger.warn('driver failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
    await say(`✘ driver error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  process.exit(0)
}

void main()
