/**
 * Phase 8 (D2/D13): local-first ComfyUI media provider.
 *
 * ComfyUI runs as a separate process (same box by default — loopback
 * `http://127.0.0.1:8188`; a remote GPU host is an env-only switch). The DSH
 * process stays model-code-free: it instantiates a server-held workflow
 * template (D10, `comfy-templates.ts`), POSTs the graph to `/prompt`, tracks
 * the job over `/ws` + `/history` polling, and fetches the output bytes from
 * `/view` so the runner can post them into the room as real media (P8-M3).
 *
 * The provider is **config-gated** like `video-provider.ts`:
 * {@link comfyConfigFromEnv} returns `undefined` unless `DSH_COMFY_BASE_URL`
 * is set, so without ComfyUI the D15 availability gate keeps image/video
 * `unavailable` and this provider is never constructed.
 *
 * P8-M4: `/ws` progress → Leg B, `/interrupt` on abort, overall timeout
 * (default 900 s for the 8 GB envelope), and an in-flight cap (default 1).
 * P8-M5: fail-closed health probe (`/system_stats` + `/object_info` template
 * coverage) with a short TTL, plus mock-verifiable endpoint pooling.
 *
 * @module dsh-movie-gateway/movie-executor/comfy-provider
 */

import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { MediaGeneration, MediaHooks, MediaProvider } from './media-provider.ts'
import {
  instantiate,
  missingNodeTypes,
  templateFor,
  type ComfyNode,
  type ComfyTemplates,
  type TemplateParams,
} from './comfy-templates.ts'
import { resolveZerotierBaseUrl, zerotierRefFromEnv } from './comfy-zerotier.ts'

/** Minimal diagnostics sink (matches `ctx.logger`). */
export interface ComfyProviderLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The resolved configuration for the local ComfyUI backend. */
export interface ComfyConfig {
  /** ComfyUI endpoints (primary first, then pool), no trailing slashes. */
  endpoints: string[]
  /**
   * Optional dynamic endpoint resolver (ZeroTier overlay). When present the
   * provider re-resolves the live endpoint list on each health probe, so a
   * remote member whose managed IP changed is picked up without editing any
   * static config; resolution failures keep the last known list.
   */
  resolveEndpoints?: (() => Promise<string[]>) | undefined
  /** Optional bearer token (ComfyUI `--api-key`); never logged. */
  token?: string | undefined
  /** History poll interval while awaiting completion, in milliseconds. */
  pollIntervalMs: number
  /** Overall per-generation timeout, in milliseconds (8 GB envelope: 900 s). */
  timeoutMs: number
  /** Maximum concurrent generations submitted to the backend. */
  inflightMax: number
  /** Per-request health-probe timeout (H20's /object_info is ~2.4 MB over the overlay). */
  probeTimeoutMs?: number
}

/** Per-modality backend readiness (fail-closed: unknown = not ready). */
export interface ComfyReadiness {
  image: boolean
  video: boolean
  audio: boolean
}

/** The ComfyUI provider: the media seam plus probe/readiness for the gate. */
export interface ComfyProvider extends MediaProvider {
  /**
   * Probe backend health + template node coverage. Cached for a short TTL;
   * `force` bypasses the cache (used at activation and before each run).
   */
  probe(force?: boolean): Promise<ComfyReadiness>
  /** The last probe result; fail-closed `{image:false,video:false}` if never probed. */
  readiness(): ComfyReadiness
}

/** Health-probe cache TTL and per-request probe timeout (P8-M5). */
const PROBE_TTL_MS = 5_000
const PROBE_TIMEOUT_MS_DEFAULT = 60_000
/**
 * P8-M7 health-gate tuning for the flaky ZeroTier overlay:
 *  - capability (/object_info, ~2.4 MB) is static unless a custom node is
 *    installed, so cache it per endpoint for a long TTL;
 *  - liveness (/system_stats, ~1 KB) is cheap and bounds a hung ping;
 *  - a transient liveness failure within the grace window of the last good
 *    probe fails OPEN (run admitted) instead of 503-ing every submit;
 *  - the ZeroTier-central re-resolve is throttled so a prompt storm does not
 *    hammer the controller API on every run.
 */
const CAPABILITY_TTL_MS = 600_000
const LIVENESS_TIMEOUT_MS = 8_000
const READINESS_GRACE_MS = 120_000
const ENDPOINT_REFRESH_TTL_MS = 60_000

/**
 * Resolve the ComfyUI config from the environment (Phase-8 settings gate).
 * Returns `undefined` unless `DSH_COMFY_BASE_URL` is present.
 * @param env - the process environment (injectable for tests).
 */
export function comfyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ComfyConfig | undefined {
  const base = (env['DSH_COMFY_BASE_URL'] ?? '').trim().replace(/\/+$/, '')
  const ztRef = zerotierRefFromEnv(env)
  if (base === '' && ztRef === undefined) return undefined
  const pool = (env['DSH_COMFY_POOL'] ?? '')
    .split(',')
    .map((entry): string => entry.trim().replace(/\/+$/, ''))
    .filter((entry): boolean => entry !== '')
  const staticEndpoints = [...new Set([...(base === '' ? [] : [base]), ...pool])]
  const token = (env['DSH_COMFY_TOKEN'] ?? '').trim()
  const ztToken = (env['DSH_ZEROTIER_API_TOKEN'] ?? '').trim()
  const pollIntervalMs = Number(env['DSH_COMFY_POLL_MS'] ?? '1500')
  const timeoutMs = Number(env['DSH_COMFY_TIMEOUT_MS'] ?? '900000')
  const inflightMax = Number(env['DSH_COMFY_INFLIGHT_MAX'] ?? '1')
  // Remote H20-class backends answer /object_info with a multi-MB payload over
  // the ZeroTier overlay (~14 s observed); 5 s always died. Env-overridable.
  const probeTimeoutMs = Number(env['DSH_COMFY_PROBE_MS'] ?? String(PROBE_TIMEOUT_MS_DEFAULT))
  // Dynamic remote endpoint: resolve the ZeroTier member's current managed IP
  // at probe time and prepend it to the static endpoints (fail-closed on error).
  const resolveEndpoints = ztRef === undefined ? undefined : async (): Promise<string[]> => {
    const resolved = ztToken === ''
      ? undefined
      : await resolveZerotierBaseUrl(ztRef, ztToken).catch((): undefined => undefined)
    return [...new Set([...(resolved === undefined ? [] : [resolved]), ...staticEndpoints])]
  }
  return {
    endpoints: staticEndpoints,
    ...(resolveEndpoints === undefined ? {} : { resolveEndpoints }),
    token: token === '' ? undefined : token,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 1_500,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900_000,
    inflightMax: Number.isFinite(inflightMax) && inflightMax > 0 ? Math.floor(inflightMax) : 1,
    probeTimeoutMs: Number.isFinite(probeTimeoutMs) && probeTimeoutMs > 0 ? probeTimeoutMs : PROBE_TIMEOUT_MS_DEFAULT,
  }
}

/** Coerce one resolved input value to a non-empty string, or `undefined`. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (Array.isArray(value)) {
    const joined = value.map((entry): string => text(entry) ?? '').filter((entry): boolean => entry !== '').join('\n')
    return joined === '' ? undefined : joined
  }
  return undefined
}

/** Coerce one resolved input value to a finite number, or `undefined`. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Coerce a `models` override payload to a node-id → filename map. */
function modelsOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.trim() !== '') out[key] = entry.trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Wan frame count for a duration in seconds (16 fps, 4n+1 frames). */
function wanFrames(seconds: number): number {
  const raw = Math.min(Math.max(Math.round(seconds * 16), 9), 129)
  return 4 * Math.round((raw - 1) / 4) + 1
}

/** Build the generation prompt from a generator node's resolved inputs. */
function promptOf(inputs: Record<string, unknown>): string {
  const parts: string[] = []
  const resolved = text(inputs['resolved'])
  if (resolved !== undefined) parts.push(resolved)
  const prompt = text(inputs['prompt'])
  if (prompt !== undefined) parts.push(prompt)
  const joined = parts.join('\n\n').trim()
  return joined === '' ? 'a cinematic scene' : joined
}

/** Sleep for a bounded interval (poll spacing). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve): void => { setTimeout(resolve, ms) })
}

/** MIME types for the output extensions ComfyUI save nodes produce. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  flac: 'audio/flac',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
}

function mimeOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** The /prompt submission response envelope. */
interface PromptEnvelope {
  prompt_id?: string
  node_errors?: Record<string, unknown>
  error?: unknown
}

/** One saved output file as reported by /history. */
interface HistoryFile {
  filename?: string
  subfolder?: string
  type?: string
}

/** The /history/{id} entry envelope. */
interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
  outputs?: Record<string, Record<string, unknown>>
}

/** The /upload/image response envelope. */
interface UploadEnvelope {
  name?: string
  subfolder?: string
  type?: string
}

/**
 * Create the local ComfyUI provider (P8-M2..M5).
 * @param config - resolved config (from {@link comfyConfigFromEnv}).
 * @param logger - diagnostics sink.
 * @param templates - the server-held workflow templates (D10).
 */
export function createComfyProvider(
  config: ComfyConfig,
  logger: ComfyProviderLogger,
  templates: ComfyTemplates,
): ComfyProvider {
  const authHeaders = (): Record<string, string> =>
    config.token === undefined ? {} : { 'Authorization': `Bearer ${config.token}` }

  // --- dynamic endpoint resolution (ZeroTier overlay) ----------------------
  let currentEndpoints: string[] = config.endpoints
  // P8-M8: liveness-driven pool sizing. `config.inflightMax` is the CEILING; the
  // effective concurrency cap tracks how many pool endpoints actually answered
  // the last liveness probe, so the fleet self-tunes to 8/4/1 usable cards and
  // self-heals when an instance dies or a new one comes up. One ComfyUI instance
  // == one pinned GPU, so live-endpoint count == usable-card count.
  // `liveEndpoints` is the subset round-robin submits to (dead cards are skipped
  // up front instead of costing a failed submit + failover).
  let liveEndpoints: string[] = []
  let effectiveCap = config.inflightMax
  // P8-M7: throttle the ZeroTier-central re-resolve so a prompt storm does not
  // hammer the controller API (which itself can be slow/blocked in-region).
  let lastEndpointRefresh = 0
  async function refreshEndpoints(force = false): Promise<void> {
    if (config.resolveEndpoints === undefined) return
    if (!force && currentEndpoints.length > 0 && Date.now() - lastEndpointRefresh < ENDPOINT_REFRESH_TTL_MS) return
    lastEndpointRefresh = Date.now()
    try {
      const resolved = await config.resolveEndpoints()
      if (resolved.length > 0) currentEndpoints = resolved
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('[movie-executor] comfy endpoint resolution failed: %s', message)
    }
  }

  // --- in-flight cap (P8-M4): a slot-transferring semaphore -----------------
  let inflight = 0
  const waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error('comfy generation interrupted'))
    if (inflight < effectiveCap) {
      inflight += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject): void => {
      const waiter = { resolve, reject }
      waiters.push(waiter)
      signal?.addEventListener('abort', (): void => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) {
          waiters.splice(index, 1)
          reject(new Error('comfy generation interrupted'))
        }
      }, { once: true })
    })
  }

  function release(): void {
    inflight -= 1
    // P8-M8: hand the freed slot to the next waiter only while still under the
    // effective cap (which may have SHRUNK since admission, e.g. a GPU dropped).
    const next = waiters.shift()
    if (next !== undefined) {
      if (inflight < effectiveCap) {
        inflight += 1
        next.resolve() // hand the slot straight to the next waiter
      } else {
        waiters.unshift(next) // over cap now; a later release/pump will admit it
      }
    }
  }

  /** P8-M8: effective cap = live endpoint count, clamped to [1, ceiling]. */
  function recomputeCap(): void {
    effectiveCap = Math.max(1, Math.min(config.inflightMax, liveEndpoints.length))
  }

  /** P8-M8: admit queued jobs after the cap GROWS (a dropped card came back). */
  function pumpWaiters(): void {
    while (waiters.length > 0 && inflight < effectiveCap) {
      const next = waiters.shift()
      if (next === undefined) break
      inflight += 1
      next.resolve()
    }
  }

  /**
   * P8-M8: drop an endpoint that failed at the NETWORK level mid-run so the next
   * job does not also waste a submit on it. Self-correcting: the next liveness
   * probe (<= PROBE_TTL_MS) re-adds it if it is actually alive.
   */
  function markDead(endpoint: string): void {
    const index = liveEndpoints.indexOf(endpoint)
    if (index < 0) return
    liveEndpoints.splice(index, 1)
    recomputeCap()
    logger.warn('[movie-executor] comfy endpoint unreachable; dropping %s from live pool (%d live, cap %d)', endpoint, liveEndpoints.length, effectiveCap)
  }

  // --- health probe (P8-M5 + P8-M7): liveness split from capability ---------
  // P8-M7: the old gate forced a FULL probe (/system_stats + the 2.4 MB
  // /object_info) on *every* /prompt. Over the flaky overlay that cost ~10-15 s
  // per submit and 503'd whenever a single fetch hiccuped, even though the
  // backend was healthy. Node coverage only changes when a custom node is
  // installed, so it is cached per endpoint; each run gates on a cheap liveness
  // ping, and a transient failure within READINESS_GRACE_MS of the last good
  // probe fails OPEN (the job's own submit/poll — now backed by
  // cancel-on-disconnect — settles a truly-dead backend honestly).
  let lastProbe: { at: number; result: ComfyReadiness } | undefined
  const NOT_READY: ComfyReadiness = { image: false, video: false, audio: false }
  /** Per-endpoint /object_info coverage, cached (static unless nodes change). */
  const capabilityCache = new Map<string, { at: number; result: ComfyReadiness }>()

  /** Cheap reachability ping: true when /system_stats answers 2xx quickly. */
  async function probeLiveness(endpoint: string): Promise<boolean> {
    try {
      const stats = await fetch(`${endpoint}/system_stats`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
      })
      return stats.ok
    } catch {
      return false
    }
  }

  /**
   * Template node coverage from /object_info, cached per endpoint. `force`
   * refreshes (used at activation); otherwise a fresh cache skips the 2.4 MB
   * fetch, and a transient fetch failure keeps the last known coverage.
   */
  async function probeCapability(endpoint: string, force: boolean): Promise<ComfyReadiness> {
    const cached = capabilityCache.get(endpoint)
    if (!force && cached !== undefined && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.result
    try {
      const infoResponse = await fetch(`${endpoint}/object_info`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(config.probeTimeoutMs ?? PROBE_TIMEOUT_MS_DEFAULT),
      })
      if (!infoResponse.ok) return cached?.result ?? NOT_READY
      const objectInfo = (await infoResponse.json()) as Record<string, unknown>
      const result: ComfyReadiness = {
        image: missingNodeTypes(templates.image, objectInfo).length === 0,
        video: missingNodeTypes(templates.video, objectInfo).length === 0,
        audio: templates.audio !== undefined && missingNodeTypes(templates.audio, objectInfo).length === 0,
      }
      capabilityCache.set(endpoint, { at: Date.now(), result })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('[movie-executor] comfy capability probe failed (%s): %s', endpoint, message)
      return cached?.result ?? NOT_READY
    }
  }

  async function probe(force = false): Promise<ComfyReadiness> {
    if (!force && lastProbe !== undefined && Date.now() - lastProbe.at < PROBE_TTL_MS) {
      return lastProbe.result
    }
    await refreshEndpoints(force)
    if (currentEndpoints.length === 0) {
      lastProbe = { at: Date.now(), result: NOT_READY }
      return NOT_READY
    }
    const endpoints = [...currentEndpoints]
    // Cheap liveness across the pool; only a LIVE endpoint pays for (cached)
    // capability, so a dead one never triggers a 2.4 MB fetch.
    const live = await Promise.all(endpoints.map((endpoint): Promise<boolean> => probeLiveness(endpoint)))
    const caps = await Promise.all(endpoints.map((endpoint, index): Promise<ComfyReadiness> =>
      live[index] === true ? probeCapability(endpoint, force) : Promise.resolve(NOT_READY)))
    const result: ComfyReadiness = {
      image: caps.some((entry): boolean => entry.image),
      video: caps.some((entry): boolean => entry.video),
      audio: caps.some((entry): boolean => entry.audio),
    }
    const anyLive = live.some((entry): boolean => entry)
    const ready = result.image || result.video || result.audio
    // P8-M7 fail-open: a transient overlay hiccup (no endpoint answered) within
    // the grace window of a last-good ready probe holds the prior readiness so a
    // healthy-but-momentarily-unreachable backend does not 503 every submit.
    // lastProbe.at is deliberately NOT refreshed, so the grace stays bounded.
    if (!anyLive && !ready && lastProbe !== undefined
        && (lastProbe.result.image || lastProbe.result.video)
        && Date.now() - lastProbe.at < READINESS_GRACE_MS) {
      logger.warn('[movie-executor] comfy liveness hiccup; holding last-good readiness within %dms grace', READINESS_GRACE_MS)
      return lastProbe.result
    }
    // P8-M8: record the live subset so round-robin skips dead cards and the
    // effective concurrency cap self-tunes to the usable-GPU count (8/4/1...).
    // The grace branch above returns early, so a transient TOTAL hiccup keeps the
    // last-good live set and cap instead of collapsing them to zero.
    liveEndpoints = endpoints.filter((_, index): boolean => live[index] === true)
    recomputeCap()
    pumpWaiters()
    lastProbe = { at: Date.now(), result }
    return result
  }

  // --- endpoint pooling: round-robin with submit failover -------------------
  let rrIndex = 0
  function endpointOrder(): string[] {
    // P8-M8: rotate over the LIVE subset so we do not waste a submit + failover
    // on a dead card; fall back to the full candidate list when the live set is
    // empty (e.g. a transient total hiccup inside the fail-open grace window).
    const pool = liveEndpoints.length > 0 ? liveEndpoints : currentEndpoints
    if (pool.length === 0) return []
    const start = rrIndex % pool.length
    rrIndex += 1
    return [...pool.slice(start), ...pool.slice(0, start)]
  }

  function interrupt(endpoint: string): void {
    void fetch(`${endpoint}/interrupt`, { method: 'POST', headers: authHeaders() }).catch((): void => {})
  }

  /** Fetch input-image bytes for img2img (data: URL or http(s) reference). */
  async function inputImageBytes(ref: string): Promise<Uint8Array> {
    if (ref.startsWith('data:')) {
      const comma = ref.indexOf(',')
      const meta = ref.slice(5, comma)
      const payload = ref.slice(comma + 1)
      const raw = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
      return new Uint8Array(raw)
    }
    const response = await fetch(ref, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`comfy img2img input fetch failed: HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Upload input bytes via hand-built multipart (no FormData dependency). */
  async function uploadImage(endpoint: string, bytes: Uint8Array): Promise<string> {
    const boundary = `----dshcomfy${randomUUID()}`
    const filename = 'dsh-input.png'
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    )
    const tail = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`,
    )
    const response = await fetch(`${endpoint}/upload/image`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, Buffer.from(bytes), tail]),
      signal: AbortSignal.timeout(60_000),
    })
    const envelope = (await response.json()) as UploadEnvelope
    if (!response.ok || envelope.name === undefined) {
      throw new Error(`comfy image upload failed: HTTP ${response.status}`)
    }
    const subfolder = envelope.subfolder ?? ''
    return subfolder === '' ? envelope.name : `${subfolder}/${envelope.name}`
  }

  /** Wire an uploaded input image into the image template as img2img. */
  function applyImg2Img(graph: Record<string, ComfyNode>, meta: { ckptNode: string; samplerNode: string; vaeNode?: string }, uploaded: string): void {
    graph['90'] = { class_type: 'LoadImage', inputs: { image: uploaded } }
    const vaeLink: [string, number] = meta.vaeNode !== undefined && graph[meta.vaeNode] !== undefined
      ? [meta.vaeNode, 0]
      : [meta.ckptNode, 2]
    graph['91'] = { class_type: 'VAEEncode', inputs: { pixels: ['90', 0], vae: vaeLink } }
    const sampler = graph[meta.samplerNode]
    if (sampler) {
      sampler.inputs.latent_image = ['91', 0]
      if ('denoise' in sampler.inputs) sampler.inputs.denoise = 0.75
    }
  }

  /** Extract the first saved file from the save node's /history outputs. */
  function savedFileOf(entry: HistoryEntry, saveNode: string): HistoryFile | undefined {
    const outputs = entry.outputs?.[saveNode]
    if (outputs === undefined) return undefined
    for (const key of ['images', 'gifs', 'video', 'audio', 'audios']) {
      const list = outputs[key]
      if (Array.isArray(list)) {
        const first = list.find((item): item is HistoryFile =>
          typeof item === 'object' && item !== null && typeof (item as HistoryFile).filename === 'string')
        if (first !== undefined) return first
      }
    }
    return undefined
  }

  return {
    probe,
    readiness(): ComfyReadiness {
      return lastProbe?.result ?? NOT_READY
    },

    async generate(classType: string, inputs: Record<string, unknown>, hooks?: MediaHooks): Promise<MediaGeneration> {
      // Template variant: explicit `variant` wins; else the widget mode maps
      // VideoGenerator image_to_video → the VACE i2v graph.
      const mode = text(inputs['mode'])
      let hint = text(inputs['variant'])
      if (hint === undefined && classType === 'VideoGenerator') {
        if (mode === 'image_to_video') hint = 'i2v'
        else if (mode === 'text_to_video') hint = 't2v'
      }
      const template = templateFor(classType, templates, hint)
      if (template === undefined) throw new Error(`comfy provider: unsupported step ${classType}`)
      await acquire(hooks?.signal)
      try {
        const params: TemplateParams = { prompt: promptOf(inputs) }
        const negative = text(inputs['negative'])
        if (negative !== undefined) params.negative = negative
        const seed = num(inputs['seed'])
        if (seed !== undefined) params.seed = seed
        const width = num(inputs['width'])
        if (width !== undefined) params.width = width
        const height = num(inputs['height'])
        if (height !== undefined) params.height = height
        const length = num(inputs['length'])
        if (length !== undefined) params.length = length
        const steps = num(inputs['steps'])
        if (steps !== undefined) params.steps = steps
        const seconds = num(inputs['seconds']) ?? num(inputs['duration'])
        if (seconds !== undefined) params.seconds = seconds
        if (template.meta.modality === 'video' && params.length === undefined && seconds !== undefined) {
          params.length = wanFrames(seconds)
        }
        const models = modelsOf(inputs['models'])
        if (models !== undefined) params.models = models
        const graph = instantiate(template, params)

        const clientId = randomUUID()
        const deadline = Date.now() + config.timeoutMs
        let endpoint = ''
        let promptId = ''

        // Optional reference image: img2img on the SDXL graph, or the template's
        // LoadImage node (VACE first frame / InstantID face reference).
        const imageRef = classType === 'ImageGenerator' || classType === 'VideoGenerator' ? text(inputs['image']) : undefined

        // Submit with failover across the pool (P8-M5).
        let submitError = ''
        for (const candidate of endpointOrder()) {
          try {
            if (imageRef !== undefined && (imageRef.startsWith('data:') || /^https?:/i.test(imageRef))) {
              const bytes = await inputImageBytes(imageRef)
              const uploaded = await uploadImage(candidate, bytes)
              const imageNode = template.meta.imageNode
              if (imageNode !== undefined && graph[imageNode] !== undefined) {
                graph[imageNode].inputs.image = uploaded
              } else if (classType === 'ImageGenerator') {
                applyImg2Img(graph, template.meta, uploaded)
              }
            }
            const response = await fetch(`${candidate}/prompt`, {
              method: 'POST',
              headers: { ...authHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: graph, client_id: clientId }),
              signal: AbortSignal.timeout(30_000),
            })
            const envelope = (await response.json()) as PromptEnvelope
            const nodeErrors = envelope.node_errors ?? {}
            if (!response.ok || envelope.prompt_id === undefined || Object.keys(nodeErrors).length > 0) {
              const detail = Object.keys(nodeErrors).length > 0 ? JSON.stringify(nodeErrors) : JSON.stringify(envelope.error ?? {})
              submitError = `HTTP ${response.status} ${detail}`.trim()
              logger.warn('[movie-executor] comfy submit rejected on %s: %s', candidate, submitError)
              continue
            }
            endpoint = candidate
            promptId = envelope.prompt_id
            break
          } catch (error) {
            submitError = error instanceof Error ? error.message : String(error)
            // P8-M8: a network-level failure (not an HTTP rejection) means this
            // card is unreachable right now; drop it from the live pool so the
            // next job skips it. The next liveness probe re-adds it if it recovers.
            markDead(candidate)
          }
        }
        if (promptId === '') throw new Error(`comfy prompt submit failed: ${submitError}`)
        logger.info('[movie-executor] %s comfy job %s submitted to %s', classType, promptId, endpoint)

        // Track progress over /ws; /history polling remains the source of truth.
        let wsError = ''
        let socket: WebSocket | undefined
        try {
          const wsUrl = `${endpoint.replace(/^http/, 'ws')}/ws?clientId=${clientId}`
          socket = new WebSocket(wsUrl, { headers: authHeaders() })
          socket.on('message', (raw): void => {
            try {
              const message = JSON.parse(String(raw)) as { type?: string; data?: Record<string, unknown> }
              if (message.type === 'progress') {
                const value = num(message.data?.['value'])
                const max = num(message.data?.['max'])
                if (value !== undefined && max !== undefined && max > 0) {
                  hooks?.onProgress?.(Math.min(100, Math.round((value / max) * 100)))
                }
              } else if (message.type === 'execution_error') {
                wsError = `comfy execution error: ${JSON.stringify(message.data ?? {})}`
              }
            } catch {
              // Non-JSON ws frames are ignored; polling still completes the job.
            }
          })
          socket.on('error', (): void => {
            // Socket loss is non-fatal: /history polling is the fallback.
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('[movie-executor] comfy ws attach failed (%s): %s — polling only', endpoint, message)
        }

        // Read the abort flag through a predicate so TS control-flow narrowing
        // does not assume it stays false across the `await sleep` below.
        const aborted = (): boolean => hooks?.signal?.aborted === true
        try {
          for (;;) {
            // P8-M6: honour a cancel (client disconnect → registry kill →
            // controller.abort) *before* waiting, so the single in-flight slot
            // frees within milliseconds instead of after the next poll tick.
            // The `timeoutMs` deadline below is only a backstop for a client
            // that stays connected while the backend itself hangs.
            if (aborted()) {
              interrupt(endpoint)
              throw new Error('comfy generation interrupted')
            }
            await sleep(config.pollIntervalMs)
            if (aborted()) {
              interrupt(endpoint)
              throw new Error('comfy generation interrupted')
            }
            if (wsError !== '') throw new Error(wsError)
            if (Date.now() > deadline) {
              interrupt(endpoint)
              throw new Error(`comfy generation timed out after ${config.timeoutMs}ms (job ${promptId})`)
            }
            let entry: HistoryEntry | undefined
            try {
              const response = await fetch(`${endpoint}/history/${promptId}`, {
                headers: authHeaders(),
                signal: AbortSignal.timeout(15_000),
              })
              if (response.ok) {
                const history = (await response.json()) as Record<string, HistoryEntry>
                entry = history[promptId]
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              logger.warn('[movie-executor] comfy history poll failed (job %s): %s', promptId, message)
            }
            if (entry === undefined) continue
            if (entry.status?.status_str === 'error') {
              throw new Error(`comfy generation failed: ${JSON.stringify(entry.status.messages ?? [])}`)
            }
            const file = savedFileOf(entry, template.meta.saveNode)
            if (file?.filename === undefined) continue
            const query = new URLSearchParams({
              filename: file.filename,
              subfolder: file.subfolder ?? '',
              type: file.type ?? 'output',
            })
            const viewUrl = `${endpoint}/view?${query.toString()}`
            const bytesResponse = await fetch(viewUrl, {
              headers: authHeaders(),
              signal: AbortSignal.timeout(120_000),
            })
            if (!bytesResponse.ok) throw new Error(`comfy output fetch failed: HTTP ${bytesResponse.status}`)
            const bytes = new Uint8Array(await bytesResponse.arrayBuffer())
            logger.info('[movie-executor] %s comfy job %s ready (%d bytes)', classType, promptId, bytes.byteLength)
            return {
              artifact: viewUrl,
              media: template.meta.modality,
              bytes,
              filename: file.filename,
              mime: mimeOf(file.filename),
            }
          }
        } finally {
          socket?.close()
        }
      } finally {
        release()
      }
    },
  }
}