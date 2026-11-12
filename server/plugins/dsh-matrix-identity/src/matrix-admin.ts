/**
 * Low-level Synapse HTTP client: Admin API (user CRUD, puppet-login token
 * brokering, room membership) plus the small Client-Server API surface the
 * identity plugin needs (password login, whoami, profile writes, media upload).
 *
 * Ported from the vidsay read-only source `apps/server/src/utils/matrix/admin.ts`
 * with these adaptations:
 * - Bun/Express config globals replaced by an explicit {@link MatrixEndpoint}
 *   resolved once by the plugin from Cordis config + the credentials seam.
 * - `console.error` replaced by an injected logger so diagnostics flow through
 *   `ctx.logger`.
 * - Chinese comments rewritten in English; behavior is preserved.
 *
 * Design principle (unchanged): every helper degrades rather than throws. A
 * Synapse outage must never take the DSH host down, so failures return
 * `null`/`false`/empty and are logged, letting callers fall back.
 *
 * @module dsh-matrix-identity/matrix-admin
 */

import { randomBytes } from 'node:crypto'
import type { BrokeredCredentials, MatrixRoomId, MatrixUserId } from './types.ts'

/** A resolved Synapse endpoint: where it lives and the admin token that governs it. */
export interface MatrixEndpoint {
  /** Base URL of the homeserver, e.g. `http://127.0.0.1:8008` (no trailing slash). */
  baseUrl: string
  /** The homeserver's `server_name`, e.g. `localhost`. */
  serverName: string
  /** A Synapse server-admin access token. */
  adminToken: string
}

/** Minimal structured logger the plugin passes down (matches `ctx.logger`). */
export interface AdminLogger {
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** JSON headers carrying a bearer token. */
function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

/**
 * Generate a random password nobody will ever use: a hidden Matrix account
 * still requires a password field, but no human logs in with it directly.
 * @returns a 48-hex-character random string.
 */
export function randomPassword(): string {
  return randomBytes(24).toString('hex')
}

/** Truncate a response body for a safe, bounded log line. */
async function bodyPreview(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200)
  } catch {
    return '<unreadable body>'
  }
}

/**
 * Idempotently create or update a Matrix account
 * (`PUT /_synapse/admin/v2/users/<mxid>`). Synapse treats a PUT for an
 * existing user as an update, so re-provisioning is safe.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param mxid - fully qualified user id to create/update.
 * @param options - optional password, display name, admin flag.
 * @returns true when Synapse accepted the write; false when it degraded.
 */
export async function ensureUser(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  mxid: MatrixUserId,
  options: { password?: string; displayName?: string; admin?: boolean } = {},
): Promise<boolean> {
  const body: Record<string, unknown> = { password: options.password ?? randomPassword() }
  if (options.displayName) body.displayname = options.displayName
  if (options.admin !== undefined) body.admin = options.admin
  try {
    const response = await fetch(`${endpoint.baseUrl}/_synapse/admin/v2/users/${mxid}`, {
      method: 'PUT',
      headers: authHeaders(endpoint.adminToken),
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      logger.warn(`[matrix] ensureUser ${mxid} -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return false
    }
    return true
  } catch (error) {
    logger.warn(`[matrix] ensureUser ${mxid} failed: ${String(error)}`)
    return false
  }
}

/**
 * Broker client credentials for a hidden account via the Admin puppet-login flow
 * (`POST /_synapse/admin/v1/users/<mxid>/login`, Synapse >= 1.49). The user never
 * sees a Matrix password; the host signs a token on their behalf.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param mxid - fully qualified user id to broker for.
 * @returns the brokered credentials, or `null` when unavailable.
 */
export async function brokerToken(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  mxid: MatrixUserId,
): Promise<BrokeredCredentials | null> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/_synapse/admin/v1/users/${mxid}/login`, {
      method: 'POST',
      headers: authHeaders(endpoint.adminToken),
      body: '{}',
    })
    if (!response.ok) {
      logger.warn(`[matrix] brokerToken ${mxid} -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return null
    }
    const data = await response.json() as { access_token: string; device_id?: string }
    return { accessToken: data.access_token, userId: mxid, deviceId: data.device_id ?? null }
  } catch (error) {
    logger.warn(`[matrix] brokerToken ${mxid} failed: ${String(error)}`)
    return null
  }
}

/**
 * Password login against the Client-Server API (Mode A) using
 * `m.id.user` identifier (`POST /_matrix/client/v3/login`).
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param user - the localpart or fully qualified user id.
 * @param password - the account password.
 * @returns brokered credentials, or `null` when login failed/degraded.
 */
export async function passwordLogin(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  user: string,
  password: string,
): Promise<BrokeredCredentials | null> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
      }),
    })
    if (!response.ok) {
      logger.warn(`[matrix] passwordLogin ${user} -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return null
    }
    const data = await response.json() as { access_token: string; user_id: string; device_id?: string }
    return { accessToken: data.access_token, userId: data.user_id, deviceId: data.device_id ?? null }
  } catch (error) {
    logger.warn(`[matrix] passwordLogin ${user} failed: ${String(error)}`)
    return null
  }
}

/**
 * Introspect a Matrix access token (`GET /_matrix/client/v3/account/whoami`).
 * This is the trust anchor for Mode B: the browser presents its own Synapse
 * token and the host verifies who it belongs to before mapping a principal.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param accessToken - the token to introspect.
 * @returns `{ userId, deviceId }`, or `null` when the token is invalid/unreachable.
 */
export async function whoami(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  accessToken: string,
): Promise<{ userId: MatrixUserId; deviceId: string | null } | null> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/_matrix/client/v3/account/whoami`, {
      headers: authHeaders(accessToken),
    })
    if (!response.ok) {
      logger.warn(`[matrix] whoami -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return null
    }
    const data = await response.json() as { user_id: string; device_id?: string }
    return { userId: data.user_id, deviceId: data.device_id ?? null }
  } catch (error) {
    logger.warn(`[matrix] whoami failed: ${String(error)}`)
    return null
  }
}

/**
 * Create a room, optionally as a specific creator so that account becomes the
 * `m.room.create` sender (the front-end "host"). Falls back to the admin token
 * when no creator is given or brokering fails.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param name - the room name.
 * @param creatorMxid - optional account that should own the room.
 * @param invite - optional user ids to invite at creation.
 * @returns the new room id, or `null` on failure.
 */
export async function createRoom(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  name: string,
  creatorMxid?: MatrixUserId,
  invite: MatrixUserId[] = [],
): Promise<MatrixRoomId | null> {
  let token = endpoint.adminToken
  if (creatorMxid) {
    const creds = await brokerToken(endpoint, logger, creatorMxid)
    if (creds) token = creds.accessToken
    else logger.warn(`[matrix] createRoom could not broker ${creatorMxid}; falling back to admin`)
  }
  try {
    const response = await fetch(`${endpoint.baseUrl}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name, visibility: 'private', preset: 'private_chat', invite }),
    })
    if (!response.ok) {
      logger.warn(`[matrix] createRoom -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return null
    }
    const data = await response.json() as { room_id: string }
    return data.room_id
  } catch (error) {
    logger.warn(`[matrix] createRoom failed: ${String(error)}`)
    return null
  }
}

/**
 * Read a room's creator mxid (`GET /_synapse/admin/v1/rooms/<roomId>`).
 * @param endpoint - resolved Synapse endpoint.
 * @param roomId - the room to inspect.
 * @returns the creator mxid, or an empty string when unavailable.
 */
export async function roomCreator(endpoint: MatrixEndpoint, roomId: MatrixRoomId): Promise<string> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`, {
      headers: authHeaders(endpoint.adminToken),
    })
    if (!response.ok) return ''
    const data = await response.json() as { creator?: unknown }
    return typeof data.creator === 'string' ? data.creator : ''
  } catch {
    return ''
  }
}

/**
 * Read a room's current member mxids
 * (`GET /_synapse/admin/v1/rooms/<roomId>/members`).
 * @param endpoint - resolved Synapse endpoint.
 * @param roomId - the room to inspect.
 * @returns member mxids, or an empty array when unavailable.
 */
export async function roomMembers(endpoint: MatrixEndpoint, roomId: MatrixRoomId): Promise<MatrixUserId[]> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`, {
      headers: authHeaders(endpoint.adminToken),
    })
    if (!response.ok) return []
    const data = await response.json() as { members?: unknown }
    return Array.isArray(data.members) ? data.members.filter((m): m is string => typeof m === 'string') : []
  } catch {
    return []
  }
}

/** The Matrix power level that marks the room `host` seat (Phase-3 P3-M5). */
export const HOST_POWER_LEVEL = 100

/** The power level a prior host is demoted to on transfer (still a member). */
export const DEMOTED_POWER_LEVEL = 50

/** A room's `m.room.power_levels` content (the subset the host model uses). */
export interface RoomPowerLevels {
  /** Per-user power levels (only joined/explicitly-listed users appear). */
  users: Record<MatrixUserId, number>
  /** The default level for users not listed in `users`. */
  usersDefault: number
}

/**
 * Read one current state event's content via the Synapse ADMIN API
 * (`GET /_synapse/admin/v1/rooms/<roomId>/state`). The client state API
 * (`/_matrix/client/v3/rooms/<id>/state/...`) forbids a non-member reader when
 * room previews are disabled, and the admin token's user is typically NOT a
 * member of user rooms; the admin endpoint reads any room's state server-wide.
 * @param endpoint - resolved Synapse endpoint.
 * @param roomId - the room to inspect.
 * @param type - the state event type (e.g. `m.room.power_levels`).
 * @param stateKey - the state key (default the empty key).
 * @returns the event content, or `null` when unavailable (degraded).
 */
export async function roomStateContent(
  endpoint: MatrixEndpoint,
  roomId: MatrixRoomId,
  type: string,
  stateKey = '',
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `${endpoint.baseUrl}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`,
      { headers: authHeaders(endpoint.adminToken) },
    )
    if (!response.ok) return null
    const data = await response.json() as { state?: unknown }
    if (!Array.isArray(data.state)) return null
    for (const entry of data.state) {
      if (typeof entry !== 'object' || entry === null) continue
      const event = entry as { type?: unknown; state_key?: unknown; content?: unknown }
      if (event.type !== type) continue
      const key = typeof event.state_key === 'string' ? event.state_key : ''
      if (key !== stateKey) continue
      return typeof event.content === 'object' && event.content !== null
        ? event.content as Record<string, unknown>
        : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read a room's `m.room.power_levels` content via the Synapse admin API (see
 * {@link roomStateContent}); works for rooms the admin token's user has not joined.
 * @param endpoint - resolved Synapse endpoint.
 * @param roomId - the room to inspect.
 * @returns the power-level subset, or `null` when unavailable (degraded).
 */
export async function roomPowerLevels(endpoint: MatrixEndpoint, roomId: MatrixRoomId): Promise<RoomPowerLevels | null> {
  const content = await roomStateContent(endpoint, roomId, 'm.room.power_levels')
  if (content === null) return null
  const users: Record<MatrixUserId, number> = {}
  if (content.users !== null && typeof content.users === 'object') {
    for (const [mxid, level] of Object.entries(content.users as Record<string, unknown>)) {
      if (typeof level === 'number') users[mxid] = level
    }
  }
  const usersDefault = typeof content.users_default === 'number' ? content.users_default : 0
  return { users, usersDefault }
}

/**
 * Resolve the host seat from power levels: the single user at or above
 * {@link HOST_POWER_LEVEL}, tie-broken by mxid for determinism.
 * @param pl - the room power levels (or null).
 * @returns the host mxid, or an empty string when nobody holds the host level.
 */
export function hostFromPowerLevels(pl: RoomPowerLevels | null): MatrixUserId | '' {
  if (pl === null) return ''
  let best: MatrixUserId | '' = ''
  let bestLevel = Number.NEGATIVE_INFINITY
  for (const [mxid, level] of Object.entries(pl.users)) {
    if (level < HOST_POWER_LEVEL) continue
    if (level > bestLevel || (level === bestLevel && (best === '' || mxid < best))) {
      best = mxid
      bestLevel = level
    }
  }
  return best
}

/**
 * Transfer the room `host` seat to `targetUserId` by editing
 * `m.room.power_levels`: the target is raised to {@link HOST_POWER_LEVEL} and
 * every prior holder of that level is demoted to {@link DEMOTED_POWER_LEVEL}.
 * The PUT is signed with the ACTING host's own token (a level-100 user is
 * authorized to edit power_levels), and the rest of the content (events, ban,
 * kick, ...) is preserved verbatim.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param roomId - the room whose host seat moves.
 * @param actingToken - the current host's Matrix access token.
 * @param targetUserId - the member being promoted to host.
 * @returns the new host mxid, or an empty string when degraded/refused.
 */
export async function setRoomHostAs(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  roomId: MatrixRoomId,
  actingToken: string,
  targetUserId: MatrixUserId,
): Promise<MatrixUserId | ''> {
  const stateUrl = `${endpoint.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`
  try {
    // Read the CURRENT full content via the admin API so the PUT preserves every
    // field (events/users_default/ban/kick/...); the client state GET would 403
    // for the non-member admin token and wipe them on the subsequent PUT.
    const content: Record<string, unknown> = (await roomStateContent(endpoint, roomId, 'm.room.power_levels')) ?? {}
    const rawUsers = content.users !== null && typeof content.users === 'object'
      ? content.users as Record<string, unknown>
      : {}
    const users: Record<MatrixUserId, number> = {}
    for (const [mxid, level] of Object.entries(rawUsers)) {
      if (typeof level === 'number') users[mxid] = level
    }
    for (const [mxid, level] of Object.entries(users)) {
      if (level >= HOST_POWER_LEVEL && mxid !== targetUserId) users[mxid] = DEMOTED_POWER_LEVEL
    }
    users[targetUserId] = HOST_POWER_LEVEL
    const next = { ...content, users }
    const put = await fetch(stateUrl, {
      method: 'PUT',
      headers: authHeaders(actingToken),
      body: JSON.stringify(next),
    })
    if (!put.ok) {
      logger.warn(`[matrix] setRoomHostAs -> HTTP ${put.status}: ${await bodyPreview(put)}`)
      return ''
    }
    return targetUserId
  } catch (error) {
    logger.warn(`[matrix] setRoomHostAs failed: ${String(error)}`)
    return ''
  }
}

/**
 * Invite a target into a room as a given inviter. A target already in the room
 * is treated as success (idempotent), matching the vidsay provisioning pattern.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param inviterMxid - the account that sends the invite.
 * @param roomId - the room to invite into.
 * @param targetMxid - the account being invited.
 * @returns true when invited or already present; false when degraded.
 */
export async function inviteToRoom(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  inviterMxid: MatrixUserId,
  roomId: MatrixRoomId,
  targetMxid: MatrixUserId,
): Promise<boolean> {
  const creds = await brokerToken(endpoint, logger, inviterMxid)
  if (!creds) return false
  try {
    const response = await fetch(
      `${endpoint.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { method: 'POST', headers: authHeaders(creds.accessToken), body: JSON.stringify({ user_id: targetMxid }) },
    )
    if (!response.ok) {
      const detail = await bodyPreview(response)
      // Synapse rejects a redundant invite with 403 "is already in the room";
      // for provisioning that is the desired end state, so it counts as success.
      if (detail.includes('is already in the room')) return true
      logger.warn(`[matrix] inviteToRoom ${targetMxid} -> HTTP ${response.status}: ${detail}`)
      return false
    }
    return true
  } catch (error) {
    logger.warn(`[matrix] inviteToRoom ${targetMxid} failed: ${String(error)}`)
    return false
  }
}

/**
 * Join a room as a given account (brokering its token first). An account
 * already joined yields a Synapse no-op success.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param mxid - the account that accepts the invite.
 * @param roomId - the room to join.
 * @returns true when joined; false when degraded.
 */
export async function joinRoomAs(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  mxid: MatrixUserId,
  roomId: MatrixRoomId,
): Promise<boolean> {
  const creds = await brokerToken(endpoint, logger, mxid)
  if (!creds) return false
  try {
    const response = await fetch(
      `${endpoint.baseUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { method: 'POST', headers: authHeaders(creds.accessToken), body: '{}' },
    )
    if (!response.ok) {
      logger.warn(`[matrix] joinRoomAs ${mxid} -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return false
    }
    return true
  } catch (error) {
    logger.warn(`[matrix] joinRoomAs ${mxid} failed: ${String(error)}`)
    return false
  }
}

/**
 * Send an `m.text` message into a room as a given account (brokering its token
 * first). The transaction id makes the send idempotent, so a retry never
 * double-posts.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param mxid - the sending account.
 * @param roomId - the target room.
 * @param body - the message text.
 * @returns true when sent; false when degraded.
 */
export async function sendTextAs(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  mxid: MatrixUserId,
  roomId: MatrixRoomId,
  body: string,
): Promise<boolean> {
  const creds = await brokerToken(endpoint, logger, mxid)
  if (!creds) return false
  const txnId = `dsh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  try {
    const response = await fetch(
      `${endpoint.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
      + `/send/m.room.message/${encodeURIComponent(txnId)}`,
      { method: 'PUT', headers: authHeaders(creds.accessToken), body: JSON.stringify({ msgtype: 'm.text', body }) },
    )
    if (!response.ok) {
      logger.warn(`[matrix] sendTextAs ${mxid} -> HTTP ${response.status}: ${await bodyPreview(response)}`)
      return false
    }
    return true
  } catch (error) {
    logger.warn(`[matrix] sendTextAs ${mxid} failed: ${String(error)}`)
    return false
  }
}

/**
 * Sync a display name and/or avatar into a Matrix account's profile. The avatar
 * arrives as a data URI: it is uploaded to the media store to obtain an
 * `mxc://` uri, then written to `avatar_url`. Any step failing only logs.
 * @param endpoint - resolved Synapse endpoint.
 * @param logger - diagnostics sink.
 * @param mxid - the account whose profile is updated.
 * @param displayName - optional new display name.
 * @param avatarDataUri - optional `data:image/...;base64,...` avatar.
 * @returns true when the sync ran (best-effort); false when brokering failed.
 */
export async function syncMatrixProfile(
  endpoint: MatrixEndpoint,
  logger: AdminLogger,
  mxid: MatrixUserId,
  displayName?: string,
  avatarDataUri?: string,
): Promise<boolean> {
  const creds = await brokerToken(endpoint, logger, mxid)
  if (!creds) return false
  const headers = authHeaders(creds.accessToken)
  const encoded = encodeURIComponent(mxid)
  try {
    if (displayName) {
      const response = await fetch(`${endpoint.baseUrl}/_matrix/client/v3/profile/${encoded}/displayname`, {
        method: 'PUT', headers, body: JSON.stringify({ displayname: displayName }),
      })
      if (!response.ok) logger.warn(`[matrix] syncProfile displayname ${mxid} -> HTTP ${response.status}`)
    }
    const match = avatarDataUri
      ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(avatarDataUri)
      : null
    if (match) {
      const upload = await fetch(`${endpoint.baseUrl}/_matrix/media/v3/upload?filename=avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': match[1]! },
        body: Buffer.from(match[2]!, 'base64'),
      })
      if (upload.ok) {
        const { content_uri: contentUri } = await upload.json() as { content_uri?: string }
        if (contentUri) {
          const response = await fetch(`${endpoint.baseUrl}/_matrix/client/v3/profile/${encoded}/avatar_url`, {
            method: 'PUT', headers, body: JSON.stringify({ avatar_url: contentUri }),
          })
          if (!response.ok) logger.warn(`[matrix] syncProfile avatar ${mxid} -> HTTP ${response.status}`)
        }
      } else {
        logger.warn(`[matrix] syncProfile avatar upload ${mxid} -> HTTP ${upload.status}`)
      }
    }
    return true
  } catch (error) {
    logger.warn(`[matrix] syncProfile ${mxid} failed: ${String(error)}`)
    return false
  }
}
