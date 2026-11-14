/**
 * Server-side canvas op-script applier (Phase-5 D7/D9).
 *
 * The browser half of the `canvas.*` channel ({@link useCanvasScript.ts}) applies
 * an agent op-script to the LIVE Vue Flow graph through the iframe bridge. Phase-5
 * D7 closes the chat→graph loop with NO client in the loop: `customer_service`
 * mines a room utterance, the canvas planner emits a validated
 * {@link CanvasScript}, and the gateway must apply it to the server-authoritative
 * {@link WorkflowGraph} directly, commit it, fan it out over `workflow/watch`, and
 * narrate it once (D9).
 *
 * This module is that server-side applier. It is PURE and transactional, mirroring
 * the client executor's semantics op-for-op so an agent script produces the same
 * persisted graph whether it was applied in the browser or on the host:
 *
 *  - ids are allocated from `last_node_id` / `last_link_id` (never reused);
 *  - a node is built from its registry schema (typed input/output slots, positional
 *    widget defaults overridden by `props`), exactly as the client mapper does;
 *  - every op carries a postcondition; a miss is a HARD failure that rolls the whole
 *    transaction back (the caller then drives the corrective re-plan loop);
 *  - the D9 narration summary (`+ ImageGenerator #7; edge #3→#7`) is derived from the
 *    SAME applied ops, so the timeline reflects precisely what committed.
 *
 * `node.setStatus` and `view.fit` are view-only ops with no persisted-graph effect;
 * they are accepted (postcondition trivially true) but contribute nothing to the
 * graph and are omitted from the narration.
 *
 * @module dsh-movie-gateway/movie-executor/apply-ops
 */

import {
  FUNCTIONAL_NODES,
  MOVIE_NODES,
  type CanvasOp,
  type MovieNodeSchema,
  type OpResult,
  type WorkflowGraph,
  type WorkflowLinkTuple,
  type WorkflowNode,
  type WorkflowSlot,
} from '@dsh-movie/protocol'

/** `class_type` -> schema across BOTH catalogs (legacy steps + functional, D1/D3). */
const SCHEMA_BY_TYPE = new Map<string, MovieNodeSchema>(
  [...MOVIE_NODES, ...FUNCTIONAL_NODES].map((node): [string, MovieNodeSchema] => [node.classType, node]),
)

/** Default node body size, matching the client mapper's `DEFAULT_SIZE`. */
const DEFAULT_SIZE: [number, number] = [230, 130]

/** The outcome of applying an op-script to a graph. */
export interface ApplyOpsOutcome {
  /**
   * The resulting graph. On a committed transaction this is the mutated clone; on a
   * rollback it is the ORIGINAL graph object, unchanged (safe to re-commit as-is).
   */
  graph: WorkflowGraph
  /** Per-op outcomes, in script order (skipped ops after a hard failure included). */
  results: OpResult[]
  /** True when every op applied and satisfied its postcondition (no rollback). */
  committed: boolean
  /** The one-line D9 narration summary of the committed ops (empty on rollback). */
  summary: string
}

/** Deep-clone a plain-data graph so the applier never mutates the caller's copy. */
function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph
}

/** The next free node id: max(`last_node_id`, every node id) + 1. */
function nextNodeId(graph: WorkflowGraph): number {
  let max = graph.last_node_id ?? 0
  for (const node of graph.nodes ?? []) {
    if (Number.isFinite(node.id)) max = Math.max(max, node.id)
  }
  return max + 1
}

/** The next free link id: max(`last_link_id`, every link tuple id) + 1. */
function nextLinkId(graph: WorkflowGraph): number {
  let max = graph.last_link_id ?? 0
  for (const tuple of graph.links ?? []) {
    const linkId = Number(tuple[0])
    if (Number.isFinite(linkId)) max = Math.max(max, linkId)
  }
  return max + 1
}

/** The positional widget defaults for a schema, before any `props` overrides. */
function defaultWidgetValues(schema: MovieNodeSchema): unknown[] {
  return schema.widgets.map((widget): unknown =>
    widget.default ?? (widget.type === 'COMBO' ? widget.options?.[0] ?? '' : ''),
  )
}

/**
 * Build a fresh {@link WorkflowNode} from a registry schema, mirroring the client
 * mapper: typed input/output slots (all unconnected), positional widget values with
 * `props` applied by widget name, and a default body size.
 * @param schema - the resolved node schema.
 * @param id - the allocated node id.
 * @param pos - the canvas `[x, y]`.
 * @param props - optional widget-name -> value overrides (and a `title` key).
 * @returns the constructed workflow node.
 */
function buildNode(
  schema: MovieNodeSchema,
  id: number,
  pos: [number, number],
  props?: Record<string, unknown>,
): WorkflowNode {
  const values = defaultWidgetValues(schema)
  if (props !== undefined) {
    schema.widgets.forEach((widget, index) => {
      if (props[widget.name] !== undefined) values[index] = props[widget.name]
    })
  }
  const inputs: WorkflowSlot[] = schema.inputs.map((slot): WorkflowSlot => ({
    name: slot.name,
    type: slot.type,
    link: null,
  }))
  const outputs: WorkflowSlot[] = schema.outputs.map((slot, index): WorkflowSlot => ({
    name: slot.name,
    type: slot.type,
    link: null,
    links: null,
    slot_index: index,
  }))
  const node: WorkflowNode = {
    id,
    type: schema.classType,
    pos: [pos[0] ?? 0, pos[1] ?? 0],
    size: [DEFAULT_SIZE[0], DEFAULT_SIZE[1]],
    flags: 0,
    order: 0,
    mode: 0,
    inputs,
    outputs,
    properties: {},
    widgets_values: values,
  }
  const title = props?.title
  if (typeof title === 'string' && title !== '') node.title = title
  return node
}

/** Find a node by id, or `undefined`. */
function findNode(graph: WorkflowGraph, id: number): WorkflowNode | undefined {
  return (graph.nodes ?? []).find((node): boolean => node.id === id)
}

/**
 * Record a link on both endpoint slots: the target input takes the single link id;
 * the source output appends it to its fan-out `links` list (and mirrors `link`).
 */
function attachLink(graph: WorkflowGraph, linkId: number, fromId: number, fromSlot: number, toId: number, toSlot: number): void {
  const source = findNode(graph, fromId)
  const target = findNode(graph, toId)
  const outSlot = source?.outputs?.[fromSlot]
  if (outSlot !== undefined) {
    const links = Array.isArray(outSlot.links) ? [...outSlot.links] : []
    links.push(linkId)
    outSlot.links = links
    outSlot.link = links[0] ?? null
  }
  const inSlot = target?.inputs?.[toSlot]
  if (inSlot !== undefined) inSlot.link = linkId
}

/**
 * Clear a link from both endpoint slots (used by `edge.remove` and node deletion).
 */
function detachLink(graph: WorkflowGraph, linkId: number, fromId: number, fromSlot: number, toId: number, toSlot: number): void {
  const source = findNode(graph, fromId)
  const target = findNode(graph, toId)
  const outSlot = source?.outputs?.[fromSlot]
  if (outSlot !== undefined) {
    const links = (Array.isArray(outSlot.links) ? outSlot.links : []).filter((entry): boolean => entry !== linkId)
    outSlot.links = links.length > 0 ? links : null
    outSlot.link = links[0] ?? null
  }
  const inSlot = target?.inputs?.[toSlot]
  if (inSlot !== undefined && inSlot.link === linkId) inSlot.link = null
}

/** Remove every link touching a node and clear the node's own slot link refs. */
function removeNodeLinks(graph: WorkflowGraph, id: number): void {
  const links = graph.links ?? []
  const surviving: WorkflowLinkTuple[] = []
  for (const tuple of links) {
    const [, fromNode, fromSlot, toNode, toSlot] = tuple as WorkflowLinkTuple
    if (Number(fromNode) === id || Number(toNode) === id) {
      detachLink(graph, Number(tuple[0]), Number(fromNode), Number(fromSlot), Number(toNode), Number(toSlot))
      continue
    }
    surviving.push(tuple)
  }
  graph.links = surviving
}

/** A short human label for a node type used in the D9 narration. */
function nodeLabel(schema: MovieNodeSchema | undefined, classType: string): string {
  return schema?.displayName ?? classType
}

/**
 * Apply one op to the working graph, returning an error string on failure or
 * `null` on success. Mutates `graph` in place; the caller rolls back on error.
 * @param graph - the working (cloned) graph.
 * @param op - the op to apply.
 * @param narration - accumulator for the op's D9 summary token (view-only ops add none).
 * @returns `null` when the op applied and its postcondition holds, else the reason.
 */
function applyOne(graph: WorkflowGraph, op: CanvasOp, narration: string[]): string | null {
  const payload = op.payload as Record<string, unknown>
  switch (op.op) {
    case 'node.add': {
      const classType = String(payload.nodeType ?? '')
      const schema = SCHEMA_BY_TYPE.get(classType)
      if (schema === undefined) return `unknown node type: ${classType === '' ? '(empty)' : classType}`
      const requested = payload.id
      const id = typeof requested === 'number' && Number.isFinite(requested) && findNode(graph, requested) === undefined
        ? requested
        : nextNodeId(graph)
      const rawPos = Array.isArray(payload.pos) ? payload.pos : [0, 0]
      const pos: [number, number] = [Number(rawPos[0]) || 0, Number(rawPos[1]) || 0]
      const props = (payload.props !== undefined && typeof payload.props === 'object' && payload.props !== null
        ? payload.props
        : undefined) as Record<string, unknown> | undefined
      const node = buildNode(schema, id, pos, props)
      graph.nodes = [...(graph.nodes ?? []), node]
      graph.last_node_id = Math.max(graph.last_node_id ?? 0, id)
      narration.push(`+ ${nodeLabel(schema, classType)} #${id}`)
      return null
    }
    case 'node.remove': {
      const id = Number(payload.id)
      if (!Number.isFinite(id) || findNode(graph, id) === undefined) return `node #${id} not found`
      removeNodeLinks(graph, id)
      graph.nodes = (graph.nodes ?? []).filter((node): boolean => node.id !== id)
      narration.push(`− #${id}`)
      return null
    }
    case 'node.move': {
      const id = Number(payload.id)
      const node = findNode(graph, id)
      if (node === undefined) return `node #${id} not found`
      node.pos = [Number(payload.x) || 0, Number(payload.y) || 0]
      narration.push(`↔ #${id}`)
      return null
    }
    case 'node.setWidget': {
      const id = Number(payload.id)
      const node = findNode(graph, id)
      if (node === undefined) return `node #${id} not found`
      const key = String(payload.key ?? '')
      const schema = SCHEMA_BY_TYPE.get(node.type)
      const index = schema?.widgets.findIndex((widget): boolean => widget.name === key) ?? -1
      if (index < 0) return `widget "${key}" not found on node #${id}`
      const values = Array.isArray(node.widgets_values) ? [...node.widgets_values] : []
      while (values.length <= index) values.push('')
      values[index] = payload.value
      node.widgets_values = values
      narration.push(`✎ #${id}.${key}`)
      return null
    }
    case 'node.setStatus': {
      // View-only: run status is not persisted on the graph. Accept, narrate nothing.
      const id = Number(payload.id)
      if (!Number.isFinite(id) || findNode(graph, id) === undefined) return `node #${id} not found`
      return null
    }
    case 'edge.add': {
      const fromId = Number(payload.fromId)
      const toId = Number(payload.toId)
      const fromSlot = Number(payload.fromSlot)
      const toSlot = Number(payload.toSlot)
      const source = findNode(graph, fromId)
      const target = findNode(graph, toId)
      if (source === undefined) return `edge source #${fromId} not found`
      if (target === undefined) return `edge target #${toId} not found`
      if (source.outputs?.[fromSlot] === undefined) return `node #${fromId} has no output slot ${fromSlot}`
      if (target.inputs?.[toSlot] === undefined) return `node #${toId} has no input slot ${toSlot}`
      const linkId = nextLinkId(graph)
      const tuple: WorkflowLinkTuple = [linkId, fromId, fromSlot, toId, toSlot]
      graph.links = [...(graph.links ?? []), tuple]
      graph.last_link_id = Math.max(graph.last_link_id ?? 0, linkId)
      attachLink(graph, linkId, fromId, fromSlot, toId, toSlot)
      narration.push(`edge #${fromId}→#${toId}`)
      return null
    }
    case 'edge.remove': {
      const id = Number(payload.id)
      const links = graph.links ?? []
      const tuple = links.find((entry): boolean => Number(entry[0]) === id)
      if (tuple === undefined) return `link #${id} not found`
      const [, fromNode, fromSlot, toNode, toSlot] = tuple as WorkflowLinkTuple
      detachLink(graph, id, Number(fromNode), Number(fromSlot), Number(toNode), Number(toSlot))
      graph.links = links.filter((entry): boolean => Number(entry[0]) !== id)
      narration.push(`−edge #${id}`)
      return null
    }
    case 'group.collapse': {
      const title = String(payload.title ?? '')
      const collapsed = payload.collapsed === true
      const group = (graph.groups ?? []).find((entry): boolean => entry.title === title)
      if (group === undefined) return `group "${title}" not found`
      group.collapsed = collapsed
      narration.push(`group "${title}" ${collapsed ? 'collapsed' : 'expanded'}`)
      return null
    }
    case 'view.fit':
      // View-only: no persisted-graph effect, nothing to narrate.
      return null
    default:
      return `unsupported op: ${String((op as { op?: unknown }).op)}`
  }
}

/**
 * Apply a validated op-script to a graph transactionally.
 *
 * Ops are applied IN ORDER to a deep clone. The first op that fails its
 * postcondition aborts the transaction: the clone is discarded, every remaining op
 * is marked skipped, `committed` is false, and the ORIGINAL graph is returned
 * unchanged (so a caller may safely re-commit or drive a corrective re-plan). On
 * full success the mutated clone is returned with updated `last_node_id` /
 * `last_link_id`, `committed` is true, and `summary` is the one-line D9 narration.
 *
 * @param graph - the current server-authoritative graph (not mutated).
 * @param ops - the validated op-script ops to apply.
 * @returns the {@link ApplyOpsOutcome}.
 */
export function applyOpsToGraph(graph: WorkflowGraph, ops: readonly CanvasOp[]): ApplyOpsOutcome {
  const working = cloneGraph(graph)
  const results: OpResult[] = []
  const narration: string[] = []
  let committed = true

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] as CanvasOp
    if (!committed) {
      results.push({ index, op, ok: false, error: 'skipped: a prior op failed' })
      continue
    }
    const error = applyOne(working, op, narration)
    if (error === null) {
      results.push({ index, op, ok: true })
    } else {
      results.push({ index, op, ok: false, error })
      committed = false
    }
  }

  if (!committed) {
    return { graph, results, committed: false, summary: '' }
  }
  return { graph: working, results, committed: true, summary: narration.join('; ') }
}
