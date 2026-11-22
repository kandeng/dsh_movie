/**
 * Dynamic ComfyUI endpoint resolution over a ZeroTier overlay.
 *
 * The remote GPU host (H20) sits behind an enterprise firewall with no inbound
 * access; it is reached through a ZeroTier private network. A member's managed
 * IP is assigned by the ZeroTier controller and is *stable for the life of the
 * (network, member) pair* — it does not change per reconnect or reboot — but it
 * DOES change if the network is recreated or the member is removed/re-added.
 * To avoid baking a possibly-stale IP into a static config file, this module
 * resolves the member's *current* managed IP at runtime from the ZeroTier
 * Central API and returns a ready-to-use ComfyUI base URL.
 *
 * Resolution is best-effort and fail-closed: without a controller API token, or
 * on any network/parse error, it returns `undefined` and the caller falls back
 * to its statically-configured endpoints (e.g. the local loopback backend).
 *
 * @module dsh-movie-gateway/movie-executor/comfy-zerotier
 */

/** A reference to one ZeroTier network member whose managed IP we resolve. */
export interface ZerotierMemberRef {
  /** The 16-hex private network id (e.g. `2873fd00f2cc42ff`). */
  networkId: string
  /** The 10-hex node address of the member (e.g. `3e8f2d44bc`). */
  nodeAddress: string
  /** TCP port the ComfyUI API listens on at that member (default 8188). */
  port: number
}

/** ZeroTier Central controller API base (reachable from this host). */
const CENTRAL_API = 'https://my.zerotier.com/api/v1'

/**
 * Parse the ZeroTier member reference from the environment.
 * `DSH_COMFY_ZEROTIER` is `<networkId>/<nodeAddress>`; `DSH_COMFY_ZEROTIER_PORT`
 * overrides the ComfyUI port (default 8188). Returns `undefined` when unset or
 * malformed so the caller can treat "not configured" as "no dynamic endpoint".
 * @param env - the process environment (injectable for tests).
 */
export function zerotierRefFromEnv(env: NodeJS.ProcessEnv = process.env): ZerotierMemberRef | undefined {
  const raw = (env['DSH_COMFY_ZEROTIER'] ?? '').trim()
  if (raw === '') return undefined
  const [networkId, nodeAddress] = raw.split('/').map((part): string => part.trim())
  if (networkId === undefined || nodeAddress === undefined || networkId === '' || nodeAddress === '') return undefined
  const port = Number(env['DSH_COMFY_ZEROTIER_PORT'] ?? '8188')
  return {
    networkId,
    nodeAddress,
    port: Number.isFinite(port) && port > 0 ? port : 8188,
  }
}

/** The subset of the Central member envelope we depend on. */
interface CentralMember {
  config?: { authorized?: boolean; ipAssignments?: string[] }
  ipAssignments?: string[]
}

/**
 * Resolve the member's current managed IP into a ComfyUI base URL.
 * Returns `undefined` when the member is unauthorized, has no managed IP, or
 * the controller is unreachable — the caller must fall back, never guess.
 * @param ref - the network member to resolve.
 * @param token - a ZeroTier Central API bearer token (admin of the network).
 * @param timeoutMs - per-request timeout for the controller call.
 */
export async function resolveZerotierBaseUrl(
  ref: ZerotierMemberRef,
  token: string,
  timeoutMs = 8_000,
): Promise<string | undefined> {
  if (token === '') return undefined
  const url = `${CENTRAL_API}/network/${ref.networkId}/member/${ref.nodeAddress}`
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return undefined
  const member = (await response.json()) as CentralMember
  const authorized = member.config?.authorized
  if (authorized !== true) return undefined
  const assignments = member.config?.ipAssignments ?? member.ipAssignments ?? []
  const ip = assignments.find((entry): boolean => entry.trim() !== '')
  if (ip === undefined) return undefined
  return `http://${ip}:${ref.port}`
}
