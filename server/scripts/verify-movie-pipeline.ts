/**
 * Movie pipeline + re-plan verifier (Phase-3 P3-M4, design doc §2/§5).
 *
 * Two layers:
 *
 *  1. OFFLINE / deterministic (no network, no LLM): `initialPipelineStatus`
 *     derives the six pending steps from {@link MOVIE_NODES} in pipeline order.
 *
 *  2. LIVE gateway (movie-profile host up: gateway 8788, identity 8787, Synapse
 *     8008) using brokered Matrix tokens like logged-in browsers:
 *     - `movie/run` + `movie/status` refuse a non-member `forbidden` (403), a
 *       missing token `missing-token` (400), an invalid token `invalid-token`
 *       (401), and bad params `bad-request` (400);
 *     - a member `movie/run` is accepted with a `runId`, and `movie/status`
 *       reads back a six-step pipeline for it (key-free: the POST only starts
 *       the director and records the initial pipeline);
 *     - the observe->re-plan loop: a member `canvas/result` with `committed:false`
 *       answers with a fresh `replanTxnId`, and an explicit `canvas/replan`
 *       returns a corrective `txnId` (both key-free — generation is async);
 *     - when `BAILIAN_API_KEY` is set, a member `movie/run` streams all six
 *       steps to `done` over the `movie/run` mux (real text for MovieScript /
 *       MovieShotPlan, canned media for the rest), and the `replanTxnId` pulls a
 *       validated corrective `CanvasScript` on the `canvas/script` mux. When the
 *       key is unset these live-LLM legs are SKIPPED with a clear note.
 *
 * Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-movie-pipeline.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs,
  type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'
import {
  MOVIE_STEP_IDS,
  initialPipelineStatus,
  isCanvasScript,
  type CanvasOp,
  type MoviePipelineStatus,
  type MovieStepResult,
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

/** A collected `movie/run` mux stream outcome. */
interface MovieStream {
  steps: MovieStepResult[]
  pipeline: MoviePipelineStatus | null
  errorCode: string | undefined
  errorMessage: string | undefined
}

/** Open the `movie/run` mux stream and fold step frames until done/end/error. */
function collectMovieStream(wsBase: string, roomId: string, runId: string, token: string): Promise<MovieStream> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/api/ws`)
    const steps = new Map<number, MovieStepResult>()
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('movie/run mux stream timed out'))
    }, 180_000)
    const finish = (out: MovieStream): void => {
      clearTimeout(timer)
      try { socket.close() } catch { /* ignore */ }
      resolveCollect(out)
    }
    const ordered = (): MovieStepResult[] => [...steps.values()].sort((a, b): number => a.step - b.step)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ op: 'open', stream: 's1', channel: 'movie/run', params: { roomId, runId, token } }))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (typeof parsed !== 'object' || parsed === null) return
      const frame = parsed as Partial<StreamFrame>
      if (frame.stream !== 's1' || typeof frame.type !== 'string') return
      if (frame.type === 'data') {
        const payload = frame.payload as { stage?: string; step?: MovieStepResult; pipeline?: MoviePipelineStatus } | undefined
        if (payload?.stage === 'step' && payload.step !== undefined) {
          steps.set(payload.step.step, payload.step)
          return
        }
        if (payload?.stage === 'done' && payload.pipeline !== undefined) {
          for (const step of payload.pipeline.steps) steps.set(step.step, step)
          finish({ steps: ordered(), pipeline: payload.pipeline, errorCode: undefined, errorMessage: undefined })
        }
        return
      }
      if (frame.type === 'error') {
        const payload = frame.payload as { code?: string; message?: string } | undefined
        finish({ steps: ordered(), pipeline: null, errorCode: payload?.code, errorMessage: payload?.message })
        return
      }
      if (frame.type === 'end') {
        finish({ steps: ordered(), pipeline: null, errorCode: 'end-without-done', errorMessage: 'stream ended without a done frame' })
      }
    })
    socket.addEventListener('error', () => { /* the timeout guards a hard failure */ })
  })
}

/** Open the `canvas/script` mux stream and await the generated script. */
function collectScriptStream(wsBase: string, roomId: string, txnId: string, token: string): Promise<{ script: unknown | null; errorCode: string | undefined; errorMessage: string | undefined }> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/api/ws`)
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('canvas/script mux stream timed out'))
    }, 120_000)
    const finish = (out: { script: unknown | null; errorCode: string | undefined; errorMessage: string | undefined }): void => {
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
      const frame = parsed as Partial<StreamFrame>
      if (frame.stream !== 's1' || typeof frame.type !== 'string') return
      if (frame.type === 'data') {
        const payload = frame.payload as { stage?: string; script?: unknown } | undefined
        if (payload?.stage === 'script') finish({ script: payload.script, errorCode: undefined, errorMessage: undefined })
        return
      }
      if (frame.type === 'error') {
        const payload = frame.payload as { code?: string; message?: string } | undefined
        finish({ script: null, errorCode: payload?.code, errorMessage: payload?.message })
        return
      }
      if (frame.type === 'end') {
        finish({ script: null, errorCode: 'end-without-script', errorMessage: 'stream ended without a script' })
      }
    })
    socket.addEventListener('error', () => { /* the timeout guards a hard failure */ })
  })
}

/** Run the offline, deterministic pipeline-shape checks. */
function offlineChecks(): void {
  process.stdout.write('\n— offline: initial pipeline status —\n')
  const status = initialPipelineStatus('run-offline', '!room:localhost')
  check('initialPipelineStatus derives six steps', status.steps.length === 6, `${status.steps.length} steps`)
  check('initialPipelineStatus starts not-done', status.done === false)
  check('every initial step is pending', status.steps.every((step): boolean => step.status === 'pending'))
  const classTypes = status.steps.map((step): string => step.classType)
  check('the six steps match MOVIE_STEP_IDS in order', classTypes.join(',') === MOVIE_STEP_IDS.join(','), classTypes.join(' -> '))
  check('steps are numbered 1..6', status.steps.every((step, index): boolean => step.step === index + 1))
}

/** Dev-only throwaway local accounts; not real secrets. */
const HOST_LOCALPART = 'movie_pipe_host'
const MEMBER_LOCALPART = 'movie_pipe_member'
const OUTSIDER_LOCALPART = 'movie_pipe_outsider'
const DEMO_PASSWORD = 'movie-pipe-pass'

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

  process.stdout.write('\n— live: movie.* role-gating over the gateway —\n')
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }
  const hostId = `@${HOST_LOCALPART}:${serverName}`
  const memberId = `@${MEMBER_LOCALPART}:${serverName}`
  const outsiderId = `@${OUTSIDER_LOCALPART}:${serverName}`

  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Pipeline Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Pipeline Member' })
  await ensureUser(endpoint, logger, outsiderId, { password: DEMO_PASSWORD, displayName: 'Pipeline Outsider' })
  const roomId = await createRoom(endpoint, logger, 'Movie Pipeline Room', hostId, [memberId, botUserId])
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

  // movie/run role-gating + param validation (none of these start a pipeline:
  // they fail before the director, so the gate stays deterministic and key-free).
  const outsiderRun = await callLegC(gatewayUrl, 'movie/run', outsiderCreds.accessToken, { roomId, intent: 'a cat dancing on the moon' })
  check('movie/run is forbidden for a non-member', outsiderRun.status === 403 && outsiderRun.errorCode === 'forbidden', outsiderRun.errorCode ?? `status ${outsiderRun.status}`)
  const runNoToken = await callLegC(gatewayUrl, 'movie/run', null, { roomId, intent: 'x' })
  check('movie/run without a token is missing-token (400)', runNoToken.status === 400 && runNoToken.errorCode === 'missing-token', runNoToken.errorCode ?? `status ${runNoToken.status}`)
  const runBadToken = await callLegC(gatewayUrl, 'movie/run', 'bogus-token', { roomId, intent: 'x' })
  check('movie/run with an invalid token is invalid-token (401)', runBadToken.status === 401 && runBadToken.errorCode === 'invalid-token', runBadToken.errorCode ?? `status ${runBadToken.status}`)
  const runNoIntent = await callLegC(gatewayUrl, 'movie/run', memberCreds.accessToken, { roomId })
  check('movie/run without an intent is bad-request (400)', runNoIntent.status === 400 && runNoIntent.errorCode === 'bad-request', runNoIntent.errorCode ?? `status ${runNoIntent.status}`)

  // movie/status role-gating + a missing run reads back a null pipeline.
  const outsiderStatus = await callLegC(gatewayUrl, 'movie/status', outsiderCreds.accessToken, { roomId, runId: 'run-none' })
  check('movie/status is forbidden for a non-member', outsiderStatus.status === 403 && outsiderStatus.errorCode === 'forbidden', outsiderStatus.errorCode ?? `status ${outsiderStatus.status}`)
  const statusMissing = await callLegC(gatewayUrl, 'movie/status', memberCreds.accessToken, { roomId, runId: 'run-does-not-exist' })
  const missingPayload = statusMissing.result as { pipeline?: MoviePipelineStatus | null } | undefined
  check('movie/status for an unknown run reads a null pipeline', statusMissing.status === 200 && statusMissing.ok && missingPayload?.pipeline === null, `status ${statusMissing.status}`)

  // A member movie/run is accepted with a runId and recorded (key-free: the POST
  // only starts the director; movie/status reads the initial six-step pipeline).
  const memberRun = await callLegC(gatewayUrl, 'movie/run', memberCreds.accessToken, { roomId, intent: 'a short film about a robot learning to paint' })
  const runAck = memberRun.result as { runId?: string; accepted?: boolean } | undefined
  check('movie/run accepts a member intent with a runId', memberRun.status === 200 && memberRun.ok && runAck?.accepted === true && typeof runAck?.runId === 'string', runAck?.runId ?? `status ${memberRun.status}`)
  if (typeof runAck?.runId === 'string') {
    const recorded = await callLegC(gatewayUrl, 'movie/status', memberCreds.accessToken, { roomId, runId: runAck.runId })
    const pipeline = (recorded.result as { pipeline?: MoviePipelineStatus | null } | undefined)?.pipeline
    check('movie/status reads back a six-step pipeline for the run', recorded.status === 200 && pipeline !== null && pipeline !== undefined && pipeline.steps.length === 6 && pipeline.runId === runAck.runId, pipeline ? `${pipeline.steps.length} steps` : 'null pipeline')
  }

  // Observe -> re-plan (key-free): a rolled-back result yields a replanTxnId and
  // an explicit canvas/replan yields a corrective txnId (generation is async).
  process.stdout.write('\n— live: observe -> re-plan loop (key-free acceptance) —\n')
  const failedResult = await callLegC(gatewayUrl, 'canvas/result', memberCreds.accessToken, {
    roomId, txnId: 'replan-probe', committed: false,
    opResults: [{ index: 0, op: { op: 'edge.add', payload: { fromId: 1, fromSlot: 0, toId: 99, toSlot: 0 } }, ok: false, error: 'demo failure' }],
  })
  const resultAck = failedResult.result as { accepted?: boolean; replanTxnId?: string } | undefined
  check('canvas/result with committed:false is accepted', failedResult.status === 200 && failedResult.ok && resultAck?.accepted === true, `status ${failedResult.status}`)
  check('canvas/result returns a corrective replanTxnId', typeof resultAck?.replanTxnId === 'string' && resultAck.replanTxnId.length > 0, resultAck?.replanTxnId ?? 'none')

  const explicitReplan = await callLegC(gatewayUrl, 'canvas/replan', memberCreds.accessToken, { roomId, txnId: 'replan-probe-explicit' })
  const replanAck = explicitReplan.result as { txnId?: string; accepted?: boolean } | undefined
  check('canvas/replan returns a corrective txnId', explicitReplan.status === 200 && explicitReplan.ok && replanAck?.accepted === true && typeof replanAck?.txnId === 'string', replanAck?.txnId ?? explicitReplan.errorCode ?? `status ${explicitReplan.status}`)
  const outsiderReplan = await callLegC(gatewayUrl, 'canvas/replan', outsiderCreds.accessToken, { roomId, txnId: 'x' })
  check('canvas/replan is forbidden for a non-member', outsiderReplan.status === 403 && outsiderReplan.errorCode === 'forbidden', outsiderReplan.errorCode ?? `status ${outsiderReplan.status}`)

  // Live LLM legs: only meaningful when the Bailian key is present.
  if (bailianKey === '') {
    note('live movie/run six-step pipeline stream', 'BAILIAN_API_KEY unset; the director text steps would degrade')
    note('live re-plan corrective script pull', 'BAILIAN_API_KEY unset; the generator would degrade to llm-unavailable')
  } else {
    process.stdout.write('\n— live: real-LLM movie/run pipeline over the mux —\n')
    const liveRun = await callLegC(gatewayUrl, 'movie/run', memberCreds.accessToken, { roomId, intent: 'a short film about a robot learning to paint' })
    const liveAck = liveRun.result as { runId?: string; accepted?: boolean } | undefined
    check('movie/run accepts the live intent', liveRun.status === 200 && liveAck?.accepted === true && typeof liveAck?.runId === 'string', liveAck?.runId ?? `status ${liveRun.status}`)
    if (typeof liveAck?.runId === 'string') {
      const stream = await collectMovieStream(wsBase, roomId, liveAck.runId, memberCreds.accessToken)
      const done = stream.pipeline !== null
      check('the movie/run mux streamed a done frame', done, done ? 'done received' : `${stream.errorCode ?? 'none'}: ${stream.errorMessage ?? ''}`)
      if (done && stream.pipeline !== null) {
        const steps = stream.pipeline.steps
        check('the pipeline completed all six steps', steps.length === 6 && stream.pipeline.done === true, `${steps.length} steps done=${String(stream.pipeline.done)}`)
        const textSteps = steps.filter((step): boolean => step.classType === 'MovieScript' || step.classType === 'MovieShotPlan')
        check(
          'the text steps produced real (non-media) artifacts',
          textSteps.length === 2 && textSteps.every((step): boolean => step.status === 'success' && step.media !== true && typeof step.artifact === 'string' && step.artifact.length > 0),
          textSteps.map((step): string => `${step.classType}:${step.status}${step.media === true ? '(media)' : ''}`).join(', '),
        )
        const mediaSteps = steps.filter((step): boolean => step.classType !== 'MovieScript' && step.classType !== 'MovieShotPlan')
        check(
          'the media steps produced canned placeholders',
          mediaSteps.length === 4 && mediaSteps.every((step): boolean => step.status === 'success' && step.media === true),
          mediaSteps.map((step): string => `${step.classType}:${step.status}${step.media === true ? '(media)' : ''}`).join(', '),
        )
      }
    }

    process.stdout.write('\n— live: re-plan corrective script over the mux —\n')
    const seed = await callLegC(gatewayUrl, 'canvas/script', memberCreds.accessToken, { roomId, intent: 'Add the MovieScript and MovieShotPlan nodes and connect them.' })
    const seedAck = seed.result as { txnId?: string } | undefined
    if (typeof seedAck?.txnId === 'string') {
      const rolled = await callLegC(gatewayUrl, 'canvas/result', memberCreds.accessToken, {
        roomId, txnId: seedAck.txnId, committed: false,
        opResults: [{ index: 0, op: { op: 'edge.add', payload: { fromId: 1, fromSlot: 0, toId: 99, toSlot: 0 } } as CanvasOp, ok: false, error: 'demo failure' }],
      })
      const rolledAck = rolled.result as { replanTxnId?: string } | undefined
      check('the rolled-back result yields a replanTxnId', typeof rolledAck?.replanTxnId === 'string', rolledAck?.replanTxnId ?? 'none')
      if (typeof rolledAck?.replanTxnId === 'string') {
        const corrective = await collectScriptStream(wsBase, roomId, rolledAck.replanTxnId, memberCreds.accessToken)
        const gotScript = corrective.script !== null
        check('the replanTxnId streams a corrective script', gotScript, gotScript ? 'script received' : `${corrective.errorCode ?? 'none'}: ${corrective.errorMessage ?? ''}`)
        if (gotScript) check('the corrective script is a well-formed CanvasScript', isCanvasScript(corrective.script))
      }
    } else {
      check('the seed canvas/script intent was accepted', false, seed.errorCode ?? `status ${seed.status}`)
    }
  }

  process.stdout.write(failures === 0 ? '\nALL MOVIE-PIPELINE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
