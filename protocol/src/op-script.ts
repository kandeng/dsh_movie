/**
 * Canvas op-script contract (Phase-3 P3-M3, design doc §5).
 *
 * An *op-script* is a constrained, ordered sequence of canvas operations the
 * server agent emits from a natural-language intent. It is NEVER eval-able
 * JavaScript: every entry maps 1:1 onto the parent->iframe bridge command
 * catalog in {@link ./bridge.ts}, so a script is fully schema-validatable on the
 * server before it is streamed, and deterministically replayable/verifiable on
 * the client.
 *
 * Flow (design doc §5):
 *  1. server agent turns intent -> `CanvasScript { txnId, ops }`;
 *  2. client executor snapshots the graph, applies each op through the bridge,
 *     checks postconditions, retries transient failures, rolls back on a hard
 *     failure;
 *  3. client streams `CanvasScriptResult { txnId, committed, opResults }` back
 *     for server-side evaluation (the intelligent re-plan loop is Phase-3 M4).
 *
 * The op catalog is intentionally a strict SUBSET of the bridge commands: only
 * graph-mutating / view ops an agent should drive. `hello/version`, `graph.load`,
 * `graph.export`, and `setReadonly` are parent-internal and excluded.
 *
 * @module @dsh-movie/protocol/op-script
 */

import {
  BRIDGE_VERSION,
  type BridgeCommand,
  type BridgeCommandPayloads,
} from './bridge.ts'

/**
 * The agent-drivable canvas operation types. Each is also a valid bridge
 * command `type`, so an op applies directly through `CanvasBridge.request`.
 */
export type CanvasOpType =
  | 'node.add'
  | 'node.remove'
  | 'node.move'
  | 'node.setWidget'
  | 'node.setStatus'
  | 'edge.add'
  | 'edge.remove'
  | 'group.collapse'
  | 'view.fit'

/** Every valid {@link CanvasOpType} discriminator (for validation / catalog UI). */
export const CANVAS_OP_TYPES: readonly CanvasOpType[] = [
  'node.add',
  'node.remove',
  'node.move',
  'node.setWidget',
  'node.setStatus',
  'edge.add',
  'edge.remove',
  'group.collapse',
  'view.fit',
] as const

/**
 * A single canvas operation: an op discriminator plus the exact bridge command
 * payload for that op. Modeled as a correlated union so `op` and `payload`
 * always agree (e.g. `node.add` carries `{ nodeType, pos, ... }`).
 */
export type CanvasOp = {
  [K in CanvasOpType]: {
    /** The operation discriminator (also the bridge command `type`). */
    op: K
    /** The bridge command payload for this op. */
    payload: BridgeCommandPayloads[K]
  }
}[CanvasOpType]

/**
 * A constrained operation script emitted by the server agent. The `txnId`
 * correlates the whole transaction: the client executor applies `ops` in order
 * and reports back a {@link CanvasScriptResult} carrying the same `txnId`.
 */
export interface CanvasScript {
  /** Transaction id correlating this script with its result. */
  txnId: string
  /** The ordered operations to apply. */
  ops: CanvasOp[]
}

/** The outcome of applying one op within a script transaction. */
export interface OpResult {
  /** The op's position in {@link CanvasScript.ops}. */
  index: number
  /** The op that was attempted. */
  op: CanvasOp
  /** Whether the op applied AND satisfied its postcondition. */
  ok: boolean
  /** Failure/skip reason; absent when `ok` is true. */
  error?: string | undefined
}

/** The client executor's report for a whole script transaction. */
export interface CanvasScriptResult {
  /** Echoes {@link CanvasScript.txnId}. */
  txnId: string
  /** True when every op applied (no rollback); false when the txn rolled back. */
  committed: boolean
  /** Per-op outcomes, in script order. */
  opResults: OpResult[]
}

/**
 * Narrow an unknown value to a {@link CanvasOp}.
 *
 * A shallow shape check only: it confirms the `op` discriminator is in the
 * catalog and a payload object is present. Deep per-op payload validation lives
 * server-side (`op-script-validator.ts`), which owns the schemastery schemas.
 *
 * @param value - the candidate value.
 * @returns true when the value looks like a catalog op with a payload object.
 */
export function isCanvasOp(value: unknown): value is CanvasOp {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { op?: unknown; payload?: unknown }
  if (typeof candidate.op !== 'string') return false
  if (!CANVAS_OP_TYPES.includes(candidate.op as CanvasOpType)) return false
  return typeof candidate.payload === 'object' && candidate.payload !== null
}

/**
 * Narrow an unknown value to a {@link CanvasScript}.
 * @param value - the candidate value.
 * @returns true when the value carries a string `txnId` and an op array.
 */
export function isCanvasScript(value: unknown): value is CanvasScript {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { txnId?: unknown; ops?: unknown }
  if (typeof candidate.txnId !== 'string') return false
  if (!Array.isArray(candidate.ops)) return false
  return candidate.ops.every(isCanvasOp)
}

/**
 * Translate a {@link CanvasOp} into the parent->iframe {@link BridgeCommand} the
 * executor posts. The op discriminator IS the bridge command `type`, so this is
 * a shape-preserving wrap in the versioned envelope.
 * @param op - the canvas operation.
 * @param txn - optional correlation id for a `commandResult` reply.
 * @returns the enveloped bridge command.
 */
export function opToBridgeCommand(op: CanvasOp, txn?: string): BridgeCommand {
  const message = { v: BRIDGE_VERSION, type: op.op, payload: op.payload }
  return (txn !== undefined ? { ...message, txn } : message) as BridgeCommand
}
