/**
 * Editor-graph schema migrations (contract-as-code: pure functions only).
 *
 * When the node catalog unifies or retires an input slot, graphs saved BEFORE
 * the change still carry the old slot indices. The canvas load path is
 * schema-authoritative (a link whose target slot index is out of range for the
 * live schema is dropped), so stale indices would silently disconnect wires.
 * The gateway's workspace store therefore runs every graph it READS or WRITES
 * through {@link migrateGraph}: old rooms converge onto the current schema on
 * the next autosave/commit without ever rewriting immutable history files.
 *
 * Migration list (each step idempotent):
 *  1. Video Generator unified REF slot — the legacy two-input layout
 *     (`prompt` slot 0, `image` slot 1) collapsed into ONE variadic `in`
 *     slot 0 (type `REF`; the gateway adapter splits links by source output
 *     type). Links targeting slot 1 are remapped to slot 0 — composition
 *     order is preserved because a variadic slot resolves in link-creation
 *     order — and the stored node's `inputs` array is rewritten to the single
 *     unified slot, its PRIMARY `link` pointer set to the oldest link that
 *     still targets the node (matching the LiteGraph serialization shape).
 *
 * @module @dsh-movie/protocol/migrate
 */

import type { WorkflowGraph, WorkflowLinkTuple, WorkflowNode, WorkflowSlot } from './leg-b.ts'
import { REF_SLOT_TYPE } from './nodes.ts'

/** Class types whose saved graphs may use the legacy two-input layout. */
const UNIFIED_REF_CLASSES: ReadonlySet<string> = new Set(['VideoGenerator'])

/** The unified slot's name in the current schema (see `nodes.ts`). */
const UNIFIED_SLOT_NAME = 'in'

/** The legacy second (`image`) input slot index folded into slot 0. */
const LEGACY_SECOND_SLOT = 1

/**
 * Bring one editor graph up to the current node-catalog schema.
 * @param graph - the stored (possibly legacy) workflow graph.
 * @returns the migrated graph — the SAME object when nothing changed.
 */
export function migrateGraph(graph: WorkflowGraph): WorkflowGraph {
  if (typeof graph !== 'object' || graph === null || !Array.isArray(graph.nodes)) return graph
  const unifiedIds = new Set<number>(
    graph.nodes
      .filter((node): boolean => UNIFIED_REF_CLASSES.has(node.type))
      .map((node): number => node.id),
  )
  if (unifiedIds.size === 0) return graph

  // 1a. Fold links targeting the legacy second slot onto the unified slot 0.
  let linksChanged = false
  const links: WorkflowLinkTuple[] = (graph.links ?? []).map((tuple): WorkflowLinkTuple => {
    const [linkId, from, fromSlot, to, toSlot, ...rest] = tuple
    if (!unifiedIds.has(Number(to)) || Number(toSlot) !== LEGACY_SECOND_SLOT) return tuple
    linksChanged = true
    return [linkId, from, fromSlot, to, 0, ...rest]
  })

  // The PRIMARY link pointer of a variadic slot is its OLDEST link
  // (link-creation order = composition order), per the WorkflowSlot contract.
  const primaryByNode = new Map<number, number>()
  for (const tuple of links) {
    const to = Number(tuple[3])
    const linkId = Number(tuple[0])
    const current = primaryByNode.get(to)
    if (current === undefined || linkId < current) primaryByNode.set(to, linkId)
  }

  // 1b. Rewrite stored per-node input arrays to the single unified slot.
  let nodesChanged = false
  const nodes: WorkflowNode[] = graph.nodes.map((node): WorkflowNode => {
    if (!unifiedIds.has(node.id)) return node
    const stored = node.inputs ?? []
    const alreadyUnified =
      stored.length === 1 && stored[0]?.name === UNIFIED_SLOT_NAME && stored[0]?.type === REF_SLOT_TYPE
    // A node with no serialized inputs needs no rewrite: the schema-
    // authoritative load path synthesizes the slot list from the catalog.
    if (alreadyUnified || stored.length === 0) return node
    nodesChanged = true
    const slot: WorkflowSlot = { name: UNIFIED_SLOT_NAME, type: REF_SLOT_TYPE, link: primaryByNode.get(node.id) ?? null }
    return { ...node, inputs: [slot] }
  })

  if (!linksChanged && !nodesChanged) return graph
  return { ...graph, links, nodes }
}
