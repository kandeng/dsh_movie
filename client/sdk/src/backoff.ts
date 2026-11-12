/**
 * Capped exponential backoff with jitter (Phase-2 M7 hardening).
 *
 * A tiny pure helper shared by the Leg B exec socket and the Leg C mux socket so
 * both reconnect on the same schedule: `delay = min(maxMs, baseMs * 2^attempt)`,
 * then "equal jitter" (half fixed, half random) to decorrelate many clients
 * reconnecting after a gateway restart. Deterministic in tests by injecting
 * `random` and/or disabling `jitter`.
 *
 * @module @dsh-movie/sdk/backoff
 */

/** Tunables for {@link backoff}. */
export interface BackoffOptions {
  /** Delay for attempt 0 (ms); defaults to 500. */
  baseMs?: number | undefined
  /** Upper bound on any single delay (ms); defaults to 15000. */
  maxMs?: number | undefined
  /** Apply equal jitter; defaults to true. Set false for a deterministic delay. */
  jitter?: boolean | undefined
  /** RNG in `[0, 1)` used for jitter; defaults to `Math.random`. */
  random?: (() => number) | undefined
}

/**
 * Compute the reconnect delay for a zero-based attempt counter.
 * @param attempt - how many reconnects have already been scheduled (0-based).
 * @param options - base/max/jitter/random overrides.
 * @returns the delay in milliseconds (always >= 0, <= `maxMs`).
 */
export function backoff(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 500
  const maxMs = options.maxMs ?? 15_000
  const jitter = options.jitter ?? true
  const random = options.random ?? Math.random
  const n = Math.max(0, Math.floor(attempt))
  const exp = Math.min(maxMs, baseMs * 2 ** n)
  if (!jitter) return Math.round(exp)
  // Equal jitter: keep half the delay fixed, randomize the other half.
  return Math.round(exp / 2 + random() * (exp / 2))
}
