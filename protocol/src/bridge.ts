/**
 * Canvas bridge contract v1 (Phase-2 M5, Phase-3 §3).
 *
 * The Studio canvas embeds the pinned ComfyUI frontend in a same-origin iframe.
 * The parent (our Vue app) and the iframe (via a bridge extension we own) talk
 * over `postMessage` using this versioned envelope. The parent never touches
 * ComfyUI internals directly; every interaction is a typed command/event here.
 *
 * Every message is `{ v: 1, txn?, type, payload }`, discriminated on `type`:
 *  - Parent -> iframe: {@link BridgeCommand} (e.g. `graph.load`, `node.setStatus`).
 *  - Iframe -> parent: {@link BridgeEvent} (e.g. `ready`, `nodeSelected`).
 *
 * `txn` is an optional correlation id: a command carrying `txn` is answered by a
 * `commandResult` event with the same `txn`, enabling the Phase-3 transactional
 * op-script executor. The wire contract is intentionally tiny and stable so a
 * pinned frontend version can be conformance-tested against it.
 *
 * @module @dsh-movie/protocol/bridge
 */

import type { WorkflowGraph } from './leg-b.ts'

/** The bridge protocol version. Bump on any breaking envelope/command change. */
export const BRIDGE_VERSION = 1 as const

/** The run status painted onto a node badge (driven by Leg B lifecycle events). */
export type NodeRunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'progress'
  | 'success'
  | 'error'

/* -------------------------------------------------------------------------- */
/* Parent -> iframe commands                                                   */
/* -------------------------------------------------------------------------- */

/** Payload map for each parent->iframe command `type`. */
export interface BridgeCommandPayloads {
  /** Version handshake; the iframe answers with a `ready` event. */
  'hello/version': { version: number }
  /** Replace the whole graph from workflow JSON. */
  'graph.load': { graph: WorkflowGraph }
  /** Ask the iframe to export the current graph (answered via `commandResult`). */
  'graph.export': Record<string, never>
  /** Add a node of `nodeType` at `pos`; optional starting widget props/id. */
  'node.add': { nodeType: string; pos: [number, number]; props?: Record<string, unknown>; id?: number }
  /** Remove a node by id. */
  'node.remove': { id: number }
  /** Move a node to an absolute canvas position. */
  'node.move': { id: number; x: number; y: number }
  /** Set a widget value on a node. */
  'node.setWidget': { id: number; key: string; value: unknown }
  /** Paint a run-status badge on a node. */
  'node.setStatus': { id: number; status: NodeRunStatus }
  /** Connect two node slots. */
  'edge.add': { fromId: number; fromSlot: number; toId: number; toSlot: number }
  /** Remove a link by its link id. */
  'edge.remove': { id: number }
  /** Collapse/expand a graph group box. */
  'group.collapse': { title: string; collapsed: boolean }
  /** Fit the view to the whole graph or to the given node ids. */
  'view.fit': { ids?: number[] }
  /** Toggle the edit lock (multi-user read-only mode). */
  'setReadonly': { readonly: boolean }
}

/** Every parent->iframe command `type`. */
export type BridgeCommandType = keyof BridgeCommandPayloads

/** A single parent->iframe command message. */
export type BridgeCommand = {
  [K in BridgeCommandType]: {
    v: typeof BRIDGE_VERSION
    txn?: string
    type: K
    payload: BridgeCommandPayloads[K]
  }
}[BridgeCommandType]

/* -------------------------------------------------------------------------- */
/* Iframe -> parent events                                                     */
/* -------------------------------------------------------------------------- */

/** Payload map for each iframe->parent event `type`. */
export interface BridgeEventPayloads {
  /** The iframe finished booting and the bridge extension is live. */
  ready: { version: number }
  /** The graph changed (manual edit); carries the serialized graph + a revision. */
  graphChanged: { graph: WorkflowGraph; rev: number }
  /** A node was selected (or deselected when `id` is null). */
  nodeSelected: { id: number | null }
  /** A node status badge was painted from a Leg B lifecycle event. */
  execPainted: { id: number; status: NodeRunStatus }
  /** The result of a `txn`-correlated command. */
  commandResult: { txn?: string; ok: boolean; error?: string; data?: unknown }
  /** A bridge-level error. */
  bridgeError: { code: string; message: string }
}

/** Every iframe->parent event `type`. */
export type BridgeEventType = keyof BridgeEventPayloads

/** A single iframe->parent event message. */
export type BridgeEvent = {
  [K in BridgeEventType]: {
    v: typeof BRIDGE_VERSION
    txn?: string
    type: K
    payload: BridgeEventPayloads[K]
  }
}[BridgeEventType]

/** Any message crossing the bridge in either direction. */
export type BridgeMessage = BridgeCommand | BridgeEvent

/** Every valid message `type` discriminator (commands + events). */
export const BRIDGE_MESSAGE_TYPES: readonly string[] = [
  'hello/version',
  'graph.load',
  'graph.export',
  'node.add',
  'node.remove',
  'node.move',
  'node.setWidget',
  'node.setStatus',
  'edge.add',
  'edge.remove',
  'group.collapse',
  'view.fit',
  'setReadonly',
  'ready',
  'graphChanged',
  'nodeSelected',
  'execPainted',
  'commandResult',
  'bridgeError',
]

/**
 * Narrow an unknown postMessage payload to a {@link BridgeMessage}.
 * @param value - the parsed `event.data`.
 * @returns true when the payload carries our envelope shape and a known type.
 */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { v?: unknown; type?: unknown }
  return message.v === BRIDGE_VERSION
    && typeof message.type === 'string'
    && BRIDGE_MESSAGE_TYPES.includes(message.type)
}

/**
 * Build a parent->iframe command envelope.
 * @param type - the command type.
 * @param payload - the command payload.
 * @param txn - optional correlation id for a `commandResult` reply.
 * @returns the enveloped command message.
 */
export function bridgeCommand<K extends BridgeCommandType>(
  type: K,
  payload: BridgeCommandPayloads[K],
  txn?: string,
): BridgeCommand {
  return { v: BRIDGE_VERSION, ...(txn !== undefined ? { txn } : {}), type, payload } as BridgeCommand
}

/**
 * Build an iframe->parent event envelope.
 * @param type - the event type.
 * @param payload - the event payload.
 * @param txn - optional correlation id echoing the originating command.
 * @returns the enveloped event message.
 */
export function bridgeEvent<K extends BridgeEventType>(
  type: K,
  payload: BridgeEventPayloads[K],
  txn?: string,
): BridgeEvent {
  return { v: BRIDGE_VERSION, ...(txn !== undefined ? { txn } : {}), type, payload } as BridgeEvent
}
