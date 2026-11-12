/**
 * `@dsh-movie/sdk` - the dsh_movie browser client SDK.
 *
 * One typed surface over the three protocol legs, all typed by
 * `@dsh-movie/protocol` so the client and the DSH host gateway agree on every
 * wire shape:
 * - Leg A (`legA`): a thin `matrix-js-sdk` factory - Mode-B login/restore, sync
 *   lifecycle, text/media send, authenticated media URLs.
 * - Leg B (`legB`): the ComfyUI execution-lifecycle WebSocket client, prompt
 *   submission, and a minimal workflow->prompt flatten helper.
 * - Leg C (`legC`): the JSON-RPC HTTP client and the `/api/ws` stream mux,
 *   attaching the Matrix access token as the principal.
 *
 * @module @dsh-movie/sdk
 */

export * from './config.ts'
export * from './backoff.ts'
export * from './legA.ts'
export * from './legB.ts'
export * from './legC.ts'

// Re-export the Matrix client type so consumers can hold a client without
// importing matrix-js-sdk directly.
export type { MatrixClient } from 'matrix-js-sdk'
