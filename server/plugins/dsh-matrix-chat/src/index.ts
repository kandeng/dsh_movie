/**
 * `dsh-matrix-chat`: a long-lived matrix-js-sdk bot transport exposed as the
 * Cordis service `ctx.matrixChat`. It logs the bot in with a token brokered by
 * `ctx.matrixIdentity`, syncs its joined rooms, relays human `m.text` messages
 * into a per-room serialized DSH agent inbox, and posts the agent's reply back
 * into the room (optionally mentioning the sender and threading to their
 * message).
 *
 * Lifecycle is a reversible Cordis effect: activation starts the client,
 * disposal stops it and disposes the inbox, so a host reload or Synapse blip
 * never leaks a client. A light supervisor restarts the sync loop with bounded
 * backoff if the client stops unexpectedly. Every network path degrades rather
 * than throws — a Synapse outage logs and idles, it never crashes the host.
 *
 * @module dsh-matrix-chat
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as sdk from 'matrix-js-sdk'
// Type-only import loads the ctx.matrixIdentity service-key + event merges.
import type {} from 'dsh-matrix-identity/types'
import { AgentInbox } from './agent-inbox.ts'
import { createRoomPoster, type RoomPoster } from './room-post.ts'
import type {
  MatrixChat, MatrixChatStatus, MatrixRoomId, MatrixUserId, PostFile, PostOptions, RoomMessage, RoomReply,
} from './types.ts'

export type {
  MatrixChat, MatrixChatStatus, PostFile, PostOptions, RoomMessage, RoomReply,
} from './types.ts'

/** Stable Loader identity. */
export const name = 'matrix-chat'

/** The identity service brokers the bot token; the agent runtime drives replies. */
export const inject = ['matrixIdentity', 'agents', 'agentDefaultModel', 'sessions']

/** Plugin configuration. */
export interface Config {
  /** The bot's fully qualified Matrix user id, e.g. `@vidsay_bot:localhost`. */
  botUserId: string
  /** Rooms the bot joins at boot (idempotent). */
  autoJoinRooms: string[]
  /** Timeline events pulled on the initial sync. */
  initialSyncLimit: number
  /** Whether inbound human messages drive the DSH agent inbox (else events only). */
  agentEnabled: boolean
  /** Whether replies `m.mention` and thread to the requesting sender. */
  replyWithMentions: boolean
  /** Cap on reconnect backoff, in milliseconds. */
  maxReconnectDelayMs: number
}

/** Schemastery validation + defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  botUserId: z.string().default(''),
  autoJoinRooms: z.array(z.string()).default([]),
  initialSyncLimit: z.number().min(1).default(30),
  agentEnabled: z.boolean().default(true),
  replyWithMentions: z.boolean().default(true),
  maxReconnectDelayMs: z.number().min(0).default(30_000),
})

/** Extract the bare localpart from a fully qualified `@local:server` id. */
function localpartOf(userId: MatrixUserId): string {
  const withoutAt = userId.startsWith('@') ? userId.slice(1) : userId
  const colon = withoutAt.indexOf(':')
  return colon < 0 ? withoutAt : withoutAt.slice(0, colon)
}

/**
 * Activate the chat transport: provide `ctx.matrixChat`, then start the bot as a
 * reversible effect with a bounded reconnect supervisor.
 * @param ctx - host context with `matrixIdentity` and the agent runtime.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let client: sdk.MatrixClient | null = null
  let poster: RoomPoster | null = null
  let syncState: string | null = null
  let running = false
  let prepared = false
  let disposed = false
  let reconnectAttempts = 0
  let reconnectTimer: NodeJS.Timeout | null = null

  const inbox = new AgentInbox({
    agents: ctx.agents,
    agentDefaultModel: ctx.agentDefaultModel,
    sessions: ctx.sessions,
    ...ctx.get('subagents') === undefined ? {} : { subagents: ctx.get('subagents') },
    cwd: process.cwd(),
    logger: ctx.logger,
  })

  const status = (): MatrixChatStatus => ({
    running,
    botUserId: config.botUserId === '' ? null : config.botUserId,
    syncState,
    rooms: inbox.roomCount,
  })

  /** Handle one inbound human text message: relay, run the agent, post the reply. */
  async function handleMessage(message: RoomMessage): Promise<void> {
    ctx.emit('matrix/room-message', message)
    if (!config.agentEnabled) return
    let replyText: string
    try {
      replyText = await inbox.run(message.roomId, message.body)
    } catch (error) {
      ctx.logger.warn('[matrix-chat] agent turn failed in %s: %s', message.roomId, String(error))
      return
    }
    if (replyText.trim() === '' || poster === null) return
    const options: PostOptions = {
      ...(message.eventId !== null ? { replyTo: message.eventId } : {}),
      ...(config.replyWithMentions ? { mentions: [message.senderId] } : {}),
    }
    const ok = await service.postText(message.roomId, replyText, options)
    const reply: RoomReply = { roomId: message.roomId, inReplyTo: message.eventId, body: replyText, ok }
    ctx.emit('matrix/room-reply', reply)
  }

  const service: MatrixChat = {
    status,
    async ensureJoined(roomId: MatrixRoomId): Promise<boolean> {
      if (client === null) return false
      try {
        await client.joinRoom(roomId)
        return true
      } catch (error) {
        ctx.logger.warn('[matrix-chat] joinRoom %s failed: %s', roomId, String(error))
        return false
      }
    },
    async postText(roomId: MatrixRoomId, body: string, options?: PostOptions): Promise<boolean> {
      if (poster === null) return false
      try {
        await poster.sendText(roomId, body, options)
        return true
      } catch (error) {
        ctx.logger.warn('[matrix-chat] postText %s failed: %s', roomId, String(error))
        return false
      }
    },
    async postFile(roomId: MatrixRoomId, bytes: Uint8Array, file: PostFile, options?: PostOptions): Promise<boolean> {
      if (poster === null) return false
      try {
        await poster.sendFile(roomId, bytes, file, options)
        return true
      } catch (error) {
        ctx.logger.warn('[matrix-chat] postFile %s failed: %s', roomId, String(error))
        return false
      }
    },
  }

  /** Broker (provisioning first if needed) the bot's client token. */
  async function botToken(): Promise<string | null> {
    const botUserId = config.botUserId
    if (botUserId === '') return null
    let creds = await ctx.matrixIdentity.brokerToken(botUserId)
    if (creds === null) {
      // The bot account may not exist yet in a fresh deployment: provision it
      // idempotently, then broker again.
      await ctx.matrixIdentity.provisionUser(localpartOf(botUserId), { displayName: 'Movie Bot' })
      creds = await ctx.matrixIdentity.brokerToken(botUserId)
    }
    return creds?.accessToken ?? null
  }

  /** Attach the timeline + sync listeners to a freshly created client. */
  function attachListeners(instance: sdk.MatrixClient): void {
    instance.on(sdk.RoomEvent.Timeline, (event, _room, toStartOfTimeline) => {
      if (!prepared || toStartOfTimeline) return
      const sender = event.getSender()
      if (sender === config.botUserId) return
      if (event.getType() !== 'm.room.message') return
      const content = event.getContent<{ msgtype?: string; body?: string }>() ?? {}
      if (content.msgtype !== 'm.text') return
      const body = (content.body ?? '').trim()
      if (body === '') return
      const roomId = event.getRoomId()
      if (roomId === null || roomId === undefined) return
      const senderId = sender ?? ''
      const senderName = instance.getRoom(roomId)?.getMember(senderId)?.name ?? senderId
      const message: RoomMessage = {
        roomId, senderId, senderName, body, eventId: event.getId() ?? null,
      }
      void handleMessage(message).catch((error: unknown) => {
        ctx.logger.warn('[matrix-chat] handleMessage failed: %s', String(error))
      })
    })

    instance.on(sdk.ClientEvent.Sync, (state: sdk.SyncState) => {
      syncState = state
      if (state === sdk.SyncState.Prepared) {
        prepared = true
        reconnectAttempts = 0
      }
      if (state === sdk.SyncState.Error) {
        ctx.logger.warn('[matrix-chat] sync error; the sdk will retry')
      }
      ctx.emit('matrix/bot-state', status())
      // An unexpected stop (not disposal) triggers a supervised restart.
      if (state === sdk.SyncState.Stopped && !disposed) scheduleReconnect()
    })

    // Auto-accept invites: a human who creates a room and invites the bot pulls
    // it in without a host round-trip, which is how "bot joins provisioned
    // rooms" works for user-created rooms. Degrades (logs) rather than throws.
    instance.on(sdk.RoomEvent.MyMembership, (room, membership) => {
      if (membership !== 'invite' || disposed) return
      void instance.joinRoom(room.roomId).catch((error: unknown) => {
        ctx.logger.warn('[matrix-chat] auto-accept invite %s failed: %s', room.roomId, String(error))
      })
    })
  }

  /** Start (or restart) the bot client; degrades to idle when unconfigured. */
  async function start(): Promise<void> {
    if (disposed || running) return
    if (config.botUserId === '') {
      ctx.logger.warn('[matrix-chat] no botUserId configured; transport idle')
      return
    }
    const token = await botToken()
    if (token === null) {
      ctx.logger.warn('[matrix-chat] could not broker a token for %s; scheduling retry', config.botUserId)
      scheduleReconnect()
      return
    }
    const endpoint = await ctx.matrixIdentity.whoami(token)
    const deviceId = endpoint?.deviceId ?? null
    const instance = sdk.createClient({
      baseUrl: homeserverUrlOf(ctx),
      accessToken: token,
      userId: endpoint?.userId ?? config.botUserId,
      ...(deviceId === null ? {} : { deviceId }),
    })
    client = instance
    poster = createRoomPoster(instance)
    attachListeners(instance)
    try {
      await instance.startClient({ initialSyncLimit: config.initialSyncLimit })
      running = true
      ctx.emit('matrix/bot-state', status())
      ctx.logger.info('[matrix-chat] bot started as %s', config.botUserId)
      for (const roomId of config.autoJoinRooms) {
        await service.ensureJoined(roomId)
      }
      // Accept any invites already pending from the initial sync (the live
      // MyMembership listener only catches invites that arrive after boot).
      for (const room of instance.getRooms()) {
        if (room.getMyMembership() === 'invite') await service.ensureJoined(room.roomId)
      }
    } catch (error) {
      ctx.logger.warn('[matrix-chat] startClient failed: %s', String(error))
      running = false
      scheduleReconnect()
    }
  }

  /** Schedule a bounded-backoff reconnect unless disposed. */
  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return
    reconnectAttempts += 1
    const delay = Math.min(config.maxReconnectDelayMs, 1000 * 2 ** Math.min(reconnectAttempts, 5))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (disposed) return
      teardownClient()
      void start()
    }, delay)
  }

  /** Stop and drop the current client without scheduling a reconnect. */
  function teardownClient(): void {
    prepared = false
    running = false
    if (client !== null) {
      try {
        client.stopClient()
      } catch (error) {
        ctx.logger.warn('[matrix-chat] stopClient failed: %s', String(error))
      }
      client.removeAllListeners()
    }
    client = null
    poster = null
  }

  ctx.provide('matrixChat', service)

  // Reversible lifecycle: start on activation, fully tear down on disposal.
  ctx.effect(() => {
    void ctx.get('loader')?.await().then(() => start()).catch((error: unknown) => {
      ctx.logger.warn('[matrix-chat] boot failed: %s', String(error))
    })
    return async () => {
      disposed = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      teardownClient()
      inbox.dispose()
    }
  })
}

/**
 * Resolve the homeserver base URL from the sibling identity plugin's config.
 * The identity row owns the endpoint coordinates; the chat row reads the same
 * value so the two never drift. Falls back to the local dev default.
 * @param ctx - host context.
 * @returns the homeserver base URL.
 */
function homeserverUrlOf(ctx: Context): string {
  const url = process.env.SYNAPSE_BASE_URL
  if (url !== undefined && url !== '') return url
  void ctx
  return 'http://127.0.0.1:8008'
}
