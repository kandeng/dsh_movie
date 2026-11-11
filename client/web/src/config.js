/**
 * Runtime configuration for the minimal Phase-1 web client.
 *
 * Every value can be overridden with a `VITE_*` environment variable at build
 * or dev time (Vite exposes `import.meta.env`); the defaults target the local
 * development stack: a Synapse homeserver on 8008, the DSH movie host's
 * identity-plugin `/auth` listener on 8787, and the server-side agent bot.
 */
export const config = {
  /** Synapse Client-Server base URL (the browser talks to Synapse directly). */
  homeserverUrl: import.meta.env.VITE_HS_URL ?? 'http://127.0.0.1:8008',
  /** The homeserver's `server_name`, used to expand a bare localpart. */
  serverName: import.meta.env.VITE_SERVER_NAME ?? 'localhost',
  /** DSH host identity-plugin `/auth` listener (Mode-B principal proof). */
  authUrl: import.meta.env.VITE_AUTH_URL ?? 'http://127.0.0.1:8787',
  /** The server-side agent bot to invite into the room. */
  botUserId: import.meta.env.VITE_BOT_ID ?? '@vidsay_bot:localhost',
  /** Optional pre-seeded room id; when empty the client creates a fresh room. */
  demoRoomId: import.meta.env.VITE_ROOM_ID ?? '',
}
