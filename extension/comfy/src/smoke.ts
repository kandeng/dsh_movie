/**
 * Offline/live smoke check for the comfy-remote MCP server's upstream API.
 *
 * Runs WITHOUT the MCP layer: it exercises the same HTTP surface the tools
 * use, against COMFY_REMOTE_BASE_URL (default http://10.188.8.105:8188, the H20's
 * ZeroTier managed IP). Fail-closed: a down/unreachable upstream exits non-zero
 * with a ZeroTier overlay hint.
 *
 * Usage:
 *   node src/smoke.ts                       # health + catalog only (read-only)
 *   COMFY_SMOKE_PROMPT=1 node src/smoke.ts  # + model-free LoadImage→SaveImage E2E
 *
 * @module extension/comfy/src/smoke
 */

import { randomUUID } from 'node:crypto'

const BASE_URL = (process.env['COMFY_REMOTE_BASE_URL'] ?? 'http://10.188.8.105:8188').replace(/\/+$/, '')
const TOKEN = (process.env['COMFY_REMOTE_TOKEN'] ?? '').trim()

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

async function get(path: string, timeoutMs = 8_000): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: TOKEN === '' ? {} : { 'Authorization': `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** 1×1 red PNG, base64 (model-free E2E input). */
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function main(): Promise<void> {
  process.stdout.write(`comfy-remote smoke → upstream ${BASE_URL}\n`)

  // 1. health
  let healthy = false
  try {
    const response = await get('/system_stats')
    healthy = response.ok
    const stats = (await response.json()) as { system?: { comfyui_version?: string }; devices?: unknown[] }
    check('GET /system_stats 200', healthy,
      `ComfyUI ${stats.system?.comfyui_version ?? '?'}, ${Array.isArray(stats.devices) ? stats.devices.length : '?'} device(s)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check('GET /system_stats 200', false, message)
    process.stdout.write(`\nHint: is the ZeroTier overlay up on BOTH ends?\n` +
      `  local:  zerotier-cli listnetworks   (managed IP must show OK; join via extension/zerotier/zt_install.sh)\n` +
      `  H20:    zerotier-cli listnetworks   (expect yw01 / 10.188.8.105 authorized)\n`)
    process.exit(1)
  }
  if (!healthy) process.exit(1)

  // 2. catalog
  try {
    const response = await get('/model_catalog')
    check('GET /model_catalog 200', response.ok, `HTTP ${response.status}`)
    if (response.ok) {
      const catalog = (await response.json()) as { models?: unknown[] } | unknown[]
      const entries = Array.isArray(catalog) ? catalog : (catalog.models ?? [])
      check('catalog non-empty', entries.length > 0, `${entries.length} entries`)
      const first = entries[0] as Record<string, unknown> | undefined
      check('entry carries description', first !== undefined && typeof first['description'] === 'string',
        first?.['id'] === undefined ? '' : `e.g. ${String(first['id'])}`)
    }
  } catch (error) {
    check('GET /model_catalog 200', false, error instanceof Error ? error.message : String(error))
  }
  try {
    const response = await get('/model_catalog/categories')
    check('GET /model_catalog/categories 200', response.ok, `HTTP ${response.status}`)
  } catch (error) {
    check('GET /model_catalog/categories 200', false, error instanceof Error ? error.message : String(error))
  }

  // 3. optional model-free E2E: upload → LoadImage → SaveImage → /view bytes
  if (process.env['COMFY_SMOKE_PROMPT'] === '1') {
    try {
      const boundary = `----smoke${randomUUID()}`
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="smoke-pixel.png"\r\nContent-Type: application/octet-stream\r\n\r\n`)
      const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`)
      const upload = await fetch(`${BASE_URL}/upload/image`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat([head, Buffer.from(PIXEL_PNG_BASE64, 'base64'), tail]),
        signal: AbortSignal.timeout(30_000),
      })
      const uploaded = (await upload.json()) as { name?: string }
      check('POST /upload/image', upload.ok && uploaded.name !== undefined, uploaded.name ?? `HTTP ${upload.status}`)

      const clientId = randomUUID()
      const graph = {
        '1': { class_type: 'LoadImage', inputs: { image: uploaded.name ?? 'smoke-pixel.png' } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'smoke' } },
      }
      const submit = await fetch(`${BASE_URL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
        signal: AbortSignal.timeout(30_000),
      })
      const envelope = (await submit.json()) as { prompt_id?: string; node_errors?: object }
      check('POST /prompt accepted', submit.ok && envelope.prompt_id !== undefined,
        envelope.prompt_id ?? JSON.stringify(envelope.node_errors ?? {}))

      if (envelope.prompt_id !== undefined) {
        let saved: { filename: string; subfolder?: string; type?: string } | undefined
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline && saved === undefined) {
          await new Promise((resolve): void => { setTimeout(resolve, 1_500) })
          const history = await get(`/history/${envelope.prompt_id}`, 15_000)
          if (!history.ok) continue
          const entry = ((await history.json()) as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> }>)[envelope.prompt_id]
          const images = entry?.outputs?.['2']?.images
          if (Array.isArray(images) && images.length > 0) saved = images[0]
        }
        check('job produced SaveImage output', saved !== undefined, saved?.filename ?? 'timeout')
        if (saved !== undefined) {
          const view = await get(`/view?${new URLSearchParams({ filename: saved.filename, subfolder: saved.subfolder ?? '', type: saved.type ?? 'output' }).toString()}`, 30_000)
          const bytes = await view.arrayBuffer()
          check('GET /view returns bytes', view.ok && bytes.byteLength > 0, `${bytes.byteLength} bytes`)
        }
      }
    } catch (error) {
      check('model-free E2E', false, error instanceof Error ? error.message : String(error))
    }
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
