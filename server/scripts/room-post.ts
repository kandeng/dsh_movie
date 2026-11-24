/**
 * Room-post utility (live simulation narration).
 *
 * Brokers a Matrix token for the room host and posts one m.text message into
 * the room, exactly like `drive-episode-clip.ts`'s `say()` but standalone, so
 * every pipeline task can narrate decisions/results into the chatroom without
 * re-implementing the broker + PUT dance.
 *
 * The message body comes from (first that applies):
 *   1. `--file <path>`  — read the file verbatim (used for long work packages);
 *   2. the remaining argv joined by spaces;
 *   3. stdin (when piped).
 *
 * Run from the `server/` directory:
 *   node --experimental-strip-types scripts/room-post.ts "hello room"
 *   node --experimental-strip-types scripts/room-post.ts --file /tmp/pkg.txt
 *   node --experimental-strip-types scripts/room-post.ts --room '!abc:localhost' --user '@bob:localhost' "hi"
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brokerToken, type MatrixEndpoint } from '../plugins/dsh-matrix-identity/src/matrix-admin.ts'

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
    const val = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = val
  }
}

loadDotEnv()

const logger = {
  info(message: string, ...args: unknown[]): void {
    process.stdout.write(`${format(message, args)}\n`)
  },
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${format(message, args)}\n`)
  },
}

/** Minimal printf-style interpolation (%s / %d) for the logger lines. */
function format(message: string, args: unknown[]): string {
  let i = 0
  return message.replace(/%[sd]/g, (): string => String(args[i++] ?? ''))
}

const SYNAPSE = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
const SERVER_NAME = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
const ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN ?? ''

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let room = process.env.DRIVE_ROOM_ID ?? '!kSVxAPSTOJeHPiOPIh:localhost'
  let user = process.env.DRIVE_HOST_USER ?? `@dsh_demo.19r4u2n:${SERVER_NAME}`
  let file: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--room') { room = argv[++i] ?? room; continue }
    if (arg === '--user') { user = argv[++i] ?? user; continue }
    if (arg === '--file') { file = argv[++i]; continue }
    rest.push(arg)
  }

  let body = ''
  if (file !== undefined) body = readFileSync(file, 'utf8')
  else if (rest.length > 0) body = rest.join(' ')
  else body = await readStdin()
  body = body.trim()
  if (body === '') {
    logger.warn('empty message body; nothing to post')
    process.exit(2)
  }
  if (ADMIN_TOKEN === '') {
    logger.warn('SYNAPSE_ADMIN_TOKEN missing; cannot broker the host token')
    process.exit(1)
  }

  const endpoint: MatrixEndpoint = { baseUrl: SYNAPSE, serverName: SERVER_NAME, adminToken: ADMIN_TOKEN }
  const creds = await brokerToken(endpoint, logger, user)
  if (creds === null) {
    logger.warn('could not broker a token for %s', user)
    process.exit(1)
  }

  const txn = `roompost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const resp = await fetch(
    `${SYNAPSE}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ msgtype: 'm.text', body, format: 'org.matrix.custom.html', formatted_body: `<pre>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>` }),
    },
  )
  if (!resp.ok) {
    logger.warn('room post failed: HTTP %d %s', resp.status, (await resp.text()).slice(0, 200))
    process.exit(1)
  }
  logger.info('posted %d char(s) to room %s as %s', body.length, room, user)
  process.exit(0)
}

void main()
