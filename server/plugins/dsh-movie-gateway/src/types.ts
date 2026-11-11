/**
 * Public contract of the `dsh-movie-gateway` plugin: the `ctx.movieGateway`
 * service handle and the value shapes it exposes to sibling plugins.
 *
 * The gateway is the Phase-2 generalization of the Phase-1 `/auth` listener: one
 * loopback HTTP + WS server that serves Leg B (ComfyUI-subset graph endpoints +
 * execution-lifecycle socket) and Leg C (the `POST /api/<ns>/<method>` JSON-RPC
 * dispatcher). It owns no identity logic — it maps a caller's Matrix access
 * token to a principal through `ctx.matrixIdentity`, so a single trust anchor
 * covers both legs.
 *
 * @module dsh-movie-gateway/types
 */

/** Where the gateway is listening (loopback prototype coordinates). */
export interface MovieGatewayInfo {
  /** Loopback TCP port the gateway is bound to. */
  port: number
  /** Base URL of the HTTP surface, e.g. `http://127.0.0.1:8788`. */
  url: string
  /** URL of the Leg B execution-lifecycle WebSocket. */
  execWsUrl: string
  /** URL of the Leg C multiplexed stream WebSocket. */
  muxWsUrl: string
}

/**
 * The gateway service (Cordis service key `ctx.movieGateway`).
 *
 * A thin introspection handle: the gateway runs itself as a reversible effect,
 * so siblings only need to know where it is listening (e.g. to advertise the
 * URLs to the browser client over Leg A chat).
 */
export interface MovieGateway {
  /** Whether the gateway HTTP/WS server is currently listening. */
  isListening(): boolean
  /** The loopback coordinates the gateway is serving on. */
  info(): MovieGatewayInfo
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Leg B/C browser gateway; see {@link MovieGateway}. */
    movieGateway: MovieGateway
  }
}
