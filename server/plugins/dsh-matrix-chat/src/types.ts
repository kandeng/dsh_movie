/**
 * Public contract of the `dsh-matrix-chat` plugin: the `ctx.matrixChat` service,
 * the room-message/reply value shapes, and the typed events it emits.
 *
 * The plugin owns a single long-lived matrix-js-sdk bot client (the "transport")
 * that syncs its joined rooms, relays human `m.text` messages into a per-room
 * serialized DSH agent inbox, and posts the agent's reply back into the room.
 * Bot lifecycle (start/stop, reconnect/backoff) is a reversible Cordis effect, so
 * a host reload or Synapse blip never leaks a client or drops the process.
 *
 * @module dsh-matrix-chat/types
 */

import type { MatrixRoomId, MatrixUserId } from 'dsh-matrix-identity/types'

export type { MatrixRoomId, MatrixUserId }

/** A human room message relayed into the agent inbox. */
export interface RoomMessage {
  /** Room the message arrived in. */
  roomId: MatrixRoomId
  /** Sender's Matrix user id. */
  senderId: MatrixUserId
  /** Sender's resolved display name (falls back to the mxid). */
  senderName: string
  /** Trimmed `m.text` body. */
  body: string
  /** The Matrix event id, used for reply-threading and de-duplication. */
  eventId: string | null
}

/** An agent reply posted back into a room. */
export interface RoomReply {
  /** Room the reply was posted into. */
  roomId: MatrixRoomId
  /** The human message event id this reply responds to, when known. */
  inReplyTo: string | null
  /** The reply body that was posted. */
  body: string
  /** Whether the post succeeded (false when the transport degraded). */
  ok: boolean
}

/** Options for posting into a room. */
export interface PostOptions {
  /** User ids to `m.mentions`; the body should carry the matching `@name` text. */
  mentions?: MatrixUserId[]
  /** Optional HTML rich-text body (`org.matrix.custom.html`). */
  html?: string
  /** Optional event id to reply to (renders as a quote/thread). */
  replyTo?: string
}

/** A file to post into a room. */
export interface PostFile {
  /** Filename reported to the media store and the `m.file` event. */
  filename: string
  /** MIME type of the bytes. */
  mimetype: string
}

/** Live transport status, for a settings/status surface. */
export interface MatrixChatStatus {
  /** Whether the bot client is started and syncing. */
  running: boolean
  /** The bot's Matrix user id, or null when unconfigured. */
  botUserId: MatrixUserId | null
  /** Current matrix-js-sdk sync state name, or null when not syncing. */
  syncState: string | null
  /** Number of rooms with a live agent inbox. */
  rooms: number
}

/**
 * Matrix chat transport (Cordis service key `ctx.matrixChat`).
 *
 * The bot client lifecycle is owned by the plugin as a reversible effect; these
 * methods are the imperative surface other plugins (and later the `@Remote`
 * gateway) use to post into rooms and inspect the transport.
 */
export interface MatrixChat {
  /** Current transport status. */
  status(): MatrixChatStatus
  /** Idempotently ensure the bot has joined a room. */
  ensureJoined(roomId: MatrixRoomId): Promise<boolean>
  /** Post an `m.text` message into a room as the bot. */
  postText(roomId: MatrixRoomId, body: string, options?: PostOptions): Promise<boolean>
  /** Upload bytes and post an `m.file` message into a room as the bot. */
  postFile(roomId: MatrixRoomId, bytes: Uint8Array, file: PostFile, options?: PostOptions): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Matrix chat transport; see {@link MatrixChat}. */
    matrixChat: MatrixChat
  }

  interface Events {
    /**
     * A human `m.text` room message was relayed into the agent inbox. Emitted
     * before the agent runs, so observers can log/annotate inbound traffic.
     * @param message - the relayed human message.
     * @mode emit
     */
    'matrix/room-message'(message: RoomMessage): void

    /**
     * An agent reply was posted back into a room (or the post degraded).
     * @param reply - the reply and its post outcome.
     * @mode emit
     */
    'matrix/room-reply'(reply: RoomReply): void

    /**
     * The bot transport changed running state (started, stopped, or reconnected).
     * @param status - the transport status snapshot at the transition.
     * @mode emit
     */
    'matrix/bot-state'(status: MatrixChatStatus): void
  }
}
