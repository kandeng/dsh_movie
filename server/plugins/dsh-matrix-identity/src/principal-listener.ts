/**
 * Plugin-owned `/auth/*` HTTP listener: the Phase-1 Mode-B trust anchor.
 *
 * The design doc (§6, "multi-user remote web trust") flags the browser→host
 * principal establishment as an open question, with the documented fallback of
 * a plugin-owned `/auth/*` HTTP listener. This module is that fallback: a tiny
 * `node:http` server that accepts a Matrix access token from the browser,
 * introspects it through `ctx.matrixIdentity.whoami` (the same cached path the
 * host uses internally), and returns the mapped DSH principal. It proves the
 * end-to-end trust chain — a token Synapse issued to the logged-in browser maps
 * back to the correct principal on the host — without depending on the Typert
 * `@Remote` generation pipeline, which an out-of-tree from-source plugin cannot
 * feed to a custom client.
 *
 * Endpoints:
 * - `GET  /auth/health`    -> `{ ok: true }`
 * - `POST /auth/principal` -> body `{ token }`; `200 { ok, principal, principalId }`
 *                             on a valid token, `401` on an invalid one, `400`
 *                             when the token is missing.
 * - `POST /auth/role`      -> body `{ token, roomId }`; `200 { ok, role }` where
 *                             `role` is the caller's resolved room role
 *                             (`host` | `member` | `none`), `401` on an invalid
 *                             token, `400` when the token or room is missing.
 * - `OPTIONS *`            -> CORS preflight (the Vite dev client is another origin).
 *
 * This is a local development prototype listener: it binds loopback only and
 * answers CORS with `*`. A production deployment front-names it behind Caddy and
 * tightens the allowed origin; the endpoint contract stays the same.
 *
 * @module dsh-matrix-identity/principal-listener
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { MatrixIdentity, MatrixPrincipal, RoomRole } from './types.ts'

/** Diagnostics sink the listener writes to (matches `ctx.logger`). */
export interface PrincipalListenerLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** What the listener needs: where to bind and how to introspect tokens. */
export interface PrincipalListenerDeps {
  /** Loopback TCP port to bind. */
  port: number
  /** The identity service used to introspect tokens and map principals. */
  identity: MatrixIdentity
  /** Diagnostics sink. */
  logger: PrincipalListenerLogger
}

/** The JSON wire shape returned by `POST /auth/principal`. */
export interface PrincipalResponse {
  /** Whether the token mapped to a principal. */
  ok: boolean
  /** The verified principal, present when `ok`. */
  principal?: MatrixPrincipal
  /** The stable DSH peer id (`matrix:<mxid>`), present when `ok`. */
  principalId?: string
  /** A short machine-readable reason, present when not `ok`. */
  error?: string
}

/** The JSON wire shape returned by `POST /auth/role`. */
export interface RoleResponse {
  /** Whether the role was resolved for a valid token. */
  ok: boolean
  /** The caller's role in the room, present when `ok`. */
  role?: RoomRole
  /** A short machine-readable reason, present when not `ok`. */
  error?: string
}

/** Bound the request body so a hostile client cannot exhaust memory. */
const MAX_BODY_BYTES = 8192

/** Attach permissive dev CORS headers (loopback prototype; tightened in prod). */
function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

/** Send a JSON response with CORS headers already applied. */
function sendJson(res: ServerResponse, status: number, payload: PrincipalResponse | RoleResponse | { ok: boolean }): void {
  applyCors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
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

/**
 * Start the loopback `/auth` listener. The returned server is stopped by the
 * plugin's reversible effect teardown.
 * @param deps - bind port, identity service, and logger.
 * @returns the listening HTTP server.
 */
export function startPrincipalListener(deps: PrincipalListenerDeps): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'OPTIONS') {
      applyCors(res)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && url === '/auth/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url === '/auth/principal') {
      let token = ''
      try {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw === '' ? '{}' : raw) as { token?: unknown }
        if (typeof parsed.token === 'string') token = parsed.token
      } catch (error) {
        deps.logger.warn('[matrix-identity] /auth/principal bad body: %s', String(error))
        sendJson(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      if (token === '') {
        sendJson(res, 400, { ok: false, error: 'missing-token' })
        return
      }
      const principal = await deps.identity.whoami(token)
      if (principal === null) {
        sendJson(res, 401, { ok: false, error: 'invalid-token' })
        return
      }
      sendJson(res, 200, { ok: true, principal, principalId: deps.identity.principalId(principal.userId) })
      return
    }
    if (req.method === 'POST' && url === '/auth/role') {
      let token = ''
      let roomId = ''
      try {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw === '' ? '{}' : raw) as { token?: unknown; roomId?: unknown }
        if (typeof parsed.token === 'string') token = parsed.token
        if (typeof parsed.roomId === 'string') roomId = parsed.roomId
      } catch (error) {
        deps.logger.warn('[matrix-identity] /auth/role bad body: %s', String(error))
        sendJson(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      if (token === '' || roomId === '') {
        sendJson(res, 400, { ok: false, error: 'missing-token-or-room' })
        return
      }
      // Resolve the caller from the token, then their role in the room. The
      // role lookup fails closed to `none`, so an unknown room or a non-member
      // is never mistaken for a privileged seat.
      const principal = await deps.identity.whoami(token)
      if (principal === null) {
        sendJson(res, 401, { ok: false, error: 'invalid-token' })
        return
      }
      const role = await deps.identity.roomRole(roomId, principal.userId)
      sendJson(res, 200, { ok: true, role })
      return
    }
    sendJson(res, 404, { ok: false, error: 'not-found' })
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      deps.logger.warn('[matrix-identity] /auth handler failed: %s', String(error))
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
      else res.end()
    })
  })
  server.listen(deps.port, '127.0.0.1')
  deps.logger.info('[matrix-identity] principal listener on http://127.0.0.1:%d/auth', deps.port)
  return server
}

/**
 * Stop the listener and drop any keep-alive sockets so the effect teardown
 * resolves promptly and the port is released.
 * @param server - the server returned by {@link startPrincipalListener}.
 * @returns a promise that resolves once the server is closed.
 */
export function stopPrincipalListener(server: Server): Promise<void> {
  return new Promise(resolveStop => {
    server.close(() => resolveStop())
    server.closeAllConnections()
  })
}
