/**
 * Phase-8 verifier fixture: a mock ComfyUI backend (P8-M2..M5).
 *
 * Implements the subset of the ComfyUI HTTP/WS surface the provider drives —
 * `/system_stats`, `/object_info`, `/prompt`, `/history/{id}`, `/view`,
 * `/interrupt`, `/upload/image`, and `/ws?clientId=` progress frames — with
 * runtime-toggleable controls so the verifier can exercise health fail-closed,
 * template node coverage, progress, interrupt, timeout, the in-flight cap, and
 * endpoint pooling WITHOUT a GPU or real models.
 *
 * @module scripts/fixture-comfy-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

/**
 * Minimal server→client text-frame encoder (RFC 6455). The fixture only SENDS
 * progress/success frames and never reads client frames, so a full `ws`
 * dependency is unnecessary here (scripts/ cannot resolve the plugin-local
 * `ws` package).
 */
function wsTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8')
  const len = data.byteLength
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

/** A 1×1 PNG the fixture serves as "generated" image bytes. */
export const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
/** Fake mp4 bytes (content matters only for byte-length assertions). */
export const FIXTURE_MP4 = Buffer.from('fixture-mp4-bytes-0123456789')

/** Runtime-toggleable fixture behavior. */
export interface FixtureControls {
  /** When false, /system_stats answers 500 (probe must fail closed). */
  healthy: boolean
  /** Node types withheld from /object_info (template coverage probe). */
  missingNodes: string[]
  /** Milliseconds before a submitted job completes. */
  jobDelayMs: number
  /** When true, jobs never complete (timeout/interrupt tests). */
  hang: boolean
  /** When true, the next job settles with status `error`. */
  fail: boolean
  /** When set, /prompt answers this HTTP status (submit failover tests). */
  promptStatus: number
}

/** One recorded /prompt submission. */
export interface FixturePrompt {
  id: string
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  clientId: string
}

/** The running fixture handle. */
export interface FixtureComfy {
  url: string
  controls: FixtureControls
  prompts: FixturePrompt[]
  interrupts: number
  uploads: number
  /** Peak concurrent in-flight jobs (in-flight cap assertions). */
  maxActive: number
  stop(): Promise<void>
}

/** All node types the bundled image+video templates reference. */
const TEMPLATE_NODE_TYPES = [
  'CheckpointLoaderSimple', 'KSampler', 'EmptyLatentImage', 'CLIPTextEncode',
  'VAEDecode', 'SaveImage', 'CLIPLoader', 'LTXVConditioning',
  'EmptyLTXVLatentVideo', 'ModelSamplingLTXV', 'LTXVScheduler',
  'SamplerCustomAdvanced', 'RandomNoise', 'CFGGuider', 'KSamplerSelect',
  'CreateVideo', 'SaveVideo', 'LoadImage', 'VAEEncode',
]

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject): void => {
    let raw = ''
    req.on('data', (chunk): void => { raw += String(chunk) })
    req.on('end', (): void => { resolve(raw) })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

/**
 * Start one mock ComfyUI endpoint on an ephemeral loopback port.
 * @param overrides - initial control values.
 */
export async function startFixtureComfy(overrides: Partial<FixtureControls> = {}): Promise<FixtureComfy> {
  const controls: FixtureControls = {
    healthy: true,
    missingNodes: [],
    jobDelayMs: 120,
    hang: false,
    fail: false,
    promptStatus: 200,
    ...overrides,
  }
  const prompts: FixturePrompt[] = []
  const history = new Map<string, unknown>()
  const sockets = new Map<string, Duplex>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let interrupts = 0
  let uploads = 0
  let active = 0
  let maxActive = 0
  let counter = 0

  const server: Server = createServer((req, res): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    void (async (): Promise<void> => {
      if (path === '/system_stats') {
        if (!controls.healthy) return json(res, 500, { error: 'unhealthy' })
        return json(res, 200, { system: { os: 'fixture' }, devices: [{ name: 'fixture-gpu', vram_total: 8589934592 }] })
      }
      if (path === '/object_info') {
        const info: Record<string, unknown> = {}
        for (const type of TEMPLATE_NODE_TYPES) {
          if (!controls.missingNodes.includes(type)) info[type] = { input: { required: {} }, output: [] }
        }
        return json(res, 200, info)
      }
      if (path === '/prompt' && req.method === 'POST') {
        if (controls.promptStatus !== 200) return json(res, controls.promptStatus, { error: 'fixture-refused' })
        const body = JSON.parse(await readBody(req)) as { prompt: FixturePrompt['graph']; client_id?: string }
        counter += 1
        const id = `fx-${counter}`
        const clientId = body.client_id ?? ''
        prompts.push({ id, graph: body.prompt, clientId })
        active += 1
        maxActive = Math.max(maxActive, active)
        const saveNode = Object.entries(body.prompt).find(([, node]): boolean =>
          node.class_type === 'SaveImage' || node.class_type === 'SaveVideo')
        const isVideo = saveNode?.[1].class_type === 'SaveVideo'
        const filename = isVideo ? 'dsh-movie-video_00001_.mp4' : 'dsh-movie_00001_.png'
        // Late-bind the ws lookup: the provider opens /ws AFTER the /prompt
        // response, so the socket may not exist yet at submission time.
        const send = (payload: string): void => {
          const socket = sockets.get(clientId)
          if (socket !== undefined && !socket.destroyed) socket.write(wsTextFrame(payload))
        }
        const later = (ms: number, fn: () => void): void => {
          const timer = setTimeout((): void => { timers.delete(timer); fn() }, ms)
          timers.add(timer)
        }
        if (!controls.hang) {
          // Four progress frames spread across the job, then completion.
          for (let step = 1; step <= 4; step += 1) {
            later((controls.jobDelayMs * step) / 5, (): void => {
              send(JSON.stringify({ type: 'progress', data: { value: step, max: 4, prompt_id: id } }))
            })
          }
          later(controls.jobDelayMs, (): void => {
            active -= 1
            const failed = controls.fail
            controls.fail = false
            history.set(id, {
              status: { status_str: failed ? 'error' : 'success', completed: !failed, messages: failed ? [['execution_error', { fixture: true }]] : [] },
              outputs: failed ? {} : {
                [saveNode?.[0] ?? '9']: {
                  [isVideo ? 'video' : 'images']: [{ filename, subfolder: '', type: 'output' }],
                },
              },
            })
            send(JSON.stringify({ type: 'execution_success', data: { prompt_id: id } }))
          })
        }
        return json(res, 200, { prompt_id: id, number: counter })
      }
      if (path.startsWith('/history/')) {
        const id = path.slice('/history/'.length)
        return json(res, 200, history.has(id) ? { [id]: history.get(id) } : {})
      }
      if (path === '/view') {
        const filename = url.searchParams.get('filename') ?? ''
        const bytes = filename.endsWith('.mp4') ? FIXTURE_MP4 : FIXTURE_PNG
        res.writeHead(200, { 'Content-Type': filename.endsWith('.mp4') ? 'video/mp4' : 'image/png' })
        res.end(bytes)
        return
      }
      if (path === '/interrupt' && req.method === 'POST') {
        interrupts += 1
        return json(res, 200, {})
      }
      if (path === '/upload/image' && req.method === 'POST') {
        uploads += 1
        await readBody(req)
        return json(res, 200, { name: 'dsh-input.png', subfolder: '', type: 'input' })
      }
      return json(res, 404, { error: 'not-found' })
    })().catch((error): void => {
      json(res, 500, { error: String(error) })
    })
  })

  server.on('upgrade', (req, socket, head): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    // RFC 6455 handshake; the fixture only writes text frames afterwards.
    const key = req.headers['sec-websocket-key'] ?? ''
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (head.byteLength > 0) socket.unshift(head)
    const clientId = url.searchParams.get('clientId') ?? ''
    sockets.set(clientId, socket)
    socket.on('close', (): void => { sockets.delete(clientId) })
    socket.on('error', (): void => { sockets.delete(clientId) })
    // Client frames are ignored (the provider never sends any); drain them.
    socket.on('data', (): void => {})
  })

  await new Promise<void>((resolve): void => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    controls,
    prompts,
    get interrupts(): number { return interrupts },
    get uploads(): number { return uploads },
    get maxActive(): number { return maxActive },
    async stop(): Promise<void> {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets.values()) socket.destroy()
      await new Promise<void>((resolve): void => { server.close((): void => { resolve() }) })
    },
  } as FixtureComfy
}