/**
 * `dsh-matrix-identity`: a Synapse-backed identity provider exposed as the
 * Cordis service `ctx.matrixIdentity`. It adapts Synapse's stable Admin +
 * Client-Server APIs to DSH — provisioning hidden accounts idempotently,
 * brokering/introspecting access tokens, mapping a Matrix user to a stable DSH
 * principal, and syncing profile fields — without duplicating any identity
 * domain logic (no password hashing, JWT signing, or email on our side).
 *
 * Secrets stay in the credentials seam: config carries only a *reference*
 * (`adminTokenRef`, an environment-style name); the admin token value is
 * resolved per operation from `ctx.credentials` (which layers the stored file
 * over the launch env and `.env`), so a rotated token takes effect on the next
 * call with no plugin restart.
 *
 * Every network path degrades rather than throws: a Synapse outage yields
 * `null`/`false` and a log line, never a host crash.
 *
 * @module dsh-matrix-identity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  brokerToken as adminBrokerToken,
  ensureUser,
  passwordLogin,
  roomCreator,
  roomMembers,
  syncMatrixProfile,
  whoami as adminWhoami,
  type MatrixEndpoint,
} from './matrix-admin.ts'
import { startPrincipalListener, stopPrincipalListener } from './principal-listener.ts'
import type {
  BrokeredCredentials,
  MatrixIdentity,
  MatrixPrincipal,
  MatrixRoomId,
  MatrixUserId,
  ProvisionOptions,
  ProvisionResult,
  RoomRole,
} from './types.ts'

export type {
  BrokeredCredentials, MatrixIdentity, MatrixPrincipal, MatrixRoomId, MatrixUserId,
  ProvisionOptions, ProvisionResult, RoomRole,
} from './types.ts'

/** Stable Loader identity. */
export const name = 'matrix-identity'

/** The credentials seam supplies the admin token value; this plugin stores no secret. */
export const inject = ['credentials']

/** Plugin configuration: non-secret endpoint coordinates + the admin-token reference. */
export interface Config {
  /** Homeserver base URL, e.g. `http://127.0.0.1:8008`. */
  homeserverUrl: string
  /** The homeserver's `server_name`, e.g. `localhost`. */
  serverName: string
  /** Credential reference (env-style name) resolving to the Synapse admin token. */
  adminTokenRef: string
  /** Optional bot account mxid, exposed for the chat transport. */
  botUserId: string
  /** Lifetime of a `whoami` result cache entry, in milliseconds. */
  whoamiCacheMs: number
  /** Loopback port for the plugin-owned `/auth` principal listener; `0` disables it. */
  principalListenerPort: number
}

/** Schemastery validation + defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  homeserverUrl: z.string(),
  serverName: z.string(),
  adminTokenRef: z.string().default('SYNAPSE_ADMIN_TOKEN'),
  botUserId: z.string().default(''),
  whoamiCacheMs: z.number().min(0).default(60_000),
  principalListenerPort: z.number().min(0).default(0),
})

/** One cached `whoami` introspection. */
interface WhoamiCacheEntry {
  principal: MatrixPrincipal
  expiresAt: number
}

/** Strip a trailing slash so `${baseUrl}/path` never doubles up. */
function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** Split a fully qualified `@localpart:server` id into its parts. */
function splitUserId(userId: MatrixUserId, fallbackServer: string): { localpart: string; serverName: string } {
  const withoutAt = userId.startsWith('@') ? userId.slice(1) : userId
  const colon = withoutAt.indexOf(':')
  if (colon < 0) return { localpart: withoutAt, serverName: fallbackServer }
  return { localpart: withoutAt.slice(0, colon), serverName: withoutAt.slice(colon + 1) }
}

/**
 * Activate the identity provider: resolve the endpoint lazily per operation
 * (so a rotated admin token is picked up live), provide `ctx.matrixIdentity`,
 * and emit the typed provisioning/login/profile events siblings listen to.
 * @param ctx - host context with the `credentials` service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const baseUrl = normalizeBaseUrl(config.homeserverUrl)
  const serverName = config.serverName
  const whoamiCache = new Map<string, WhoamiCacheEntry>()

  /**
   * Resolve the live Synapse endpoint. The admin token comes from the
   * credentials seam on every call, so an unset/rotated token is reflected
   * immediately; an unconfigured token degrades to `null`.
   */
  async function resolveEndpoint(): Promise<MatrixEndpoint | null> {
    const resolved = await ctx.credentials.resolve(credentialRef(config.adminTokenRef))
    if (resolved === undefined || resolved.value.length === 0) {
      ctx.logger.warn(`[matrix-identity] admin token ref "${config.adminTokenRef}" is not set; identity degraded`)
      return null
    }
    return { baseUrl, serverName, adminToken: resolved.value }
  }

  const service: MatrixIdentity = {
    async isConfigured(): Promise<boolean> {
      return (await resolveEndpoint()) !== null
    },

    userIdFor(localpart: string): MatrixUserId {
      const bare = localpart.startsWith('@') ? splitUserId(localpart, serverName).localpart : localpart
      return `@${bare}:${serverName}`
    },

    async provisionUser(localpart: string, options: ProvisionOptions = {}): Promise<ProvisionResult> {
      const userId = service.userIdFor(localpart)
      const endpoint = await resolveEndpoint()
      if (endpoint === null) return { userId, provisioned: false }
      const provisioned = await ensureUser(endpoint, ctx.logger, userId, options)
      // Emit even on degrade so listeners observe the attempt; the flag tells
      // them whether Synapse actually accepted it.
      ctx.emit('matrix/user-provisioned', { userId, provisioned })
      return { userId, provisioned }
    },

    async brokerToken(userId: MatrixUserId): Promise<BrokeredCredentials | null> {
      const endpoint = await resolveEndpoint()
      if (endpoint === null) return null
      return adminBrokerToken(endpoint, ctx.logger, userId)
    },

    async login(user: string, password: string): Promise<BrokeredCredentials | null> {
      const endpoint = await resolveEndpoint()
      if (endpoint === null) return null
      const creds = await passwordLogin(endpoint, ctx.logger, user, password)
      if (creds === null) return null
      const principal = toPrincipal(creds.userId, creds.deviceId)
      ctx.emit('matrix/user-login', principal)
      return creds
    },

    async whoami(accessToken: string): Promise<MatrixPrincipal | null> {
      const now = Date.now()
      const cached = whoamiCache.get(accessToken)
      if (cached !== undefined && cached.expiresAt > now) return cached.principal
      const endpoint = await resolveEndpoint()
      if (endpoint === null) return null
      const result = await adminWhoami(endpoint, ctx.logger, accessToken)
      if (result === null) {
        whoamiCache.delete(accessToken)
        return null
      }
      const principal = toPrincipal(result.userId, result.deviceId)
      whoamiCache.set(accessToken, { principal, expiresAt: now + config.whoamiCacheMs })
      ctx.emit('matrix/user-login', principal)
      return principal
    },

    principalId(userId: MatrixUserId): string {
      // A stable, namespaced peer key: the same Matrix user always maps to the
      // same DSH principal, which is what per-user scoped Contexts key on.
      return `matrix:${userId}`
    },

    async syncProfile(userId: MatrixUserId, displayName?: string, avatarDataUri?: string): Promise<boolean> {
      const endpoint = await resolveEndpoint()
      if (endpoint === null) return false
      const ok = await syncMatrixProfile(endpoint, ctx.logger, userId, displayName, avatarDataUri)
      if (ok) ctx.emit('matrix/profile-changed', userId)
      return ok
    },

    async roomRole(roomId: MatrixRoomId, userId: MatrixUserId): Promise<RoomRole> {
      const endpoint = await resolveEndpoint()
      if (endpoint === null) return 'none'
      // The creator holds the `host` seat; everyone else who has joined is a
      // `member`. A degraded/empty lookup (Synapse down, unknown room, user not
      // in the member list) resolves to `none` so callers fail closed.
      const creator = await roomCreator(endpoint, roomId)
      if (creator.length > 0 && creator === userId) return 'host'
      const members = await roomMembers(endpoint, roomId)
      if (members.includes(userId)) return 'member'
      return 'none'
    },
  }

  /** Build a principal from a verified user id + device. */
  function toPrincipal(userId: MatrixUserId, deviceId: string | null): MatrixPrincipal {
    const { localpart } = splitUserId(userId, serverName)
    return { userId, localpart, serverName, deviceId }
  }

  ctx.provide('matrixIdentity', service)
  ctx.logger.info('[matrix-identity] identity provider active for server_name=%s at %s', serverName, baseUrl)

  // Optional Mode-B trust anchor: a loopback `/auth` listener the web client
  // presents its Matrix token to, so the host maps it to a DSH principal. Owned
  // as a reversible effect so a host reload never leaks the socket.
  if (config.principalListenerPort > 0) {
    ctx.effect(() => {
      const server = startPrincipalListener({
        port: config.principalListenerPort,
        identity: service,
        logger: ctx.logger,
      })
      return async () => {
        await stopPrincipalListener(server)
      }
    })
  }
}
