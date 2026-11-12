/**
 * The Leg B/C gateway server: one loopback `node:http` server plus two
 * `noServer` WebSocket endpoints, generalizing the Phase-1 `/auth` listener.
 *
 * Surfaces:
 * - Leg C (JSON-RPC over HTTP): `POST /api/<ns>/<method>` dispatched through
 *   `@dsh-movie/protocol`'s {@link methodFromApiPath}. Every call presents the
 *   caller's Matrix access token (`Authorization: Bearer`, or a `token` body
 *   field) which the host maps to a {@link Principal} via `ctx.matrixIdentity`.
 *   `assets/list` is gated on the `host` room seat to prove the role policy.
 * - Leg C (stream mux over WS): `/api/ws` carries {@link StreamFrame}s keyed by
 *   a logical `stream` id; `open` on channel `leg-b/exec` replays the canned
 *   lifecycle as data frames, anything else errors `unimplemented` (M1 stub).
 * - Leg B (ComfyUI subset over HTTP): `GET /object_info`, `/system_stats`,
 *   `/queue`, `/history`, and `POST /prompt` which assigns an execution id and
 *   drives the lifecycle socket. No Python/model code runs on the host.
 * - Leg B (execution lifecycle over WS): `/ws` sends `status` on connect and
 *   broadcasts the {@link cannedLifecycle} for each submitted prompt.
 *
 * This is a local development prototype: it binds loopback only and answers CORS
 * with `*`. Production front-names it behind Caddy and tightens the origin; the
 * endpoint contract stays the same.
 *
 * @module dsh-movie-gateway/gateway-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve as resolvePath } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  ApiError,
  ApiErrorCode,
  ApiOk,
  ApiResult,
  ExecMessage,
  LegCMethod,
  LegCResponse,
  Principal,
  PromptGraph,
  StreamControl,
  StreamFrame,
  StreamOpen,
} from '@dsh-movie/protocol'
import { IMPLEMENTED_METHODS, methodFromApiPath, buildObjectInfo } from '@dsh-movie/protocol'
import type { MatrixIdentity, MatrixPrincipal } from 'dsh-matrix-identity/types'
import {
  CANNED_ASSETS,
  CANNED_OBJECT_INFO,
  CANNED_REGISTRY,
  CANNED_SYSTEM_STATS,
  cannedLifecycle,
  nodeIdsOf,
} from './fixtures.ts'
import type { MovieGatewayInfo } from './types.ts'

/** Diagnostics sink the gateway writes to (matches `ctx.logger`). */
export interface GatewayLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** What the gateway needs: where to bind and how to introspect tokens. */
export interface GatewayServerDeps {
  /** Loopback TCP port to bind. */
  port: number
  /** The identity service used to introspect tokens and resolve room roles. */
  identity: MatrixIdentity
  /** Diagnostics sink. */
  logger: GatewayLogger
  /**
   * Directory holding the pinned ComfyUI frontend build, served same-origin at
   * `/comfy/` (Phase-2 M5). When unset, `/comfy/` answers 503 so the Studio
   * canvas can show a clear "frontend not fetched" state instead of a blank 404.
   */
  staticDir?: string | undefined
  /**
   * Absolute path to the bridge extension JS we own, served at
   * `/comfy/extensions/dsh-movie-bridge.js` and listed by `/comfy/api/extensions`.
   */
  bridgeExtensionFile?: string | undefined
}

/** A running gateway: introspection plus a reversible stop. */
export interface GatewayHandle {
  /** Whether the HTTP/WS server is currently listening. */
  isListening(): boolean
  /** The loopback coordinates the gateway is serving on. */
  info(): MovieGatewayInfo
  /** Stop listening, terminate sockets, and release the port. */
  stop(): Promise<void>
}

/** Bound the request body so a hostile client cannot exhaust memory. */
const MAX_BODY_BYTES = 65_536

/** MIME type by lowercase file extension for the `/comfy/` static route. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * The URL the frontend imports for our bridge extension, listed by
 * `/comfy/api/extensions`. The pinned frontend resolves each entry with
 * `fileURL(e) = api_base + e`, where `api_base` is `/comfy` for a subpath
 * deployment, so we advertise an api_base-relative path (leading slash, NO
 * `/comfy` prefix). That yields the final `/comfy/extensions/dsh-movie-bridge.js`
 * we serve below. Returning the absolute `/comfy/...` form would double the
 * prefix (`/comfy/comfy/...` -> 404 -> a vite preloadError that aborts
 * `app.setup()`, leaving node defs and the bridge unregistered).
 */
const BRIDGE_EXTENSION_URL = '/extensions/dsh-movie-bridge.js'

/** HTTP status each Leg C error code maps to. */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  'bad-request': 400,
  'missing-token': 400,
  'invalid-token': 401,
  'forbidden': 403,
  'not-found': 404,
  'unimplemented': 501,
  'internal': 500,
}

/** Attach permissive dev CORS headers (loopback prototype; tightened in prod). */
function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

/** Send an arbitrary JSON payload with CORS headers applied. */
function sendRaw(res: ServerResponse, status: number, payload: unknown): void {
  applyCors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Wrap a successful Leg C result. */
function ok<R>(result: R): ApiOk<R> {
  return { ok: true, result }
}

/** Wrap a failed Leg C result. */
function err(code: ApiErrorCode, message: string): ApiError {
  return { ok: false, error: { code, message } }
}

/** Send a Leg C {@link ApiResult}, deriving the HTTP status from its tag. */
function sendApi(res: ServerResponse, result: ApiResult<unknown>): void {
  const status = result.ok ? 200 : STATUS_BY_CODE[result.error.code]
  sendRaw(res, status, result)
}

/** Read a length-bounded request body as UTF-8 text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** Parse a request body into a JSON object (empty object when blank/invalid shape). */
async function readParams(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

/** Extract a non-empty string param, or `undefined`. */
function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Extract the bearer token from the `Authorization` header, if present. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const token = match?.[1]?.trim()
  return token !== undefined && token.length > 0 ? token : undefined
}

/** Map the identity plugin's principal onto the protocol's wire shape. */
function toPrincipal(principal: MatrixPrincipal): Principal {
  return {
    userId: principal.userId,
    localpart: principal.localpart,
    serverName: principal.serverName,
    deviceId: principal.deviceId,
  }
}

/**
 * Start the loopback Leg B/C gateway. The returned handle is stopped by the
 * plugin's reversible effect teardown.
 * @param deps - bind port, identity service, and logger.
 * @returns the running gateway handle.
 */
export function startGatewayServer(deps: GatewayServerDeps): GatewayHandle {
  const { port, identity, logger, staticDir, bridgeExtensionFile } = deps
  const execClients = new Set<WebSocket>()
  let queueCounter = 0
  let listening = false

  /** Send one lifecycle message to a socket when it is open. */
  function sendExec(socket: WebSocket, message: ExecMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  /** Broadcast a lifecycle sequence to every connected `/ws` client. */
  function broadcastExec(messages: ExecMessage[]): void {
    for (const client of execClients) {
      for (const message of messages) sendExec(client, message)
    }
  }

  /** Send one mux frame to a socket when it is open. */
  function sendFrame(socket: WebSocket, frame: StreamFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  /* ---------------------------- Leg C dispatch --------------------------- */

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'POST') {
      sendApi(res, err('bad-request', 'Leg C methods are POST /api/<ns>/<method>'))
      return
    }
    const method: LegCMethod | null = methodFromApiPath(pathname)
    if (method === null) {
      sendApi(res, err('not-found', `malformed api path: ${pathname}`))
      return
    }
    if (!IMPLEMENTED_METHODS.includes(method)) {
      sendApi(res, err('unimplemented', `${method} is not implemented in M1`))
      return
    }

    let params: Record<string, unknown>
    try {
      params = await readParams(req)
    } catch (error) {
      logger.warn('[movie-gateway] %s bad body: %s', method, String(error))
      sendApi(res, err('bad-request', 'invalid JSON body'))
      return
    }

    const token = bearerToken(req) ?? stringParam(params, 'token')
    if (token === undefined) {
      sendApi(res, err('missing-token', 'a Matrix access token is required'))
      return
    }
    const principal = await identity.whoami(token)
    if (principal === null) {
      sendApi(res, err('invalid-token', 'the Matrix access token was rejected'))
      return
    }

    switch (method) {
      case 'auth/principal': {
        const payload: LegCResponse<'auth/principal'> = {
          principal: toPrincipal(principal),
          principalId: identity.principalId(principal.userId),
        }
        sendApi(res, ok(payload))
        return
      }
      case 'auth/role': {
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        const payload: LegCResponse<'auth/role'> = { role }
        sendApi(res, ok(payload))
        return
      }
      case 'registry/list': {
        const kind = stringParam(params, 'kind')
        const entries = kind === undefined
          ? [...CANNED_REGISTRY]
          : CANNED_REGISTRY.filter((entry): boolean => entry.kind === kind)
        const payload: LegCResponse<'registry/list'> = { entries }
        sendApi(res, ok(payload))
        return
      }
      case 'registry/get': {
        const id = stringParam(params, 'id')
        if (id === undefined) {
          sendApi(res, err('bad-request', 'id is required'))
          return
        }
        const entry = CANNED_REGISTRY.find((candidate): boolean => candidate.id === id) ?? null
        const payload: LegCResponse<'registry/get'> = { entry }
        sendApi(res, ok(payload))
        return
      }
      case 'assets/list': {
        // M1 stub policy: the asset repository is host-gated. A caller must hold
        // the `host` seat in the given room; members and non-members are refused
        // (fail-closed), proving the roomRole policy over the wire.
        const roomId = stringParam(params, 'roomId')
        if (roomId === undefined) {
          sendApi(res, err('bad-request', 'roomId is required'))
          return
        }
        const role = await identity.roomRole(roomId, principal.userId)
        if (role !== 'host') {
          sendApi(res, err('forbidden', `role "${role}" may not list assets; host seat required`))
          return
        }
        const payload: LegCResponse<'assets/list'> = { assets: [...CANNED_ASSETS] }
        sendApi(res, ok(payload))
        return
      }
      case 'assets/get': {
        const id = stringParam(params, 'id')
        if (id === undefined) {
          sendApi(res, err('bad-request', 'id is required'))
          return
        }
        const asset = CANNED_ASSETS.find((candidate): boolean => candidate.id === id) ?? null
        const payload: LegCResponse<'assets/get'> = { asset }
        sendApi(res, ok(payload))
        return
      }
      default:
        sendApi(res, err('unimplemented', `${method} is not implemented in M1`))
        return
    }
  }

  /* ----------------------------- Leg B routes ---------------------------- */

  async function handleLegB(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET' && pathname === '/health') {
      sendRaw(res, 200, { ok: true })
      return
    }
    if (method === 'GET' && pathname === '/object_info') {
      sendRaw(res, 200, CANNED_OBJECT_INFO)
      return
    }
    if (method === 'GET' && pathname === '/system_stats') {
      sendRaw(res, 200, CANNED_SYSTEM_STATS)
      return
    }
    if (pathname === '/queue') {
      sendRaw(res, 200, { queue_running: [], queue_pending: [] })
      return
    }
    if (pathname === '/history') {
      sendRaw(res, 200, {})
      return
    }
    if (method === 'POST' && pathname === '/prompt') {
      let prompt: PromptGraph
      try {
        const params = await readParams(req)
        const raw = params['prompt']
        if (typeof raw !== 'object' || raw === null) {
          sendRaw(res, 400, { error: 'bad-request', message: 'prompt graph is required' })
          return
        }
        prompt = raw as PromptGraph
      } catch (error) {
        logger.warn('[movie-gateway] /prompt bad body: %s', String(error))
        sendRaw(res, 400, { error: 'bad-request', message: 'invalid JSON body' })
        return
      }
      const promptId = randomUUID()
      const number = ++queueCounter
      const lifecycle = cannedLifecycle(promptId, number, nodeIdsOf(prompt))
      // Drive the lifecycle socket first so a client already connected on `/ws`
      // observes the full sequence for this prompt id.
      broadcastExec(lifecycle)
      sendRaw(res, 200, { prompt_id: promptId, number })
      return
    }
    sendRaw(res, 404, { error: 'not-found' })
  }

  /* --------------------- ComfyUI frontend (/comfy/*) --------------------- */

  /** Accept a prompt graph and drive the shared execution-lifecycle socket. */
  async function submitPrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let prompt: PromptGraph
    try {
      const params = await readParams(req)
      const raw = params['prompt']
      if (typeof raw !== 'object' || raw === null) {
        sendRaw(res, 400, { error: 'bad-request', message: 'prompt graph is required' })
        return
      }
      prompt = raw as PromptGraph
    } catch (error) {
      logger.warn('[movie-gateway] /prompt bad body: %s', String(error))
      sendRaw(res, 400, { error: 'bad-request', message: 'invalid JSON body' })
      return
    }
    const promptId = randomUUID()
    const number = ++queueCounter
    broadcastExec(cannedLifecycle(promptId, number, nodeIdsOf(prompt)))
    sendRaw(res, 200, { prompt_id: promptId, number })
  }

  /** Stream a file from disk with a MIME type, or 404 when absent. */
  function sendFile(res: ServerResponse, filePath: string): void {
    let isFile = false
    try {
      isFile = statSync(filePath).isFile()
    } catch {
      isFile = false
    }
    if (!isFile) {
      sendRaw(res, 404, { error: 'not-found' })
      return
    }
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    applyCors(res)
    res.writeHead(200, { 'Content-Type': type })
    createReadStream(filePath).pipe(res)
  }

  /**
   * The minimal ComfyUI backend-protocol subset the pinned frontend demands on
   * boot, served under `/comfy/api/*` (the frontend prefixes every REST call with
   * `{api_base}/api`, where `api_base` is `/comfy`). Optional cloud/agent/hub
   * features answer with empty defaults; unknown calls are logged and 404 so the
   * E2E pass reveals any remaining boot gap.
   */
  async function handleComfyApi(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (endpoint === '/prompt') {
      if (method === 'POST') await submitPrompt(req, res)
      else sendRaw(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (method !== 'GET' && method !== 'POST') {
      sendRaw(res, 405, { error: 'method-not-allowed' })
      return
    }
    switch (endpoint) {
      case '/object_info': sendRaw(res, 200, buildObjectInfo()); return
      case '/system_stats': sendRaw(res, 200, CANNED_SYSTEM_STATS); return
      case '/extensions': sendRaw(res, 200, [BRIDGE_EXTENSION_URL]); return
      case '/queue': sendRaw(res, 200, { queue_running: [], queue_pending: [] }); return
      case '/history': sendRaw(res, 200, {}); return
      case '/settings': sendRaw(res, 200, {}); return
      case '/userdata': sendRaw(res, 200, []); return
      case '/user': sendRaw(res, 200, {}); return
      case '/users': sendRaw(res, 200, {}); return
      case '/i18n': sendRaw(res, 200, {}); return
      case '/features': sendRaw(res, 200, {}); return
      case '/node_replacements': sendRaw(res, 200, []); return
      case '/global_subgraphs': sendRaw(res, 200, []); return
      case '/folder_paths': sendRaw(res, 200, {}); return
      case '/workflow_templates': sendRaw(res, 200, []); return
      // The pinned frontend derives the queue FROM the Jobs API (`fetchQueue`
      // calls `fetchJobsRaw`), zod-parsing `{ jobs, pagination: { total, offset,
      // limit, has_more } }`. An empty-but-well-shaped answer silences both the
      // Jobs and "Failed to fetch queue" console errors.
      case '/jobs': sendRaw(res, 200, { jobs: [], pagination: { total: 0, offset: 0, limit: 200, has_more: false } }); return
      default: break
    }
    // A single job detail (`/jobs/{id}`) has no history in this prototype.
    if (endpoint.startsWith('/jobs/')) {
      sendRaw(res, 200, {})
      return
    }
    // Prefix families that must answer with benign empties to let boot proceed.
    if (endpoint.startsWith('/settings/')
      || endpoint.startsWith('/models')
      || endpoint.startsWith('/templates')
      || endpoint.startsWith('/embeddings')
      || endpoint.startsWith('/workflow_templates/')) {
      sendRaw(res, 200, [])
      return
    }
    if (endpoint.startsWith('/userdata/')) {
      if (method === 'POST') { sendRaw(res, 200, { ok: true }); return }
      sendRaw(res, 404, { error: 'not-found' })
      return
    }
    logger.warn('[movie-gateway] unhandled comfy api: %s %s', method, endpoint)
    sendRaw(res, 404, { error: 'not-found', endpoint })
  }

  /** Serve the pinned frontend build (and our bridge extension) under `/comfy/`. */
  function handleComfyStatic(res: ServerResponse, subPath: string): void {
    if (subPath === 'extensions/dsh-movie-bridge.js') {
      if (bridgeExtensionFile === undefined) { sendRaw(res, 404, { error: 'bridge-not-configured' }); return }
      sendFile(res, bridgeExtensionFile)
      return
    }
    if (staticDir === undefined) {
      sendRaw(res, 503, { error: 'comfy-frontend-not-fetched', hint: 'run server/scripts/fetch-comfy-frontend.ts' })
      return
    }
    const rel = subPath === '' ? 'index.html' : subPath
    const root = resolvePath(staticDir)
    const full = resolvePath(root, normalize(rel))
    if (full !== root && !full.startsWith(root + '/')) {
      sendRaw(res, 403, { error: 'forbidden' })
      return
    }
    if (existsSync(full) && statSync(full).isDirectory()) {
      sendFile(res, join(full, 'index.html'))
      return
    }
    sendFile(res, full)
  }

  /** Route a `/comfy/*` request to the API subset or the static build. */
  async function handleComfy(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const sub = pathname.slice('/comfy'.length)
    if (sub === '/api' || sub.startsWith('/api/')) {
      await handleComfyApi(req, res, sub.slice('/api'.length) || '/')
      return
    }
    handleComfyStatic(res, sub.replace(/^\//, ''))
  }

  /* ------------------------------ HTTP router ---------------------------- */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'OPTIONS') {
      applyCors(res)
      res.writeHead(204)
      res.end()
      return
    }
    if (pathname === '/comfy' || pathname.startsWith('/comfy/')) {
      await handleComfy(req, res, pathname)
      return
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname)
      return
    }
    await handleLegB(req, res, pathname)
  }

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.warn('[movie-gateway] handler failed: %s', String(error))
      if (!res.headersSent) sendApi(res, err('internal', 'gateway handler failed'))
      else res.end()
    })
  })

  /* --------------------------- WebSocket endpoints ----------------------- */

  const execWs = new WebSocketServer({ noServer: true })
  const muxWs = new WebSocketServer({ noServer: true })

  execWs.on('connection', (socket: WebSocket) => {
    execClients.add(socket)
    socket.on('close', () => execClients.delete(socket))
    socket.on('error', () => execClients.delete(socket))
    sendExec(socket, { type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } })
  })

  muxWs.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: RawData) => {
      let control: StreamControl
      try {
        control = JSON.parse(raw.toString()) as StreamControl
      } catch {
        sendFrame(socket, { stream: '', type: 'error', payload: { code: 'bad-request', message: 'invalid JSON frame' } })
        return
      }
      if (control.op === 'open') {
        const open = control as StreamOpen
        const stream = open.stream
        if (open.channel === 'leg-b/exec') {
          const promptId = randomUUID()
          const params = open.params
          const requested = params?.['nodeIds']
          const nodeIds = Array.isArray(requested)
            ? requested.filter((id): id is string => typeof id === 'string')
            : ['1']
          for (const message of cannedLifecycle(promptId, 1, nodeIds)) {
            sendFrame(socket, { stream, type: 'data', payload: message })
          }
          sendFrame(socket, { stream, type: 'end' })
        } else {
          sendFrame(socket, { stream, type: 'error', payload: { code: 'unimplemented', message: `channel "${open.channel}" is not implemented in M1` } })
        }
        return
      }
      if (control.op === 'close') {
        sendFrame(socket, { stream: control.stream, type: 'end' })
      }
    })
  })

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (pathname === '/ws' || pathname === '/comfy/ws') {
      execWs.handleUpgrade(req, socket, head, (ws: WebSocket) => execWs.emit('connection', ws, req))
      return
    }
    if (pathname === '/api/ws') {
      muxWs.handleUpgrade(req, socket, head, (ws: WebSocket) => muxWs.emit('connection', ws, req))
      return
    }
    socket.destroy()
  })

  httpServer.on('close', () => {
    listening = false
  })
  httpServer.listen(port, '127.0.0.1', () => {
    listening = true
    logger.info('[movie-gateway] Leg B/C gateway on http://127.0.0.1:%d (exec /ws, mux /api/ws)', port)
  })

  const info: MovieGatewayInfo = {
    port,
    url: `http://127.0.0.1:${port}`,
    execWsUrl: `ws://127.0.0.1:${port}/ws`,
    muxWsUrl: `ws://127.0.0.1:${port}/api/ws`,
  }

  return {
    isListening(): boolean {
      return listening
    },
    info(): MovieGatewayInfo {
      return info
    },
    async stop(): Promise<void> {
      for (const client of execWs.clients) client.terminate()
      for (const client of muxWs.clients) client.terminate()
      execClients.clear()
      await new Promise<void>(resolveClose => execWs.close(() => resolveClose()))
      await new Promise<void>(resolveClose => muxWs.close(() => resolveClose()))
      await new Promise<void>(resolveClose => {
        httpServer.close(() => resolveClose())
        httpServer.closeAllConnections()
      })
      listening = false
    },
  }
}
