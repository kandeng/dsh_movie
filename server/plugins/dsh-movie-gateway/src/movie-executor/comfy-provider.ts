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
  /** Optional bearer token (ComfyUI `--api-key`); never logged. */
  token?: string | undefined
  /** History poll interval while awaiting completion, in milliseconds. */
  pollIntervalMs: number
  /** Overall per-generation timeout, in milliseconds (8 GB envelope: 900 s). */
  timeoutMs: number
  /** Maximum concurrent generations submitted to the backend. */
  inflightMax: number
}

/** Per-modality backend readiness (fail-closed: unknown = not ready). */
export interface ComfyReadiness {
  image: boolean
  video: boolean
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
const PROBE_TIMEOUT_MS = 5_000

/**
 * Resolve the ComfyUI config from the environment (Phase-8 settings gate).
 * Returns `undefined` unless `DSH_COMFY_BASE_URL` is present.
 * @param env - the process environment (injectable for tests).
 */
export function comfyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ComfyConfig | undefined {
  const base = (env['DSH_COMFY_BASE_URL'] ?? '').trim().replace(/\/+$/, '')
  if (base === '') return undefined
  const pool = (env['DSH_COMFY_POOL'] ?? '')
    .split(',')
    .map((entry): string => entry.trim().replace(/\/+$/, ''))
    .filter((entry): boolean => entry !== '')
  const endpoints = [...new Set([base, ...pool])]
  const token = (env['DSH_COMFY_TOKEN'] ?? '').trim()
  const pollIntervalMs = Number(env['DSH_COMFY_POLL_MS'] ?? '1500')
  const timeoutMs = Number(env['DSH_COMFY_TIMEOUT_MS'] ?? '900000')
  const inflightMax = Number(env['DSH_COMFY_INFLIGHT_MAX'] ?? '1')
  return {
    endpoints,
    token: token === '' ? undefined : token,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 1_500,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900_000,
    inflightMax: Number.isFinite(inflightMax) && inflightMax > 0 ? Math.floor(inflightMax) : 1,
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
}

function mimeOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** The /prompt submission response envelope. */
interface PromptEnvelope {
  prompt_id?: string
  node_errors?: Record<string, unknown>
  error?: string
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

  // --- in-flight cap (P8-M4): a slot-transferring semaphore -----------------
  let inflight = 0
  const waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error('comfy generation interrupted'))
    if (inflight < config.inflightMax) {
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
    const next = waiters.shift()
    if (next) next.resolve() // hand the slot straight to the next waiter
    else inflight -= 1
  }

  // --- health probe (P8-M5): fail-closed, short TTL -------------------------
  let lastProbe: { at: number; result: ComfyReadiness } | undefined
  const NOT_READY: ComfyReadiness = { image: false, video: false }

  async function probeEndpoint(endpoint: string): Promise<ComfyReadiness> {
    try {
      const stats = await fetch(`${endpoint}/system_stats`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!stats.ok) return NOT_READY
      const infoResponse = await fetch(`${endpoint}/object_info`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!infoResponse.ok) return NOT_READY
      const objectInfo = (await infoResponse.json()) as Record<string, unknown>
      return {
        image: missingNodeTypes(templates.image, objectInfo).length === 0,
        video: missingNodeTypes(templates.video, objectInfo).length === 0,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('[movie-executor] comfy probe failed (%s): %s', endpoint, message)
      return NOT_READY
    }
  }

  async function probe(force = false): Promise<ComfyReadiness> {
    if (!force && lastProbe !== undefined && Date.now() - lastProbe.at < PROBE_TTL_MS) {
      return lastProbe.result
    }
    const results = await Promise.all(config.endpoints.map((endpoint): Promise<ComfyReadiness> => probeEndpoint(endpoint)))
    const result: ComfyReadiness = {
      image: results.some((entry): boolean => entry.image),
      video: results.some((entry): boolean => entry.video),
    }
    lastProbe = { at: Date.now(), result }
    return result
  }

  // --- endpoint pooling: round-robin with submit failover -------------------
  let rrIndex = 0
  function endpointOrder(): string[] {
    const start = rrIndex % config.endpoints.length
    rrIndex += 1
    return [...config.endpoints.slice(start), ...config.endpoints.slice(0, start)]
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
  function applyImg2Img(graph: Record<string, ComfyNode>, ckptNode: string, samplerNode: string, uploaded: string): void {
    graph['90'] = { class_type: 'LoadImage', inputs: { image: uploaded } }
    graph['91'] = { class_type: 'VAEEncode', inputs: { pixels: ['90', 0], vae: [ckptNode, 2] } }
    const sampler = graph[samplerNode]
    if (sampler) {
      sampler.inputs.latent_image = ['91', 0]
      if ('denoise' in sampler.inputs) sampler.inputs.denoise = 0.75
    }
  }

  /** Extract the first saved file from the save node's /history outputs. */
  function savedFileOf(entry: HistoryEntry, saveNode: string): HistoryFile | undefined {
    const outputs = entry.outputs?.[saveNode]
    if (outputs === undefined) return undefined
    for (const key of ['images', 'gifs', 'video']) {
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
      const template = templateFor(classType, templates)
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
        const graph = instantiate(template, params)

        const clientId = randomUUID()
        const deadline = Date.now() + config.timeoutMs
        let endpoint = ''
        let promptId = ''

        // Optional img2img: an image reference on an ImageGenerator step.
        const imageRef = classType === 'ImageGenerator' ? text(inputs['image']) : undefined

        // Submit with failover across the pool (P8-M5).
        let submitError = ''
        for (const candidate of endpointOrder()) {
          try {
            if (imageRef !== undefined && (imageRef.startsWith('data:') || /^https?:/i.test(imageRef))) {
              const bytes = await inputImageBytes(imageRef)
              const uploaded = await uploadImage(candidate, bytes)
              applyImg2Img(graph, template.meta.ckptNode, template.meta.samplerNode, uploaded)
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
              submitError = `HTTP ${response.status} ${envelope.error ?? JSON.stringify(nodeErrors)}`.trim()
              continue
            }
            endpoint = candidate
            promptId = envelope.prompt_id
            break
          } catch (error) {
            submitError = error instanceof Error ? error.message : String(error)
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

        try {
          for (;;) {
            await sleep(config.pollIntervalMs)
            if (hooks?.signal?.aborted === true) {
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