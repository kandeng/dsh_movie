/**
 * Leg B executor prompt validation (Phase-3 P3-M4, design doc §6).
 *
 * Validates a flattened ComfyUI prompt graph before it is scheduled: every
 * `class_type` must be in the executor {@link registry}, node specs may carry
 * only the known keys (`class_type`, `inputs`, `_meta`), and every link input
 * `[sourceId, slotIndex]` must reference an existing node and an in-range output
 * slot. The result mirrors the ComfyUI `/prompt` `node_errors` shape so the
 * gateway can return it verbatim on a 400.
 *
 * @module dsh-movie-gateway/movie-executor/validate
 */

import type { PromptGraph, PromptGraphNode } from '@dsh-movie/protocol'
import { classTypeOutputs, isKnownClassType } from './registry.ts'

/** The per-node error bundle returned in a failed validation. */
export interface NodeError {
  /** The node's declared `class_type` (empty when missing/invalid). */
  class_type: string
  /** Human-readable validation errors for this node. */
  errors: string[]
}

/** The outcome of validating one prompt graph. */
export type PromptValidation =
  | { ok: true }
  | { ok: false; nodeErrors: Record<string, NodeError> }

/** Node-spec keys the executor accepts (anything else is rejected). */
const ALLOWED_NODE_KEYS: ReadonlySet<string> = new Set(['class_type', 'inputs', '_meta'])

/**
 * Narrow an input value to a ComfyUI link tuple `[sourceId, slotIndex]`.
 * @param value - the raw input value.
 * @returns true when the value is a two-element link reference.
 */
function isLink(value: unknown): value is [string | number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    typeof value[1] === 'number'
  )
}

/**
 * Validate a flattened prompt graph against the executor registry.
 * @param graph - the `POST /prompt` execution graph.
 * @returns `{ ok: true }`, or `{ ok: false, nodeErrors }` keyed by node id.
 */
export function validatePromptGraph(graph: PromptGraph): PromptValidation {
  if (typeof graph !== 'object' || graph === null) {
    return { ok: false, nodeErrors: { '': { class_type: '', errors: ['prompt graph must be an object'] } } }
  }

  const nodeErrors: Record<string, NodeError> = {}
  const addError = (id: string, classType: string, message: string): void => {
    const existing = nodeErrors[id]
    if (existing === undefined) {
      nodeErrors[id] = { class_type: classType, errors: [message] }
    } else {
      existing.errors.push(message)
    }
  }

  for (const id of Object.keys(graph)) {
    const node: PromptGraphNode | undefined = graph[id]
    if (typeof node !== 'object' || node === null) {
      addError(id, '', 'node must be an object')
      continue
    }

    const classType: string = node.class_type
    for (const key of Object.keys(node)) {
      if (!ALLOWED_NODE_KEYS.has(key)) addError(id, classType, `unknown node key "${key}"`)
    }
    if (typeof classType !== 'string' || !isKnownClassType(classType)) {
      addError(id, String(classType), `unknown class_type "${String(classType)}"`)
      continue
    }

    const inputs: unknown = node.inputs
    if (typeof inputs !== 'object' || inputs === null) {
      addError(id, classType, 'node.inputs must be an object')
      continue
    }

    for (const [inputKey, value] of Object.entries(inputs as Record<string, unknown>)) {
      if (!isLink(value)) continue
      const sourceId = String(value[0])
      const slot = value[1]
      if (!Object.prototype.hasOwnProperty.call(graph, sourceId)) {
        addError(id, classType, `input "${inputKey}" links to missing node "${sourceId}"`)
        continue
      }
      const sourceNode: PromptGraphNode | undefined = graph[sourceId]
      const sourceOutputs = sourceNode === undefined ? undefined : classTypeOutputs(sourceNode.class_type)
      if (sourceOutputs !== undefined && (slot < 0 || slot >= sourceOutputs.length)) {
        addError(id, classType, `input "${inputKey}" links to out-of-range slot ${slot} on node "${sourceId}"`)
      }
    }
  }

  return Object.keys(nodeErrors).length === 0 ? { ok: true } : { ok: false, nodeErrors }
}
