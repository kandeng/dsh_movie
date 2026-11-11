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

/** A handle to close an execution-lifecycle socket. */
export interface ExecSocket {
  /** Close the underlying WebSocket. */
  close(): void
}

/**
 * Connect to the gateway's Leg B execution-lifecycle socket (`/ws`).
 * @param config - the SDK config carrying the gateway URL.
 * @param handlers - lifecycle callbacks.
 * @returns a handle to close the socket.
 */
export function connectExecSocket(config: SdkConfig, handlers: ExecSocketHandlers): ExecSocket {
  const socket = new WebSocket(`${gatewayWsBase(trimTrailingSlash(config.gatewayUrl))}/ws`)
  socket.onopen = () => handlers.onOpen?.()
  socket.onclose = () => handlers.onClose?.()
  socket.onerror = (event: Event) => handlers.onError?.(event)
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (isExecMessage(parsed)) handlers.onMessage(parsed)
  }
  return {
    close(): void {
      socket.close()
    },
  }
}

/**
 * Submit a flattened prompt graph for execution (`POST /prompt`).
 * @param config - the SDK config carrying the gateway URL.
 * @param prompt - the execution graph.
 * @param clientId - optional client id used to route lifecycle events.
 * @returns the gateway's prompt response (execution id + queue number).
 */
export async function submitPrompt(config: SdkConfig, prompt: PromptGraph, clientId?: string): Promise<PromptResponse> {
  const body = clientId !== undefined ? { prompt, client_id: clientId } : { prompt }
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
