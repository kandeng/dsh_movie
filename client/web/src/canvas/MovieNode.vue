<script setup lang="ts">
/**
 * Generic Vue Flow node for every movie step (Phase-4 P4-M3, Path B).
 *
 * A single component renders all six `MOVIE_NODES` types: it reads the node's
 * {@link MovieNodeData} (title, input/output slots, widgets, run status) that the
 * {@link graphMapper} produced from the ComfyUI `WorkflowGraph`, and paints
 * handles + widgets. Handle ids are `in-<slot>` / `out-<slot>` so the mapper can
 * round-trip edges back into ComfyUI link tuples.
 *
 * Widget edits write straight back into the shared Vue Flow store via
 * `updateNodeData`; the bridge's deep watch coalesces that into a `graphChanged`
 * emission (host-only autosave). Inputs carry `nodrag`/`nowheel` so editing does
 * not drag the node or pan the canvas.
 */
import { computed } from "vue";
import { Handle, Position, useVueFlow, type NodeProps } from "@vue-flow/core";
import { schemaFor, type MovieNodeData, type NodeWidgetView } from "@/canvas/graphMapper";

const props = defineProps<NodeProps<MovieNodeData>>();
const { updateNodeData } = useVueFlow();

const data = computed<MovieNodeData>(() => props.data ?? ({} as MovieNodeData));
const schema = computed(() => schemaFor(data.value.classType));
const title = computed(() => data.value.title ?? schema.value?.displayName ?? data.value.classType);
const description = computed(() => schema.value?.description ?? "");
const inputs = computed(() => data.value.inputs ?? []);
const outputs = computed(() => data.value.outputs ?? []);
const widgets = computed(() => data.value.widgets ?? []);
const status = computed(() => data.value.status ?? "idle");
const isOutputNode = computed(() => schema.value?.outputNode === true);

/** Write a single widget value back into the store by index. */
function setWidget(index: number, value: unknown): void {
  const next = widgets.value.map((widget, i): NodeWidgetView => (i === index ? { ...widget, value } : widget));
  updateNodeData(props.id, {
    widgets: next,
    widgetsValues: next.map((widget): unknown => widget.value),
  } as Partial<MovieNodeData>);
}

/** Coerce a text/number input event into the widget's value. */
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

/** Bind an input's value as a string regardless of the underlying type. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}
</script>

<template>
  <div class="movieNode" :class="[`status-${status}`, { output: isOutputNode, selected }]">
    <header class="nodeHead">
      <span class="statusDot" :class="`dot-${status}`" :title="status" />
      <span class="nodeTitle">{{ title }}</span>
      <span v-if="schema" class="nodeStep">{{ schema.step }}/6</span>
    </header>

    <div v-if="inputs.length > 0" class="ports portsIn">
      <div v-for="(slot, i) in inputs" :key="`in-${i}`" class="portRow">
        <Handle type="target" :position="Position.Left" :id="`in-${i}`" class="port portIn" />
        <span class="portName">{{ slot.name || `in ${i}` }}</span>
        <span class="portType">{{ slot.type }}</span>
      </div>
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

    <div v-if="outputs.length > 0" class="ports portsOut">
      <div v-for="(slot, i) in outputs" :key="`out-${i}`" class="portRow">
        <span class="portType">{{ slot.type }}</span>
        <span class="portName">{{ slot.name || `out ${i}` }}</span>
        <Handle type="source" :position="Position.Right" :id="`out-${i}`" class="port portOut" />
      </div>
    </div>

    <p v-if="description" class="nodeDesc">{{ description }}</p>
  </div>
</template>

<style lang="scss" scoped>
.movieNode {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--ui-radius, 8px);
  background: var(--el-bg-color-overlay, #2b2d31);
  color: var(--el-text-color-primary);
  font-size: 12px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 24%);

  &.selected {
    border-color: var(--el-color-primary);
  }

  &.status-running { border-color: var(--el-color-warning); }
  &.status-progress { border-color: var(--el-color-warning); }
  &.status-success { border-color: var(--el-color-success); }
  &.status-error { border-color: var(--el-color-danger); }
}

.nodeHead {
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

.nodeTitle {
  flex: 1 1 auto;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nodeStep {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.ports {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.portRow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
}

.portsOut .portRow {
  justify-content: flex-end;
}

.portName {
  color: var(--el-text-color-regular);
}

.portType {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  text-transform: uppercase;
}

.port {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--el-color-primary-light-3);
  border: 1px solid var(--el-bg-color);
}

.widgets {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.widgetRow {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.widgetLabel {
  font-size: 10px;
  color: var(--el-text-color-secondary);
}

.widget {
  width: 100%;
  box-sizing: border-box;
  padding: 3px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-blank, #1e1f22);
  color: var(--el-text-color-primary);
  font-size: 11px;
  font-family: inherit;
  resize: vertical;
}

.nodeDesc {
  margin: 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}
</style>
