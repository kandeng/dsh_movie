/**
 * A dependency-free HTTP helper for the network adapters (Phase-7 P7-M3).
 *
 * Adapters run as OS-sandboxed children (egress restricted to their manifest
 * allow-list), so this wraps the global `fetch` with a hard timeout and a
 * rate-limit verdict the host index understands (R11): a 403/429 with an
 * exhausted GitHub/registry budget is reported as `rateLimited` so the host
 * serves its cache instead of surfacing an empty result.
 *
 * Only `node:*` and globals are used, keeping the adapters hermetic.
 *
 * @module dsh-movie-market/adapters/http
 */

/** The decoded outcome of one GET. */
export interface HttpResult {
  /** HTTP status code. */
  status: number
  /** The response body as text. */
  body: string
  /** Lower-cased response headers. */
  headers: Record<string, string>
}

/** Options for {@link httpGet}. */
export interface HttpGetOptions {
  /** Hard timeout in ms (default 8000). */
  timeoutMs?: number | undefined
  /** Extra request headers (e.g. an Authorization token). */
  headers?: Readonly<Record<string, string>> | undefined
}

/**
 * Perform a GET with a timeout. Never throws on a non-2xx status — the caller
 * inspects `status` (so a rate-limit is a normal, cacheable outcome).
 * @param url - the absolute URL to fetch.
 * @param options - timeout + headers.
 * @returns the decoded result.
 * @throws only on a network/timeout failure.
 */
export async function httpGet(url: string, options: HttpGetOptions = {}): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'dsh-movie-market/0.1', accept: 'application/json, text/plain, */*', ...(options.headers ?? {}) },
      signal: controller.signal,
    })
    const body = await response.text()
    const headers: Record<string, string> = {}
    response.headers.forEach((value: string, key: string): void => {
      headers[key.toLowerCase()] = value
    })
    return { status: response.status, body, headers }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a response indicates the upstream rate-limited us (R11). Covers the
 * generic 429 and GitHub's 403-with-exhausted-budget convention.
 * @param result - the HTTP result to inspect.
 * @returns true when the caller should treat this as a rate-limit.
 */
export function isRateLimited(result: HttpResult): boolean {
  if (result.status === 429) return true
  if (result.status === 403) {
    const remaining = result.headers['x-ratelimit-remaining']
    if (remaining !== undefined && Number(remaining) === 0) return true
    return /rate ?limit/i.test(result.body)
  }
  return false
}

/**
 * Safely JSON-parse a body, returning `null` when it is not valid JSON.
 * @param body - the raw text.
 * @returns the parsed value or `null`.
 */
export function tryJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}
