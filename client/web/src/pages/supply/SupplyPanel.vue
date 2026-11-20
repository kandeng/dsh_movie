<script setup lang="ts">
// ACT: 供应面板（Phase-10.2：Supply 页主面板）。主面板由 Model/Tool/Skill/Asset
// 四类别段落组成（段落首行为标题），段落内陈列“接入与账单”级联
// （配置 → 连接/状态 → 折叠账单）：添加供应的“种类”级联出六类 AI 供应商
// （Bailian → Volcano → Anthropic → OpenAI → Remote ComfyUI → Local ComfyUI），
// 每类的输入文本框随类型切换（各平台预先需要知道的变量/参数不同）；连接握手
// 用字段所填信息经同源桥真实访问对应平台。资源卡片仅供给 Plugin 子页；
// 演示目录源（demo 标记）不列为接入块。数据按用户隔离；删除可撤销。
import { computed, onBeforeUnmount, ref } from "vue";
import { translate } from "@dsh-movie/i18n/vue";
import { IconPlus } from "@tabler/icons-vue";
import {
  useProviders,
  type ProviderSnapshot,
} from "@/composables/useProviders";
import {
  PROVIDER_TYPES,
  adoptFields,
  defaultFieldsOf,
  inferProviderType,
  providerTypeSpec,
  type ProviderType,
} from "@/lib/providerCatalog";
import type { CardKind, ProviderRecord } from "@/lib/providerCatalog";
import SupplyBlock from "./SupplyBlock.vue";

const props = defineProps<{ category: "all" | CardKind }>();

const registry = useProviders();

// ACT: 段落内按名称确定性排序（供应数量有限，不提供排序控件）。

// ACT: 段落分组（布局提案 §1）：主面板由 Model/Tool/Skill/Asset 四类别段落组成，
// 段落首行为标题、其后为该类别的接入块。all 模式陈列全部非空段落；类别模式仅
// 陈列该段落。接入块归属：有卡片者按卡片类别（可同属多段）；无卡片者按其自身
// kind（保证新增接入可见、可连接）。演示目录源（demo）不在此陈列。
const SECTION_KINDS: CardKind[] = ["models", "tools", "skills", "assets"];
const SECTION_LABEL: Record<CardKind, string> = {
  models: "供应模型",
  tools: "供应工具",
  skills: "供应技能",
  assets: "供应资产",
};
const KIND_SECTION: Record<ProviderRecord["kind"], CardKind> = {
  llm: "models",
  comfy: "models",
  mcp: "tools",
  skills: "skills",
  assets: "assets",
};

function sectionOf(row: ProviderRecord): CardKind {
  const spec = providerTypeSpec(row.providerType);
  return KIND_SECTION[spec?.kind ?? row.kind];
}

const sortedRows = computed(() => {
  const rows = registry.providers.value.filter((row) => row.demo !== true);
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
});

const sections = computed(() => {
  const kinds = props.category === "all" ? SECTION_KINDS : [props.category];
  const list = kinds.map((kind) => ({
    kind,
    label: SECTION_LABEL[kind],
    rows: sortedRows.value.filter((row) =>
      row.cards.length > 0
        ? row.cards.some((card) => card.kind === kind)
        : sectionOf(row) === kind,
    ),
  }));
  return props.category === "all" ? list.filter((section) => section.rows.length > 0) : list;
});

// ACT: 新增 / 编辑对话框（Phase-10.2 重实现）：种类下拉级联六类 AI 供应商，
// 输入文本框随类型切换（schema 见 PROVIDER_TYPES）；编辑保留 id 与已记录用量。
const editVisible = ref(false);
const editId = ref<string | null>(null);
const editName = ref("");
const editType = ref<ProviderType>("bailian");
const editFields = ref<Record<string, string>>({});

const editSpec = computed(() => providerTypeSpec(editType.value) ?? PROVIDER_TYPES[0]!);
// ACT: 保存门槛：名称 + 该类型的必填字段（如 API Key / Base URL / Endpoint ID）均非空。
const canSave = computed(() => {
  if (editName.value.trim() === "") return false;
  return editSpec.value.fields.every(
    (field) => field.required !== true || (editFields.value[field.key] ?? "").trim() !== "",
  );
});

// ACT: 各段落右侧的“添加供应”入口：预选该段落首个归属供应商类型作为 Category；
// 当前六类均属 Model（llm/comfy），Tool/Skill/Asset 段落尚无专属类型
// （其添加的接入仍按自身 kind 归属），待后续扩展级联。
const ADD_DEFAULT_TYPE: Record<CardKind, ProviderType> = {
  models: "bailian",
  tools: "bailian",
  skills: "bailian",
  assets: "bailian",
};

function openAddFor(kind: CardKind): void {
  editId.value = null;
  editName.value = "";
  const type = ADD_DEFAULT_TYPE[kind];
  editType.value = type;
  editFields.value = defaultFieldsOf(providerTypeSpec(type) ?? PROVIDER_TYPES[0]!);
  editVisible.value = true;
}
function openEdit(provider: ProviderRecord): void {
  editId.value = provider.id;
  editName.value = provider.name;
  const type = provider.providerType ?? inferProviderType(provider);
  editType.value = type;
  const spec = providerTypeSpec(type) ?? PROVIDER_TYPES[0]!;
  editFields.value = adoptFields(spec, provider);
  editVisible.value = true;
}
// ACT: 切换种类：输入框组整体换为该类型的 schema 默认值（名称保留）。
function changeType(type: ProviderType): void {
  editType.value = type;
  const spec = providerTypeSpec(type) ?? PROVIDER_TYPES[0]!;
  editFields.value = defaultFieldsOf(spec);
}
function submitEdit(): void {
  if (!canSave.value) return;
  const spec = editSpec.value;
  const fields: Record<string, string> = {};
  for (const field of spec.fields) fields[field.key] = (editFields.value[field.key] ?? "").trim();
  const existing = editId.value === null ? undefined : registry.byId(editId.value);
  const record: ProviderRecord = {
    id: existing?.id ?? `p-${Date.now().toString(36)}`,
    name: editName.value.trim(),
    kind: spec.kind,
    providerType: spec.type,
    fields,
    // ACT: 镜像列（搜索/旧握手兼容）：取字段中的地址与密钥。
    baseUrl: fields["baseUrl"] ?? "",
    apiKey: fields["apiKey"] ?? fields["token"] ?? "",
    password: existing?.password ?? "",
    status: "disconnected",
    error: null,
    connectedAt: null,
    cards: existing?.cards ?? [],
    usage: existing?.usage ?? {},
    ...(existing?.engine === undefined ? {} : { engine: existing.engine }),
  };
  registry.save(record);
  editVisible.value = false;
}

// ACT: 删除 + 撤销条（10 秒）。撤销把快照插回原位置。
const undoBar = ref<{ name: string; snapshot: ProviderSnapshot } | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | null = null;
function deleteProvider(provider: ProviderRecord): void {
  const snapshot = registry.remove(provider.id);
  if (snapshot === null) return;
  undoBar.value = { name: provider.name, snapshot };
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { undoBar.value = null; }, 10000);
}
function undoDelete(): void {
  if (undoBar.value === null) return;
  registry.restore(undoBar.value.snapshot);
  undoBar.value = null;
  if (undoTimer !== null) clearTimeout(undoTimer);
}
onBeforeUnmount(() => {
  if (undoTimer !== null) clearTimeout(undoTimer);
});
</script>

<template>
  <div class="supplyPanel">
    <header class="supplyHead">
      <div class="headTitle">
        <h2>{{ translate("供应") }}</h2>
        <p class="privacyHint">{{ translate("仅你可见：其他用户无法查看或修改你的供应配置。") }}</p>
      </div>
    </header>

    <!-- ACT: 段落级联：每段首行为类别标题（Model/Tool/Skill/Asset）+ 该段落的
         “添加供应”入口（右对齐），其后为该类别的接入块（配置 → 连接/状态 →
         折叠账单）；资源卡片不在此陈列（归 Plugin 子页）。 -->
    <template v-for="section in sections" :key="section.kind">
      <h3 class="zoneTitle">
        <span class="zoneLabel">
          {{ translate(section.label) }} <span class="zoneCount">{{ section.rows.length }}</span>
        </span>
        <el-button class="zoneAdd" size="small" type="primary" @click="openAddFor(section.kind)">
          <icon-plus :size="14" aria-hidden="true" />
          {{ translate("添加供应") }}
        </el-button>
      </h3>
      <div v-if="section.rows.length === 0" class="empty">{{ translate("无匹配供应") }}</div>
      <SupplyBlock
        v-for="provider in section.rows"
        :key="provider.id"
        :provider="provider"
        @edit="openEdit"
        @delete="deleteProvider" />
    </template>
    <div v-if="sections.length === 0" class="empty">{{ translate("无匹配供应") }}</div>

    <!-- ACT: 新增/编辑供应对话框（Phase-10.2）：种类级联六类 AI 供应商，
         输入文本框随类型切换；必填字段带 * 且未填时保存禁用。 -->
    <el-dialog
      v-model="editVisible"
      :title="editId === null ? translate('添加供应') : translate('编辑')"
      width="520px"
      class="supplyDialog">
      <el-form label-position="top">
        <el-form-item :label="translate('名称')">
          <el-input v-model="editName" :placeholder="translate('名称')" />
        </el-form-item>
        <el-form-item :label="translate('种类')">
          <el-select :model-value="editType" class="fullWidth" @update:model-value="changeType">
            <el-option
              v-for="spec in PROVIDER_TYPES" :key="spec.type"
              :label="spec.label" :value="spec.type" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-for="field in editSpec.fields" :key="field.key"
          :label="field.label" :required="field.required === true">
          <el-input
            v-if="field.textarea === true"
            v-model="editFields[field.key]"
            type="textarea" :rows="3"
            :placeholder="field.placeholder" />
          <el-input
            v-else
            v-model="editFields[field.key]"
            :type="field.secret === true ? 'password' : 'text'"
            :show-password="field.secret === true"
            :placeholder="field.placeholder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">{{ translate("取消") }}</el-button>
        <el-button type="primary" :disabled="!canSave" @click="submitEdit">
          {{ translate("保存") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ACT: 删除撤销条（10 秒自动消失）。 -->
    <transition name="undoFade">
      <div v-if="undoBar" class="undoBar" role="status">
        <span>{{ translate("已删除") }} {{ undoBar.name }}</span>
        <el-button size="small" type="primary" @click="undoDelete">{{ translate("撤销") }}</el-button>
      </div>
    </transition>
  </div>
</template>

<style lang="scss" scoped>
.supplyPanel {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 5px 72px;
}

.supplyHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;

  .headTitle h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .privacyHint {
    margin: 4px 0 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.6;
  }
}

.zoneTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 20px 0 12px;
  font-size: 15px;
  font-weight: 600;

  .zoneLabel {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  // ACT: “添加供应”入口右对齐于段落标题行。
  .zoneAdd { margin-left: auto; }

  .zoneCount {
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--el-fill-color-light);
    color: var(--el-text-color-secondary);
    font-size: 12px;
    font-weight: 500;
  }
}

.empty {
  padding: 32px 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  text-align: center;
}

.undoBar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--el-text-color-primary);
  color: var(--el-bg-color);
  font-size: 13px;
  box-shadow: var(--el-box-shadow);
  z-index: 60;
}

.undoFade-enter-active,
.undoFade-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.undoFade-enter-from,
.undoFade-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }

.fullWidth { width: 100%; }

// ACT: 对话框在窄屏（手机）下不超出视口：Element Plus 的 width 属性为固定值，
// 这里用媒体查询兼盖为视口宽度减边距。
@media (max-width: 560px) {
  :global(.supplyDialog) { width: calc(100vw - 32px) !important; }
}
</style>