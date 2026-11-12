/**
 * Leg C: the direct browser-to-host RPC channel client.
 *
 * Two transports, both typed by `@dsh-movie/protocol`:
 * - {@link RpcClient}: `POST /api/<ns>/<method>` request/response, attaching the
 *   caller's Matrix access token as the principal (`Authorization: Bearer`).
 *   `call` is generic over {@link LegCMethod}, so the params and result are
 *   checked against the shared namespace contracts.
 * - {@link MuxSocket}: the `/api/ws` multiplexed stream socket, carrying
 *   {@link StreamFrame}s keyed by a logical `stream` id. Many streams share one
 *   socket; `open`/`close` control messages subscribe/unsubscribe.
 *
 * @module @dsh-movie/sdk/legC
 */

import type {
  ApiErrorCode,
  ApiResult,
  LegCMethod,
  LegCRequest,
  LegCResponse,
  StreamClose,
  StreamFrame,
  StreamOpen,
} from '@dsh-movie/protocol'
import { isApiOk } from '@dsh-movie/protocol'
import { gatewayWsBase, trimTrailingSlash, type SdkConfig } from './config.ts'
import { backoff } from './backoff.ts'

/** An error surfaced by the gateway's Leg C envelope. */
export class LegCError extends Error {
  /** The machine-readable gateway error code. */
  readonly code: ApiErrorCode

  /**
   * @param code - the gateway error code.
   * @param message - the human-readable message.
   */
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'LegCError'
  }
}

/** How the RPC client obtains the caller's Matrix access token per call. */
export interface RpcClientOptions {
  /** Return the current access token, or `null` when not logged in. */
  getToken(): string | null
}

/**
 * The Leg C JSON-RPC client over HTTP.
 *
 * Each `call` resolves the namespace/method from the typed method name, sends
 * the params as the JSON body, and unwraps the {@link ApiResult} envelope —
 * throwing a {@link LegCError} on the `error` branch.
 */
export class RpcClient {
  private readonly config: SdkConfig
  private readonly options: RpcClientOptions

  /**
   * @param config - the SDK config carrying the gateway URL.
   * @param options - how to obtain the caller's access token.
   */
  constructor(config: SdkConfig, options: RpcClientOptions) {
    this.config = config
    this.options = options
  }

  /**
   * Invoke a Leg C method.
   * @param method - the typed `<ns>/<method>` name.
   * @param params - the method's request params.
   * @returns the method's response payload.
   * @throws {LegCError} when the gateway returns an error envelope.
   */
  async call<M extends LegCMethod>(method: M, params: LegCRequest<M>): Promise<LegCResponse<M>> {
    const slash = method.indexOf('/')
    const ns = method.slice(0, slash)
    const name = method.slice(slash + 1)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = this.options.getToken()
    if (token !== null) headers['Authorization'] = `Bearer ${token}`
    const response = await fetch(`${trimTrailingSlash(this.config.gatewayUrl)}/api/${ns}/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    })
    const body = (await response.json()) as ApiResult<LegCResponse<M>>
    if (!isApiOk(body)) throw new LegCError(body.error.code, body.error.message)
    return body.result
  }
}

/** Callbacks for a single multiplexed stream. */
export interface StreamHandlers {
  /** A data frame arrived on the stream. */
  onData(payload: unknown): void
  /** The stream ended normally. */
  onEnd?(): void
  /** The stream errored. */
  onError?(payload: unknown): void
}

/** A handle to close one multiplexed stream. */
export interface MuxStream {
  /** Close this logical stream (sends a `close` control frame). */
  close(): void
}

/** Reconnect/backoff tuning for {@link MuxSocket} (Phase-2 M7). */
export interface MuxSocketOptions {
  /** Re-create the socket after a drop; defaults to true. */
  reconnect?: boolean | undefined
  /** Max reconnect attempts before giving up; defaults to unbounded. */
  maxAttempts?: number | undefined
  /** Backoff base delay (ms); defaults to 500. */
  baseDelayMs?: number | undefined
  /** Backoff max delay (ms); defaults to 15000. */
  maxDelayMs?: number | undefined
  /** Called before each reconnect wait with the 1-based attempt + delay. */
  onReconnecting?(attempt: number, delayMs: number): void
  /** Called whenever the socket opens (true) or drops (false). */
  onStatusChange?(connected: boolean): void
}

/** A subscribed stream: its channel/params (for re-subscribe) + handlers. */
interface MuxEntry {
  channel: string
  params: Record<string, unknown> | undefined
  handlers: StreamHandlers
}

/**
 * The Leg C `/api/ws` multiplexed stream socket.
 *
 * Frames are routed to per-stream handlers by their `stream` id. `open`
 * subscribes to a named server channel; the returned {@link MuxStream} closes
 * just that logical stream without tearing down the socket.
 *
 * On an unexpected drop the socket reconnects with capped exponential backoff
 * (default on) and re-sends `open` for every still-subscribed stream, so logical
 * streams survive a gateway restart transparently.
 */
export class MuxSocket {
  private readonly config: SdkConfig
  private readonly options: MuxSocketOptions
  private readonly streams = new Map<string, MuxEntry>()
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private counter = 0
  private attempt = 0
  private closed = false

  /**
   * @param config - the SDK config carrying the gateway URL.
   * @param options - optional reconnect/backoff tuning.
   */
  constructor(config: SdkConfig, options: MuxSocketOptions = {}) {
    this.config = config
    this.options = options
    this.connect()
  }

  /** (Re)create the underlying WebSocket and re-subscribe open streams. */
  private connect(): void {
    if (this.closed) return
    const socket = new WebSocket(`${gatewayWsBase(trimTrailingSlash(this.config.gatewayUrl))}/api/ws`)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.options.onStatusChange?.(true)
      for (const [stream, entry] of this.streams) this.sendRaw(this.openMessage(stream, entry))
    }
    socket.onclose = () => {
      this.options.onStatusChange?.(false)
      this.scheduleReconnect()
    }
    socket.onmessage = (event: MessageEvent) => this.handleMessage(event)
  }

  /** Schedule a backoff-delayed reconnect unless closed or out of attempts. */
  private scheduleReconnect(): void {
    const reconnect = this.options.reconnect ?? true
    const maxAttempts = this.options.maxAttempts ?? Number.POSITIVE_INFINITY
    if (this.closed || !reconnect || this.attempt >= maxAttempts) return
    const delayMs = backoff(this.attempt, { baseMs: this.options.baseDelayMs, maxMs: this.options.maxDelayMs })
    this.attempt += 1
    this.options.onReconnecting?.(this.attempt, delayMs)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delayMs)
  }

  /** Route an incoming frame to its stream handlers. */
  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    let frame: StreamFrame
    try {
      frame = JSON.parse(event.data) as StreamFrame
    } catch {
      return
    }
    const entry = this.streams.get(frame.stream)
    if (entry === undefined) return
    if (frame.type === 'data') {
      entry.handlers.onData(frame.payload)
      return
    }
    if (frame.type === 'end') {
      this.streams.delete(frame.stream)
      entry.handlers.onEnd?.()
      return
    }
    entry.handlers.onError?.(frame.payload)
  }

  /** Build the `open` control message for a stream entry. */
  private openMessage(stream: string, entry: MuxEntry): StreamOpen {
    return entry.params !== undefined
      ? { op: 'open', stream, channel: entry.channel, params: entry.params }
      : { op: 'open', stream, channel: entry.channel }
  }

  /** Send a control frame, deferring until the socket opens if needed. */
  private sendRaw(message: StreamOpen | StreamClose): void {
    const text = JSON.stringify(message)
    const socket = this.socket
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(text)
      return
    }
    socket?.addEventListener('open', () => socket.send(text), { once: true })
  }

  /**
   * Open a logical stream on a server channel.
   * @param channel - the channel to open, e.g. `leg-b/exec`.
   * @param params - optional channel parameters.
   * @param handlers - per-stream frame callbacks.
   * @returns a handle to close this stream.
   */
  open(channel: string, params: Record<string, unknown> | undefined, handlers: StreamHandlers): MuxStream {
    const stream = `s${++this.counter}`
    const entry: MuxEntry = { channel, params, handlers }
    this.streams.set(stream, entry)
    this.sendRaw(this.openMessage(stream, entry))
    return {
      close: () => {
        this.streams.delete(stream)
        this.sendRaw({ op: 'close', stream })
      },
    }
  }

  /** Close the whole socket, stop reconnecting, and forget every stream. */
  close(): void {
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.streams.clear()
    this.socket?.close()
    this.socket = null
  }
}
