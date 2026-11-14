/**
 * Group-box overlay helpers (Phase-5 D13).
 *
 * Groups are aesthetic-only bookkeeping: an under-node rectangle layer that
 * renders `WorkflowGraph.groups`, is created by a one-shot pointer-drag while
 * the 分组节点 tool is armed, and is ignored by validation/topo/runner. Vue Flow
 * has no group primitive and nodes are never children of a group, so the boxes
 * are plain absolutely-positioned rectangles laid out in graph coordinates
 * inside the transformed viewport.
 *
 * This module is the pure data half (color palette + drag geometry); the visual
 * layer is rendered by `VueFlowCanvas.vue` and the rename/recolor popover by
 * `pages/studio/index.vue`.
 *
 * @module @/canvas/groupOverlay
 */

import type { WorkflowGroup } from "@dsh-movie/protocol";

/**
 * The selectable group background colors, keyed by the string `color` a
 * {@link WorkflowGroup} stores (matching the LiteGraph numeric color-key shape
 * the pinned frontend serializes). Order defines the swatch order in the
 * recolor popover.
 */
export const GROUP_COLOR_KEYS: readonly string[] = ["0", "1", "2", "3", "4", "5", "6", "7"];

/** Color key → hex. Unknown keys fall back to {@link DEFAULT_GROUP_COLOR}. */
const GROUP_COLOR_HEX: Readonly<Record<string, string>> = {
  "0": "#409eff",
  "1": "#52c41a",
  "2": "#faad14",
  "3": "#f56c6c",
  "4": "#9254de",
  "5": "#13c2c2",
  "6": "#eb2f96",
  "7": "#8c8c8c",
};

/** The default group color key (blue). */
export const DEFAULT_GROUP_COLOR = "0";

/**
 * Resolve a group's color key to a hex color.
 * @param key - the stored color key (may be undefined for legacy groups).
 * @returns a CSS hex color.
 */
export function groupColor(key: string | undefined): string {
  if (key === undefined) return GROUP_COLOR_HEX[DEFAULT_GROUP_COLOR];
  return GROUP_COLOR_HEX[key] ?? GROUP_COLOR_HEX[DEFAULT_GROUP_COLOR];
}

/** The minimum drag size (in graph px) that counts as an intentional group. */
export const MIN_GROUP_SIZE = 40;

/**
 * Normalize a two-corner drag into a `bounding` box `[x, y, width, height]`
 * with a non-negative origin and size, so a drag in any direction yields the
 * same rectangle.
 * @param start - the drag start in graph coordinates.
 * @param end - the drag end in graph coordinates.
 * @returns the bounding box, or `undefined` when the drag was too small.
 */
export function boundingFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
): WorkflowGroup["bounding"] | undefined {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < MIN_GROUP_SIZE || height < MIN_GROUP_SIZE) return undefined;
  return [x, y, width, height];
}
