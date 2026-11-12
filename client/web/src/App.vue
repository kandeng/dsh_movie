<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import { elementLocales } from "@dsh-movie/i18n/elementPlus";
import { locale } from "@dsh-movie/i18n/vue";
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

.appMain {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
