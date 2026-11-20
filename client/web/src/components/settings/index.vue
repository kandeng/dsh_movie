<!-- ACT: 设置整页（对齐 Account / Supply 页布局）：左侧双倍加深菜单栏（外观 / 问题，
     无图标）+ 右侧扁平主面板。菜单栏仅两个条目：外观保留完整 ui 面板，
     问题为 GitHub 式 Issue 列表面板（公开仓库直连 + 不可达降级引导）。 -->
<template>
  <div class="settings">
    <aside class="sidebar" aria-label="设置分类">
      <div class="settingsNav">
        <button
          v-for="item in sections"
          :key="item.id"
          class="settingsItem"
          type="button"
          :aria-label="translate(item.label)"
          :aria-pressed="activeSection === item.id"
          @click="activeSection = item.id">
          <span>{{ translate(item.label) }}</span>
        </button>
      </div>
    </aside>

    <section class="content" aria-label="设置内容" tabindex="0">
      <div class="panelContent">
        <section v-if="activeSection === 'appearance'" class="settingsSection" aria-labelledby="appearanceTitle">
          <h2 id="appearanceTitle">{{ translate("界面设置") }}</h2>
          <uiPanel />
        </section>

        <section v-else class="settingsSection" aria-labelledby="issuesTitle">
          <h2 id="issuesTitle">{{ translate("问题") }}</h2>
          <issuesPanel />
        </section>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { translate } from "@dsh-movie/i18n/vue";
import uiPanel from "./panels/ui.vue";
import issuesPanel from "./panels/issues.vue";

type SectionId = "appearance" | "issues";

// ACT: 菜单栏仅两个条目且不带图标（对齐用户提案）；旧 vidsay 移植的 12 个占位面板
// （模型 / 市场 / 通讯 / 其他分组）因后端未接入全部下线，仅保留真实可用的外观面板。
const sections: { id: SectionId; label: string }[] = [
  { id: "appearance", label: "界面设置" },
  { id: "issues", label: "问题" },
];
const activeSection = ref<SectionId>("appearance");
</script>

<style lang="scss" scoped>
// ACT: 与 Account 页同款的整页网格：左 220px 双倍加深菜单栏 + 右主面板；基准字号 14px。
.settings {
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

    .settingsNav {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 2px 2px;
    }
  }

  // ACT: 菜单项纯文字（无图标），选中态主色浅底。
  .settingsItem {
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

    &:hover {
      background: var(--el-fill-color-light);
    }

    &[aria-pressed="true"] {
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 20px;
    overflow: hidden;

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 20px 5px 50px;
    }
  }
}

// ACT: 窄屏（手机）：左菜单收窄但保留文字可读（与 Account 页一致）。
@media (max-width: 700px) {
  .settings {
    grid-template-columns: 148px minmax(0, 1fr);

    .sidebar .settingsItem { padding: 8px 8px; font-size: 13px; }
    .content { padding: 0 10px; }
  }
}

.settingsSection {
  margin-bottom: 36px;

  &:last-child { margin-bottom: 0; }

  h2 {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 600;
  }
}
</style>
