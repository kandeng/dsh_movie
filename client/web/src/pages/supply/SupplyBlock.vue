<script setup lang="ts">
// ACT: 供应级联块（Phase-9 提案 §3，Phase-10 移入账户页）：配置 → 连接按钮 + 状态标签 → 折叠账单明细。
// 独立组件承载单块渲染：父页 v-for 仅传 prop，块内直接读写注册表中的同一对象引用
// （乐观变更即时持久化）。编辑/删除上抛父页（对话框与撤销条在父页）。
import { ref } from "vue";
import { translate } from "@dsh-movie/i18n/vue";
import {
  IconPlug,
  IconRefresh,
  IconTrash,
  IconPencil,
  IconCoin,
  IconCpu,
  IconCloud,
  IconTool,
  IconBook,
  IconBox,
} from "@tabler/icons-vue";
import { useProviders, PROVIDER_KIND_LABEL, PRICE_UNIT_LABEL } from "@/composables/useProviders";
import type { ProviderKind, ProviderRecord } from "@/lib/providerCatalog";

const props = defineProps<{ provider: ProviderRecord }>();
const emit = defineEmits<{ edit: [provider: ProviderRecord]; delete: [provider: ProviderRecord] }>();

// ACT: 解构为本地函数绑定：模板（含折叠面板插槽）只调用本地包装函数，
// 避免 vue-tsc 对插槽/事件作用域内对象绑定的 ref 解包歧义。
const { costOf, priceLabel, connect, disconnect } = useProviders();
const openBilling = ref<string[]>([]);
const revealed = ref(false);

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
function cardCountOf(provider: ProviderRecord, kind: string): number {
  return provider.cards.filter((card) => card.kind === kind).length;
}
function kindLabelOf(kind: string): string {
  if (kind === "models") return translate("模型");
  if (kind === "tools") return translate("工具");
  if (kind === "skills") return translate("技能");
  return translate("资产");
}
async function toggleConnect(): Promise<void> {
  if (props.provider.status === "connected") disconnect(props.provider.id);
  else await connect(props.provider.id);
}
function refresh(): void {
  void connect(props.provider.id);
}
function costText(provider: ProviderRecord): string {
  return money(costOf(provider), providerCurrency(provider));
}
function priceText(card: ProviderRecord["cards"][number]): string {
  const price = card.price;
  if (price === null || price.amount === 0) return translate("免费");
  return `${priceLabel(price)} / ${translate(PRICE_UNIT_LABEL[price.unit])}`;
}
function memLabel(provider: ProviderRecord): string {
  const gpu = provider.engine?.gpu ?? "";
  return gpu.toLowerCase().includes("cpu") ? translate("内存") : translate("显存");
}
</script>

<template>
  <article class="providerBlock">
    <header class="blockHead">
      <span class="kindBadge" :class="`kind-${provider.kind}`">
        <component :is="kindIcon(provider.kind)" :size="15" aria-hidden="true" />
        {{ translate(PROVIDER_KIND_LABEL[provider.kind]) }}
      </span>
      <h3 class="blockTitle">{{ provider.name }}</h3>
      <el-tag size="small" :type="statusType(provider.status)" effect="dark">
        {{ statusLabel(provider.status) }}
      </el-tag>
      <span class="spacer" />
      <span class="monthCost" :title="translate('本月费用')">
        <icon-coin :size="14" aria-hidden="true" />
        {{ costText(provider) }}
      </span>
    </header>

    <div class="configGrid">
      <div class="field fieldBase">
        <span class="fieldLabel">{{ translate("端点地址") }}</span>
        <el-input v-model="provider.baseUrl" placeholder="http://127.0.0.1:8188" />
      </div>
      <div class="field">
        <span class="fieldLabel">apiKey</span>
        <el-input
          v-model="provider.apiKey"
          :type="revealed ? 'text' : 'password'"
          placeholder="Bearer token" />
      </div>
      <div class="field">
        <span class="fieldLabel">{{ translate("密码") }}</span>
        <el-input
          v-model="provider.password"
          :type="revealed ? 'text' : 'password'"
          :placeholder="translate('可选')" />
      </div>
      <el-tooltip :content="revealed ? translate('隐藏密钥') : translate('显示密钥')" placement="top">
        <el-button class="revealButton" text @click="revealed = !revealed">
          {{ revealed ? translate("隐藏") : translate("显示") }}
        </el-button>
      </el-tooltip>
    </div>

    <p v-if="provider.engine" class="engineRow">
      <icon-cpu :size="14" aria-hidden="true" />
      {{ provider.engine.gpu }} · {{ (provider.engine.vramMb / 1024).toFixed(1) }} GB {{ memLabel(provider) }} ·
      ComfyUI {{ provider.engine.version }}
    </p>
    <p v-if="provider.status === 'error' && provider.error" class="errorRow">
      {{ errorText(provider) }}
    </p>

    <div class="chipRow">
      <el-tag size="small" type="info" effect="plain">
        {{ translate("模型") }} {{ cardCountOf(provider, "models") }}
      </el-tag>
      <el-tag size="small" type="info" effect="plain">
        {{ translate("工具") }} {{ cardCountOf(provider, "tools") }}
      </el-tag>
      <el-tag size="small" type="info" effect="plain">
        {{ translate("技能") }} {{ cardCountOf(provider, "skills") }}
      </el-tag>
      <el-tag size="small" type="info" effect="plain">
        {{ translate("资产") }} {{ cardCountOf(provider, "assets") }}
      </el-tag>
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

    <!-- ACT: 折叠账单明细：单价 × 用量 = 小计，底部合计。 -->
    <el-collapse v-model="openBilling" class="billing">
      <el-collapse-item :name="provider.id">
        <template #title>
          <span class="billingTitle">
            {{ translate("账单明细（本月）") }}
            <span class="billingTotal">{{ costText(provider) }}</span>
          </span>
        </template>
        <table class="billingTable">
          <thead>
            <tr>
              <th>{{ translate("资源") }}</th>
              <th>{{ translate("类型") }}</th>
              <th>{{ translate("单价") }}</th>
              <th>{{ translate("用量") }}</th>
              <th class="num">{{ translate("小计") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="card in provider.cards" :key="card.id">
              <td class="name">{{ card.name }}</td>
              <td>{{ kindLabelOf(card.kind) }}</td>
              <td>{{ priceText(card) }}</td>
              <td>{{ provider.usage[card.id] ?? 0 }}</td>
              <td class="num">
                {{ card.price === null ? money(0) : money(card.price.amount * (provider.usage[card.id] ?? 0), card.price.currency) }}
              </td>
            </tr>
            <tr v-if="provider.cards.length === 0">
              <td colspan="5" class="none">{{ translate("连接后从 /info 获取资源目录") }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4">{{ translate("合计") }}</td>
              <td class="num">{{ costText(provider) }}</td>
            </tr>
          </tfoot>
        </table>
      </el-collapse-item>
    </el-collapse>
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

  .spacer { flex: 1; }

  .monthCost {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--el-color-warning);
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
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

.configGrid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;

  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }

  .fieldLabel {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .revealButton { margin-bottom: 1px; }
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

.chipRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.blockActions {
  display: flex;
  align-items: center;
  gap: 8px;

  .spacer { flex: 1; }
}

.billing {
  border-top: 1px dashed var(--el-border-color);
  --el-collapse-border-color: transparent;
  --el-collapse-header-height: 40px;

  .billingTitle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--el-text-color-regular);

    .billingTotal {
      color: var(--el-color-warning);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
  }
}

.billingTable {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--el-border-color-lighter);
    text-align: left;
    color: var(--el-text-color-regular);
  }

  th {
    color: var(--el-text-color-secondary);
    font-weight: 500;
  }

  td.name { color: var(--el-text-color-primary); font-weight: 500; }
  td.none { color: var(--el-text-color-secondary); text-align: center; padding: 16px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  tfoot td {
    border-bottom: 0;
    color: var(--el-text-color-primary);
    font-weight: 600;
  }
}

@media (max-width: 900px) {
  .configGrid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}

@media (max-width: 700px) {
  .configGrid { grid-template-columns: minmax(0, 1fr); }
}
</style>