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
 * the templates. Picking a leaf emits either `{ classType }` (drop one node) or
 * `{ templateId }` (expand a macro); the caller decides the drop position and
 * routes it through the bridge.
 *
 * The same component backs the toolbar "添加节点" popover and the empty-canvas
 * quick-create overlay, so both surfaces open the identical cascade (D12).
 */
import { computed, ref } from "vue";
import { translate } from "@dsh-movie/i18n/vue";
import {
  FUNCTIONAL_NODES,
  WORKFLOW_TEMPLATES,
  type NodeFamily,
} from "@dsh-movie/protocol";

const emit = defineEmits<{ select: [payload: CascadeSelection] }>();

/** One level-2 class entry. */
interface ClassEntry {
  classType: string;
  displayName: string;
  description: string;
}
/** One level-2 template entry. */
interface TemplateEntry {
  templateId: string;
  displayName: string;
  description: string;
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

/**
 * Class types hidden from the add-node cascade. `TextMerge` is functionally
 * subsumed by variadic TEXT input slots — any TEXT input already concatenates
 * N linked texts in link-creation order with a blank-line separator — so
 * offering it only invites redundant graphs. This is a PALETTE-level hide, not
 * a deletion: the class type stays registered in the protocol/executor, so
 * existing saved graphs containing a TextMerge still validate and execute.
 */
const HIDDEN_FROM_PALETTE: ReadonlySet<string> = new Set(["TextMerge"]);

const branches = computed<Branch[]>(() => {
  const familyBranches = FAMILY_ORDER.map((family): Branch => ({
    key: family,
    label: translate(FAMILY_LABEL[family]),
    classes: FUNCTIONAL_NODES.filter(
      (node) => node.family === family && !HIDDEN_FROM_PALETTE.has(node.classType),
    ).map((node): ClassEntry => ({
      classType: node.classType,
      // The protocol ships English display names; route them through the i18n
      // catalog (keyed by the English name) so the cascade leaves localize.
      displayName: translate(node.displayName),
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
      displayName: translate(template.displayName),
      description: template.description,
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
        </button>
      </li>
      <li v-for="entry in activeBranch.templates" :key="entry.templateId">
        <button type="button" class="leafItem" :title="entry.description" @click="pickTemplate(entry.templateId)">
          <span class="leafName">{{ entry.displayName }}</span>
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
  // Hug the content: the leaf column sizes to its longest entry instead of
  // stretching to a fixed popover width. min-width keeps the two columns from
  // collapsing for very short labels.
  width: max-content;
  min-width: 260px;
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
  // Never shrink: the column is exactly as wide as its longest entry, so the
  // popover hugs the longest display name. The cap keeps one verbose name from
  // blowing the popover open (ellipsis then kicks in on .leafName).
  flex: 0 0 auto;
  width: max-content;
  max-width: 340px;
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
  }

  .leafEmpty {
    padding: 12px 10px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}
</style>
