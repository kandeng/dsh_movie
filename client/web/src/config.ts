/**
 * Runtime configuration for the dsh_movie browser client (Phase 2).
 *
 * Every value can be overridden with a `VITE_*` environment variable at build
 * or dev time (Vite exposes `import.meta.env`). The defaults target the local
 * development stack: a Synapse homeserver on 8008, the DSH movie host gateway
 * on 8788 (Leg B/C), the identity plugin `/auth` listener on 8787, and the
 * server-side agent bot.
 */
import type { SdkConfig } from "@dsh-movie/sdk";

export const clientConfig = {
  /** Synapse Client-Server base URL (the browser talks to Synapse directly). */
  homeserverUrl: import.meta.env.VITE_HS_URL ?? "http://127.0.0.1:8008",
  /** The homeserver's `server_name`, used to expand a bare localpart. */
  serverName: import.meta.env.VITE_SERVER_NAME ?? "localhost",
  /** DSH movie host gateway base URL (Leg B `/ws`, Leg C `/api`). */
  gatewayUrl: import.meta.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:8788",
  /** DSH host identity-plugin `/auth` listener (Phase-1 Mode-B principal proof). */
  authUrl: import.meta.env.VITE_AUTH_URL ?? "http://127.0.0.1:8787",
  /** The server-side agent bot to invite into the room. */
  botUserId: import.meta.env.VITE_BOT_ID ?? "@vidsay_bot:localhost",
} as const;

/**
 * The SDK-facing slice of the config: Leg A talks to Synapse, Legs B/C talk to
 * the movie host gateway.
 */
export const sdkConfig: SdkConfig = {
  homeserverUrl: clientConfig.homeserverUrl,
  gatewayUrl: clientConfig.gatewayUrl,
};

/** Expand a bare localpart (`alice`) into a full mxid (`@alice:serverName`). */
export function toMatrixId(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith("@")) return trimmed;
  return `@${trimmed}:${clientConfig.serverName}`;
}
