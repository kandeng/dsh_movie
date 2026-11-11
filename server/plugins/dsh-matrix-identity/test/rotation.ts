/**
 * M4 token-rotation responsiveness test for `dsh-matrix-identity`.
 *
 * The identity plugin resolves the Synapse admin token from the credentials
 * seam on *every* operation (`resolveEndpoint()` -> `ctx.credentials.resolve`),
 * never caching the value, so rotating the stored token takes effect on the next
 * call with no plugin reload or host restart. This test proves that property by
 * driving the plugin's `apply()` once against a mutable in-memory credential
 * store and observing three live transitions:
 *
 *   good token   -> admin operations succeed (baseline);
 *   bogus token  -> the very next operation degrades (rotated value picked up);
 *   good token   -> operations succeed again (recovered, still no reload);
 *   empty token  -> `isConfigured()` reports degraded, then recovers.
 *
 * Run from the `server/` directory (so node_modules resolution works):
 *   node --experimental-strip-types plugins/dsh-matrix-identity/test/rotation.ts
 *
 * Secrets are read from `server/.env`; nothing sensitive is printed.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, type Config } from '../src/index.ts'
import type { MatrixIdentity } from '../src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '../../..')

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

/** Minimal logger stand-in matching `ctx.logger`. */
const logger = {
  warn(message: string, ...args: unknown[]): void {
    process.stderr.write(`warn: ${message} ${args.map(String).join(' ')}\n`)
  },
  info(message: string, ...args: unknown[]): void {
    process.stderr.write(`info: ${message} ${args.map(String).join(' ')}\n`)
  },
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

async function main(): Promise<void> {
  const realToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  if (realToken === '') {
    process.stdout.write('SYNAPSE_ADMIN_TOKEN missing from server/.env; cannot test rotation.\n')
    process.exit(1)
  }
  const ref = 'SYNAPSE_ADMIN_TOKEN'

  // A mutable credential store standing in for `credentials-local`. Rotating the
  // token means writing a new value here — the plugin is never re-applied.
  const store = new Map<string, string>([[ref, realToken]])

  let service: MatrixIdentity | undefined
  const ctx = {
    logger,
    credentials: {
      async resolve(name: string): Promise<{ value: string; source: string } | undefined> {
        const value = store.get(name)
        return value !== undefined && value.length > 0 ? { value, source: 'test' } : undefined
      },
    },
    provide(_name: string, impl: MatrixIdentity): void {
      service = impl
    },
    emit(): void {
      // Rotation is not an event-driven path; events are ignored here.
    },
  }

  const config: Config = {
    homeserverUrl: process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008',
    serverName: process.env.SYNAPSE_SERVER_NAME ?? 'localhost',
    adminTokenRef: ref,
    botUserId: process.env.SYNAPSE_BOT_USER_ID ?? '',
    whoamiCacheMs: 60_000,
    principalListenerPort: 0,
  }

  // Apply ONCE. Every assertion below observes live per-op credential resolution.
  apply(ctx as any, config)
  const identity = service
  check('service provided as ctx.matrixIdentity', identity !== undefined)
  if (identity === undefined) process.exit(1)

  check('isConfigured() true with the real token', await identity.isConfigured())

  // Provision a throwaway account to broker against (uses the current good token).
  const localpart = `dsh_rot_${Date.now().toString(36)}`
  const userId = identity.userIdFor(localpart)
  const provision = await identity.provisionUser(localpart, { displayName: 'DSH Rotation' })
  check('provisioned a throwaway account with the real token', provision.provisioned, provision.userId)

  const baseline = await identity.brokerToken(userId)
  check('brokerToken succeeds with the real token (baseline)', baseline !== null && baseline.accessToken.length > 0)

  // ROTATE to a bogus token. No reload — the next op must use the new value.
  store.set(ref, 'syt_rotated_bogus_token_that_synapse_will_reject')
  const afterBadRotation = await identity.brokerToken(userId)
  check('brokerToken degrades immediately after rotating to a bogus token', afterBadRotation === null)

  // ROTATE back to the real token. Still no reload — recovery must be live.
  store.set(ref, realToken)
  const afterGoodRotation = await identity.brokerToken(userId)
  check('brokerToken recovers immediately after rotating back to the real token', afterGoodRotation !== null && afterGoodRotation.accessToken.length > 0)

  // An EMPTY (unset) token reports degraded configuration, then recovers.
  store.set(ref, '')
  check('isConfigured() false when the token is rotated to empty', !(await identity.isConfigured()))
  store.set(ref, realToken)
  check('isConfigured() true again after restoring the token', await identity.isConfigured())

  process.stdout.write(failures === 0 ? '\nALL M4 TOKEN-ROTATION CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
