<script setup lang="ts">
/**
 * The Studio canvas, ported from vidsay `pages/workspace/panels/canvas/index.vue`
 * (Path B). Node types stay dsh_movie's six movie steps; everything about the
 * canvas *surface* matches vidsay:
 *  - static 16px dot field via CSS (not the Vue Flow <Background> addon),
 *  - vidsay's VueFlow prop set (zoom 0.2–8, strict connections, non-focusable
 *    nodes/edges, elevate-on-select, partial selection, no dblclick zoom,
 *    wheel = zoom (Shift+wheel pans, pinch zooms), right/middle-drag pan, hand mode),
 *  - hand-mode grab cursor + pointer-events isolation,
 *  - click-an-edge → floating disconnect bubble,
 *  - empty-canvas hint overlay (`canvasEmpty`).
 */
import { computed, markRaw, nextTick, onMounted, provide, ref, toRef, watch } from "vue";
import {
  VueFlow,
  useVueFlow,
  ConnectionMode,
  PanOnScrollMode,
  SelectionMode,
  type NodeTypesObject,
  type EdgeMouseEvent,
  type NodeMouseEvent,
} from "@vue-flow/core";
import { IconUnlink } from "@tabler/icons-vue";
import { FUNCTIONAL_NODES, MOVIE_NODES, type WorkflowGroup } from "@dsh-movie/protocol";
import MovieNode from "@/canvas/MovieNode.vue";
import canvasEmpty from "@/canvas/canvasEmpty.vue";
import { boundingFromDrag, groupColor } from "@/canvas/groupOverlay";
import { CANVAS_TOOL_KEY, type CanvasToolMode } from "@/canvas/toolContext";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

const props = withDefaults(
  defineProps<{
    /** Hand (pan) tool armed for one gesture (Phase-5 D14). */
    handMode?: boolean;
    /** Group-draw tool armed for one rectangle (Phase-5 D13). */
    groupMode?: boolean;
    /** Live drawn group boxes rendered under the nodes (Phase-5 D13). */
    groups?: WorkflowGroup[];
    /** Active pointer tool: hover highlight + click-click connect + click delete. */
    toolMode?: CanvasToolMode;
  }>(),
  { handMode: false, groupMode: false, groups: () => [], toolMode: "cursor" },
);
const emit = defineEmits<{
  /** A completed one-shot group rectangle draw (D13). */
  "group-draw": [bounding: WorkflowGroup["bounding"]];
  /** A group's title chip was clicked; carries the screen anchor for the popover. */
  "group-click": [payload: { index: number; x: number; y: number }];
  /** The one-shot hand gesture finished, so the parent disarms (D14). */
  "hand-done": [];
  /** Connect mode: two node clicks completed a source→target pair. */
  "connect-pick": [payload: { source: number; target: number }];
  /** Delete mode: the clicked node should be removed. */
  "delete-node": [id: number];
  /** Delete mode: the clicked edge (flow id) should be removed. */
  "delete-edge": [id: string];
}>();

// ── Pointer tool context: shared with MovieNode via inject so nodes can paint
//    the hover border highlight and the sticky connect-source highlight without
//    prop drilling through Vue Flow's node-type registry. ──
const connectSourceId = ref<string | undefined>(undefined);
provide(CANVAS_TOOL_KEY, { toolMode: toRef(props, "toolMode"), connectSourceId });
// Leaving connect mode always drops a pending first pick.
watch(
  () => props.toolMode,
  (mode) => {
    if (mode !== "connect") connectSourceId.value = undefined;
  },
);

/**
 * Map every registered `class_type` to the generic node component: the six
 * deprecated movie steps ({@link MOVIE_NODES}) plus the Phase-5 functional
 * primitives ({@link FUNCTIONAL_NODES}). The catalogs are disjoint, so one loop
 * registers the whole two-layer palette (D1/D3/D12).
 */
const nodeTypes: NodeTypesObject = {};
for (const node of [...MOVIE_NODES, ...FUNCTIONAL_NODES]) {
  nodeTypes[node.classType] = markRaw(MovieNode);
}

const { nodes, fitView, viewport, removeEdges, findEdge, screenToFlowCoordinate, setTransform } = useVueFlow();

// Center the graph the first time nodes appear (workspace hydrate / demo reload from
// empty). fit-view-on-init runs before the async graph lands, so we fit here instead.
let fitted = false;
watch(
  () => nodes.value.length,
  count => {
    if (count > 0 && !fitted) {
      fitted = true;
      void nextTick(() => fitView({ padding: 0.2, duration: 200 }));
    }
    if (count === 0) fitted = false;
  },
);

// Avoid flashing the empty-state overlay while the workspace graph is still hydrating.
const emptyVisible = ref(false);
onMounted(() => {
  window.setTimeout(() => {
    emptyVisible.value = true;
  }, 400);
});

// Wheel ownership: plain wheel zooms (forward = in, backward = out) anchored at
// the cursor; Shift+wheel pans for trackpad users; Ctrl/Meta+wheel and pinch keep
// zooming. Elements vue-flow marks `.nowheel` (node widgets) scroll natively.
function onWheel(event: WheelEvent) {
  if ((event.target as HTMLElement).closest(".nowheel")) return;
  event.preventDefault();
  const vp = viewport.value;
  if (event.shiftKey) {
    setTransform({ x: vp.x - event.deltaX, y: vp.y - event.deltaY, zoom: vp.zoom });
    return;
  }
  const factor = Math.exp(-event.deltaY * 0.002);
  const next = Math.min(8, Math.max(0.2, vp.zoom * factor));
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const scale = next / vp.zoom;
  setTransform({ x: px - (px - vp.x) * scale, y: py - (py - vp.y) * scale, zoom: next });
}

// vidsay: clicking an edge surfaces a floating disconnect bubble at the click point.
// In the new tool modes the click is rerouted instead: `delete` removes the edge,
// `connect` ignores edges entirely (only nodes are pickable).
const edgeDisconnect = ref<{ id: string; x: number; y: number }>();
function onEdgeClick(event: EdgeMouseEvent) {
  if (props.toolMode === "delete") {
    emit("delete-edge", event.edge.id);
    return;
  }
  if (props.toolMode === "connect") return;
  const source = event.event;
  if (!("clientX" in source)) return;
  edgeDisconnect.value = { id: event.edge.id, x: source.clientX, y: source.clientY };
}

// ── Tool-mode node clicks: `connect` is a two-click pick (first click arms the
//    source, second on a different node completes the pair and the parent exits
//    back to cursor mode); `delete` reports the node under the cursor. ──
function onNodeToolClick(event: NodeMouseEvent): void {
  const mode = props.toolMode;
  if (mode === "connect") {
    const id = event.node.id;
    if (connectSourceId.value === undefined) {
      connectSourceId.value = id;
      return;
    }
    if (connectSourceId.value === id) return; // same node: keep waiting for a target
    emit("connect-pick", { source: Number(connectSourceId.value), target: Number(id) });
    connectSourceId.value = undefined;
    return;
  }
  if (mode === "delete") emit("delete-node", Number(event.node.id));
}

/** Pane click: dismiss the disconnect bubble and drop a pending connect source. */
function onPaneClick(): void {
  edgeDisconnect.value = undefined;
  connectSourceId.value = undefined;
}
function disconnect(edgeId: string) {
  removeEdges(edgeId);
  edgeDisconnect.value = undefined;
}

// ── Group overlay (Phase-5 D13). Boxes render in the transformed `zoom-pane`
//    slot at graph coordinates, so they pan/zoom with the nodes and sit under
//    them (z-index -1). Drawing is a ONE-SHOT pointer-drag on a screen-space
//    catcher armed by the 分组节点 tool: the two corners are projected into graph
//    space (`screenToFlowCoordinate`) and normalized into a `bounding` box, then
//    handed to the parent, which owns the group store and disarms the tool. ──
const drawing = ref(false);
const drawStart = ref<{ x: number; y: number }>();
const drawEnd = ref<{ x: number; y: number }>();

/** The live preview rectangle (graph coords) while a draw drag is in flight. */
const drawPreview = computed<WorkflowGroup["bounding"] | undefined>(() => {
  const start = drawStart.value;
  const end = drawEnd.value;
  if (start === undefined || end === undefined) return undefined;
  return [
    Math.min(start.x, end.x),
    Math.min(start.y, end.y),
    Math.abs(end.x - start.x),
    Math.abs(end.y - start.y),
  ];
});

/** Project a pointer event's client position into graph coordinates. */
function toFlow(event: PointerEvent): { x: number; y: number } {
  return screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
}

function onDrawDown(event: PointerEvent): void {
  if (!props.groupMode || event.button !== 0) return;
  event.preventDefault();
  drawing.value = true;
  drawStart.value = toFlow(event);
  drawEnd.value = drawStart.value;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onDrawMove(event: PointerEvent): void {
  if (!drawing.value) return;
  drawEnd.value = toFlow(event);
}
function onDrawUp(event: PointerEvent): void {
  if (!drawing.value) return;
  drawing.value = false;
  const start = drawStart.value;
  drawStart.value = undefined;
  drawEnd.value = undefined;
  if (start === undefined) return;
  const bounding = boundingFromDrag(start, toFlow(event));
  if (bounding !== undefined) emit("group-draw", bounding);
}

/** Click a group's title chip → give the parent the screen anchor for its popover. */
function onGroupTitle(event: MouseEvent, index: number): void {
  emit("group-click", { index, x: event.clientX, y: event.clientY });
}

// ── One-shot hand (Phase-5 D14): a completed PAN gesture disarms the tool. A
//    real drag carries a mouse/pointer/touch `sourceEvent`; a wheel or programmatic
//    zoom does not, so only genuine pans notify the parent to disarm. ──
function onMoveEnd(payload: { event?: unknown }): void {
  if (!props.handMode) return;
  const event = payload?.event as { sourceEvent?: Event | null; type?: string } | undefined;
  const source = event?.sourceEvent ?? undefined;
  const type = source?.type ?? event?.type ?? "";
  if (/^(mouse|pointer|touch)/.test(type)) emit("hand-done");
}
</script>

<template>
  <div class="canvas" :class="[{ handMode }, `tool-${toolMode}`]" @wheel.capture="onWheel">
    <VueFlow
      :node-types="nodeTypes"
      :min-zoom="0.2"
      :max-zoom="8"
      :nodes-draggable="true"
      :nodes-connectable="true"
      :connection-mode="ConnectionMode.Strict"
      :nodes-focusable="false"
      :edges-focusable="false"
      :edges-updatable="false"
      :elevate-nodes-on-select="true"
      :elevate-edges-on-select="false"
      :disable-keyboard-a11y="true"
      :select-nodes-on-drag="false"
      :auto-pan-on-node-drag="false"
      :auto-pan-on-connect="false"
      :zoom-on-double-click="false"
      :zoom-on-scroll="false"
      :zoom-on-pinch="true"
      :pan-on-scroll="false"
      :pan-on-drag="handMode ? true : [1, 2]"
      :pan-on-scroll-mode="PanOnScrollMode.Free"
      :delete-key-code="null"
      :multi-selection-key-code="null"
      :pan-activation-key-code="null"
      :selection-mode="SelectionMode.Partial"
      :default-edge-options="{ type: 'default' }"
      @node-click="onNodeToolClick"
      @edge-click="onEdgeClick"
      @move-end="onMoveEnd"
      @pane-click="onPaneClick">
      <!-- Group boxes (D13): a graph-space layer under the nodes (zoom-pane is
           inside the transformed viewport, so boxes pan/zoom with the graph). -->
      <template #zoom-pane>
        <div class="groupLayer">
          <div
            v-for="(group, index) in groups"
            :key="`group-${index}`"
            class="groupBox"
            :style="{
              left: `${group.bounding[0]}px`,
              top: `${group.bounding[1]}px`,
              width: `${group.bounding[2]}px`,
              height: `${group.bounding[3]}px`,
              '--group-color': groupColor(group.color),
            }">
            <button type="button" class="groupTitle" :title="group.title" @click.stop="onGroupTitle($event, index)">
              {{ group.title }}
            </button>
          </div>
          <div
            v-if="drawPreview"
            class="groupBox preview"
            :style="{
              left: `${drawPreview[0]}px`,
              top: `${drawPreview[1]}px`,
              width: `${drawPreview[2]}px`,
              height: `${drawPreview[3]}px`,
            }" />
        </div>
      </template>
    </VueFlow>
    <!-- One-shot group-draw catcher (D13): a screen-space overlay, armed only
         while the 分组节点 tool is active, that turns a pointer-drag into a box. -->
    <div
      v-if="groupMode"
      class="groupDrawCatcher"
      @pointerdown="onDrawDown"
      @pointermove="onDrawMove"
      @pointerup="onDrawUp"
      @pointercancel="onDrawUp" />
    <canvasEmpty v-if="emptyVisible && nodes.length === 0" />
    <teleport to="body">
      <el-button
        v-if="edgeDisconnect && findEdge(edgeDisconnect.id)"
        class="edgeDisconnect"
        type="danger"
        circle
        aria-label="断开连接"
        title="断开连接"
        :style="{ left: `${edgeDisconnect.x}px`, top: `${edgeDisconnect.y}px` }"
        @click.stop="disconnect(edgeDisconnect.id)"
        @mouseleave="edgeDisconnect = undefined">
        <IconUnlink :size="16" />
      </el-button>
    </teleport>
  </div>
</template>

<style lang="scss" scoped>
.canvas {
  width: 100%;
  height: 100%;
  // vidsay: canvas base color + dot grid identical to the Chat stage — static CSS,
  // 16px grid of 1px dots, does not scale/pan with the viewport.
  background-color: var(--el-bg-color);
  background-image: radial-gradient(var(--el-border-color) 1px, transparent 1px);
  background-size: 16px 16px;

  // vidsay: hand tool isolates the transformation pane so drag always pans.
  &.handMode :deep(.vue-flow__transformationpane),
  &.handMode :deep(.vue-flow__transformationpane *) {
    pointer-events: none !important;
  }

  &.handMode :deep(.vue-flow__pane) {
    cursor: grab;
  }

  // vidsay: show every target handle while a connection drag is in flight.
  &:has(.vue-flow__connection) :deep(.vue-flow__node:not(.selected) .nodeHandle.target .handleIcon) {
    opacity: 1;
  }

  // Cursor / delete modes: hovering an edge highlights the whole arc (the g
  // wrapper receives :hover from either the visible path or the fat invisible
  // interaction path vue-flow renders underneath it).
  &.tool-cursor :deep(.vue-flow__edge:hover .vue-flow__edge-path),
  &.tool-delete :deep(.vue-flow__edge:hover .vue-flow__edge-path) {
    stroke: var(--el-color-primary);
    stroke-width: 2.5;
  }

  // Connect mode: nodes read as pick targets.
  &.tool-connect :deep(.vue-flow__node) {
    cursor: crosshair;
  }

  // Delete mode: everything is a click-to-remove target.
  &.tool-delete :deep(.vue-flow__node),
  &.tool-delete :deep(.vue-flow__edge) {
    cursor: pointer;
  }

  // vidsay: selection marquee gets an 8px breathing box.
  :deep(.vue-flow__nodesselection-rect) {
    box-sizing: content-box;
    padding: 8px;
    margin: -8px;
    border-radius: 4px;
  }
}

.groupLayer {
  // Drawn under the nodes: the transformed pane is the stacking context, so a
  // negative z-index paints the boxes above the canvas grid but below nodes/edges.
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  pointer-events: none;
}

.groupBox {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--group-color, var(--el-color-primary));
  border-radius: 8px;
  background: color-mix(in srgb, var(--group-color, var(--el-color-primary)) 12%, transparent);

  &.preview {
    border-style: dashed;
    background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  }
}

.groupTitle {
  position: absolute;
  top: 0;
  left: 0;
  max-width: calc(100% - 8px);
  padding: 2px 10px;
  border: 0;
  border-radius: 8px 0 8px 0;
  background: var(--group-color, var(--el-color-primary));
  color: #fff;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  // The title chip is the only interactive part of a group, so the box body
  // never blocks panning or node dragging.
  pointer-events: auto;
}

.groupDrawCatcher {
  position: absolute;
  inset: 0;
  z-index: 20;
  cursor: crosshair;
  touch-action: none;
}

.edgeDisconnect {
  position: fixed;
  z-index: 1000;
  width: 32px;
  height: 32px;
  padding: 0;
  transform: translate(-50%, -50%);
}
</style>
