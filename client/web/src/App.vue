<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import { useRoute } from "vue-router";
import { elementLocales } from "@dsh-movie/i18n/elementPlus";
import { locale } from "@dsh-movie/i18n/vue";
import { uiSettings } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import appShell from "@/components/appShell.vue";

const route = useRoute();
const auth = useAuthStore();

// Element Plus locale follows the active app locale.
const elementLocale = computed(() => elementLocales[locale.value]);

// ACT: 仅带 shell 元信息的路由套用全局外壳（左栏 + 顶栏）。
const shellRoute = computed(() => route.meta.shell === true);

// Track the OS color-scheme so `theme: "system"` reacts live.
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(systemTheme.matches);
function updateSystemTheme(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
systemTheme.addEventListener("change", updateSystemTheme);
onBeforeUnmount(() => systemTheme.removeEventListener("change", updateSystemTheme));

// Apply theme, primary color, font scale, and radius to the document root.
watchEffect(() => {
  const { theme, primaryColor, fontScale, radius } = uiSettings.value;
  const dark = theme === "system" ? systemDark.value : theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.fontSize = `${(16 * fontScale) / 100}px`;
  root.style.setProperty("--ui-radius", `${radius}px`);
  root.style.setProperty("--el-color-primary", primaryColor);
  for (let level = 1; level <= 9; level++) {
    root.style.setProperty(
      `--el-color-primary-light-${level}`,
      `color-mix(in srgb, ${primaryColor} ${100 - level * 10}%, ${dark ? "#141414" : "#fff"})`,
    );
  }
  root.style.setProperty("--el-color-primary-dark-2", `color-mix(in srgb, ${primaryColor} 80%, ${dark ? "#fff" : "#000"})`);
});

// ACT: 取消浏览器默认缩放（Ctrl+滚轮 / Ctrl 加减/0），但继续把事件传给 Vue Flow 缩放画布。
function preventPageZoom(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) event.preventDefault();
}
function preventPageZoomShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ["+", "=", "-", "0"].includes(event.key)) event.preventDefault();
}
window.addEventListener("wheel", preventPageZoom, { capture: true, passive: false });
window.addEventListener("keydown", preventPageZoomShortcut);
onBeforeUnmount(() => {
  window.removeEventListener("wheel", preventPageZoom, true);
  window.removeEventListener("keydown", preventPageZoomShortcut);
});

// ── M7：会话重校验。Synapse Mode-B 用长效令牌（无刷新令牌流），所以只在
//    页面重新可见/聚焦与轻量定时器时重跑 whoami；令牌失效时 auth.revalidate()
//    会 invalidate()，路由守卫随即弹回登录页。Leg C/Leg B 每次调用都重读令牌，
//    因此会话一旦刷新会自动传播。──
const REVALIDATE_INTERVAL_MS = 60_000;
let revalidateTimer: ReturnType<typeof setInterval> | null = null;

function stopInterval() {
  if (revalidateTimer !== null) {
    clearInterval(revalidateTimer);
    revalidateTimer = null;
  }
}
function startInterval() {
  stopInterval();
  if (!auth.signedIn) return;
  revalidateTimer = setInterval(() => { void auth.revalidate(); }, REVALIDATE_INTERVAL_MS);
}
function onRevisible() {
  if (document.visibilityState === "visible" && auth.signedIn) void auth.revalidate();
}

onMounted(() => {
  document.addEventListener("visibilitychange", onRevisible);
  window.addEventListener("focus", onRevisible);
  if (auth.signedIn) void auth.revalidate();
  startInterval();
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onRevisible);
  window.removeEventListener("focus", onRevisible);
  stopInterval();
});
watch(() => auth.signedIn, (signed) => {
  if (signed) {
    void auth.revalidate();
    startInterval();
  } else {
    stopInterval();
  }
});
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <router-view v-slot="{ Component: currentComponent }">
      <appShell v-if="shellRoute">
        <component :is="currentComponent" />
      </appShell>
      <component v-else :is="currentComponent" />
    </router-view>
  </el-config-provider>
</template>

<style lang="scss">
html {
  background-color: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-family: Calibri, "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
}

:root {
  --el-font-family: Calibri, "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
}

// ACT: 画布与代码/数字输入强制 LTR，避免 RTL 语言下坐标/数值镜像。
.vue-flow,
pre,
code,
input[type="number"] {
  direction: ltr;
  unicode-bidi: isolate;
}

// ACT: Vue Flow 主题变量对齐 Element Plus 令牌，随明暗主题切换。
.vue-flow {
  --vf-node-bg: var(--el-bg-color-overlay);
  --vf-node-text: var(--el-text-color-primary);
  --vf-node-color: var(--el-border-color-darker);
  --vf-connection-path: var(--el-text-color-secondary);
  --vf-handle: var(--el-text-color-secondary);
}
</style>
