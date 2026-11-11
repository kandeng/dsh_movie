/**
 * `dsh-movie-gateway`: the Phase-2 Leg B/C browser gateway, exposed as the
 * Cordis service `ctx.movieGateway`.
 *
 * It generalizes the Phase-1 `/auth` listener into one loopback HTTP + WS server
 * (see `gateway-server.ts`): Leg C is a `POST /api/<ns>/<method>` JSON-RPC
 * dispatcher (auth/registry/assets in M1), and Leg B is a ComfyUI-subset surface
 * (`/object_info`, `/system_stats`, `/prompt`, `/queue`, `/history`) plus the
 * `/ws` execution-lifecycle socket. The gateway owns no identity logic — it maps
 * a caller's Matrix access token to a principal through the injected
 * `ctx.matrixIdentity`, so a single trust anchor covers both legs, and gates the
 * host-only `assets/list` op on `matrixIdentity.roomRole`.
 *
 * The server runs as a reversible effect: a host reload tears the socket down
 * and releases the port. The identity plugin's own `8787` `/auth` listener stays
 * intact, so the Phase-1 verification scripts remain green.
 *
 * @module dsh-movie-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startGatewayServer, type GatewayHandle } from './gateway-server.ts'
import type { MovieGateway, MovieGatewayInfo } from './types.ts'

export type { MovieGateway, MovieGatewayInfo } from './types.ts'

/** Stable Loader identity. */
export const name = 'movie-gateway'

/** The gateway resolves callers through the identity provider. */
export const inject = ['matrixIdentity']

/** Plugin configuration: the loopback port to bind. */
export interface Config {
  /** Loopback port for the Leg B/C gateway; `0` disables it. */
  port: number
}

/** Schemastery validation + defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  port: z.number().min(0).default(8788),
})

/** Build the gateway's loopback coordinates for a port. */
function coordinatesFor(port: number): MovieGatewayInfo {
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    execWsUrl: `ws://127.0.0.1:${port}/ws`,
    muxWsUrl: `ws://127.0.0.1:${port}/api/ws`,
  }
}

/**
 * Activate the gateway: provide `ctx.movieGateway` and, when a port is set, run
 * the HTTP/WS server as a reversible effect.
 * @param ctx - host context with the `matrixIdentity` service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let handle: GatewayHandle | null = null
  const fallback = coordinatesFor(config.port)

  const service: MovieGateway = {
    isListening(): boolean {
      return handle?.isListening() ?? false
    },
    info(): MovieGatewayInfo {
      return handle?.info() ?? fallback
    },
  }

  ctx.provide('movieGateway', service)

  if (config.port > 0) {
    ctx.effect(() => {
      handle = startGatewayServer({
        port: config.port,
        identity: ctx.matrixIdentity,
        logger: ctx.logger,
      })
      ctx.logger.info('[movie-gateway] Leg B/C gateway active on port %d', config.port)
      return async () => {
        const current = handle
        handle = null
        if (current !== null) await current.stop()
      }
    })
  } else {
    ctx.logger.warn('[movie-gateway] port is 0; gateway disabled')
  }
}
