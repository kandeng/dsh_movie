/**
 * Dev verifier for the Phase-1 Mode-B principal path (M3/M4).
 *
 * Brokers a Matrix token for the seeded demo account through the Synapse Admin
 * API (exactly the kind of token a logged-in browser holds), then presents it to
 * the DSH host's `/auth/principal` listener and checks that the host maps it
 * back to the correct principal. Also asserts an invalid token is rejected and
 * the health endpoint answers. Tokens are never printed.
 *
 * Run from the `server/` directory (host must be up with principalListenerPort):
 *   node --experimental-strip-types scripts/verify-principal.ts
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

async function main(): Promise<void> {
  const baseUrl = process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008'
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const authUrl = process.env.AUTH_URL ?? 'http://127.0.0.1:8787'
  const demoUserId = `@movie_demo:${serverName}`
  if (adminToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot verify.\n')
    process.exit(1)
  }
  const endpoint: MatrixEndpoint = { baseUrl, serverName, adminToken }

  const health = await fetch(`${authUrl}/auth/health`)
  check('GET /auth/health answers ok', health.ok && (await health.json() as { ok?: boolean }).ok === true)

  const creds = await brokerToken(endpoint, logger, demoUserId)
  check('brokered a demo token via the Admin API', creds !== null && creds.accessToken.length > 0)
  if (creds === null) process.exit(1)

  const resp = await fetch(`${authUrl}/auth/principal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: creds.accessToken }),
  })
  const data = await resp.json() as {
    ok?: boolean
    principal?: { userId?: string; localpart?: string }
    principalId?: string
  }
  check('POST /auth/principal accepted a valid token', resp.status === 200 && data.ok === true, `status=${resp.status}`)
  check('host mapped the token to the demo user', data.principal?.userId === demoUserId, data.principal?.userId ?? 'none')
  check('host derived the stable principal id', data.principalId === `matrix:${demoUserId}`, data.principalId ?? 'none')

  const bad = await fetch(`${authUrl}/auth/principal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'syt_not_a_real_token' }),
  })
  check('POST /auth/principal rejected an invalid token (401)', bad.status === 401, `status=${bad.status}`)

  const missing = await fetch(`${authUrl}/auth/principal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('POST /auth/principal rejected a missing token (400)', missing.status === 400, `status=${missing.status}`)

  process.stdout.write(failures === 0 ? '\nALL PRINCIPAL-PATH CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
