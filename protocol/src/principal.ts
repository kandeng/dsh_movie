/**
 * Shared principal/role contract for dsh_movie.
 *
 * These are the wire shapes the browser client, the client SDK, and the DSH
 * host gateway all agree on for "who is calling" and "what seat do they hold in
 * a room". They intentionally mirror the Phase-1 `ctx.matrixIdentity` types so
 * a Matrix access token maps to the same principal on both sides of the wire.
 *
 * Contract-as-code only: pure types plus tiny pure helpers, no runtime proxies
 * and no external dependencies, so both the tsx server and the Vite client can
 * import it directly from source.
 *
 * @module @dsh-movie/protocol/principal
 */

/** A fully qualified Matrix user id, e.g. `@alice:localhost`. */
export type MatrixUserId = string

/** A Matrix room id, e.g. `!abc:localhost`. */
export type MatrixRoomId = string

/**
 * A caller's role within a room (resolved from Synapse room state):
 * - `host`   - the seat holding the top power level (the room creator is the
 *              initial host; the seat is transferable - Phase-3 P3-M5).
 * - `member` - a joined participant who is not the current host.
 * - `none`   - not a member, or the role could not be resolved (fail-closed).
 */
export type RoomRole = 'host' | 'member' | 'none'

/** The DSH-side principal a Matrix user maps to (stable peer key). */
export interface Principal {
  /** Fully qualified Matrix user id. */
  userId: MatrixUserId
  /** Bare localpart, without the leading `@` or the `:server` suffix. */
  localpart: string
  /** The homeserver's `server_name`. */
  serverName: string
  /** Device the introspected token belongs to, when Synapse reports one. */
  deviceId: string | null
}

/**
 * Build the stable, namespaced DSH principal id for a Matrix user. Matches the
 * identity plugin's `principalId()` so both sides derive the same peer key.
 * @param userId - a fully qualified Matrix user id.
 * @returns the principal id, e.g. `matrix:@alice:localhost`.
 */
export function principalIdOf(userId: MatrixUserId): string {
  return `matrix:${userId}`
}

/**
 * Extract the bare localpart from a fully qualified `@localpart:server` id.
 * Used for display fallbacks where no profile display name is set.
 * @param userId - a fully qualified Matrix user id.
 * @returns the localpart without `@` or the `:server` suffix.
 */
export function localpartOf(userId: MatrixUserId): string {
  if (userId === '') return ''
  const bare = userId.startsWith('@') ? userId.slice(1) : userId
  const colon = bare.indexOf(':')
  return colon < 0 ? bare : bare.slice(0, colon)
}

/** Whether a resolved role grants the privileged `host` seat. */
export function isHostRole(role: RoomRole): boolean {
  return role === 'host'
}
