<script setup lang="ts">
// ACT: 供应级联块（Phase-9 提案 §3，Phase-10 移入账户页，Phase-10.2 类型化字段）：
// 配置行（Key → Value 竖排，只读展示：卡片不可输入，改值走编辑弹窗）→ 操作行
// （连接按钮 + 状态标签并排，右侧编辑/删除）→ 账单行（左侧本月费用，右侧账单
// 明细深链 Account → Billing）。状态标签与连接按钮相邻（因果就近），连接中就
// 地显示转圈。配置行按供应商类型的 schema 渲染各自的展示框（密钥字段行内眼睛
// 切换）；无类型旧行保留旧三字段行。块内直接读写注册表中的同一对象引用
// （乐观变更即时持久化）。编辑/删除上抛父页。
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { translate } from "@dsh-movie/i18n/vue";
import {
  IconPlug,
  IconRefresh,
  IconTrash,
  IconPencil,
  IconLoader2,
  IconCpu,
  IconCloud,
  IconTool,
  IconBook,
  IconBox,
  IconCoin,
  IconArrowRight,
} from "@tabler/icons-vue";
import { useProviders, PROVIDER_KIND_LABEL } from "@/composables/useProviders";
import { providerTypeSpec } from "@/lib/providerCatalog";
import type { ProviderKind, ProviderRecord } from "@/lib/providerCatalog";

const props = defineProps<{ provider: ProviderRecord }>();
const emit = defineEmits<{ edit: [provider: ProviderRecord]; delete: [provider: ProviderRecord] }>();

// ACT: 供应商类型 schema：有类型 → 按字段组渲染配置网格；无 → 旧三字段网格。
const spec = computed(() => providerTypeSpec(props.provider.providerType));
const fieldValues = computed<Record<string, string>>(() => props.provider.fields ?? {});
function badgeLabel(): string {
  return spec.value?.label ?? PROVIDER_KIND_LABEL[props.provider.kind];
}
function badgeKind(): ProviderKind {
  return spec.value?.kind ?? props.provider.kind;
}

// ACT: 解构为本地函数绑定：模板只调用本地包装函数，
// 避免 vue-tsc 对插槽/事件作用域内对象绑定的 ref 解包歧义。
const { costOf, connect, disconnect } = useProviders();
const router = useRouter();

// ACT: 账单明细深链：Account → Billing 段落，并预选本供应为筛选对象。
function goBilling(): void {
  void router.push({ path: "/account", query: { section: "billing", provider: props.provider.id } });
}

// ACT: 已连接供应的可用模型名 chips（/supply-probe 真探回的 cards）：点击深链
// Plugin 页模型卡（?category=models&model=<cardId>）；超过上限折叠，+N 展开。
const MODEL_CHIP_LIMIT = 12;
const expanded = ref(false);
const modelCards = computed(() => props.provider.cards.filter((card) => card.kind === "models"));
const shownModelCards = computed(() => (expanded.value ? modelCards.value : modelCards.value.slice(0, MODEL_CHIP_LIMIT)));
const hiddenModelCount = computed(() => Math.max(0, modelCards.value.length - MODEL_CHIP_LIMIT));
function goModel(cardId: string): void {
  void router.push({ path: "/plugins", query: { category: "models", model: cardId } });
}

function statusLabel(status: ProviderRecord["status"]): string {
  if (status === "connected") return translate("已连接");
  if (status === "connecting") return translate("连接中");
  if (status === "error") return translate("连接错误");
  return translate("未连接");
}
function statusType(status: ProviderRecord["status"]): "success" | "warning" | "danger" | "info" {
  if (status === "connected") return "success";
  if (status === "connecting") return "warning";
  if (status === "error") return "danger";
  return "info";
}
function kindIcon(kind: ProviderKind) {
  if (kind === "comfy") return IconCpu;
  if (kind === "llm") return IconCloud;
  if (kind === "mcp") return IconTool;
  if (kind === "skills") return IconBook;
  return IconBox;
}
function errorText(provider: ProviderRecord): string {
  const raw = provider.error ?? "";
  // ACT: 类型化握手的桥错误码：缺密钥 / 缺地址 / 引擎离线 / 上游状态码透传。
  if (raw === "no-api-key") return translate("缺少 API 密钥");
  if (raw === "no-base-url") return translate("缺少端点地址");
  if (raw === "engine-offline") return translate("生成引擎离线或未暴露 /info 接口");
  const upstream = /upstream-(\d{3})/.exec(raw);
  if (upstream !== null) return `HTTP ${upstream[1]}`;
  if (raw.includes("503")) return translate("生成引擎离线或未暴露 /info 接口");
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) {
    return translate("无法访问该地址（网络或跨域限制）");
  }
  if (raw === "连接超时") return translate("连接超时");
  return raw;
}
function money(amount: number, currency: "CNY" | "USD" = "CNY"): string {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${amount.toFixed(2)}`;
}
function providerCurrency(provider: ProviderRecord): "CNY" | "USD" {
  return provider.cards.find((card) => card.price !== null)?.price?.currency ?? "CNY";
}
function costText(provider: ProviderRecord): string {
  return money(costOf(provider), providerCurrency(provider));
}
async function toggleConnect(): Promise<void> {
  if (props.provider.status === "connected") disconnect(props.provider.id);
  else await connect(props.provider.id);
}
function refresh(): void {
  void connect(props.provider.id);
}
function memLabel(provider: ProviderRecord): string {
  const gpu = provider.engine?.gpu ?? "";
  return gpu.toLowerCase().includes("cpu") ? translate("内存") : translate("显存");
}
</script>

<template>
  <article class="providerBlock">
    <header class="blockHead">
      <span class="kindBadge" :class="`kind-${badgeKind()}`">
        <component :is="kindIcon(badgeKind())" :size="15" aria-hidden="true" />
        {{ badgeLabel() }}
      </span>
      <h3 class="blockTitle">{{ provider.name }}</h3>
    </header>

    <!-- ACT: 配置行：Key → Value 竖排（标签列定宽、展示列弹性，占位符不再截断）；
         卡片只读展示（readonly，不可输入；改值走编辑弹窗），密钥字段保留行内眼睛切换。 -->
    <div v-if="spec !== undefined" class="configRows">
      <div v-for="field in spec.fields" :key="field.key" class="fieldRow">
        <span class="fieldLabel">
          {{ field.label }}<i v-if="field.required === true" class="req">*</i>
        </span>
        <el-input
          v-if="field.textarea === true"
          class="fieldControl"
          type="textarea" :rows="2" readonly
          :model-value="fieldValues[field.key] ?? ''"
          :placeholder="field.placeholder" />
        <el-input
          v-else
          class="fieldControl"
          :type="field.secret === true ? 'password' : 'text'"
          :show-password="field.secret === true"
          readonly
          :model-value="fieldValues[field.key] ?? ''"
          :placeholder="field.placeholder" />
      </div>
    </div>
    <div v-else class="configRows">
      <div class="fieldRow">
        <span class="fieldLabel">{{ translate("端点地址") }}</span>
        <el-input class="fieldControl" :model-value="provider.baseUrl" readonly placeholder="http://127.0.0.1:8188" />
      </div>
      <div class="fieldRow">
        <span class="fieldLabel">apiKey</span>
        <el-input class="fieldControl" :model-value="provider.apiKey" type="password" show-password readonly placeholder="Bearer token" />
      </div>
      <div class="fieldRow">
        <span class="fieldLabel">{{ translate("密码") }}</span>
        <el-input class="fieldControl" :model-value="provider.password" type="password" show-password readonly :placeholder="translate('可选')" />
      </div>
    </div>

    <p v-if="provider.engine" class="engineRow">
      <icon-cpu :size="14" aria-hidden="true" />
      {{ provider.engine.gpu }} · {{ (provider.engine.vramMb / 1024).toFixed(1) }} GB {{ memLabel(provider) }} ·
      ComfyUI {{ provider.engine.version }}
    </p>
    <p v-if="provider.status === 'error' && provider.error" class="errorRow">
      {{ errorText(provider) }}
    </p>

    <!-- ACT: 可用模型名 chips：仅已连接且探回模型卡时展示；点击跳 Plugin 页对应模型卡。 -->
    <div v-if="provider.status === 'connected' && modelCards.length > 0" class="modelNames">
      <button
        v-for="card in shownModelCards"
        :key="card.id"
        class="modelName"
        type="button"
        :title="card.name"
        @click="goModel(card.id)">
        {{ card.name }}
      </button>
      <button
        v-if="hiddenModelCount > 0"
        class="modelName more"
        type="button"
        @click="expanded = !expanded">
        {{ expanded ? translate("收起") : `+${hiddenModelCount}` }}
      </button>
    </div>

    <footer class="blockActions">
      <el-button
        :type="provider.status === 'connected' ? 'default' : 'primary'"
        size="small"
        :loading="provider.status === 'connecting'"
        @click="toggleConnect">
        <icon-plug :size="14" aria-hidden="true" />
        {{ provider.status === 'connected' ? translate("断开") : translate("连接") }}
      </el-button>
      <el-button
        v-if="provider.status === 'connected'"
        size="small" text
        @click="refresh">
        <icon-refresh :size="14" aria-hidden="true" />
        {{ translate("刷新") }}
      </el-button>
      <!-- ACT: 状态标签与连接按钮并排（因果就近）；连接中就地显示转圈。 -->
      <el-tag class="statusChip" size="small" :type="statusType(provider.status)" effect="dark">
        <icon-loader-2 v-if="provider.status === 'connecting'" :size="12" class="spin" aria-hidden="true" />
        {{ statusLabel(provider.status) }}
      </el-tag>
      <span class="spacer" />
      <el-button size="small" text @click="emit('edit', provider)">
        <icon-pencil :size="14" aria-hidden="true" />
        {{ translate("编辑") }}
      </el-button>
      <el-button size="small" text type="danger" @click="emit('delete', provider)">
        <icon-trash :size="14" aria-hidden="true" />
        {{ translate("删除") }}
      </el-button>
    </footer>

    <!-- ACT: 账单行：左侧本月费用，右侧账单明细深链（Account → Billing，预选本供应筛选）。 -->
    <div class="billingRow">
      <span class="costText">
        <icon-coin :size="14" aria-hidden="true" />
        {{ translate("本月费用") }} <b>{{ costText(provider) }}</b>
      </span>
      <el-button class="billingLink" size="small" text type="primary" @click="goBilling">
        {{ translate("账单明细") }}
        <icon-arrow-right :size="14" aria-hidden="true" />
      </el-button>
    </div>
  </article>
</template>

<style lang="scss" scoped>
.providerBlock {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 0 16px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: calc(var(--ui-radius) * 2.5);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
  box-shadow: var(--el-box-shadow-lighter);
}

.blockHead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;

  .blockTitle {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--el-text-color-primary);
    word-break: break-word;
    flex: 1 1 160px;
    min-width: 160px;
  }
}

.kindBadge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 11px;
  white-space: nowrap;

  &.kind-comfy { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
  &.kind-llm { background: color-mix(in srgb, #8b5cf6 14%, var(--el-bg-color)); color: #7c3aed; }
  &.kind-mcp { background: color-mix(in srgb, #10b981 14%, var(--el-bg-color)); color: #059669; }
  &.kind-skills { background: color-mix(in srgb, #f59e0b 16%, var(--el-bg-color)); color: #b45309; }
  &.kind-assets { background: color-mix(in srgb, #ec4899 14%, var(--el-bg-color)); color: #db2777; }
}

// ACT: 配置行：Key → Value 竖排（标签列定宽 130px、输入列弹性），不再截断占位符。
.configRows {
  display: flex;
  flex-direction: column;
  gap: 8px;

  .fieldRow {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }

  .fieldLabel {
    color: var(--el-text-color-secondary);
    font-size: 12px;
    overflow-wrap: anywhere;

    .req { color: var(--el-color-danger); font-style: normal; margin-inline-start: 2px; }
  }

  // ACT: 只读展示框：去掉可编辑观感（默认光标/悬停态），保留边框与掩码眼睛。
  .fieldControl {
    :deep(.el-input__inner),
    :deep(.el-textarea__inner) {
      cursor: default;
    }
  }
}

// ACT: 窄屏（手机）：标签在上、输入在下，自然堆叠。
@media (max-width: 560px) {
  .configRows .fieldRow {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}

.engineRow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.errorRow {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
  font-size: 12px;
}

// ACT: 模型名 chips：圆角胶囊按钮，悬停主色提示可点击（跳 Plugin 页）。
.modelNames {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  .modelName {
    max-width: 100%;
    padding: 3px 10px;
    border: 1px solid var(--el-border-color-light);
    border-radius: 999px;
    background: var(--el-fill-color-light);
    color: var(--el-text-color-regular);
    font: inherit;
    font-size: 12px;
    overflow-wrap: anywhere;
    cursor: pointer;
    transition: border-color 0.18s, color 0.18s, background-color 0.18s;

    &:hover {
      border-color: var(--el-color-primary);
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
    }
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }

    &.more { border-style: dashed; color: var(--el-text-color-secondary); }
  }
}

.blockActions {
  display: flex;
  align-items: center;
  gap: 8px;

  .spacer { flex: 1; }

  // ACT: 状态标签与连接按钮并排；连接中转圈就地旋转。
  .statusChip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .spin { animation: blockSpin 0.9s linear infinite; }
}

@keyframes blockSpin {
  to { transform: rotate(360deg); }
}

// ACT: 账单行：左侧本月费用（图标 + 金额），右侧账单明细链接（深链 Account → Billing）。
.billingRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color);

  .costText {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--el-text-color-secondary);

    b {
      color: var(--el-color-warning);
      font-variant-numeric: tabular-nums;
    }
  }

  .billingLink {
    margin-left: auto;

    :deep(span) { display: inline-flex; align-items: center; gap: 2px; }
  }
}
</style>