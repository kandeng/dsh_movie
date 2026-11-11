/**
 * Room poster: sends `m.text` and `m.file` events into a room as the bot, with
 * optional `m.mentions`, HTML rich text, and reply-threading.
 *
 * Ported from the vidsay read-only source `apps/server/src/matrix/roomPost.ts`.
 * Two matrix-js-sdk v42 quirks are preserved deliberately:
 * - `sendEvent` must be `.bind(client)`-ed: internally it relies on `this`
 *   (`addThreadRelationIfNeeded`), so destructuring/assigning loses the receiver
 *   and throws a TypeError at runtime.
 * - v42 types `sendEvent`'s content by `msgtype` strictly, so custom fields
 *   (`m.mentions`, `m.relates_to`) are passed through a loosened signature.
 *
 * @module dsh-matrix-chat/room-post
 */

import * as sdk from 'matrix-js-sdk'
import type { PostFile, PostOptions } from './types.ts'

/** The imperative poster bound to one bot client. */
export interface RoomPoster {
  /** Send an `m.text` message. */
  sendText(roomId: string, body: string, options?: PostOptions): Promise<void>
  /** Upload bytes and send an `m.file` message. */
  sendFile(roomId: string, bytes: Uint8Array, file: PostFile, options?: PostOptions): Promise<void>
}

/** Build the optional relation/mention fields shared by text and file posts. */
function relate(options?: PostOptions): Record<string, unknown> {
  return {
    ...(options?.mentions?.length ? { 'm.mentions': { user_ids: options.mentions } } : {}),
    ...(options?.html ? { format: 'org.matrix.custom.html', formatted_body: options.html } : {}),
    ...(options?.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: options.replyTo } } } : {}),
  }
}

/**
 * Create a room poster over a live bot client.
 * @param client - the started matrix-js-sdk client (the bot).
 * @returns the imperative poster.
 */
export function createRoomPoster(client: sdk.MatrixClient): RoomPoster {
  // Must stay bound to the client; see the module note on the v42 `this` quirk.
  const sendRoomMessage = client.sendEvent.bind(client) as unknown as (
    roomId: string, eventType: string, content: Record<string, unknown>,
  ) => Promise<unknown>
  return {
    async sendText(roomId, body, options) {
      await sendRoomMessage(roomId, sdk.EventType.RoomMessage, {
        msgtype: sdk.MsgType.Text, body, ...relate(options),
      })
    },
    async sendFile(roomId, bytes, file, options) {
      const uploaded = await client.uploadContent(bytes, { name: file.filename, type: file.mimetype })
      await sendRoomMessage(roomId, sdk.EventType.RoomMessage, {
        msgtype: sdk.MsgType.File,
        body: file.filename,
        filename: file.filename,
        url: uploaded.content_uri,
        info: { mimetype: file.mimetype, size: bytes.byteLength },
        ...relate(options),
      })
    },
  }
}
