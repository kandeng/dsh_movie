/**
 * SDK configuration and coordinate helpers.
 *
 * The dsh_movie browser client talks to two origins:
 * - the Synapse homeserver (Leg A: Matrix Client-Server API), and
 * - the DSH host gateway (Leg B: ComfyUI execution channel, Leg C: JSON-RPC).
 *
 * A single {@link SdkConfig} carries both so every leg helper derives its URLs
 * from one place. The gateway is a loopback prototype in M1; production fronts
 * both origins behind Caddy and only these two base URLs change.
 *
 * @module @dsh-movie/sdk/config
 */

/** The two origins the SDK addresses. */
export interface SdkConfig {
  /** Synapse base URL, e.g. `http://127.0.0.1:8008` (Leg A). */
  homeserverUrl: string
  /** DSH host gateway base URL, e.g. `http://127.0.0.1:8788` (Legs B + C). */
  gatewayUrl: string
}

/**
 * Convert an `http(s)` gateway base URL into its `ws(s)` equivalent for the
 * Leg B execution socket and the Leg C stream mux.
 * @param gatewayUrl - the gateway HTTP base URL.
 * @returns the same origin with a WebSocket scheme.
 */
export function gatewayWsBase(gatewayUrl: string): string {
  return gatewayUrl.replace(/^http/, 'ws')
}

/** Strip a trailing slash so `${base}/path` never doubles up. */
export function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
