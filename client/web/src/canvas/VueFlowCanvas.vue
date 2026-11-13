<script setup lang="ts">
/**
 * The Studio Vue Flow canvas (Phase-4 P4-M3, Path B).
 *
 * Replaces the pinned ComfyUI iframe. It renders a `<VueFlow>` bound to the
 * shared store the Studio created via {@link useVueFlowBridge} (the store is
 * `provide`d there and injected here automatically, so no id prop is needed).
 * Every movie step type maps to the single generic {@link MovieNode} component.
 */
import { markRaw } from "vue";
import { VueFlow, type NodeTypesObject } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import { MOVIE_NODES } from "@dsh-movie/protocol";
import MovieNode from "@/canvas/MovieNode.vue";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";

/** Map every registered movie `class_type` to the generic node component. */
const nodeTypes: NodeTypesObject = {};
for (const node of MOVIE_NODES) {
  nodeTypes[node.classType] = markRaw(MovieNode);
}
</script>

<template>
  <VueFlow
    class="movieCanvas"
    :node-types="nodeTypes"
    :min-zoom="0.2"
    :max-zoom="4"
    :snap-to-grid="false"
    fit-view-on-init
    :default-viewport="{ x: 0, y: 0, zoom: 0.6 }">
    <Background :gap="18" :size="1" />
    <MiniMap pannable zoomable />
  </VueFlow>
</template>

<style lang="scss" scoped>
.movieCanvas {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  background: #202124;
}
</style>
