/**
 * Leg B executor topological sort (Phase-3 P3-M4, design doc §6).
 *
 * Orders a flattened prompt graph for execution with Kahn's algorithm over the
 * link edges (`inputs[*] = [sourceId, slotIndex]`): a node runs only after every
 * node it links from. When the graph has a cycle the unorderable remainder is
 * returned so the gateway can reject the prompt.
 *
 * @module dsh-movie-gateway/movie-executor/topo
 */

import type { PromptGraph, PromptGraphNode } from '@dsh-movie/protocol'

/** The outcome of a topological sort. */
export type TopoSortResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] }

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
 * Topologically sort a prompt graph by its link edges.
 * @param graph - the `POST /prompt` execution graph.
 * @returns `{ ok: true, order }` (sources first), or `{ ok: false, cycle }`
 *   listing the node ids that could not be ordered.
 */
export function topoSort(graph: PromptGraph): TopoSortResult {
  const ids = Object.keys(graph)
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    dependents.set(id, [])
  }

  for (const id of ids) {
    const node: PromptGraphNode | undefined = graph[id]
    const inputs: unknown = node?.inputs
    if (typeof inputs !== 'object' || inputs === null) continue
    for (const value of Object.values(inputs as Record<string, unknown>)) {
      if (!isLink(value)) continue
      const sourceId = String(value[0])
      if (sourceId === id) continue
      const list = dependents.get(sourceId)
      if (list === undefined) continue
      list.push(id)
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
    }
  }

  const queue: string[] = ids.filter((id): boolean => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    order.push(id)
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) queue.push(dependent)
    }
  }

  if (order.length === ids.length) return { ok: true, order }
  const cycle = ids.filter((id): boolean => (indegree.get(id) ?? 0) > 0)
  return { ok: false, cycle }
}
