/**
 * matrix-js-sdk console sink with a benign-noise filter.
 *
 * matrix-js-sdk v42 unconditionally probes the unstable MSC4143 endpoint
 * (`/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`) from a
 * `PollingCachedValue` created inside the `MatrixClient` constructor, and there
 * is no client option to switch the probe off. Synapse does not implement the
 * MSC, so every boot logs a 404 `M_UNRECOGNIZED` error plus a stack trace even
 * though nothing is wrong (dsh_movie uses Matrix for room messaging only, never
 * for calls). The SDK does accept an injected logger via `IClientOpts.logger`,
 * so we supply one that mirrors the SDK's default console behaviour for
 * everything, but downgrades messages matching the probe to `debug` — which the
 * default Cordis log level filters out — keeping the boot log clean without
 * hiding real failures.
 *
 * @module dsh-matrix-chat/sdk-logger
 */

/** The subset of the matrix-js-sdk `Logger` interface the SDK actually calls. */
export interface SdkLogger {
  trace(...msg: unknown[]): void
  debug(...msg: unknown[]): void
  info(...msg: unknown[]): void
  warn(...msg: unknown[]): void
  error(...msg: unknown[]): void
  getChild(namespace: string): SdkLogger
}

/** Matches the known-benign MSC4143 RTC-transports probe noise. */
const BENIGN = /RTCTransports|M_UNRECOGNIZED|org\.matrix\.msc4143/

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/** Console sink mirroring the SDK's default loglevel method factory. */
function sink(level: Level, msg: unknown[]): void {
  if (level === 'trace' || level === 'debug') console.debug(...msg)
  else if (level === 'info') console.info(...msg)
  else if (level === 'warn') console.warn(...msg)
  else console.error(...msg)
}

/**
 * Create the filtered logger to pass as `IClientOpts.logger`.
 *
 * @param quiet - sink for downgraded (benign) messages; wire this to the Cordis
 *   logger's `debug`, which the default boot log filters out.
 * @returns the root logger; child loggers inherit the filter and carry their
 *   namespace prefix into the match (the probe logs via
 *   `PollingCachedValue<RTCTransports>`).
 */
export function createSdkLogger(quiet: (...msg: unknown[]) => void): SdkLogger {
  function make(prefix: string): SdkLogger {
    function emit(level: Level, msg: unknown[]): void {
      const joined = msg.map((part) => (part instanceof Error ? part.message : String(part))).join(' ')
      if (BENIGN.test(prefix === '' ? joined : `${prefix} ${joined}`)) {
        quiet(`[matrix-sdk] ${prefix === '' ? level : `${prefix} ${level}`}:`, joined)
        return
      }
      sink(level, prefix === '' ? msg : [prefix, ...msg])
    }
    return {
      trace: (...msg: unknown[]): void => emit('trace', msg),
      debug: (...msg: unknown[]): void => emit('debug', msg),
      info: (...msg: unknown[]): void => emit('info', msg),
      warn: (...msg: unknown[]): void => emit('warn', msg),
      error: (...msg: unknown[]): void => emit('error', msg),
      getChild: (namespace: string): SdkLogger => make(prefix === '' ? namespace : `${prefix}-${namespace}`),
    }
  }
  return make('')
}
