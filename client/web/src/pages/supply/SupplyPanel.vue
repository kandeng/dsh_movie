<script setup lang="ts">
// ACT: 供应面板（Phase-10.1：Supply 页主面板）。只展示“接入与账单”级联
// （配置 → 连接/状态 → 折叠账单）：Model 类别即百炼平台与本机 ComfyUI 两个 env 驱动
// 真实接入（输入字段以 server/.env 为真源回填，连接握手用字段所填信息真实访问平台）；
// 资源卡片仅供给 Plugin 子页，不再在此陈列。演示目录源（demo 标记）不列为接入块。
// 数据按用户隔离（useProviders.loadFor）；删除可撤销（底部撤销条）。
import { computed, onBeforeUnmount, ref } from "vue";
import { translate } from "@dsh-movie/i18n/vue";
import { IconPlus, IconSearch } from "@tabler/icons-vue";
import {
  useProviders,
  PROVIDER_KIND_LABEL,
  type ProviderSnapshot,
} from "@/composables/useProviders";
import type { CardKind, ProviderKind, ProviderRecord } from "@/lib/providerCatalog";
import SupplyBlock from "./SupplyBlock.vue";

const props = defineProps<{ category: "all" | CardKind }>();

const registry = useProviders();

// ACT: 种类选项数组（编辑对话框 v-for 用数组源）。
const KIND_OPTIONS = (Object.keys(PROVIDER_KIND_LABEL) as ProviderKind[]).map((kind) => ({
  kind,
  label: PROVIDER_KIND_LABEL[kind],
}));

// ACT: 工具栏：搜索 / 排序（名称·本月费用·状态）。类别过滤来自账户页左菜单。
const query = ref("");
const sortBy = ref<"name" | "cost" | "status">("name");

const STATUS_ORDER: Record<ProviderRecord["status"], number> = {
  connected: 0,
  connecting: 1,
  error: 2,
  disconnected: 3,
};

// ACT: 级联：供给当前类别的接入块（all = 全部），搜索匹配名称/地址；
// 演示目录源（demo）不在此陈列（其卡片仅供给 Plugin 子页）。
const visibleProviders = computed(() => {
  const q = query.value.trim().toLowerCase();
  const rows = registry.providers.value.filter((row) => {
    if (row.demo === true) return false;
    if (props.category !== "all" && !row.cards.some((card) => card.kind === props.category)) return false;
    if (q === "") return true;
    return row.name.toLowerCase().includes(q) || row.baseUrl.toLowerCase().includes(q);
  });
  return [...rows].sort((a, b) => {
    if (sortBy.value === "cost") return registry.costOf(b) - registry.costOf(a);
    if (sortBy.value === "status") return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
});

// ACT: 顶部汇总仅统计自管接入（排除仅向 Plugin 页供给卡片的演示目录源）。
const managed = computed(() => registry.providers.value.filter((row) => row.demo !== true));
const connectedCount = computed(
  () => managed.value.filter((row) => row.status === "connected").length,
);
const cardCount = computed(() => managed.value.reduce((sum, row) => sum + row.cards.length, 0));

function money(amount: number, currency: "CNY" | "USD" = "CNY"): string {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${amount.toFixed(2)}`;
}
function totalCostText(): string {
  return money(managed.value.reduce((sum, row) => sum + registry.costOf(row), 0));
}

// ACT: 新增 / 编辑对话框。编辑保留 id 与已记录用量；新增从空目录开始。
const editVisible = ref(false);
const editId = ref<string | null>(null);
const editName = ref("");
const editKind = ref<ProviderKind>("comfy");
const editBase = ref("");
const editKey = ref("");
const editPassword = ref("");

function openAdd(): void {
  editId.value = null;
  editName.value = "";
  editKind.value = "comfy";
  editBase.value = "";
  editKey.value = "";
  editPassword.value = "";
  editVisible.value = true;
}
function openEdit(provider: ProviderRecord): void {
  editId.value = provider.id;
  editName.value = provider.name;
  editKind.value = provider.kind;
  editBase.value = provider.baseUrl;
  editKey.value = provider.apiKey;
  editPassword.value = provider.password;
  editVisible.value = true;
}
function submitEdit(): void {
  const name = editName.value.trim();
  const base = editBase.value.trim();
  if (name === "" || base === "") return;
  const existing = editId.value === null ? undefined : registry.byId(editId.value);
  const record: ProviderRecord = existing === undefined
    ? {
        id: `p-${Date.now().toString(36)}`,
        name,
        kind: editKind.value,
        baseUrl: base,
        apiKey: editKey.value.trim(),
        password: editPassword.value,
        status: "disconnected",
        error: null,
        connectedAt: null,
        cards: [],
        usage: {},
      }
    : {
        ...existing,
        name,
        kind: editKind.value,
        baseUrl: base,
        apiKey: editKey.value.trim(),
        password: editPassword.value,
        status: "disconnected",
        error: null,
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
      <div class="headSummary">
        <span class="sumChip">{{ translate("已连接") }} <strong>{{ connectedCount }} / {{ registry.providers.value.length }}</strong></span>
        <span class="sumChip">{{ translate("资源卡片") }} <strong>{{ cardCount }}</strong></span>
        <span class="sumChip total">{{ translate("本月费用") }} <strong>{{ totalCostText() }}</strong></span>
      </div>
    </header>

    <div class="toolbar">
      <el-input
        v-model="query" class="searchInput" clearable
        :placeholder="translate('搜索供应或地址')">
        <template #prefix><icon-search :size="15" aria-hidden="true" /></template>
      </el-input>
      <el-select v-model="sortBy" class="sortSelect">
        <el-option :label="translate('按名称')" value="name" />
        <el-option :label="translate('按本月费用')" value="cost" />
        <el-option :label="translate('按状态')" value="status" />
      </el-select>
      <el-button type="primary" @click="openAdd">
        <icon-plus :size="15" aria-hidden="true" />
        {{ translate("添加供应") }}
      </el-button>
    </div>

    <!-- ACT: 接入与账单级联：配置 → 连接/状态 → 折叠账单（提案 §3 布局）；
         资源卡片不在此陈列（归 Plugin 子页）。 -->
    <h3 class="zoneTitle">{{ translate("接入与账单") }} <span class="zoneCount">{{ visibleProviders.length }}</span></h3>
    <div v-if="visibleProviders.length === 0" class="empty">{{ translate("无匹配供应") }}</div>
    <SupplyBlock
      v-for="provider in visibleProviders"
      :key="provider.id"
      :provider="provider"
      @edit="openEdit"
      @delete="deleteProvider" />

    <!-- ACT: 新增/编辑供应对话框。 -->
    <el-dialog
      v-model="editVisible"
      :title="editId === null ? translate('添加供应') : translate('编辑')"
      width="480px">
      <el-form label-position="top">
        <el-form-item :label="translate('名称')">
          <el-input v-model="editName" :placeholder="translate('名称')" />
        </el-form-item>
        <el-form-item :label="translate('种类')">
          <el-select v-model="editKind" class="fullWidth">
            <el-option
              v-for="option in KIND_OPTIONS" :key="option.kind"
              :label="translate(option.label)" :value="option.kind" />
          </el-select>
        </el-form-item>
        <el-form-item :label="translate('端点地址')">
          <el-input v-model="editBase" placeholder="https://gpu.internal.example.com" />
        </el-form-item>
        <el-form-item label="apiKey">
          <el-input v-model="editKey" type="password" show-password placeholder="Bearer token" />
        </el-form-item>
        <el-form-item :label="translate('密码')">
          <el-input v-model="editPassword" type="password" show-password :placeholder="translate('可选')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">{{ translate("取消") }}</el-button>
        <el-button
          type="primary"
          :disabled="editName.trim() === '' || editBase.trim() === ''"
          @click="submitEdit">
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

  .headSummary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .sumChip {
    padding: 4px 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 12px;
    background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
    color: var(--el-text-color-secondary);
    font-size: 12px;

    strong { color: var(--el-text-color-primary); font-weight: 600; }

    &.total strong { color: var(--el-color-warning); }
  }
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;

  .searchInput { flex: 1; min-width: 180px; }
  .sortSelect { width: 150px; }
}

.zoneTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 20px 0 12px;
  font-size: 15px;
  font-weight: 600;

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
</style>