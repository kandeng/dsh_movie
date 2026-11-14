/**
 * Phase-5 D15 video-generation seam — Bailian "Happyhorse" (DashScope synthesis).
 *
 * dsh_movie's only video model is Bailian's "Happyhorse" synthesis model, reached
 * over HTTPS through the DashScope async video-synthesis API (no GPU/model code
 * on the DSH host). The call is create-task → poll-task:
 *
 *   POST {baseUrl}/services/aigc/video-generation/video-synthesis
 *        header `X-DashScope-Async: enable`, `Authorization: Bearer <key>`
 *        body   `{ model, input: { prompt, img_url? }, parameters: { audio } }`
 *        →      `{ output: { task_id } }`
 *   GET  {baseUrl}/tasks/{task_id}
 *        →      `{ output: { task_status, video_url?, message? } }`
 *
 * Native audio (D15 / "Video Native Audio Strategy"): `audio: true` asks the
 * model to render synchronized diegetic sound into the mp4 by default; it stays
 * editable per-deployment via env without a code change.
 *
 * The provider is **config-gated**: {@link videoConfigFromEnv} returns
 * `undefined` unless a video model + key are present, so today (no Happyhorse
 * endpoint configured) the D15 availability gate marks video `unavailable` and
 * this provider is never constructed. Wiring Happyhorse is therefore a
 * settings/env change, not a code change.
 *
 * @module dsh-movie-gateway/movie-executor/video-provider
 */

import type { MediaGeneration, MediaProvider } from './media-provider.ts'

/** Minimal diagnostics sink (matches `ctx.logger`). */
export interface VideoProviderLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The resolved configuration for one Bailian video model. */
export interface VideoModelConfig {
  /** DashScope-compatible API base URL (no trailing slash). */
  baseUrl: string
  /** The bearer API key (resolved from env; never logged). */
  apiKey: string
  /** The video model id (e.g. `happyhorse`). */
  model: string
  /** Whether to request synchronized native audio in the mp4 (D15). */
  audio: boolean
  /** Poll interval while awaiting task completion, in milliseconds. */
  pollIntervalMs: number
  /** Overall timeout while awaiting task completion, in milliseconds. */
  timeoutMs: number
}

/** The default DashScope video-synthesis base URL. */
const DEFAULT_VIDEO_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'

/**
 * Resolve the video-model config from the environment (D15 settings gate).
 * Video is `available` only when a model id AND a key are present.
 * @param env - the process environment (injectable for tests).
 * @returns the config, or `undefined` when no video model is configured.
 */
export function videoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VideoModelConfig | undefined {
  const model = (env['DSH_VIDEO_MODEL'] ?? '').trim()
  const apiKey = (env['DSH_VIDEO_API_KEY'] ?? env['BAILIAN_API_KEY'] ?? '').trim()
  if (model === '' || apiKey === '') return undefined
  const baseUrl = (env['DSH_VIDEO_BASE_URL'] ?? DEFAULT_VIDEO_BASE_URL).trim().replace(/\/+$/, '')
  const audio = (env['DSH_VIDEO_AUDIO'] ?? 'true').trim().toLowerCase() !== 'false'
  const pollIntervalMs = Number(env['DSH_VIDEO_POLL_MS'] ?? '3000')
  const timeoutMs = Number(env['DSH_VIDEO_TIMEOUT_MS'] ?? '300000')
  return {
    baseUrl,
    apiKey,
    model,
    audio,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 3000,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000,
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

/** Build the synthesis prompt from a generator node's resolved inputs. */
function promptOf(inputs: Record<string, unknown>): string {
  const parts: string[] = []
  const resolved = text(inputs['resolved'])
  if (resolved !== undefined) parts.push(resolved)
  const prompt = text(inputs['prompt'])
  if (prompt !== undefined) parts.push(prompt)
  const joined = parts.join('\n\n').trim()
  return joined === '' ? 'a short cinematic clip' : joined
}

/** Sleep for a bounded interval (poll spacing). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve): void => { setTimeout(resolve, ms) })
}

/** The DashScope async-task envelope shapes this provider reads. */
interface TaskEnvelope {
  output?: { task_id?: string; task_status?: string; video_url?: string; message?: string }
  message?: string
}

/**
 * Create the Bailian "Happyhorse" video provider.
 * @param config - the resolved video-model config (from {@link videoConfigFromEnv}).
 * @param logger - diagnostics sink.
 * @returns a {@link MediaProvider} whose `generate` renders one clip.
 */
export function createVideoProvider(config: VideoModelConfig, logger: VideoProviderLogger): MediaProvider {
  const headers = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable',
  }

  return {
    async generate(classType: string, inputs: Record<string, unknown>): Promise<MediaGeneration> {
      const prompt = promptOf(inputs)
      const imgUrl = text(inputs['image'])
      const body = {
        model: config.model,
        input: { prompt, ...(imgUrl === undefined ? {} : { img_url: imgUrl }) },
        parameters: { audio: config.audio },
      }
      const createUrl = `${config.baseUrl}/services/aigc/video-generation/video-synthesis`
      let taskId: string
      try {
        const response = await fetch(createUrl, { method: 'POST', headers, body: JSON.stringify(body) })
        const envelope = (await response.json()) as TaskEnvelope
        if (!response.ok || envelope.output?.task_id === undefined) {
          throw new Error(`video synthesis create failed: HTTP ${response.status} ${envelope.message ?? envelope.output?.message ?? ''}`.trim())
        }
        taskId = envelope.output.task_id
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[movie-executor] %s video create failed: %s', classType, message)
        throw new Error(`video generation failed: ${message}`)
      }

      const taskUrl = `${config.baseUrl}/tasks/${taskId}`
      const deadline = Date.now() + config.timeoutMs
      for (;;) {
        await sleep(config.pollIntervalMs)
        let envelope: TaskEnvelope
        try {
          const response = await fetch(taskUrl, { method: 'GET', headers: { 'Authorization': headers['Authorization'] } })
          envelope = (await response.json()) as TaskEnvelope
          if (!response.ok) throw new Error(`HTTP ${response.status} ${envelope.message ?? ''}`.trim())
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('[movie-executor] %s video poll failed (task %s): %s', classType, taskId, message)
          throw new Error(`video generation poll failed: ${message}`)
        }
        const status = envelope.output?.task_status ?? ''
        if (status === 'SUCCEEDED') {
          const videoUrl = envelope.output?.video_url ?? ''
          logger.info('[movie-executor] %s video ready (task %s)', classType, taskId)
          return { artifact: videoUrl, media: 'video' }
        }
        if (status === 'FAILED' || status === 'UNKNOWN') {
          throw new Error(`video generation failed: ${envelope.output?.message ?? status}`)
        }
        if (Date.now() > deadline) {
          throw new Error(`video generation timed out after ${config.timeoutMs}ms (task ${taskId}, status ${status})`)
        }
      }
    },
  }
}
