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

/**
 * The Leg C `/api/ws` multiplexed stream socket.
 *
 * Frames are routed to per-stream handlers by their `stream` id. `open`
 * subscribes to a named server channel; the returned {@link MuxStream} closes
 * just that logical stream without tearing down the socket.
 */
export class MuxSocket {
  private readonly socket: WebSocket
  private readonly streams = new Map<string, StreamHandlers>()
  private counter = 0

  /**
   * @param config - the SDK config carrying the gateway URL.
   */
  constructor(config: SdkConfig) {
    this.socket = new WebSocket(`${gatewayWsBase(trimTrailingSlash(config.gatewayUrl))}/api/ws`)
    this.socket.onmessage = (event: MessageEvent) => this.handleMessage(event)
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
    const handlers = this.streams.get(frame.stream)
    if (handlers === undefined) return
    if (frame.type === 'data') {
      handlers.onData(frame.payload)
      return
    }
    if (frame.type === 'end') {
      this.streams.delete(frame.stream)
      handlers.onEnd?.()
      return
    }
    handlers.onError?.(frame.payload)
  }

  /** Send a control frame, deferring until the socket opens if needed. */
  private send(message: StreamOpen | StreamClose): void {
    const text = JSON.stringify(message)
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text)
      return
    }
    this.socket.addEventListener('open', () => this.socket.send(text), { once: true })
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
    this.streams.set(stream, handlers)
    const message: StreamOpen = params !== undefined ? { op: 'open', stream, channel, params } : { op: 'open', stream, channel }
    this.send(message)
    return {
      close: () => {
        this.streams.delete(stream)
        this.send({ op: 'close', stream })
      },
    }
  }

  /** Close the whole socket and forget every stream. */
  close(): void {
    this.streams.clear()
    this.socket.close()
  }
}
