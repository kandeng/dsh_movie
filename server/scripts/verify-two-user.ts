/**
 * Two-user end-to-end verifier for the Phase-1 M4 hardening milestone.
 *
 * Provisions two distinct demo accounts (a room `host` = creator, and a
 * `member`), stands up a room between them plus the agent bot, and verifies the
 * full trust + policy chain through the running DSH host's `/auth/*` listener:
 *
 *  1. each Matrix token maps to its own distinct DSH principal (`matrix:<mxid>`);
 *  2. room role policy resolves the creator to `host`, a joined participant to
 *     `member`, and a non-member to `none` (fail-closed);
 *  3. a human message relay works deterministically between the two users —
 *     the member sends into the room and the host reads it back from the room
 *     timeline via the Client-Server API.
 *
 * The relay check deliberately reads the room timeline rather than asserting on
 * a bot reply, so it is independent of any other backend sharing the bot mxid.
 * Tokens and the Synapse admin token are never printed.
 *
 * Run from the `server/` directory (host must be up with principalListenerPort):
 *   node --experimental-strip-types scripts/verify-two-user.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokerToken, createRoom, ensureUser, joinRoomAs, sendTextAs,
  type MatrixEndpoint,
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

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** POST a token to `/auth/principal` and return the parsed body. */
async function askPrincipal(authUrl: string, token: string): Promise<{ status: number; principalId: string | undefined; userId: string | undefined }> {
  const resp = await fetch(`${authUrl}/auth/principal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const data = await resp.json() as { principalId?: string; principal?: { userId?: string } }
  return { status: resp.status, principalId: data.principalId, userId: data.principal?.userId }
}

/** POST a token + room to `/auth/role` and return the resolved role. */
async function askRole(authUrl: string, token: string, roomId: string): Promise<{ status: number; role: string | undefined }> {
  const resp = await fetch(`${authUrl}/auth/role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, roomId }),
  })
  const data = await resp.json() as { role?: string }
  return { status: resp.status, role: data.role }
}

/** Read the most recent room messages as a given user via the CS API. */
async function recentBodies(baseUrl: string, token: string, roomId: string, limit = 30): Promise<string[]> {
  const url = `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) return []
  const data = await resp.json() as { chunk?: Array<{ type?: string; content?: { body?: unknown } }> }
  if (!Array.isArray(data.chunk)) return []
  return data.chunk
    .filter((event): boolean => event.type === 'm.room.message' && typeof event.content?.body === 'string')
    .map((event): string => String(event.content?.body))
}

/** Dev-only throwaway local accounts; not real secrets. */
const HOST_LOCALPART = 'movie_host'
const MEMBER_LOCALPART = 'movie_member'
const OUTSIDER_LOCALPART = 'movie_outsider'
const DEMO_PASSWORD = 'movie-two-user-pass'

async function main(): Promise<void> {
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const authUrl = process.env.AUTH_URL ?? 'http://127.0.0.1:8787'
  const botUserId = process.env.SYNAPSE_BOT_USER_ID ?? `@vidsay_bot:${serverName}`
  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot verify.\n')
    process.exit(1)
  }
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }

  const hostId = `@${HOST_LOCALPART}:${serverName}`
  const memberId = `@${MEMBER_LOCALPART}:${serverName}`
  const outsiderId = `@${OUTSIDER_LOCALPART}:${serverName}`

  // 1. Provision the three accounts idempotently (host, member, and an outsider
  //    that will NOT be in the room, to prove the fail-closed `none` role).
  await ensureUser(endpoint, logger, hostId, { password: DEMO_PASSWORD, displayName: 'Movie Host' })
  await ensureUser(endpoint, logger, memberId, { password: DEMO_PASSWORD, displayName: 'Movie Member' })
  await ensureUser(endpoint, logger, outsiderId, { password: DEMO_PASSWORD, displayName: 'Movie Outsider' })

  // 2. Host creates the room (becomes its creator), invites member + bot, joins them.
  const roomId = await createRoom(endpoint, logger, 'Movie Two-User Room', hostId, [memberId, botUserId])
  check('host created the two-user room', roomId !== null, roomId ?? 'none')
  if (roomId === null) process.exit(1)
  await joinRoomAs(endpoint, logger, memberId, roomId)
  await joinRoomAs(endpoint, logger, botUserId, roomId)

  // 3. Broker a token for each account — exactly what each logged-in browser holds.
  const hostCreds = await brokerToken(endpoint, logger, hostId)
  const memberCreds = await brokerToken(endpoint, logger, memberId)
  const outsiderCreds = await brokerToken(endpoint, logger, outsiderId)
  check('brokered tokens for all three accounts', hostCreds !== null && memberCreds !== null && outsiderCreds !== null)
  if (hostCreds === null || memberCreds === null || outsiderCreds === null) process.exit(1)

  const health = await fetch(`${authUrl}/auth/health`)
  check('host /auth/health answers ok', health.ok && (await health.json() as { ok?: boolean }).ok === true)

  // 4. Distinct principals: each token maps to its own stable DSH principal id.
  const hostPrincipal = await askPrincipal(authUrl, hostCreds.accessToken)
  const memberPrincipal = await askPrincipal(authUrl, memberCreds.accessToken)
  check('host token mapped to the host principal', hostPrincipal.status === 200 && hostPrincipal.userId === hostId, hostPrincipal.userId ?? 'none')
  check('member token mapped to the member principal', memberPrincipal.status === 200 && memberPrincipal.userId === memberId, memberPrincipal.userId ?? 'none')
  check('principals are distinct (host != member)', hostPrincipal.principalId === `matrix:${hostId}` && memberPrincipal.principalId === `matrix:${memberId}` && hostPrincipal.principalId !== memberPrincipal.principalId)

  // 5. Role policy: creator=host, joined participant=member, non-member=none.
  const hostRole = await askRole(authUrl, hostCreds.accessToken, roomId)
  const memberRole = await askRole(authUrl, memberCreds.accessToken, roomId)
  const outsiderRole = await askRole(authUrl, outsiderCreds.accessToken, roomId)
  check('host resolves to role "host"', hostRole.status === 200 && hostRole.role === 'host', hostRole.role ?? 'none')
  check('member resolves to role "member"', memberRole.status === 200 && memberRole.role === 'member', memberRole.role ?? 'none')
  check('non-member resolves to role "none" (fail-closed)', outsiderRole.status === 200 && outsiderRole.role === 'none', outsiderRole.role ?? 'none')

  // 6. Deterministic relay: the member sends a unique message into the room and
  //    the host reads it back from the timeline (independent of any bot reply).
  const marker = `two-user-relay-${Date.now()}`
  const sent = await sendTextAs(endpoint, logger, memberId, roomId, marker)
  check('member sent a message into the room', sent)
  let seen = false
  for (let attempt = 0; attempt < 10 && !seen; attempt += 1) {
    const bodies = await recentBodies(baseUrl, hostCreds.accessToken, roomId)
    seen = bodies.includes(marker)
    if (!seen) await new Promise(r => setTimeout(r, 500))
  }
  check('host read the member message back from the timeline', seen, seen ? marker : 'not observed')

  // 7. The outsider is barred from the room timeline (CS API denies a non-member).
  const outsiderBodies = await recentBodies(baseUrl, outsiderCreds.accessToken, roomId)
  check('non-member cannot read the room timeline', outsiderBodies.length === 0)

  process.stdout.write(failures === 0 ? '\nALL TWO-USER E2E CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
