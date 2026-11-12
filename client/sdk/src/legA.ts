/**
 * Leg A: the Matrix Client-Server leg, a thin factory over `matrix-js-sdk`.
 *
 * Mode B trust: the browser logs into Synapse *directly* (`loginWithPassword`),
 * keeps the resulting half-session (access token + user/device id), and can
 * later re-validate it with `whoami` on restore. The same access token is what
 * the client presents to the DSH host gateway (Legs B/C) so one login maps to
 * one principal everywhere.
 *
 * These helpers stay deliberately small: they cover login/restore, sync
 * lifecycle, sending text and media, and authenticated media URLs. The Chat
 * port (P2-M2) builds its richer room/timeline logic on top of the returned
 * `MatrixClient`.
 *
 * @module @dsh-movie/sdk/legA
 */

import { createClient, type MatrixClient } from 'matrix-js-sdk'
import { trimTrailingSlash, type SdkConfig } from './config.ts'

/** A persisted Matrix half-session (enough to resume without re-login). */
export interface MatrixSession {
  /** Matrix access token the client presents to the CS API and the gateway. */
  accessToken: string
  /** Fully qualified Matrix user id, e.g. `@alice:localhost`. */
  userId: string
  /** Device id Synapse assigned, when any. */
  deviceId: string | null
}

/** The result of validating an access token against `/account/whoami`. */
export interface WhoamiResult {
  /** Fully qualified Matrix user id the token belongs to. */
  userId: string
  /** Device id the token belongs to, when Synapse reports one. */
  deviceId: string | null
}

/** The media kind selector mapped onto Matrix `msgtype` values. */
export type MediaKind = 'image' | 'video' | 'audio' | 'file'

/** Map a {@link MediaKind} to its Matrix message type. */
function msgtypeFor(kind: MediaKind): string {
  switch (kind) {
    case 'image':
      return 'm.image'
    case 'video':
      return 'm.video'
    case 'audio':
      return 'm.audio'
    default:
      return 'm.file'
  }
}

/**
 * The loosened `sendEvent` signature.
 *
 * matrix-js-sdk v42 types `sendEvent`'s content by `msgtype` via a nominal enum
 * and an XOR content type that is awkward to construct literally, and the method
 * relies on its `this` receiver internally. So (mirroring the chat plugin's
 * proven room poster) we `.bind(client)` and cast to a plain record-content
 * signature; the runtime behaviour is identical.
 */
type BoundSend = (
  roomId: string,
  eventType: string,
  content: Record<string, unknown>,
) => Promise<{ event_id: string }>

/** Bind a client's `sendEvent` into the loosened {@link BoundSend} form. */
function boundSend(client: MatrixClient): BoundSend {
  return client.sendEvent.bind(client) as unknown as BoundSend
}

/**
 * Log into Synapse directly with a password (Mode B) and return the half-session.
 * @param config - the SDK config carrying the homeserver URL.
 * @param user - the localpart or fully qualified user id.
 * @param password - the account password.
 * @returns the persisted session; rejects when Synapse refuses the login.
 */
export async function loginWithPassword(config: SdkConfig, user: string, password: string): Promise<MatrixSession> {
  const client = createClient({ baseUrl: trimTrailingSlash(config.homeserverUrl) })
  try {
    const response = await client.loginWithPassword(user, password)
    return {
      accessToken: response.access_token,
      userId: response.user_id,
      deviceId: response.device_id,
    }
  } finally {
    client.stopClient()
  }
}

/**
 * Validate an access token against `/account/whoami` (used to restore a session
 * without re-login). Mirrors the host's own `whoami` introspection.
 * @param config - the SDK config carrying the homeserver URL.
 * @param accessToken - the token to validate.
 * @returns the whoami result, or `null` when the token is rejected.
 */
export async function whoami(config: SdkConfig, accessToken: string): Promise<WhoamiResult | null> {
  const url = `${trimTrailingSlash(config.homeserverUrl)}/_matrix/client/v3/account/whoami`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) return null
  const body = (await response.json()) as { user_id?: unknown; device_id?: unknown }
  if (typeof body.user_id !== 'string') return null
  return {
    userId: body.user_id,
    deviceId: typeof body.device_id === 'string' ? body.device_id : null,
  }
}

/**
 * Create a `MatrixClient` from a persisted session (no sync started yet).
 * @param config - the SDK config carrying the homeserver URL.
 * @param session - the half-session to resume.
 * @returns an unstarted Matrix client authenticated with the session token.
 */
export function createMatrixClient(config: SdkConfig, session: MatrixSession): MatrixClient {
  return createClient({
    baseUrl: trimTrailingSlash(config.homeserverUrl),
    accessToken: session.accessToken,
    userId: session.userId,
    timelineSupport: true,
    ...(session.deviceId !== null ? { deviceId: session.deviceId } : {}),
  })
}

/**
 * Begin syncing. Call once after {@link createMatrixClient} to receive events.
 * @param client - the client to start.
 * @param initialSyncLimit - how many messages to fetch per room on first sync.
 */
export function startSync(client: MatrixClient, initialSyncLimit = 30): void {
  client.startClient({ initialSyncLimit })
}

/**
 * Stop syncing and release the client's connections.
 * @param client - the client to stop.
 */
export function stopSync(client: MatrixClient): void {
  client.stopClient()
}

/**
 * Send a plain text message into a room.
 * @param client - an authenticated, started client.
 * @param roomId - the target room id.
 * @param body - the message text.
 * @returns the sent event id.
 */
export async function sendText(client: MatrixClient, roomId: string, body: string): Promise<string> {
  const response = await boundSend(client)(roomId, 'm.room.message', { msgtype: 'm.text', body })
  return response.event_id
}

/**
 * Upload a file and send it into a room as the given media kind.
 * @param client - an authenticated, started client.
 * @param roomId - the target room id.
 * @param file - the browser `File`/`Blob` to upload.
 * @param kind - the media kind selecting the Matrix `msgtype`.
 * @param body - optional caption; defaults to the file name.
 * @returns the sent event id.
 */
export async function sendMedia(
  client: MatrixClient,
  roomId: string,
  file: File,
  kind: MediaKind,
  body?: string,
): Promise<string> {
  const upload = await client.uploadContent(file)
  const response = await boundSend(client)(roomId, 'm.room.message', {
    msgtype: msgtypeFor(kind),
    body: body ?? file.name,
    url: upload.content_uri,
  })
  return response.event_id
}

/**
 * Resolve an `mxc://` uri to an authenticated media HTTP URL.
 * @param client - an authenticated client (supplies the media token).
 * @param mxc - the `mxc://` content uri.
 * @returns the authenticated download URL, or `null` when unresolved.
 */
export function mxcToHttp(client: MatrixClient, mxc: string): string | null {
  // The 7th flag requests an authenticated-media URL (Synapse MSC3916 path),
  // matching the Chat port's authenticated media download.
  return client.mxcUrlToHttp(mxc, undefined, undefined, undefined, undefined, undefined, true)
}

/**
 * Set the account's display name (Matrix `PUT .../profile/{userId}/displayname`).
 * @param config - the SDK config carrying the homeserver URL.
 * @param session - the authenticated half-session (token + user id).
 * @param displayName - the new display name.
 */
export async function setDisplayName(
  config: SdkConfig,
  session: MatrixSession,
  displayName: string,
): Promise<void> {
  const url = `${trimTrailingSlash(config.homeserverUrl)}/_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/displayname`
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayname: displayName }),
  })
  if (!response.ok) throw new Error(`displayname HTTP ${response.status}`)
}

/**
 * Upload an image blob and set it as the account's avatar.
 *
 * The upload goes through `matrix-js-sdk`'s `uploadContent` so it targets the
 * correct (authenticated-media) upload endpoint for the pinned SDK version;
 * the resulting `mxc://` uri is then written to the profile's `avatar_url`.
 * @param config - the SDK config carrying the homeserver URL.
 * @param session - the authenticated half-session (token + user id).
 * @param blob - the avatar image bytes.
 * @returns the uploaded `mxc://` content uri now set as the avatar.
 */
export async function setAvatar(
  config: SdkConfig,
  session: MatrixSession,
  blob: Blob,
): Promise<string> {
  const client = createClient({
    baseUrl: trimTrailingSlash(config.homeserverUrl),
    accessToken: session.accessToken,
    userId: session.userId,
  })
  try {
    const upload = await client.uploadContent(blob)
    const mxc = upload.content_uri
    const url = `${trimTrailingSlash(config.homeserverUrl)}/_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/avatar_url`
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ avatar_url: mxc }),
    })
    if (!response.ok) throw new Error(`avatar_url HTTP ${response.status}`)
    return mxc
  } finally {
    client.stopClient()
  }
}

/**
 * Change the account password.
 *
 * Drives the user-interactive-authentication (UIA) flow directly against
 * `POST /_matrix/client/v3/account/password`: the first request returns a UIA
 * `session` (401), which is then replayed with password auth. Devices are
 * logged out so a stale token cannot survive the change; the caller should
 * re-login afterwards.
 * @param config - the SDK config carrying the homeserver URL.
 * @param session - the authenticated half-session (token + user id).
 * @param oldPassword - the current password (for UIA).
 * @param newPassword - the password to set.
 */
export async function changePassword(
  config: SdkConfig,
  session: MatrixSession,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const url = `${trimTrailingSlash(config.homeserverUrl)}/_matrix/client/v3/account/password`
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
  }
  const bodyFor = (uiaSession?: string) => JSON.stringify({
    auth: {
      type: 'm.login.password',
      user: session.userId,
      password: oldPassword,
      ...(uiaSession ? { session: uiaSession } : {}),
    },
    new_password: newPassword,
    logout_devices: true,
  })

  const first = await fetch(url, { method: 'POST', headers, body: bodyFor() })
  if (first.ok) return
  // A 401 with a UIA session id means "authenticate to continue"; replay once.
  if (first.status === 401) {
    const challenge = (await first.json().catch(() => null)) as { session?: unknown } | null
    const uiaSession = typeof challenge?.session === 'string' ? challenge.session : undefined
    const second = await fetch(url, { method: 'POST', headers, body: bodyFor(uiaSession) })
    if (second.ok) return
    throw new Error(`changePassword HTTP ${second.status}`)
  }
  throw new Error(`changePassword HTTP ${first.status}`)
}
