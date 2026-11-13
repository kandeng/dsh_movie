<template>
  <main class="settingsGrid">
    <aside class="settingsSidebar">
      <div class="sidebarHeader">
        <h2>设置</h2>
      </div>
      <nav class="settingsNav" aria-label="设置分类">
        <template v-for="(item, index) in items" :key="item.value">
          <p v-if="item.group && item.group !== items[index - 1]?.group" class="groupLabel">{{ translate(item.group) }}</p>
          <button
            type="button"
            class="navButton"
            :aria-current="activePanel === item.value ? 'page' : undefined"
            @click="activePanel = item.value">
            <component :is="item.icon" :size="18" />
            <span>{{ translate(item.label) }}</span>
          </button>
        </template>
      </nav>
    </aside>
    <section class="settingsMain">
      <!-- 界面设置：完整移植 vidsay ui 面板，直接驱动 dsh_movie 的 uiSettings；
           其余面板依赖 vidsay 后端能力（模型/插件/MCP/网络/统计等），dsh_movie 暂未接入：占位。
           KeepAlive 只允许一个子组件，故沿用 vidsay 的单 <component :is> 写法。 -->
      <Transition name="el-fade-in" mode="out-in">
        <KeepAlive include="personalization">
          <component :is="panelComponent" :title="panelTitle" />
        </KeepAlive>
      </Transition>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import {
  IconBrush,
  IconSettings,
  IconBrain,
  IconPhotoAi,
  IconCpu,
  IconApps,
  IconPlug,
  IconDeviceTv,
  IconNetwork,
  IconUser,
  IconShieldLock,
  IconCode,
  IconInfoCircle,
} from "@tabler/icons-vue";
import { translate } from "@dsh-movie/i18n/vue";
import uiPanel from "./panels/ui.vue";
import stubPanel from "./panels/_stub.vue";

type PanelId =
  | "ui"
  | "general"
  | "languageModel"
  | "mediaModel"
  | "localModel"
  | "pluginMarket"
  | "mcp"
  | "chatToVideo"
  | "network"
  | "personalization"
  | "privacy"
  | "developer"
  | "about";

const activePanel = ref<PanelId>("ui");

const items: { value: PanelId; label: string; group?: string; icon: typeof IconSettings }[] = [
  { value: "ui", label: "界面设置", icon: IconBrush },
  { value: "general", label: "通用设置", icon: IconSettings },
  { value: "languageModel", label: "模型设置", group: "模型", icon: IconBrain },
  { value: "mediaModel", label: "媒体模型设置", icon: IconPhotoAi },
  { value: "localModel", label: "本地模型设置", icon: IconCpu },
  { value: "pluginMarket", label: "插件市场", group: "市场", icon: IconApps },
  { value: "mcp", label: "通讯设置", group: "通讯", icon: IconPlug },
  { value: "chatToVideo", label: "Chat-to-Video", icon: IconDeviceTv },
  { value: "network", label: "网络与代理", icon: IconNetwork },
  { value: "personalization", label: "个性化", group: "其他", icon: IconUser },
  { value: "privacy", label: "隐私", icon: IconShieldLock },
  { value: "developer", label: "开发者", icon: IconCode },
  { value: "about", label: "关于", icon: IconInfoCircle },
];

const activeTitle = computed(() => items.find(item => item.value === activePanel.value)?.label ?? "");
// 单一动态组件：ui 面板不接收 title（传 undefined 时 Vue 不会渲染该 attribute）。
const panelComponent = computed(() => (activePanel.value === "ui" ? uiPanel : stubPanel));
const panelTitle = computed(() => (activePanel.value === "ui" ? undefined : activeTitle.value));
</script>

<style lang="scss" scoped>
.settingsGrid {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  height: 100%;
}

.settingsSidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;

  .sidebarHeader {
    display: flex;
    align-items: center;
    gap: 10px;

    h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--el-text-color-primary);
    }
  }
}

.settingsNav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;

  .groupLabel {
    margin: 10px 0 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .navButton {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--el-border-radius-base);
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover {
      background: var(--el-fill-color-light);
    }

    &[aria-current="page"] {
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      font-weight: 600;
    }
  }
}

.settingsMain {
  min-width: 0;
  overflow-y: auto;
}

@media (max-width: 700px) {
  .settingsGrid {
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 10px;
  }

  .sidebarHeader {
    display: none;
  }

  .groupLabel {
    display: none;
  }

  .navButton span {
    display: none;
  }

  .navButton {
    justify-content: center;
    padding: 10px 0;
  }
}
</style>
