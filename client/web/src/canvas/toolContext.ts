/**
 * Canvas tool-mode context shared between VueFlowCanvas (provider) and MovieNode
 * (consumer). The Studio toolbar owns three mutually exclusive pointer modes:
 *  - `cursor`  — default: hover highlights node borders and edge arcs; click
 *    selects nodes and opens the edge disconnect bubble.
 *  - `connect` — click node A, then node B, to create an edge; `connectSourceId`
 *    keeps the first pick highlighted until the second click (or a pane click).
 *  - `delete`  — hover highlights nodes and edges; one left-click deletes the
 *    hovered element and the mode falls back to `cursor`.
 * Provided via inject/provide (not props) because MovieNode is instantiated by
 * Vue Flow's node-type registry and receives no extra props from the canvas.
 */
import type { InjectionKey, Ref } from "vue";

export type CanvasToolMode = "cursor" | "connect" | "delete";

export interface CanvasToolContext {
  /** The active pointer tool mode (from the Studio toolbar). */
  toolMode: Readonly<Ref<CanvasToolMode>>;
  /** Flow id of the first node picked while in `connect` mode, if any. */
  connectSourceId: Readonly<Ref<string | undefined>>;
}

export const CANVAS_TOOL_KEY: InjectionKey<CanvasToolContext> = Symbol("dsh-movie-canvas-tool");
