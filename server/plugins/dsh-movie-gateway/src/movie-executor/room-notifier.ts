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
import { txnNarrationBody } from '@dsh-movie/protocol'

/** The minimal room-posting seam (`ctx.matrixChat` is structurally compatible). */
export interface RoomPoster {
  /**
   * Post an `m.text` message into a room.
   * @param roomId - the target room.
   * @param body - the message text.
   * @returns true when the post succeeded.
   */
  postText(roomId: string, body: string): Promise<boolean>
  /**
   * Phase 8 P8-M3: upload media bytes and post them as an `m.image`/`m.video`/
   * `m.file` message. Optional — posters without media support keep text-only.
   * @param roomId - the target room.
   * @param bytes - the raw media bytes.
   * @param filename - the file name presented in the room.
   * @param mime - the media MIME type (selects the message type).
   * @returns the uploaded `mxc://` content URI, or `undefined` on failure.
   */
  postMedia?(roomId: string, bytes: Uint8Array, filename: string, mime: string): Promise<string | undefined>
}

/**
 * Phase 8 P8-M3: persists generated media bytes under the room's workspace
 * directory (`<roomDir>/artifacts/`). `workspaceStore.writeArtifact` satisfies
 * this; absent in the isolated verifier (media then rides Matrix only).
 */
export interface ArtifactWriter {
  /**
   * Write bytes to a room-relative path (zip-slip guarded by the store).
   * @returns true when the file was written.
   */
  writeArtifact(roomId: string, relPath: string, bytes: Uint8Array): boolean
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
  /**
   * Phase 8 P8-M3: echo real generated media bytes into the room — upload to
   * Matrix (when the poster supports media) and persist a local copy under the
   * room's `artifacts/` directory (when a writer is injected).
   * @param roomId - the room to post into (empty → no-op).
   * @param classType - the producing node class.
   * @param nodeId - the producing node id (names the local artifact file).
   * @param bytes - the raw media bytes.
   * @param filename - the backend's file name.
   * @param mime - the media MIME type.
   * @returns the posted `mxc://` uri and/or room-relative path, or `undefined`
   * when neither sink was available (the run still succeeds).
   */
  echoMediaFile(roomId: string, classType: string, nodeId: string, bytes: Uint8Array, filename: string, mime: string): Promise<{ uri?: string | undefined; path?: string | undefined } | undefined>
  /**
   * Narrate one committed op-script transaction into the room (D9).
   *
   * Posts a SINGLE batched, collapsible system message summarizing every op the
   * transaction applied (e.g. `+ ImageGenerator #7; edge #3→#7`) — never one
   * message per op or per keystroke. The body carries the shared
   * {@link TXN_NARRATION_PREFIX} sentinel so the client timeline renders it as a
   * collapsible system entry. An empty summary posts nothing.
   * @param roomId - the room to narrate into (empty → log-only degrade).
   * @param summary - the one-line op summary produced by the op applier.
   */
  narrateTxn(roomId: string, summary: string): Promise<void>
}

/**
 * Build the room notifier.
 * @param poster - the room-posting seam (`ctx.matrixChat`), or `undefined` when
 * the chat transport is absent (e.g. the isolated verifier).
 * @param logger - diagnostics sink.
 * @param artifactWriter - optional Phase-8 local artifact persistence seam.
 * @returns the notifier; every post degrades to a log line without a poster/room.
 */
export function createRoomNotifier(poster: RoomPoster | undefined, logger: NotifierLogger, artifactWriter?: ArtifactWriter): RoomNotifier {
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
    async echoMediaFile(roomId: string, classType: string, nodeId: string, bytes: Uint8Array, filename: string, mime: string): Promise<{ uri?: string | undefined; path?: string | undefined } | undefined> {
      if (roomId === '') return undefined
      const result: { uri?: string | undefined; path?: string | undefined } = {}
      // Local copy under <roomDir>/artifacts/ (P8-M3): the file name is
      // sanitized and the store guards the room-relative path (zip-slip).
      if (artifactWriter !== undefined) {
        const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_')
        const relPath = `artifacts/${nodeId.replace(/[^A-Za-z0-9._-]/g, '_')}-${safeName}`
        try {
          if (artifactWriter.writeArtifact(roomId, relPath, bytes)) result.path = relPath
        } catch (error) {
          logger.warn('[movie-executor] artifact write failed for room %s: %s', roomId, error instanceof Error ? error.message : String(error))
        }
      }
      // Matrix media message (m.image/m.video/m.file) when the poster supports it.
      if (poster?.postMedia !== undefined) {
        try {
          const uri = await poster.postMedia(roomId, bytes, filename, mime)
          if (uri !== undefined && uri !== '') result.uri = uri
        } catch (error) {
          logger.warn('[movie-executor] media post failed for room %s: %s', roomId, error instanceof Error ? error.message : String(error))
        }
      }
      if (result.uri === undefined && result.path === undefined) {
        logger.info('[movie-executor] media echo skipped (no media sinks) for %s in room %s', classType, roomId)
        return undefined
      }
      logger.info('[movie-executor] media echo (P8-M3) %s in room %s: uri=%s path=%s', classType, roomId, result.uri ?? '-', result.path ?? '-')
      return result
    },
    async narrateTxn(roomId: string, summary: string): Promise<void> {
      if (summary === '') return
      await post(roomId, txnNarrationBody(summary), 'txn narration (D9)')
    },
  }
}
