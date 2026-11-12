/**
 * Canvas op-script verifier (Phase-3 P3-M3).
 *
 * Two layers:
 *
 *  1. OFFLINE / deterministic (no network, no LLM):
 *     - the server op-script validator (`op-script-validator.ts`) accepts a
 *       well-formed script and rejects unknown op types, malformed payloads, and
 *       non-array input;
 *     - every catalog op maps onto a parent->iframe bridge command via
 *       `opToBridgeCommand` (the op discriminator IS the bridge command type);
 *     - `isCanvasScript` / `isCanvasOp` narrow correctly.
 *
 *  2. LIVE gateway role-gating (movie-profile host up: gateway 8788, identity
 *     8787, Synapse 8008) using brokered Matrix tokens like logged-in browsers:
 *     - `canvas/script` and `canvas/result` refuse a non-member `forbidden`
 *       (403), a missing token `missing-token` (400), an invalid token
 *       `invalid-token` (401), and bad params `bad-request` (400);
 *     - `canvas/result` accepts a member/host report (`accepted: true`);
 *     - when `BAILIAN_API_KEY` is set, a member `canvas/script` intent is
 *       accepted (txnId) and the generated `CanvasScript` arrives on the
 *       `canvas/script` mux stream, validates against the catalog, and maps to
 *       bridge commands. When the key is unset this live-LLM leg is SKIPPED with
 *       a clear note (the generator degrades to `llm-unavailable`).
 *
 * Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory:
 *   node --experimental-strip-types scripts/verify-canvas-script.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs,
  type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'
import { validateOps } from '../plugins/dsh-movie-gateway/src/op-script-validator.ts'
import {
  CANVAS_OP_TYPES,
  isCanvasOp,
  isCanvasScript,
  opToBridgeCommand,
  type CanvasOp,
  type StreamFrame,
} from '../../protocol/src/index.ts'

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
    const value = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

const logger = {
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}
function note(label: string, detail = ''): void {
  process.stdout.write(`[SKIP] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/** A well-formed op-script over the catalog (mirrors what the agent emits). */
function validOps(): unknown[] {
  return [
    { op: 'node.add', payload: { nodeType: 'MovieScript', pos: [80, 160] } },
    { op: 'node.add', payload: { nodeType: 'MovieShotPlan', pos: [340, 160], id: 2 } },
    { op: 'edge.add', payload: { fromId: 1, fromSlot: 0, toId: 2, toSlot: 0 } },
    { op: 'node.setStatus', payload: { id: 1, status: 'queued' } },
    { op: 'view.fit', payload: {} },
  ]
}

/** A Leg C call result: the HTTP status plus the parsed `ApiResult` envelope. */
interface LegCCall {
  status: number
  ok: boolean
  result: unknown
  errorCode: string | undefined
}

/** Call a Leg C method with a bearer token and a params body. */
async function callLegC(gatewayUrl: string, method: string, token: string | null, params: Record<string, unknown>): Promise<LegCCall> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  const resp = await fetch(`${gatewayUrl}/api/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })
  const body = (await resp.json()) as { ok?: boolean; result?: unknown; error?: { code?: string } }
  return { status: resp.status, ok: body.ok === true, result: body.result, errorCode: body.error?.code }
}

/** A collected `canvas/script` mux stream outcome. */
interface ScriptStream {
  frames: StreamFrame[]
  script: unknown | null
  errorCode: string | undefined
  errorMessage: string | undefined
}

/** Open the `canvas/script` mux stream and collect frames until end/error. */
function collectScriptStream(wsBase: string, roomId: string, txnId: string, token: string): Promise<ScriptStream> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/api/ws`)
    const frames: StreamFrame[] = []
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('canvas/script mux stream timed out'))
    }, 120_000)
    const finish = (out: ScriptStream): void => {
      clearTimeout(timer)
      try { socket.close() } catch { /* ignore */ }
      resolveCollect(out)
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ op: 'open', stream: 's1', channel: 'canvas/script', params: { roomId, txnId, token } }))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (typeof parsed !== 'object' || parsed === null) return
      const candidate = parsed as Partial<StreamFrame>
      if (typeof candidate.stream !== 'string' || typeof candidate.type !== 'string') return
      frames.push(parsed as StreamFrame)
      if (candidate.stream !== 's1') return
      if (candidate.type === 'data') {
        const payload = candidate.payload as { stage?: string; script?: unknown } | undefined
        if (payload?.stage === 'script') {
          finish({ frames, script: payload.script, errorCode: undefined, errorMessage: undefined })
        }
        return
      }
      if (candidate.type === 'error') {
        const payload = candidate.payload as { code?: string; message?: string } | undefined
        finish({ frames, script: null, errorCode: payload?.code, errorMessage: payload?.message })
        return
      }
      if (candidate.type === 'end') {
        finish({ frames, script: null, errorCode: 'end-without-script', errorMessage: 'stream ended without a script' })
      }
    })
    socket.addEventListener('error', () => { /* the timeout guards a hard failure */ })
  })
}

/** Dev-only throwaway local accounts; not real secrets. */
const HOST_LOCALPART = 'movie_script_host'
const MEMBER_LOCALPART = 'movie_script_member'
const OUTSIDER_LOCALPART = 'movie_script_outsider'
const DEMO_PASSWORD = 'movie-script-pass'

/** Run the offline, deterministic validator + bridge-mapping checks. */
function offlineChecks(): void {
  process.stdout.write('\n— offline: op-script validator + bridge mapping —\n')

  const good = validateOps(validOps())
  check('validator accepts a well-formed script', good.ok, good.ok ? `${good.ops.length} ops` : good.message)

  const unknown = validateOps([{ op: 'node.bogus', payload: {} }])
  check('validator rejects an unknown op type', !unknown.ok && unknown.message.includes('unknown op type'), unknown.ok ? 'accepted' : unknown.message)

  const badPayload = validateOps([{ op: 'node.add', payload: { pos: [1, 2] } }])
  check('validator rejects a node.add missing nodeType', !badPayload.ok && badPayload.message.includes('payload invalid'), badPayload.ok ? 'accepted' : badPayload.message)

  const notArray = validateOps({ op: 'view.fit', payload: {} })
  check('validator rejects a non-array input', !notArray.ok && notArray.message.includes('must be an array'), notArray.ok ? 'accepted' : notArray.message)

  const badEntry = validateOps(['nope'])
  check('validator rejects a non-object entry', !badEntry.ok, badEntry.ok ? 'accepted' : badEntry.message)

  // A validated script round-trips through the protocol guards + bridge mapping.
  if (good.ok) {
    const script = { txnId: 'txn-offline', ops: good.ops }
    check('isCanvasScript narrows a validated script', isCanvasScript(script))
    check('every op passes isCanvasOp', good.ops.every((op: CanvasOp): boolean => isCanvasOp(op)))
    const mapped = good.ops.every((op: CanvasOp): boolean => {
      const command = opToBridgeCommand(op, 'txn-offline') as { type?: string; txn?: string }
      return command.type === op.op && command.txn === 'txn-offline'
    })
    check('every op maps to a bridge command of the same type', mapped)
    check('the catalog covers all nine agent-drivable ops', CANVAS_OP_TYPES.length === 9, `${CANVAS_OP_TYPES.length}`)
  } else {
    check('isCanvasScript narrows a validated script', false, 'validator rejected the well-formed script')
  }

  check('isCanvasScript rejects a malformed value', !isCanvasScript({ txnId: 1, ops: [] }))
}

async function main(): Promise<void> {
  offlineChecks()

  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
  const wsBase = gatewayUrl.replace(/^http/, 'ws')
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  const bailianKey = process.env.BAILIAN_API_KEY ?? ''
  if (adminToken === '') {
    process.stdout.write('\nSYNAPSE_ADMIN_TOKEN missing from server/.env; skipping live gateway checks.\n')
    process.stdout.write(failures === 0 ? '\nALL OFFLINE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
    process.exit(failures === 0 ? 0 : 1)
  }

  process.stdout.write('\n— live: canvas.* role-gating over the gateway —\n')
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }
  const hostId = `@${HOST_LOCALPART}:${serverName}`
  const memberId = `@${MEMBER_LOCALPART}:${serverName}`
  const outsiderId = `@${OUTSIDER_LOCALPART}:${serverName}`

  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Script Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Script Member' })
  await ensureUser(endpoint, logger, outsiderId, { password: DEMO_PASSWORD, displayName: 'Script Outsider' })
  const roomId = await createRoom(endpoint, logger, 'Movie Script Room', hostId, [memberId, botUserId])
  check('host created a fresh room', roomId !== null, roomId ?? 'none')
  if (roomId === null) process.exit(1)
  await joinRoomAs(endpoint, logger, memberId, roomId)
  await joinRoomAs(endpoint, logger, botUserId, roomId)

  const hostCreds = await brokerToken(endpoint, logger, hostId)
  const memberCreds = await brokerToken(endpoint, logger, memberId)
  const outsiderCreds = await brokerToken(endpoint, logger, outsiderId)
  check('brokered tokens for all three accounts', hostCreds !== null && memberCreds !== null && outsiderCreds !== null)
  if (hostCreds === null || memberCreds === null || outsiderCreds === null) process.exit(1)

  const health = await fetch(`${gatewayUrl}/health`)
  check('gateway /health answers ok', health.ok && ((await health.json()) as { ok?: boolean }).ok === true)

  // canvas/script role-gating + param validation (none of these reach the LLM:
  // they fail before generation, so the gate stays deterministic and key-free).
  const outsiderScript = await callLegC(gatewayUrl, 'canvas/script', outsiderCreds.accessToken, { roomId, intent: 'connect the script node' })
  check('canvas/script is forbidden for a non-member', outsiderScript.status === 403 && outsiderScript.errorCode === 'forbidden', outsiderScript.errorCode ?? `status ${outsiderScript.status}`)
  const missingToken = await callLegC(gatewayUrl, 'canvas/script', null, { roomId, intent: 'x' })
  check('canvas/script without a token is missing-token (400)', missingToken.status === 400 && missingToken.errorCode === 'missing-token', missingToken.errorCode ?? `status ${missingToken.status}`)
  const invalidToken = await callLegC(gatewayUrl, 'canvas/script', 'bogus-token', { roomId, intent: 'x' })
  check('canvas/script with an invalid token is invalid-token (401)', invalidToken.status === 401 && invalidToken.errorCode === 'invalid-token', invalidToken.errorCode ?? `status ${invalidToken.status}`)
  const noIntent = await callLegC(gatewayUrl, 'canvas/script', memberCreds.accessToken, { roomId })
  check('canvas/script without an intent is bad-request (400)', noIntent.status === 400 && noIntent.errorCode === 'bad-request', noIntent.errorCode ?? `status ${noIntent.status}`)

  // canvas/result role-gating + a member report is recorded and accepted.
  const outsiderResult = await callLegC(gatewayUrl, 'canvas/result', outsiderCreds.accessToken, { roomId, txnId: 'txn-x', committed: true, opResults: [] })
  check('canvas/result is forbidden for a non-member', outsiderResult.status === 403 && outsiderResult.errorCode === 'forbidden', outsiderResult.errorCode ?? `status ${outsiderResult.status}`)
  const noTxn = await callLegC(gatewayUrl, 'canvas/result', memberCreds.accessToken, { roomId, committed: true, opResults: [] })
  check('canvas/result without a txnId is bad-request (400)', noTxn.status === 400 && noTxn.errorCode === 'bad-request', noTxn.errorCode ?? `status ${noTxn.status}`)
  const memberResult = await callLegC(gatewayUrl, 'canvas/result', memberCreds.accessToken, {
    roomId, txnId: 'txn-recorded', committed: false,
    opResults: [{ index: 0, op: { op: 'view.fit', payload: {} }, ok: false, error: 'demo failure' }],
  })
  const resultAck = memberResult.result as { accepted?: boolean } | undefined
  check('canvas/result accepts a member report', memberResult.status === 200 && memberResult.ok && resultAck?.accepted === true, resultAck?.accepted === true ? 'accepted' : `status ${memberResult.status}`)

  // Live LLM generation: only meaningful when the Bailian key is present.
  if (bailianKey === '') {
    note('live intent->op-script generation', 'BAILIAN_API_KEY unset; the generator would degrade to llm-unavailable')
  } else {
    process.stdout.write('\n— live: real-LLM intent -> op-script over the mux —\n')
    // P3-M5: canvas/script mutates the workflow graph, so it is host-gated; the
    // live generation leg drives it with the host token (a member would 403).
    const accepted = await callLegC(gatewayUrl, 'canvas/script', hostCreds.accessToken, {
      roomId, intent: 'Add the MovieScript and MovieShotPlan nodes and connect the script output to the shot plan input.',
    })
    const ack = accepted.result as { txnId?: string; accepted?: boolean } | undefined
    check('canvas/script accepts a host intent', accepted.status === 200 && accepted.ok && ack?.accepted === true && typeof ack?.txnId === 'string', ack?.txnId ?? `status ${accepted.status}`)
    if (ack?.txnId !== undefined) {
      const stream = await collectScriptStream(wsBase, roomId, ack.txnId, hostCreds.accessToken)
      const gotScript = stream.script !== null
      check('the mux streamed a script frame', gotScript, gotScript ? 'script received' : `${stream.errorCode ?? 'none'}: ${stream.errorMessage ?? ''}`)
      if (gotScript) {
        check('the streamed script is a well-formed CanvasScript', isCanvasScript(stream.script))
        const ops = (stream.script as { ops: CanvasOp[] }).ops
        check('every streamed op is in the catalog', ops.every((op: CanvasOp): boolean => isCanvasOp(op)), `${ops.length} ops`)
        check('every streamed op maps to a bridge command', ops.every((op: CanvasOp): boolean => opToBridgeCommand(op).type === op.op))
      }
    }
  }

  process.stdout.write(failures === 0 ? '\nALL CANVAS-SCRIPT CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
