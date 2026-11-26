/**
 * Client-side template expansion (Phase-5 D6).
 *
 * A {@link WorkflowTemplate} is pure data: local node keys, functional class
 * types, canvas offsets, widget overrides, and internal links. Dropping one
 * expands it EAGERLY into ordinary graph nodes with fresh numeric ids — after
 * the drop the inserted nodes are indistinguishable from hand-placed ones
 * (rewire, edit, delete, branch freely). The server never sees templates: the
 * persisted `WorkflowGraph` and the submitted `PromptGraph` always contain
 * expanded functional nodes only, so validation/topo/runner/governance never
 * learn templates exist (D6).
 *
 * Expansion rides the EXISTING bridge commands (`node.add` → `{ id }`,
 * `edge.add` → `{ link }`) so it shares one code path with manual edits and the
 * AI op-script executor: ids are allocated by the bridge's `nextNodeId`, the
 * edits coalesce into a single debounced `graphChanged`, and host autosave /
 * undo / commit all apply unchanged.
 *
 * @module @/canvas/expandTemplate
 */

import type { WorkflowTemplate } from "@dsh-movie/protocol";
import type { CanvasBridge } from "@/composables/useCanvasBridge";

/** The result of expanding a template onto the canvas. */
export interface ExpandTemplateResult {
  /** The freshly created node ids, in the template's node order. */
  nodeIds: number[];
  /** The number of internal links wired between them. */
  linkCount: number;
}

/**
 * Expand a template at a canvas origin into fresh nodes + internal links.
 *
 * Each template node is added via `node.add` (which allocates the next free
 * numeric id, applies `widgetOverrides` through `props`, and applies an optional
 * `title` override); the returned ids are keyed by the template-local node key so
 * the internal links can be wired with `edge.add`. Links referencing an unknown
 * key are skipped defensively.
 * @param bridge - the canvas bridge driving the shared Vue Flow store.
 * @param template - the workflow template to instantiate.
 * @param origin - the canvas `[x, y]` the template's `[0, 0]` maps onto.
 * @returns the created node ids and the wired link count.
 */
export async function expandTemplate(
  bridge: CanvasBridge,
  template: WorkflowTemplate,
  origin: [number, number],
): Promise<ExpandTemplateResult> {
  const idByKey = new Map<string, number>();
  const nodeIds: number[] = [];

  for (const spec of template.nodes) {
    const pos: [number, number] = [origin[0] + spec.pos[0], origin[1] + spec.pos[1]];
    const result = (await bridge.request("node.add", {
      nodeType: spec.classType,
      pos,
      ...(spec.widgets === undefined ? {} : { props: spec.widgets }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
    })) as { id?: number } | null;
    const id = Number(result?.id);
    if (!Number.isFinite(id)) continue;
    idByKey.set(spec.key, id);
    nodeIds.push(id);
  }

  let linkCount = 0;
  for (const link of template.links) {
    const fromId = idByKey.get(link.from);
    const toId = idByKey.get(link.to);
    if (fromId === undefined || toId === undefined) continue;
    await bridge.request("edge.add", {
      fromId,
      fromSlot: link.fromSlot,
      toId,
      toSlot: link.toSlot,
    });
    linkCount += 1;
  }

  return { nodeIds, linkCount };
}
