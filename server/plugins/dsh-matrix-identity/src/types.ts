/**
 * Public contract of the `dsh-matrix-identity` plugin: the `ctx.matrixIdentity`
 * service, the value shapes it exchanges, and the typed events it emits for
 * sibling plugins (the chat transport joins/invites on provision).
 *
 * The plugin is a thin adaptation layer over Synapse's stable Admin + Client-
 * Server APIs; no identity domain logic is duplicated here. Every network
 * helper degrades rather than throws, so a Synapse outage never takes the DSH
 * host down — callers receive `null`/`false` and fall back.
 *
 * @module dsh-matrix-identity/types
 */

/** A fully qualified Matrix user id, e.g. `@alice:localhost`. */
export type MatrixUserId = string

/** A Matrix room id, e.g. `!abc:localhost`. */
export type MatrixRoomId = string

/**
 * A user's role within a room, resolved from Synapse's room state:
 * - `host` — the seat holding the top power level (Phase-3 P3-M5); the room
 *   creator is the initial host, and the seat can be transferred to a member.
 * - `member` — a joined participant who is not the current host.
 * - `none` — not a member of the room (or the role could not be resolved).
 */
export type RoomRole = 'host' | 'member' | 'none'

/** The DSH-side principal a Matrix user maps to (stable peer key). */
export interface MatrixPrincipal {
  /** Fully qualified Matrix user id. */
  userId: MatrixUserId
  /** Bare localpart, without the leading `@` or the `:server` suffix. */
  localpart: string
  /** The homeserver's `server_name`. */
  serverName: string
  /** Device the introspected token belongs to, when Synapse reports one. */
  deviceId: string | null
}

/** Client credentials brokered for a hidden Matrix account. */
export interface BrokeredCredentials {
  /** Matrix access token the client presents to the CS API. */
  accessToken: string
  /** The account the token belongs to. */
  userId: MatrixUserId
  /** Device id Synapse assigned, when any. */
  deviceId: string | null
}

/** Options for idempotent provisioning of a hidden account. */
export interface ProvisionOptions {
  /** Explicit password; a random unusable one is generated when omitted. */
  password?: string
  /** Display name to set on the account profile. */
  displayName?: string
  /** Whether the account is a Synapse server admin. */
  admin?: boolean
}

/** Result of a provisioning attempt. */
export interface ProvisionResult {
  /** The fully qualified user id that was created/updated. */
  userId: MatrixUserId
  /** True when Synapse accepted the create/update; false when it degraded. */
  provisioned: boolean
}

/**
 * Synapse-backed identity provider (Cordis service key `ctx.matrixIdentity`).
 *
 * Authentication modes (Phase 1):
 * - Mode A (brokered): {@link login} against the CS API, or {@link brokerToken}
 *   via the Admin puppet-login flow for a hidden account.
 * - Mode B (direct, default): the web client logs into Synapse itself and
 *   presents its Matrix token; the host introspects it with {@link whoami} and
 *   maps it to a {@link MatrixPrincipal} via {@link principalId}.
 */
export interface MatrixIdentity {
  /** Whether a reachable Synapse endpoint and admin token are configured. */
  isConfigured(): Promise<boolean>
  /** Build the fully qualified Matrix user id for a bare localpart. */
  userIdFor(localpart: string): MatrixUserId
  /** Idempotently create/update a hidden Matrix account for a localpart. */
  provisionUser(localpart: string, options?: ProvisionOptions): Promise<ProvisionResult>
  /** Broker a client token for a hidden account via the Admin puppet-login flow. */
  brokerToken(userId: MatrixUserId): Promise<BrokeredCredentials | null>
  /** Password login against the CS API (Mode A). Returns credentials or `null`. */
  login(user: string, password: string): Promise<BrokeredCredentials | null>
  /** Introspect a Matrix access token via `whoami` (cached). Principal or `null`. */
  whoami(accessToken: string): Promise<MatrixPrincipal | null>
  /** Map a Matrix user id to a stable DSH principal (peer) id. */
  principalId(userId: MatrixUserId): string
  /** Sync display name and/or avatar (data URI) into the Matrix profile. */
  syncProfile(userId: MatrixUserId, displayName?: string, avatarDataUri?: string): Promise<boolean>
  /**
   * Resolve a user's role in a room from Synapse's room state. The host seat is
   * whoever holds the top power level (falling back to the room creator when
   * power levels are unavailable); any other joined member is a `member`; a
   * non-member (or a degraded lookup) is `none`. Downstream policy keys
   * privileged, graph-mutating actions on `host` (Phase-3 P3-M5).
   */
  roomRole(roomId: MatrixRoomId, userId: MatrixUserId): Promise<RoomRole>
  /**
   * Resolve the current host seat for a room (top power level; creator
   * fallback). Returns `null` when it cannot be determined.
   */
  roomHost(roomId: MatrixRoomId): Promise<MatrixUserId | null>
  /**
   * Transfer the host seat to `targetUserId` by editing the room's
   * `m.room.power_levels` (target -> 100, prior host -> 50), signed with the
   * ACTING host's own Matrix token. Returns the new host mxid, or `null` when
   * degraded/refused.
   */
  transferHost(roomId: MatrixRoomId, actingToken: string, targetUserId: MatrixUserId): Promise<MatrixUserId | null>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Synapse-backed identity provider; see {@link MatrixIdentity}. */
    matrixIdentity: MatrixIdentity
  }

  interface Events {
    /**
     * A hidden Matrix account was idempotently created or updated. The chat
     * transport listens to join/invite provisioned users into their rooms.
     * @param result - the provisioning outcome, including its degraded flag.
     * @mode emit
     */
    'matrix/user-provisioned'(result: ProvisionResult): void

    /**
     * A Matrix access token was verified and mapped to a principal (Mode A
     * login or Mode B whoami). Downstream plugins may seed per-user state.
     * @param principal - the verified principal.
     * @mode emit
     */
    'matrix/user-login'(principal: MatrixPrincipal): void

    /**
     * A user's Matrix profile (display name / avatar) was synced.
     * @param userId - the account whose profile changed.
     * @mode emit
     */
    'matrix/profile-changed'(userId: MatrixUserId): void
  }
}
