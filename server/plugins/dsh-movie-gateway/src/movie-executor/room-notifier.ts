/**
 * Phase-5 D15/D8 room notifier — the `customer_service` voice of the executor.
 *
 * Two room-facing messages originate from a graph run:
 *  - **D15 unavailable-model notice:** when a generator whose modality has no
 *    configured model is executed, `customer_service` posts
 *    {@link MODEL_UNAVAILABLE_NOTICE} into the room so the user knows to add a
 *    model in Settings rather than seeing a silent placeholder.
 *  - **D8 artifact echo:** every successfully `executed` output is posted into
 *    the room so the Chat stage shows each step's representation regardless of
 *    which page triggered the run.
 *
 * The notifier is deliberately decoupled from `dsh-matrix-chat`: it depends only
 * on a minimal {@link RoomPoster} (`postText`), which `ctx.matrixChat` satisfies
 * structurally. When no poster is injected or the run carries no room (the Leg B
 * `/prompt` surface is room-agnostic until the client threads `room_id`), every
 * post degrades to a log line — the run still behaves correctly, it just has
 * nowhere to speak. This keeps the isolated verifier (matrix-chat disabled)
 * green while exercising the seam with a fake poster.
 *
 * @module dsh-movie-gateway/movie-executor/room-notifier
 */

import { MODEL_UNAVAILABLE_NOTICE } from './model-catalog.ts'

/** The minimal room-posting seam (`ctx.matrixChat` is structurally compatible). */
export interface RoomPoster {
  /**
   * Post an `m.text` message into a room.
   * @param roomId - the target room.
   * @param body - the message text.
   * @returns true when the post succeeded.
   */
  postText(roomId: string, body: string): Promise<boolean>
}

/** Minimal diagnostics sink (matches `ctx.logger`). */
export interface NotifierLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The artifact kind being echoed (D8), chosen for the room message framing. */
export type EchoKind = 'text' | 'media'

/** The executor's room-facing message seam. */
export interface RoomNotifier {
  /**
   * Post the D15 unavailable-model notice for one generator node.
   * @param roomId - the room to notify (empty → log-only degrade).
   * @param classType - the generator class that was executed.
   * @param modality - the unbacked modality.
   */
  notifyModelUnavailable(roomId: string, classType: string, modality: string): Promise<void>
  /**
   * Echo one executed artifact into the room (D8).
   * @param roomId - the room to post into (empty → log-only degrade).
   * @param classType - the producing node class.
   * @param artifact - the artifact text (or media reference/URL).
   * @param kind - whether the artifact is text or media.
   */
  echoArtifact(roomId: string, classType: string, artifact: string, kind: EchoKind): Promise<void>
}

/**
 * Build the room notifier.
 * @param poster - the room-posting seam (`ctx.matrixChat`), or `undefined` when
 * the chat transport is absent (e.g. the isolated verifier).
 * @param logger - diagnostics sink.
 * @returns the notifier; every post degrades to a log line without a poster/room.
 */
export function createRoomNotifier(poster: RoomPoster | undefined, logger: NotifierLogger): RoomNotifier {
  /** Post one body into a room, degrading to a log line when there is nowhere to speak. */
  async function post(roomId: string, body: string, what: string): Promise<void> {
    if (poster === undefined || roomId === '') {
      logger.info('[movie-executor] %s skipped (no room/poster): %s', what, body.slice(0, 120))
      return
    }
    try {
      const ok = await poster.postText(roomId, body)
      if (!ok) logger.warn('[movie-executor] %s degraded for room %s', what, roomId)
    } catch (error) {
      logger.warn('[movie-executor] %s failed for room %s: %s', what, roomId, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    async notifyModelUnavailable(roomId: string, classType: string, modality: string): Promise<void> {
      await post(roomId, `${MODEL_UNAVAILABLE_NOTICE} (node "${classType}", ${modality})`, 'model-unavailable notice (D15)')
    },
    async echoArtifact(roomId: string, classType: string, artifact: string, kind: EchoKind): Promise<void> {
      if (artifact === '') return
      const body = kind === 'media' ? `[${classType}] ${artifact}` : artifact
      await post(roomId, body, 'artifact echo (D8)')
    },
  }
}
