<script setup lang="ts">
/**
 * Generic Vue Flow node for every movie step, skinned to the vidsay
 * `nodeSkeleton` card chrome (Path B / Phase 4).
 *
 * Visual language copied from vidsay `packages/nodeScaffold/src/nodeSkeleton.vue`:
 * a 220px node with a title bar (16px type icon + grab-cursor label) sitting above
 * a bordered content card, and 18px circular dot/dashed handles floated at ±12px on
 * the card's left/right edges (revealed on hover / when connected).
 *
 * Data wiring is unchanged from P4-M3: it reads {@link MovieNodeData} produced by the
 * {@link graphMapper} and writes widget edits back through `updateNodeData`.
 */
import { computed } from "vue";
import { Handle, Position, useVueFlow, type NodeProps } from "@vue-flow/core";
import {
  IconCircleDashed, IconCircleDot, IconFileText, IconLayoutGrid, IconListDetails,
  IconMovie, IconPhoto, IconVideo,
} from "@tabler/icons-vue";
import { schemaFor, type MovieNodeData, type NodeWidgetView } from "@/canvas/graphMapper";

const props = defineProps<NodeProps<MovieNodeData>>();
const { updateNodeData, edges } = useVueFlow();

const data = computed<MovieNodeData>(() => props.data ?? ({} as MovieNodeData));
const schema = computed(() => schemaFor(data.value.classType));
const title = computed(() => data.value.title ?? schema.value?.displayName ?? data.value.classType);
const description = computed(() => schema.value?.description ?? "");
const inputs = computed(() => data.value.inputs ?? []);
const outputs = computed(() => data.value.outputs ?? []);
const widgets = computed(() => data.value.widgets ?? []);
const status = computed(() => data.value.status ?? "idle");

/** Per-class_type icon + accent hue (Toonflow-style typed node headers). */
const TYPE_SKIN: Record<string, { icon: typeof IconFileText; accent: string }> = {
  MovieScript: { icon: IconFileText, accent: "#409eff" },
  MovieShotPlan: { icon: IconListDetails, accent: "#36cfc9" },
  MovieAsset: { icon: IconPhoto, accent: "#52c41a" },
  MovieStoryboard: { icon: IconLayoutGrid, accent: "#faad14" },
  MovieClip: { icon: IconVideo, accent: "#9254de" },
  MovieAssemble: { icon: IconMovie, accent: "#f759ab" },
};
const skin = computed(() => TYPE_SKIN[data.value.classType] ?? { icon: IconFileText, accent: "#409eff" });
const typeIcon = computed(() => skin.value.icon);
const accent = computed(() => skin.value.accent);

/** Handle ids that currently have an edge attached (dot vs dashed glyph). */
const connectedHandles = computed(() => {
  const set = new Set<string>();
  for (const edge of edges.value) {
    if (edge.target === props.id && edge.targetHandle) set.add(edge.targetHandle);
    if (edge.source === props.id && edge.sourceHandle) set.add(edge.sourceHandle);
  }
  return set;
});

/** Write a single widget value back into the store by index. */
function setWidget(index: number, value: unknown): void {
  const next = widgets.value.map((widget, i): NodeWidgetView => (i === index ? { ...widget, value } : widget));
  updateNodeData(props.id, {
    widgets: next,
    widgetsValues: next.map((widget): unknown => widget.value),
  } as Partial<MovieNodeData>);
}

function onText(index: number, event: Event): void {
  setWidget(index, (event.target as HTMLInputElement).value);
}
function onNumber(index: number, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  const num = Number(raw);
  setWidget(index, raw !== "" && Number.isFinite(num) ? num : raw);
}
function onSelect(index: number, event: Event): void {
  setWidget(index, (event.target as HTMLSelectElement).value);
}
function onBool(index: number, event: Event): void {
  setWidget(index, (event.target as HTMLInputElement).checked);
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}
</script>

<template>
  <div class="movieNode" :class="[`status-${status}`, { selected }]" :style="{ '--node-accent': accent }">
    <!-- vidsay nodeSkeleton titleBar: type icon + grab label above the content card. -->
    <div class="titleBar">
      <component :is="typeIcon" class="titleIcon" :size="16" aria-hidden="true" />
      <span class="labelText" :title="title">{{ title }}</span>
      <span v-if="schema" class="nodeStep">{{ schema.step }}/6</span>
    </div>

    <div class="cardContainer">
      <div class="contentCard" :class="{ selected }">
        <div class="cardBody">
          <div class="statusRow">
            <span class="statusDot" :class="`dot-${status}`" />
            <span class="statusText">{{ status }}</span>
          </div>

          <div v-if="widgets.length > 0" class="widgets">
            <div v-for="(widget, i) in widgets" :key="widget.name" class="widgetRow">
              <label class="widgetLabel">{{ widget.name }}</label>
              <textarea
                v-if="widget.type === 'STRING' && widget.multiline"
                class="widget nodrag nowheel"
                rows="3"
                :value="asText(widget.value)"
                @input="onText(i, $event)" />
              <select
                v-else-if="widget.type === 'COMBO'"
                class="widget nodrag nowheel"
                :value="asText(widget.value)"
                @change="onSelect(i, $event)">
                <option v-for="opt in widget.options ?? []" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else-if="widget.type === 'INT' || widget.type === 'FLOAT'"
                class="widget nodrag nowheel"
                type="number"
                :step="widget.type === 'INT' ? 1 : 0.1"
                :min="widget.min"
                :max="widget.max"
                :value="asText(widget.value)"
                @input="onNumber(i, $event)" />
              <input
                v-else-if="widget.type === 'BOOLEAN'"
                class="widget nodrag nowheel"
                type="checkbox"
                :checked="widget.value === true"
                @change="onBool(i, $event)" />
              <input
                v-else
                class="widget nodrag nowheel"
                type="text"
                :value="asText(widget.value)"
                @input="onText(i, $event)" />
            </div>
          </div>

          <div v-if="inputs.length > 0" class="portList">
            <div v-for="(slot, i) in inputs" :key="`in-${i}`" class="portRow">
              <span class="portName">{{ slot.name || `in ${i}` }}</span>
              <span class="portType">{{ slot.type }}</span>
            </div>
          </div>
          <div v-if="outputs.length > 0" class="portList out">
            <div v-for="(slot, i) in outputs" :key="`out-${i}`" class="portRow">
              <span class="portName">{{ slot.name || `out ${i}` }}</span>
              <span class="portType">{{ slot.type }}</span>
            </div>
          </div>

          <p v-if="description" class="nodeDesc">{{ description }}</p>
        </div>
      </div>

      <!-- vidsay nodeSkeleton handles: 18px circular glyphs at ±12px, distributed by index. -->
      <Handle
        v-for="(slot, i) in inputs" :key="`hin-${i}`"
        :id="`in-${i}`" type="target" :position="Position.Left"
        class="nodeHandle" :class="{ connected: connectedHandles.has(`in-${i}`) }"
        :style="{ top: `${((i + 1) / (inputs.length + 1)) * 100}%` }"
        :title="`${slot.name || `in ${i}`} · ${slot.type}`">
        <component :is="connectedHandles.has(`in-${i}`) ? IconCircleDot : IconCircleDashed" class="handleIcon" :size="18" aria-hidden="true" />
      </Handle>
      <Handle
        v-for="(slot, i) in outputs" :key="`hout-${i}`"
        :id="`out-${i}`" type="source" :position="Position.Right"
        class="nodeHandle" :class="{ connected: connectedHandles.has(`out-${i}`) }"
        :style="{ top: `${((i + 1) / (outputs.length + 1)) * 100}%` }"
        :title="`${slot.name || `out ${i}`} · ${slot.type}`">
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

  .nodeStep {
    flex-shrink: 0;
    color: var(--el-text-color-secondary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
}

.cardContainer {
  position: relative;

  .contentCard {
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--ui-radius-large, var(--el-border-radius-base));
    background: var(--el-bg-color-overlay);
    box-shadow: var(--el-box-shadow-lighter);

    &.selected {
      border-color: color-mix(in srgb, var(--el-color-primary) 50%, var(--el-border-color-light));
    }
  }

  .cardBody {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    font-size: 12px;
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
}

.statusRow {
  display: flex;
  align-items: center;
  gap: 6px;
}

.statusDot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);

  &.dot-queued { background: var(--el-color-info); }
  &.dot-running { background: var(--el-color-warning); }
  &.dot-progress { background: var(--el-color-warning); }
  &.dot-success { background: var(--el-color-success); }
  &.dot-error { background: var(--el-color-danger); }
}

.statusText {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  text-transform: capitalize;
}

.widgets {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.widgetRow {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.widgetLabel {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.widget {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-small, 4px);
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
}

.portList {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .portRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 18px;
  }

  &.out .portRow { flex-direction: row-reverse; }
}

.portName { color: var(--el-text-color-regular); font-size: 11px; }

.portType {
  color: var(--el-text-color-placeholder);
  font-size: 10px;
  text-transform: uppercase;
}

.nodeDesc {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.4;
}

.status-running .contentCard,
.status-progress .contentCard { border-color: var(--el-color-warning); }
.status-success .contentCard { border-color: var(--el-color-success); }
.status-error .contentCard { border-color: var(--el-color-danger); }
</style>
