/**
 * Dev seed helper for the Phase-1 M3/M4 end-to-end checks.
 *
 * Provisions a throwaway demo Matrix account with a known password (so the
 * browser client can log in via Synapse directly — Mode B) and creates one demo
 * room with the agent bot invited and joined. It prints the coordinates the web
 * client needs (`VITE_ROOM_ID`) plus the dev-only demo credentials.
 *
 * This is a local-development tool against the local Synapse only. The demo
 * password is an intentionally fixed, non-secret throwaway for a local account;
 * the Synapse admin token is read from `server/.env` and never printed.
 *
 * Run from the `server/` directory:
 *   node --experimental-strip-types scripts/seed-demo.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRoom, ensureUser, joinRoomAs, type MatrixEndpoint,
} from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')

/** Load `server/.env` into process.env (existing keys win). */
function loadDotEnv(): void {
  let text: string
  try {
    text = readFileSync(resolve(serverRoot, '.env'), 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

const logger = {
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
}

/** Dev-only throwaway local account; not a real secret. */
const DEMO_LOCALPART = 'movie_demo'
const DEMO_PASSWORD = 'movie-demo-pass'

async function main(): Promise<void> {
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot seed.\n')
    process.exit(1)
  }
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }
  const demoUserId = `@${DEMO_LOCALPART}:${serverName}`

  const created = await ensureUser(endpoint, logger, demoUserId, {
    password: DEMO_PASSWORD,
    displayName: 'Movie Demo',
  })
  process.stdout.write(`demo user: ${demoUserId} (provisioned=${created})\n`)

  const roomId = await createRoom(endpoint, logger, 'Movie Demo Room', demoUserId, [botUserId])
  if (roomId === null) {
    process.stdout.write('room creation failed\n')
    process.exit(1)
  }
  // Ensure the bot is a member even if the host is not currently running.
  await joinRoomAs(endpoint, logger, botUserId, roomId)
  process.stdout.write(`demo room: ${roomId}\n`)
  process.stdout.write(`demo password: ${DEMO_PASSWORD} (dev-only throwaway)\n`)
  process.stdout.write(`\nStart the client with:\n  VITE_ROOM_ID='${roomId}' pnpm --dir ../client/web dev\n`)
}

void main()
