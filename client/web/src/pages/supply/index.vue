<script setup lang="ts">
// ACT: 供应页（Phase-10）：左栏图标（账户之下）进入；布局对齐账户页——灰色左菜单 +
// 右主面板。灰菜单自上而下 Model → Tool → Skill → Asset；默认（无 cat 查询）显示全部
// 供应；点击子项过滤该类别，再点同一项回到全部。类别存于 URL 查询，左栏 Supply 图标
// 点击（push 无查询的 /supply）即重置为全部。数据按用户隔离（useProviders.loadFor）。
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { translate } from "@dsh-movie/i18n/vue";
import type { CardKind } from "@/lib/providerCatalog";
import SupplyPanel from "./SupplyPanel.vue";

const route = useRoute();
const router = useRouter();

const MENU: { id: CardKind; label: string }[] = [
  { id: "models", label: "供应模型" },
  { id: "tools", label: "供应工具" },
  { id: "skills", label: "供应技能" },
  { id: "assets", label: "供应资产" },
];

const category = computed<"all" | CardKind>(() => {
  const c = route.query.cat;
  return c === "models" || c === "tools" || c === "skills" || c === "assets" ? c : "all";
});

function pick(id: CardKind): void {
  if (category.value === id) void router.replace({ path: "/supply" });
  else void router.replace({ path: "/supply", query: { cat: id } });
}
</script>

<template>
  <div class="supplyPage">
    <aside class="sidebar" :aria-label="translate('供应')">
      <nav class="supplyNav">
        <button
          v-for="item in MENU"
          :key="item.id"
          class="supplyItem"
          type="button"
          :aria-label="translate(item.label)"
          :aria-pressed="category === item.id"
          @click="pick(item.id)">
          <span>{{ translate(item.label) }}</span>
        </button>
      </nav>
    </aside>

    <section class="content" :aria-label="translate('供应')" tabindex="0">
      <SupplyPanel :category="category" />
    </section>
  </div>
</template>

<style scoped lang="scss">
// ACT: 与账户页同款整页网格：左 220px 加深灰菜单栏 + 右主面板。
.supplyPage {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  font-size: 14px;

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: color-mix(in srgb, var(--el-bg-color) 92%, var(--el-text-color-primary));
    border-inline-end: 1px solid var(--el-border-color-lighter);

    .supplyNav {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 2px 2px;
    }

    .supplyItem {
      display: flex;
      align-items: center;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: start;
      cursor: pointer;

      > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      &:hover { background: var(--el-fill-color-light); }

      &[aria-pressed="true"] {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
        font-weight: 600;
      }

      &:focus-visible { outline: 2px solid var(--el-color-primary); }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 20px;
    overflow: hidden;
  }
}

// ACT: 窄屏（手机）：灰菜单收窄但文字可读，主面板单列。
@media (max-width: 700px) {
  .supplyPage {
    grid-template-columns: 128px minmax(0, 1fr);

    .sidebar .supplyItem { padding: 8px 8px; font-size: 13px; }
    .content { padding: 0 10px; }
  }
}

// ACT: 超窄屏（≤480px）：灰菜单改为顶部横向滚动条，内容占满整行，避免侧栏挤压
// 主面板造成横向溢出裁切。
@media (max-width: 480px) {
  .supplyPage {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);

    .sidebar {
      border-inline-end: 0;
      border-bottom: 1px solid var(--el-border-color-lighter);

      .supplyNav {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 8px;
      }

      .supplyItem {
        flex: 0 0 auto;
        width: auto;
        margin-bottom: 0;
        padding: 6px 12px;
        font-size: 13px;
        white-space: nowrap;
      }
    }

    .content { padding: 0 8px; }
  }
}
</style>