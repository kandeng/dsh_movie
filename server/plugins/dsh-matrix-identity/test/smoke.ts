/**
 * M1 smoke test for `dsh-matrix-identity` against the live local Synapse.
 *
 * It drives the plugin's `apply()` with a minimal stand-in for the Cordis host
 * context (logger + credentials seam over `process.env` + event capture), then
 * exercises the real Admin/CS API round-trips: provisioning a throwaway hidden
 * account, brokering its token, introspecting that token via `whoami`, mapping a
 * principal, and syncing a display name.
 *
 * Run from the `server/` directory (so node_modules resolution works):
 *   node --experimental-strip-types plugins/dsh-matrix-identity/test/smoke.ts
 *
 * Secrets are read from `server/.env`; nothing sensitive is printed.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, type Config } from '../src/index.ts'
import type { MatrixIdentity, MatrixPrincipal, ProvisionResult } from '../src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '../../..')

/** Load `server/.env` into process.env (KEY=VALUE lines; later lines win). */
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

/** Minimal logger stand-in matching `ctx.logger`. */
const logger = {
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
  info(message: string, ...args: unknown[]): void {
    process.stderr.write(`info: ${message} ${args.map(String).join(' ')}\n`)
  },
}

/** Captured emitted events, keyed by name. */
const events: Record<string, unknown[][]> = {}

/** Build a fake Cordis context sufficient for the plugin's `apply`. */
function makeCtx(): {
  ctx: any
  getService: () => MatrixIdentity | undefined
} {
  let service: MatrixIdentity | undefined
  const ctx = {
    logger,
    credentials: {
      async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
        const value = process.env[ref]
        return value !== undefined && value.length > 0 ? { value, source: 'env' } : undefined
      },
    },
    provide(_name: string, impl: MatrixIdentity): void {
      service = impl
    },
    emit(name: string, ...args: unknown[]): void {
      ;(events[name] ??= []).push(args)
    },
  }
  return { ctx, getService: () => service }
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'PASS' : 'FAIL'
  process.stdout.write(`[${mark}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

async function main(): Promise<void> {
  const config: Config = {
    homeserverUrl: process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008',
    serverName: process.env.SYNAPSE_SERVER_NAME ?? 'localhost',
    adminTokenRef: 'SYNAPSE_ADMIN_TOKEN',
    botUserId: process.env.SYNAPSE_BOT_USER_ID ?? '',
    whoamiCacheMs: 60_000,
    principalListenerPort: 0,
  }

  const { ctx, getService } = makeCtx()
  apply(ctx, config)
  const identity = getService()
  check('service provided as ctx.matrixIdentity', identity !== undefined)
  if (identity === undefined) {
    process.exit(1)
  }

  const configured = await identity.isConfigured()
  check('Synapse endpoint + admin token configured', configured)
  if (!configured) {
    process.stdout.write('Is Synapse running and SYNAPSE_ADMIN_TOKEN present in server/.env?\n')
    process.exit(1)
  }

  // userIdFor is a pure, offline mapping.
  const localpart = `dsh_smoke_${Date.now().toString(36)}`
  const userId = identity.userIdFor(localpart)
  check('userIdFor builds a fully qualified mxid', userId === `@${localpart}:${config.serverName}`, userId)

  // Provisioning: idempotent create via the Admin API.
  const provision: ProvisionResult = await identity.provisionUser(localpart, { displayName: 'DSH Smoke' })
  check('provisionUser created the hidden account', provision.provisioned && provision.userId === userId, provision.userId)
  check('matrix/user-provisioned emitted', (events['matrix/user-provisioned'] ?? []).length === 1)

  // Re-provision must stay idempotent (still true, no throw).
  const reprovision = await identity.provisionUser(localpart, { displayName: 'DSH Smoke' })
  check('provisionUser is idempotent on re-run', reprovision.provisioned)

  // Token brokering via the Admin puppet-login flow.
  const creds = await identity.brokerToken(userId)
  check('brokerToken returned an access token', creds !== null && typeof creds.accessToken === 'string' && creds.accessToken.length > 0)
  if (creds === null) process.exit(1)

  // whoami introspection (Mode B trust anchor) must map the token back to the user.
  const principal: MatrixPrincipal | null = await identity.whoami(creds.accessToken)
  check('whoami resolved the token to the same user', principal !== null && principal.userId === userId, principal?.userId ?? 'null')
  check('whoami derived the localpart', principal?.localpart === localpart, principal?.localpart ?? 'null')
  check('matrix/user-login emitted on whoami', (events['matrix/user-login'] ?? []).length >= 1)

  // whoami cache: a second call returns the same principal without a new event.
  const loginEventsBefore = (events['matrix/user-login'] ?? []).length
  const cached = await identity.whoami(creds.accessToken)
  check('whoami cache returns a hit', cached !== null && cached.userId === userId)
  check('whoami cache suppressed a second network+event', (events['matrix/user-login'] ?? []).length === loginEventsBefore)

  // A bogus token must degrade to null, never throw.
  const bogus = await identity.whoami('syt_definitely_not_a_real_token')
  check('whoami rejects an invalid token (degrades to null)', bogus === null)

  // Principal mapping is stable + namespaced.
  check('principalId is stable and namespaced', identity.principalId(userId) === `matrix:${userId}`)

  // Profile sync (best-effort): sets a display name on the hidden account.
  const synced = await identity.syncProfile(userId, 'DSH Smoke Renamed')
  check('syncProfile ran best-effort', synced === true)
  check('matrix/profile-changed emitted', (events['matrix/profile-changed'] ?? []).length === 1)

  process.stdout.write(failures === 0 ? '\nALL M1 IDENTITY CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
