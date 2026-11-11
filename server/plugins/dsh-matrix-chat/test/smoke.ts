/**
 * M2 smoke test for `dsh-matrix-chat` against the live local Synapse.
 *
 * It composes the real `dsh-matrix-identity` plugin (so the bot token is
 * brokered and introspected against Synapse for real) with the real
 * `dsh-matrix-chat` plugin, but substitutes a stubbed DSH agent runtime that
 * echoes each message. That isolates the transport + relay wiring from the LLM
 * while still exercising a genuine end-to-end round-trip:
 *
 *   bot boots and syncs -> bot joins a room -> a second provisioned user sends
 *   an m.text -> matrix/room-message -> stub agent "turn" -> bot posts the reply
 *   -> matrix/room-reply (ok) -> the bot ignores its own reply (no echo loop)
 *
 * Per-room serialization is asserted by tracking that a room's stub agent never
 * has two turns in flight at once (peak concurrency stays at 1).
 *
 * Run from the `server/` directory (so node_modules resolution works):
 *   node --experimental-strip-types plugins/dsh-matrix-chat/test/smoke.ts
 *
 * Secrets are read from `server/.env`; nothing sensitive is printed.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyIdentity, type Config as IdentityConfig } from '../../dsh-matrix-identity/src/index.ts'
import {
  createRoom, joinRoomAs, sendTextAs, type MatrixEndpoint,
} from '../../dsh-matrix-identity/src/matrix-admin.ts'
import type { MatrixIdentity } from '../../dsh-matrix-identity/src/types.ts'
import { apply as applyChat, type Config as ChatConfig } from '../src/index.ts'
import type { MatrixChat, RoomMessage, RoomReply } from '../src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '../../..')

/** Load `server/.env` into process.env (KEY=VALUE lines; existing keys win). */
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

/** Resolve a promise after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolveTimer => setTimeout(resolveTimer, ms))
}

/** Minimal logger stand-in matching `ctx.logger`. */
const logger = {
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
  info(message: string, ...args: unknown[]): void {
    process.stderr.write(`info: ${message} ${args.map(String).join(' ')}\n`)
  },
}

/** Captured emitted events, keyed by name (shared by both plugins). */
const events: Record<string, unknown[][]> = {}

/** The shape the inbox reads off a session log entry. */
interface SessionEvent {
  type: string
  data?: { message?: { content?: Array<{ type: string; text?: string }> } }
}

/** A stub durable session whose log the inbox's `summarize` reads back. */
class FakeSession {
  seq = 0
  readonly events: SessionEvent[] = []
  eventAt(offset: unknown): SessionEvent | undefined {
    return this.events[Number(offset)]
  }
}

/** A stub agent that synchronously echoes each user turn into its session log. */
class FakeAgent {
  readonly session = new FakeSession()
  status = 'idle'
  /** Turns currently in flight for this room's agent. */
  active = 0
  /** Peak concurrent turns observed; serialization keeps this at 1. */
  peak = 0

  followup(message: { content?: Array<{ type: string; text?: string }> }): void {
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    const text = message.content?.find(block => block.type === 'text')?.text ?? ''
    this.session.events.push({ type: 'turn/start' })
    this.session.seq += 1
    this.session.events.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: `echo:${text}` }] } },
    })
    this.session.seq += 1
  }

  async whenIdle(): Promise<void> {
    // A short delay widens the window in which two turns could overlap, so the
    // serialization assertion is meaningful rather than trivially true.
    await sleep(25)
    // The inbox calls whenIdle once at agent creation (before any followup);
    // clamp at zero so only real turns drive the concurrency counter.
    if (this.active > 0) this.active -= 1
  }
}

/** Stub agents created during the run, for peak-concurrency inspection. */
const createdAgents: FakeAgent[] = []

/** Build a fake Cordis context sufficient to activate both plugins. */
function makeCtx(): { ctx: any; services: Record<string, any> } {
  const services: Record<string, any> = {}
  const ctx = {
    logger,
    credentials: {
      async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
        const value = process.env[ref]
        return value !== undefined && value.length > 0 ? { value, source: 'env' } : undefined
      },
    },
    // Stubbed DSH agent runtime: no LLM, deterministic echo replies.
    agents: {
      async create(_opts: unknown): Promise<{ agent: FakeAgent }> {
        const agent = new FakeAgent()
        createdAgents.push(agent)
        return { agent }
      },
    },
    agentDefaultModel: { currentSelection: () => ({}) },
    sessions: { async flush(_session: unknown): Promise<void> {} },
    // The chat plugin reads its identity dependency off the context; the getter
    // resolves it lazily once the identity plugin has provided it.
    get matrixIdentity(): MatrixIdentity | undefined {
      return services.matrixIdentity as MatrixIdentity | undefined
    },
    provide(name: string, impl: unknown): void {
      services[name] = impl
    },
    emit(name: string, ...args: unknown[]): void {
      ;(events[name] ??= []).push(args)
    },
    // Run the effect setup synchronously, as Cordis does on activation.
    effect(setup: () => unknown): void {
      void setup()
    },
    get(name: string): unknown {
      if (name === 'loader') return { await: async () => {} }
      return undefined
    },
  }
  return { ctx, services }
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'PASS' : 'FAIL'
  process.stdout.write(`[${mark}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** Poll `predicate` until it holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

/** Read all captured events of a name, cast to a row type. */
function rowsOf<T>(name: string): T[] {
  return (events[name] ?? []).map(args => args[0] as T)
}

async function main(): Promise<void> {
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }

  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot run the M2 smoke test.\n')
    process.exit(1)
  }

  const identityConfig: IdentityConfig = {
    homeserverUrl: baseUrl,
    serverName,
    adminTokenRef: 'SYNAPSE_ADMIN_TOKEN',
    botUserId,
    whoamiCacheMs: 60_000,
    principalListenerPort: 0,
  }
  const chatConfig: ChatConfig = {
    botUserId,
    autoJoinRooms: [],
    initialSyncLimit: 30,
    agentEnabled: true,
    replyWithMentions: true,
    maxReconnectDelayMs: 30_000,
  }

  const { ctx, services } = makeCtx()
  applyIdentity(ctx, identityConfig)
  const identity = services.matrixIdentity as MatrixIdentity | undefined
  check('identity service provided', identity !== undefined)
  if (identity === undefined) process.exit(1)
  check('Synapse endpoint + admin token configured', await identity.isConfigured())

  applyChat(ctx, chatConfig)
  const chat = services.matrixChat as MatrixChat | undefined
  check('matrixChat service provided', chat !== undefined)
  if (chat === undefined) process.exit(1)

  // Wait for the bot to boot and finish its initial sync. matrix-js-sdk fires
  // PREPARED once, then reports SYNCING/CATCHUP for the live loop, so accept any
  // of those: all imply the internal `prepared` relay gate has been set.
  const liveStates = new Set(['PREPARED', 'SYNCING', 'CATCHUP'])
  const ready = await waitFor(() => {
    const snapshot = chat.status()
    return snapshot.running && snapshot.syncState !== null && liveStates.has(snapshot.syncState)
  }, 40_000)
  check('bot client started and completed initial sync', ready, JSON.stringify(chat.status()))
  if (!ready) process.exit(1)
  check('no agent inbox exists before any message', chat.status().rooms === 0)

  // A second, human user creates a room and invites the bot.
  const localpart = `dsh_m2_${Date.now().toString(36)}`
  const human = await identity.provisionUser(localpart, { displayName: 'DSH M2 Human' })
  check('provisioned a second (human) user', human.provisioned, human.userId)
  const roomId = await createRoom(endpoint, logger, 'DSH M2 Smoke Room', human.userId, [botUserId])
  check('human created a room and invited the bot', roomId !== null, roomId ?? 'null')
  if (roomId === null) process.exit(1)

  // The bot accepts the invite through the imperative service surface.
  const joined = await chat.ensureJoined(roomId)
  check('bot joined the provisioned room (ensureJoined)', joined)
  // The creator is already joined; re-joining degrades to a no-op success.
  await joinRoomAs(endpoint, logger, human.userId, roomId)
  await sleep(1500)

  // Human message #1 -> relay -> stub agent -> bot reply.
  const sent1 = await sendTextAs(endpoint, logger, human.userId, roomId, 'hello bot one')
  check('human sent message #1', sent1)
  const reply1 = await waitFor(() => rowsOf<RoomReply>('matrix/room-reply').some(r => r.ok), 20_000)
  check('bot posted a reply to message #1', reply1)
  const repliesAt1 = rowsOf<RoomReply>('matrix/room-reply')
  check('reply #1 body is the stub echo', repliesAt1[0]?.body === 'echo:hello bot one', repliesAt1[0]?.body ?? 'none')
  const messagesAt1 = rowsOf<RoomMessage>('matrix/room-message')
  check('matrix/room-message relayed message #1', messagesAt1.length === 1 && messagesAt1[0]?.body === 'hello bot one')

  // Human message #2 -> proves ordering + per-room serialization.
  const sent2 = await sendTextAs(endpoint, logger, human.userId, roomId, 'hello bot two')
  check('human sent message #2', sent2)
  const reply2 = await waitFor(() => rowsOf<RoomReply>('matrix/room-reply').filter(r => r.ok).length >= 2, 20_000)
  check('bot posted a reply to message #2', reply2)
  const replies = rowsOf<RoomReply>('matrix/room-reply')
  check('replies arrived in send order', replies[1]?.body === 'echo:hello bot two', replies[1]?.body ?? 'none')

  // The bot must ignore its own replies: exactly two relayed human messages.
  const messages = rowsOf<RoomMessage>('matrix/room-message')
  check('bot ignored its own replies (no echo loop)', messages.length === 2, `count=${messages.length}`)

  // Serialization: the room's agent never had two turns in flight at once.
  check('per-room turns were serialized (peak concurrency 1)', (createdAgents[0]?.peak ?? 99) === 1, `peak=${createdAgents[0]?.peak ?? 'n/a'}`)
  check('exactly one room agent was created', createdAgents.length === 1)
  check('status reports one live room inbox', chat.status().rooms === 1)
  check('matrix/bot-state transitions were emitted', (events['matrix/bot-state'] ?? []).length >= 1)

  process.stdout.write(failures === 0 ? '\nALL M2 CHAT CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
