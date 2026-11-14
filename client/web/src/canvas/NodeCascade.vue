<script lang="ts">
/** What the cascade emits when a leaf is picked. */
export interface CascadeSelection {
  /** A functional class type to drop as a single node. */
  classType?: string;
  /** A template id to expand into a subgraph. */
  templateId?: string;
}
</script>

<script setup lang="ts">
/**
 * Add-node cascade (Phase-5 D12): the two-level family → class palette that
 * replaces the flat six-step dropdown, plus a fifth **Templates** branch (D6)
 * holding the pre-wired step/pipeline macros.
 *
 * Level 1 = the four functional families (`source`, `generator`, `reviewer`,
 * `combiner`) + `Templates`; level 2 = the class types of the picked family, or
 * the templates. Each class entry shows its **slot signature** (e.g.
 * `TEXT,IMAGE → IMAGE`) so wiring is predictable (D2). Picking a leaf emits
 * either `{ classType }` (drop one node) or `{ templateId }` (expand a macro);
 * the caller decides the drop position and routes it through the bridge.
 *
 * The same component backs the toolbar "添加节点" popover and the empty-canvas
 * quick-create overlay, so both surfaces open the identical cascade (D12).
 */
import { computed, ref } from "vue";
import { translate } from "@dsh-movie/i18n/vue";
import {
  FUNCTIONAL_NODES,
  WORKFLOW_TEMPLATES,
  type MovieNodeSchema,
  type NodeFamily,
} from "@dsh-movie/protocol";
import { slotColor } from "@/canvas/graphMapper";

const emit = defineEmits<{ select: [payload: CascadeSelection] }>();

/** One level-2 class entry. */
interface ClassEntry {
  classType: string;
  displayName: string;
  signature: string;
  signatureColor: string;
  description: string;
}
/** One level-2 template entry. */
interface TemplateEntry {
  templateId: string;
  displayName: string;
  description: string;
  nodeCount: number;
}
/** One level-1 branch (a family, or Templates). */
interface Branch {
  key: string;
  label: string;
  classes: ClassEntry[];
  templates: TemplateEntry[];
}

const FAMILY_ORDER: NodeFamily[] = ["source", "generator", "reviewer", "combiner"];
const FAMILY_LABEL: Record<NodeFamily, string> = {
  source: "输入源",
  generator: "生成器",
  reviewer: "审校器",
  combiner: "组合器",
};

/** Build the `IN → OUT` slot signature for a class (D12). */
function signatureOf(schema: MovieNodeSchema): string {
  const ins = schema.inputs.map((slot) => slot.type).join(",") || "—";
  const outs = schema.outputs.map((slot) => slot.type).join(",") || "—";
  return `${ins} → ${outs}`;
}

const branches = computed<Branch[]>(() => {
  const familyBranches = FAMILY_ORDER.map((family): Branch => ({
    key: family,
    label: translate(FAMILY_LABEL[family]),
    classes: FUNCTIONAL_NODES.filter((node) => node.family === family).map((node): ClassEntry => ({
      classType: node.classType,
      displayName: node.displayName,
      signature: signatureOf(node),
      signatureColor: slotColor((node.modality ?? "text").toUpperCase()),
      description: node.description,
    })),
    templates: [],
  }));
  const templateBranch: Branch = {
    key: "templates",
    label: translate("模板"),
    classes: [],
    templates: WORKFLOW_TEMPLATES.map((template): TemplateEntry => ({
      templateId: template.id,
      displayName: template.displayName,
      description: template.description,
      nodeCount: template.nodes.length,
    })),
  };
  return [...familyBranches, templateBranch];
});

const activeKey = ref<string>("source");
const activeBranch = computed<Branch>(
  () => branches.value.find((branch) => branch.key === activeKey.value) ?? branches.value[0],
);

function pickClass(classType: string): void {
  emit("select", { classType });
}
function pickTemplate(templateId: string): void {
  emit("select", { templateId });
}
</script>

<template>
  <div class="nodeCascade">
    <ul class="cascadeFamilies">
      <li v-for="branch in branches" :key="branch.key">
        <button
          type="button"
          class="familyItem"
          :class="{ active: branch.key === activeKey }"
          @pointerenter="activeKey = branch.key"
          @click="activeKey = branch.key">
          {{ branch.label }}
        </button>
      </li>
    </ul>
    <ul class="cascadeLeaves">
      <li v-for="entry in activeBranch.classes" :key="entry.classType">
        <button type="button" class="leafItem" :title="entry.description" @click="pickClass(entry.classType)">
          <span class="leafName">{{ entry.displayName }}</span>
          <span class="leafSig" :style="{ color: entry.signatureColor }">{{ entry.signature }}</span>
        </button>
      </li>
      <li v-for="entry in activeBranch.templates" :key="entry.templateId">
        <button type="button" class="leafItem template" :title="entry.description" @click="pickTemplate(entry.templateId)">
          <span class="leafName">{{ entry.displayName }}</span>
          <span class="leafSig">{{ entry.nodeCount }} {{ translate("节点") }}</span>
        </button>
      </li>
      <li v-if="activeBranch.classes.length === 0 && activeBranch.templates.length === 0" class="leafEmpty">
        {{ translate("无可用节点") }}
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.nodeCascade {
  display: flex;
  gap: 4px;
  width: 100%;
  min-height: 220px;
  text-align: left;
}

.cascadeFamilies {
  display: flex;
  flex-direction: column;
  flex: 0 0 96px;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  border-inline-end: 1px solid var(--el-border-color-lighter);

  .familyItem {
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-regular);
    font: inherit;
    font-size: 13px;
    text-align: start;
    cursor: pointer;

    &:hover { background: var(--el-fill-color-light); }
    &.active {
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      font-weight: 600;
    }
  }
}

.cascadeLeaves {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 320px;
  overflow-y: auto;

  .leafItem {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font: inherit;
    font-size: 13px;
    text-align: start;
    cursor: pointer;

    &:hover { background: var(--el-fill-color-light); }

    .leafName { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .leafSig {
      flex: 0 0 auto;
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      text-transform: uppercase;
      color: var(--el-text-color-placeholder);
    }

    &.template .leafSig { color: var(--el-color-primary); }
  }

  .leafEmpty {
    padding: 12px 10px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}
</style>
