/**
 * Server-side op-script validation (Phase-3 P3-M3, design doc §5/§8).
 *
 * The agent emits constrained op-scripts, never arbitrary JS. Before a script is
 * streamed to a client, every op is checked against the catalog: the `op`
 * discriminator must be a known {@link CanvasOpType}, and its `payload` must
 * match that op's schemastery schema. This is the server-side guard against
 * hallucinated/invalid ops (design doc §8 "Hallucinated/invalid ops"); the
 * client executor adds a second line of defense with postcondition checks.
 *
 * Pure and dependency-light so it is unit-testable from `verify-canvas-script`.
 *
 * @module dsh-movie-gateway/op-script-validator
 */

import z from '@deepseek-ai/schemastery'
import { CANVAS_OP_TYPES, type CanvasOp, type CanvasOpType } from '@dsh-movie/protocol'

/** The outcome of validating a raw op array. */
export type OpsValidation =
  | { ok: true; ops: CanvasOp[] }
  | { ok: false; message: string }

/** The six node run statuses a `node.setStatus` op may paint. */
const nodeRunStatus = z.union([
  z.const('idle'),
  z.const('queued'),
  z.const('running'),
  z.const('progress'),
  z.const('success'),
  z.const('error'),
])

/**
 * One schemastery payload schema per catalog op. Mandatory scalars are
 * `.required()`; optional/loose fields (widget `value`, `props`, `view.fit` ids)
 * stay permissive because the bridge tolerates them.
 */
const payloadSchemas: Record<CanvasOpType, Schemastery> = {
  'node.add': z.object({
    nodeType: z.string().required(),
    pos: z.array(z.number()).required(),
    props: z.dict(z.any()),
    id: z.number(),
  }),
  'node.remove': z.object({
    id: z.number().required(),
  }),
  'node.move': z.object({
    id: z.number().required(),
    x: z.number().required(),
    y: z.number().required(),
  }),
  'node.setWidget': z.object({
    id: z.number().required(),
    key: z.string().required(),
    value: z.any(),
  }),
  'node.setStatus': z.object({
    id: z.number().required(),
    status: nodeRunStatus.required(),
  }),
  'edge.add': z.object({
    fromId: z.number().required(),
    fromSlot: z.number().required(),
    toId: z.number().required(),
    toSlot: z.number().required(),
  }),
  'edge.remove': z.object({
    id: z.number().required(),
  }),
  'group.collapse': z.object({
    title: z.string().required(),
    collapsed: z.boolean().required(),
  }),
  'view.fit': z.object({
    ids: z.array(z.number()),
  }),
}

/**
 * Validate a raw (agent-produced) op array into a typed {@link CanvasOp} list.
 *
 * Rejects: a non-array; any entry that is not an object; an `op` discriminator
 * outside {@link CANVAS_OP_TYPES}; a missing/non-object `payload`; and any
 * payload that fails its op schema. The first failure short-circuits with a
 * positional message so the agent loop (Phase-3 M4) can pinpoint the bad op.
 *
 * @param raw - the untrusted op array (e.g. parsed from LLM JSON output).
 * @returns `{ ok: true, ops }` on success, else `{ ok: false, message }`.
 */
export function validateOps(raw: unknown): OpsValidation {
  if (!Array.isArray(raw)) return { ok: false, message: 'ops must be an array' }
  const ops: CanvasOp[] = []
  for (let index = 0; index < raw.length; index++) {
    const entry: unknown = raw[index]
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, message: `op[${index}] must be an object` }
    }
    const record = entry as { op?: unknown; payload?: unknown }
    const opType = record.op
    if (typeof opType !== 'string' || !CANVAS_OP_TYPES.includes(opType as CanvasOpType)) {
      return { ok: false, message: `op[${index}] has an unknown op type: ${String(opType)}` }
    }
    const type = opType as CanvasOpType
    const payload = record.payload
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, message: `op[${index}] (${type}) requires a payload object` }
    }
    const schema = payloadSchemas[type]
    try {
      const normalized: unknown = schema(payload)
      ops.push({ op: type, payload: normalized } as CanvasOp)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `op[${index}] (${type}) payload invalid: ${message}` }
    }
  }
  return { ok: true, ops }
}
