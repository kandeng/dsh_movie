<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import { elementLocales } from "@dsh-movie/i18n/elementPlus";
import { locale, translate } from "@dsh-movie/i18n/vue";
import { uiSettings } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// Element Plus locale follows the active app locale.
const elementLocale = computed(() => elementLocales[locale.value]);

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

async function onLogout() {
  await auth.logout();
  void router.push({ path: "/account", query: { login: "1" } });
}

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

const sessionTitle = computed(() => {
  if (auth.revalidating) return translate("正在校验会话……");
  return auth.sessionValid ? translate("会话有效") : translate("会话已失效，请重新登录");
});
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <div class="appRoot">
      <header class="appBar">
        <div class="brand" @click="router.push('/chat')">DSH Movie</div>
        <nav class="nav">
          <router-link to="/plaza" :class="{ active: route.path === '/plaza' }">Plaza</router-link>
          <router-link to="/chat" :class="{ active: route.path === '/chat' }">Chat</router-link>
          <router-link to="/studio" :class="{ active: route.path === '/studio' }">Studio</router-link>
          <router-link to="/account" :class="{ active: route.path === '/account' }">Account</router-link>
          <router-link to="/settings" :class="{ active: route.path === '/settings' }">Settings</router-link>
        </nav>
        <div class="spacer" />
        <div v-if="auth.signedIn" class="user">
          <span
            class="sessionDot"
            :class="{ off: !auth.sessionValid, checking: auth.revalidating }"
            :title="sessionTitle" />
          <span class="name">{{ auth.displayName }}</span>
          <el-button size="small" text @click="onLogout">Sign out</el-button>
        </div>
      </header>
      <main class="appMain">
        <router-view />
      </main>
    </div>
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
</style>

<style scoped lang="scss">
.appRoot {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.appBar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid var(--el-border-color-light);
  background-color: var(--el-bg-color-overlay);
}

.brand {
  font-weight: 600;
  cursor: pointer;
}

.nav {
  display: flex;
  gap: 12px;

  a {
    color: var(--el-text-color-secondary);
    text-decoration: none;
    padding: 4px 8px;
    border-radius: var(--ui-radius-small);

    &.active {
      color: var(--el-color-primary);
      background-color: var(--el-color-primary-light-9);
    }
  }
}

.spacer {
  flex: 1;
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;

  .name {
    color: var(--el-text-color-primary);
    font-size: 14px;
  }
}

.sessionDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-success);
  flex: 0 0 auto;

  &.checking {
    background: var(--el-color-warning);
  }

  &.off {
    background: var(--el-color-danger);
  }
}

.appMain {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
