<script setup lang="ts">
/**
 * Generic Vue Flow node for every movie step — Phase-6 D11: a presence token.
 *
 * Three rows only, top to bottom:
 *   1. modality icon + localized node type, in the family accent hue;
 *   2. the node name (displayed here, edited only in the editor card);
 *   3. a read-only content stub: image thumbnail, video first frame
 *      (`#t=0.5`), audio glyph + file name, or two clamped text lines
 *      (user description, else the first paragraph of the text payload).
 *
 * Running status is carried by the border color plus one corner dot (D13) —
 * no status word. The reviewer verdict line stays: a verdict is output data,
 * not status. Everything else the old card rendered (editable widgets, the
 * full port name/type lists, schema blurb, modality chip, family pill, step
 * badge) is gone: decoration without meaning, and editing moved to the editor
 * card. The ONE port residue that came back is each slot's NAME as a tiny
 * label beside its dot — wiring a Text Input into `skill` (slot 2) instead of
 * `prompt` (slot 0) was a blind guess with anonymous dots.
 *
 * This component never writes: it reads {@link MovieNodeData} produced by the
 * {@link graphMapper} and renders it. Handles stay because edges need them.
 */
import { computed, inject } from "vue";
import { Handle, Position, useVueFlow, type NodeProps } from "@vue-flow/core";
import { IconCircleDashed, IconCircleDot, IconVolume2 } from "@tabler/icons-vue";
import { translate } from "@dsh-movie/i18n/vue";
import { mergesInputs, schemaFor, type MovieNodeData } from "@/canvas/graphMapper";
import { nodeSkin } from "@/canvas/nodeSkin";
import { CANVAS_TOOL_KEY } from "@/canvas/toolContext";

const props = defineProps<NodeProps<MovieNodeData>>();
const { edges } = useVueFlow();

// Canvas tool context (absent only if the node is mounted outside VueFlowCanvas):
// every pointer tool mode (cursor/connect/delete) highlights the node border on
// hover, and `connect` keeps the first-picked source node highlighted until the
// second click lands on a target.
const tool = inject(CANVAS_TOOL_KEY, null);
const isConnectSource = computed(() => tool !== null && tool.connectSourceId.value === props.id);

const data = computed<MovieNodeData>(() => props.data ?? ({} as MovieNodeData));
const schema = computed(() => schemaFor(data.value.classType));
const widgets = computed(() => data.value.widgets ?? []);
const status = computed(() => data.value.status ?? "idle");
const family = computed(() => schema.value?.family);
const modality = computed(() => schema.value?.modality);

/** Row 1: the localized node type (English protocol names are i18n keys). */
const typeLabel = computed(() => translate(schema.value?.displayName ?? data.value.classType));
/** Row 2: the node name; a fresh node defaults to its localized type name. */
const nodeName = computed(() => data.value.title ?? typeLabel.value);

/** Identity skin (icon + family accent hue), shared with the docked editor's
 *  header row so the two surfaces never drift apart (`canvas/nodeSkin`). */
const skin = computed(() => nodeSkin(data.value.classType));
const typeIcon = computed(() => skin.value.icon);
const accent = computed(() => skin.value.accent);

/**
 * Reviewer verdict line (Phase-5 D5). The Leg B `executed` output for a
 * reviewer carries the verdict as its artifact; the Studio paints it onto the
 * node data (view-only). PASS/FAIL is inferred from the text so the line can be
 * colored — a FAIL verdict is DATA, never a thrown error, so the node still
 * shows `success` while the verdict line reads FAIL.
 */
const verdict = computed(() => data.value.verdict ?? "");
const verdictState = computed<"pass" | "fail" | "">(() => {
  const text = verdict.value.toUpperCase();
  if (text === "") return "";
  if (text.includes("FAIL")) return "fail";
  if (text.includes("PASS")) return "pass";
  return "";
});

/** Handle ids that currently have an edge attached (dot vs dashed glyph). */
const connectedHandles = computed(() => {
  const set = new Set<string>();
  for (const edge of edges.value) {
    if (edge.target === props.id && edge.targetHandle) set.add(edge.targetHandle);
    if (edge.source === props.id && edge.sourceHandle) set.add(edge.sourceHandle);
  }
  return set;
});

/**
 * Merged-input rendering (schema `mergeInputs`): the node's several input slots
 * collapse to ONE visible drop handle. Slot 0 is the visible dot; slots 1..n are
 * invisible same-position anchors so a type-routed edge (e.g. an image into slot
 * 1) still has a handle to attach to. Storage/execution keep the real slots.
 */
const mergedInputs = computed(() => mergesInputs(data.value.classType));
/** Any input slot connected — drives the single merged dot's filled state. */
const anyInputConnected = computed(() =>
  (data.value.inputs ?? []).some((_, i) => connectedHandles.value.has(`in-${i}`)));
/** Hover tooltip for the merged handle: every role the one drop zone accepts. */
const mergedTitle = computed(() =>
  (data.value.inputs ?? []).map((slot) => `${slot.name || "in"} · ${slot.type}`).join("  |  "));

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** The node's primary text payload: the multiline widget, else prompt/criteria. */
const primaryText = computed(() => {
  const multiline = widgets.value.find((widget) => widget.type === "STRING" && widget.multiline === true);
  if (multiline !== undefined) return multiline.value;
  const named = widgets.value.find((widget) => widget.name === "text" || widget.name === "prompt" || widget.name === "criteria");
  return named?.value;
});

/**
 * Row 3 text stub (D11): the user-written description when present, otherwise
 * the first paragraph of the text payload; the template clamps it to two lines.
 */
const stubText = computed(() => {
  if (modality.value !== "text") return "";
  const description = (data.value.description ?? "").trim();
  const source = description !== "" ? description : asText(primaryText.value).trim();
  return source.split(/\n{2,}/)[0]?.trim() ?? "";
});

/** A URL-like content reference held by the modality widget (D11 media stub). */
const mediaRef = computed(() => {
  const kind = modality.value;
  if (kind !== "image" && kind !== "video" && kind !== "audio") return "";
  const widget = widgets.value.find((item) => item.name === kind)
    ?? widgets.value.find((item) => item.type === "STRING");
  const value = asText(widget?.value).trim();
  return /^(https?:|\/|blob:|data:)/.test(value) ? value : "";
});

/** Bare file name of a media reference, shown on the audio stub line. */
const mediaName = computed(() => {
  if (mediaRef.value === "") return "";
  const path = mediaRef.value.split(/[?#]/)[0] ?? mediaRef.value;
  return path.split("/").pop() ?? "";
});
</script>

<template>
  <div class="movieNode" :class="[`status-${status}`, { selected, toolHoverable: tool !== null, connectSource: isConnectSource }]" :style="{ '--node-accent': accent }">
    <!-- Row 1: vidsay nodeSkeleton titleBar — type icon + grab label. -->
    <div class="titleBar">
      <component :is="typeIcon" class="titleIcon" :size="16" aria-hidden="true" />
      <span class="labelText" :title="typeLabel">{{ typeLabel }}</span>
    </div>

    <div class="cardContainer">
      <div class="contentCard" :class="{ selected }">
        <!-- D13: status is the border color plus this one corner dot. -->
        <span class="statusDot" :class="`dot-${status}`" :title="status" />

        <!-- Row 2: node name (read here, edited in the editor card). -->
        <div class="nameRow" :title="nodeName">{{ nodeName }}</div>

        <!-- Row 3: read-only content stub (D11). -->
        <img
          v-if="modality === 'image' && mediaRef"
          class="stubMedia nodrag nowheel"
          :src="mediaRef"
          :alt="nodeName" />
        <video
          v-else-if="modality === 'video' && mediaRef"
          class="stubMedia nodrag nowheel"
          :src="`${mediaRef}#t=0.5`"
          preload="metadata"
          muted
          playsinline
          tabindex="-1"
          aria-hidden="true" />
        <div v-else-if="modality === 'audio' && mediaRef" class="stubAudio nodrag" :title="mediaName">
          <IconVolume2 :size="14" aria-hidden="true" />
          <span class="stubAudioName">{{ mediaName }}</span>
        </div>
        <p v-else-if="modality === 'text' && stubText" class="stubText nodrag">{{ stubText }}</p>
        <div v-else class="stubEmpty" aria-hidden="true">
          <component :is="typeIcon" :size="14" />
        </div>

        <!-- Reviewer verdict line (D5): output data, kept per D13. -->
        <div v-if="family === 'reviewer' && verdict" class="verdictRow" :class="`verdict-${verdictState}`">
          <span class="verdictBadge">{{ verdictState === "fail" ? "FAIL" : verdictState === "pass" ? "PASS" : "VERDICT" }}</span>
          <span class="verdictText" :title="verdict">{{ verdict }}</span>
        </div>
      </div>

      <!-- vidsay nodeSkeleton handles: 18px circular glyphs at ±12px, distributed by index.
           Each dot carries its slot NAME on the canvas side so a port's role
           (prompt / image / skill …) is readable without hovering a tooltip. -->
      <Handle
        v-for="(slot, i) in (data.inputs ?? [])" :key="`hin-${i}`"
        :id="`in-${i}`" type="target" :position="Position.Left"
        class="nodeHandle"
        :class="mergedInputs
          ? { mergedAnchor: i > 0, connected: i === 0 && anyInputConnected }
          : { connected: connectedHandles.has(`in-${i}`) }"
        :style="{ top: mergedInputs ? '50%' : `${((i + 1) / ((data.inputs ?? []).length + 1)) * 100}%` }"
        :title="mergedInputs ? (i === 0 ? mergedTitle : '') : `${slot.name || `in ${i}`} · ${slot.type}`">
        <span v-if="!mergedInputs" class="portLabel portIn">{{ slot.name || `in ${i}` }}</span>
        <component
          v-if="!mergedInputs || i === 0"
          :is="(mergedInputs ? anyInputConnected : connectedHandles.has(`in-${i}`)) ? IconCircleDot : IconCircleDashed"
          class="handleIcon" :size="18" aria-hidden="true" />
      </Handle>
      <Handle
        v-for="(slot, i) in (data.outputs ?? [])" :key="`hout-${i}`"
        :id="`out-${i}`" type="source" :position="Position.Right"
        class="nodeHandle" :class="{ connected: connectedHandles.has(`out-${i}`) }"
        :style="{ top: `${((i + 1) / ((data.outputs ?? []).length + 1)) * 100}%` }"
        :title="`${slot.name || `out ${i}`} · ${slot.type}`">
        <span class="portLabel portOut">{{ slot.name || `out ${i}` }}</span>
        <component :is="connectedHandles.has(`out-${i}`) ? IconCircleDot : IconCircleDashed" class="handleIcon" :size="18" aria-hidden="true" />
      </Handle>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.movieNode {
  position: relative;
  width: 220px;
  color: var(--el-text-color-primary);
  text-align: left;

  &:hover .nodeHandle .handleIcon { opacity: 1; }

  // Tool-mode hover highlight: any of cursor/connect/delete lights the card border.
  &.toolHoverable:hover .contentCard {
    border-color: var(--el-color-primary);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 45%, transparent);
  }

  // Connect mode: the first-picked source stays highlighted until the second click.
  &.connectSource .contentCard {
    border-color: var(--el-color-primary);
    box-shadow: 0 0 0 1px var(--el-color-primary);
  }
}

.titleBar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 8px;
  font-size: 14px;
  line-height: 20px;

  .titleIcon { flex-shrink: 0; color: var(--node-accent); }

  .labelText {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: grab;
    user-select: none;

    &:active { cursor: grabbing; }
  }
}

.cardContainer {
  position: relative;

  .contentCard {
    position: relative;
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--ui-radius-large, var(--el-border-radius-base));
    background: var(--el-bg-color-overlay);
    box-shadow: var(--el-box-shadow-lighter);

    &.selected {
      border-color: color-mix(in srgb, var(--el-color-primary) 50%, var(--el-border-color-light));
    }
  }

  .nodeHandle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 0;
    background: transparent;
    color: var(--el-text-color-secondary);

    &.vue-flow__handle-left { left: -12px; }
    &.vue-flow__handle-right { right: -12px; }

    .handleIcon {
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease-out;
    }

    &.connected .handleIcon { opacity: 1; }
    &:hover, &.connected { color: var(--el-color-primary); }
  }

  // A merged node shows ONE drop handle (slot 0); the other input slots render
  // as invisible same-position anchors so type-routed edges still attach. They
  // must never intercept the drop (pointer-events: none) nor show a glyph.
  .mergedAnchor {
    opacity: 0;
    pointer-events: none;
  }

  // Port role labels: tiny slot names on the CANVAS side of each dot (never
  // over the card content), so `prompt` vs `skill` vs `image` is readable at a
  // glance and the connect tool's port chooser has a visible counterpart.
  .portLabel {
    position: absolute;
    font-size: 10px;
    line-height: 14px;
    color: var(--el-text-color-secondary);
    white-space: nowrap;
    pointer-events: none;
  }

  .portIn { right: calc(100% + 4px); }
  .portOut { left: calc(100% + 4px); }
}

// D13: the whole status vocabulary on the card is this dot + the border color.
.statusDot {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);

  &.dot-queued { background: var(--el-color-info); }
  &.dot-running { background: var(--el-color-warning); }
  &.dot-progress { background: var(--el-color-warning); }
  &.dot-success { background: var(--el-color-success); }
  &.dot-error { background: var(--el-color-danger); }
}

.nameRow {
  padding: 8px 22px 6px 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stubMedia {
  display: block;
  width: calc(100% - 16px);
  height: 48px;
  margin: 0 8px;
  border-radius: var(--el-border-radius-small, 4px);
  object-fit: cover;
  background: var(--el-fill-color-light);
}

.stubAudio {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 48px;
  margin: 0 8px;
  padding: 0 8px;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--el-border-radius-small, 4px);
  background: var(--el-fill-color-light);
  color: var(--node-accent);

  .stubAudioName {
    min-width: 0;
    color: var(--el-text-color-regular);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.stubText {
  margin: 0 8px;
  padding: 4px 0;
  color: var(--el-text-color-regular);
  font-size: 11px;
  line-height: 16px;
  // D11: two clamped lines; the remainder of the paragraph is chopped.
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.stubEmpty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 48px;
  margin: 0 8px;
  border: 1px dashed var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-small, 4px);
  color: var(--el-text-color-placeholder);
}

.contentCard {
  padding-bottom: 8px;
}

.verdictRow {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 8px 0;
  padding: 4px 6px;
  border: 1px solid var(--el-border-color-light);
  border-left: 3px solid var(--el-text-color-placeholder);
  border-radius: var(--el-border-radius-small, 4px);
  background: var(--el-fill-color-light);

  &.verdict-pass { border-left-color: var(--el-color-success); }
  &.verdict-fail { border-left-color: var(--el-color-danger); }
}

.verdictBadge {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--el-text-color-placeholder);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  letter-spacing: 0.04em;

  .verdict-pass & { background: var(--el-color-success); }
  .verdict-fail & { background: var(--el-color-danger); }
}

.verdictText {
  flex: 1;
  min-width: 0;
  color: var(--el-text-color-regular);
  font-size: 11px;
  line-height: 16px;
  // Two-line clamp: the verdict can be a long reviewer note.
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.status-running .contentCard,
.status-progress .contentCard { border-color: var(--el-color-warning); }
.status-success .contentCard { border-color: var(--el-color-success); }
.status-error .contentCard { border-color: var(--el-color-danger); }
</style>
