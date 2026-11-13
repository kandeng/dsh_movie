<script setup lang="ts">
/**
 * The Studio canvas, ported from vidsay `pages/workspace/panels/canvas/index.vue`
 * (Path B). Node types stay dsh_movie's six movie steps; everything about the
 * canvas *surface* matches vidsay:
 *  - static 16px dot field via CSS (not the Vue Flow <Background> addon),
 *  - vidsay's VueFlow prop set (zoom 0.2–8, strict connections, non-focusable
 *    nodes/edges, elevate-on-select, partial selection, no dblclick/scroll zoom,
 *    wheel = pan, Ctrl+wheel/pinch = zoom, right/middle-drag pan, hand mode),
 *  - hand-mode grab cursor + pointer-events isolation,
 *  - click-an-edge → floating disconnect bubble,
 *  - empty-canvas quick-create overlay (`canvasEmpty`).
 */
import { markRaw, nextTick, onMounted, ref, watch } from "vue";
import {
  VueFlow,
  useVueFlow,
  ConnectionMode,
  PanOnScrollMode,
  SelectionMode,
  type NodeTypesObject,
  type EdgeMouseEvent,
} from "@vue-flow/core";
import { IconUnlink } from "@tabler/icons-vue";
import { MOVIE_NODES } from "@dsh-movie/protocol";
import MovieNode from "@/canvas/MovieNode.vue";
import canvasEmpty from "@/canvas/canvasEmpty.vue";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

const props = withDefaults(defineProps<{ handMode?: boolean }>(), { handMode: false });
const emit = defineEmits<{ create: [classType: string] }>();

/** Map every registered movie `class_type` to the generic node component. */
const nodeTypes: NodeTypesObject = {};
for (const node of MOVIE_NODES) {
  nodeTypes[node.classType] = markRaw(MovieNode);
}

const { nodes, fitView, viewport, zoomTo, removeEdges, findEdge } = useVueFlow();

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

// vidsay: plain wheel pans (panOnScroll); Ctrl+wheel / trackpad pinch zooms.
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const next = Math.min(8, Math.max(0.2, viewport.value.zoom * (1 - event.deltaY * 0.01)));
  void zoomTo(next);
}

// vidsay: clicking an edge surfaces a floating disconnect bubble at the click point.
const edgeDisconnect = ref<{ id: string; x: number; y: number }>();
function onEdgeClick(event: EdgeMouseEvent) {
  const source = event.event;
  if (!("clientX" in source)) return;
  edgeDisconnect.value = { id: event.edge.id, x: source.clientX, y: source.clientY };
}
function disconnect(edgeId: string) {
  removeEdges(edgeId);
  edgeDisconnect.value = undefined;
}
</script>

<template>
  <div class="canvas" :class="{ handMode }" @wheel.capture="onWheel">
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
      :pan-on-scroll="!handMode"
      :pan-on-scroll-speed="1"
      :pan-on-drag="handMode ? true : [1, 2]"
      :pan-on-scroll-mode="PanOnScrollMode.Free"
      :delete-key-code="null"
      :multi-selection-key-code="null"
      :pan-activation-key-code="null"
      :selection-mode="SelectionMode.Partial"
      :default-edge-options="{ type: 'default' }"
      @edge-click="onEdgeClick"
      @pane-click="edgeDisconnect = undefined" />
    <canvasEmpty v-if="emptyVisible && nodes.length === 0" @create="classType => emit('create', classType)" />
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

  // vidsay: selection marquee gets an 8px breathing box.
  :deep(.vue-flow__nodesselection-rect) {
    box-sizing: content-box;
    padding: 8px;
    margin: -8px;
    border-radius: 4px;
  }
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
