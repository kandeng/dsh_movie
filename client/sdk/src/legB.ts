/**
 * Leg B: the ComfyUI-compatible execution channel client.
 *
 * Leg B has two halves, both typed by `@dsh-movie/protocol`:
 * - the execution-lifecycle WebSocket at `/ws`, which streams {@link ExecMessage}
 *   envelopes (`status`, `queued`, `executing`, `progress`, `executed`, ...);
 * - the HTTP `POST /prompt` submission that assigns an execution id and drives
 *   that lifecycle.
 *
 * It also carries a small workflow helper to flatten an editor
 * {@link WorkflowGraph} into the {@link PromptGraph} the executor accepts. The
 * M1 flatten is intentionally minimal (one prompt node per graph node, no link
 * resolution); full graph flattening lands with the canvas milestones.
 *
 * @module @dsh-movie/sdk/legB
 */

import type { ExecMessage, PromptGraph, PromptGraphNode, PromptResponse, WorkflowGraph } from '@dsh-movie/protocol'
import { isExecMessage } from '@dsh-movie/protocol'
import { gatewayWsBase, trimTrailingSlash, type SdkConfig } from './config.ts'
import { backoff } from './backoff.ts'

/** Callbacks for an {@link connectExecSocket} execution-lifecycle socket. */
export interface ExecSocketHandlers {
  /** A validated lifecycle message arrived. */
  onMessage(message: ExecMessage): void
  /** The socket opened. */
  onOpen?(): void
  /** The socket closed. */
  onClose?(): void
  /** The socket errored. */
  onError?(event: Event): void
}

/** Reconnect/backoff tuning for {@link connectExecSocket} (Phase-2 M7). */
export interface ExecSocketOptions {
  /** Re-create the socket after an unexpected drop; defaults to false (one-shot). */
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

/** A handle to close an execution-lifecycle socket. */
export interface ExecSocket {
  /** Close the underlying WebSocket (and stop any reconnect loop). */
  close(): void
}

/**
 * Connect to the gateway's Leg B execution-lifecycle socket (`/ws`).
 *
 * By default this is a one-shot socket (existing callers/verify scripts are
 * unaffected). Pass `{ reconnect: true }` to re-create it on an unexpected drop
 * using capped exponential backoff with jitter until {@link ExecSocket.close}.
 * @param config - the SDK config carrying the gateway URL.
 * @param handlers - lifecycle callbacks.
 * @param options - optional reconnect/backoff tuning.
 * @returns a handle to close the socket.
 */
export function connectExecSocket(
  config: SdkConfig,
  handlers: ExecSocketHandlers,
  options: ExecSocketOptions = {},
): ExecSocket {
  const url = `${gatewayWsBase(trimTrailingSlash(config.gatewayUrl))}/ws`
  const reconnect = options.reconnect ?? false
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let closed = false

  function open(): void {
    if (closed) return
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      attempt = 0
      options.onStatusChange?.(true)
      handlers.onOpen?.()
    }
    ws.onclose = () => {
      options.onStatusChange?.(false)
      handlers.onClose?.()
      scheduleReconnect()
    }
    ws.onerror = (event: Event) => handlers.onError?.(event)
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      if (isExecMessage(parsed)) handlers.onMessage(parsed)
    }
  }

  function scheduleReconnect(): void {
    if (closed || !reconnect || attempt >= maxAttempts) return
    const delayMs = backoff(attempt, { baseMs: options.baseDelayMs, maxMs: options.maxDelayMs })
    attempt += 1
    options.onReconnecting?.(attempt, delayMs)
    timer = setTimeout(() => {
      timer = null
      open()
    }, delayMs)
  }

  open()

  return {
    close(): void {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      socket?.close()
      socket = null
    },
  }
}

/**
 * Submit a flattened prompt graph for execution (`POST /prompt`).
 * @param config - the SDK config carrying the gateway URL.
 * @param prompt - the execution graph.
 * @param clientId - optional client id used to route lifecycle events.
 * @param roomId - optional Matrix room id. The Leg B surface is room-agnostic,
 *   but threading the active room lets the gateway land the D15 "no such model"
 *   notice and the D8 artifact echo in the chatbox (P5-M2).
 * @returns the gateway's prompt response (execution id + queue number).
 */
export async function submitPrompt(config: SdkConfig, prompt: PromptGraph, clientId?: string, roomId?: string): Promise<PromptResponse> {
  const body: Record<string, unknown> = { prompt }
  if (clientId !== undefined) body['client_id'] = clientId
  if (roomId !== undefined && roomId !== '') body['room_id'] = roomId
  const response = await fetch(`${trimTrailingSlash(config.gatewayUrl)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`submitPrompt failed: ${response.status}`)
  return (await response.json()) as PromptResponse
}

/**
 * Flatten an editor {@link WorkflowGraph} into an execution {@link PromptGraph}.
 *
 * M1 skeleton: emit one prompt node per workflow node keyed by its id, carrying
 * its `class_type` and (optional) title. Link/widget resolution into concrete
 * node inputs is deferred to the canvas milestones.
 * @param workflow - the editor workflow graph.
 * @returns the flattened prompt graph.
 */
export function toPromptGraph(workflow: WorkflowGraph): PromptGraph {
  const graph: PromptGraph = {}
  for (const node of workflow.nodes) {
    const spec: PromptGraphNode = { class_type: node.type, inputs: {} }
    if (node.title !== undefined) spec._meta = { title: node.title }
    graph[String(node.id)] = spec
  }
  return graph
}
