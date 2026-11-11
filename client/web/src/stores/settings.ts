import { computed, ref } from "vue";
import { normalizeLocale, type Locale } from "@dsh-movie/i18n";

/**
 * Client-side settings store (Phase 2 skeleton).
 *
 * vidsay persists settings through a server round-trip (`/api/settings/*`);
 * dsh_movie has no settings backend yet, so this is a self-contained,
 * localStorage-backed store that keeps the same public surface the app shell
 * and the persisted-state plugin rely on: `loadSettings`, `settingsStorage`,
 * `uiSettings`, `updateUiSettings`, `defaultUiSettings`.
 */

const STORAGE_KEY = "dsh-movie.settings";

/** The whole settings blob; `stores` holds pinia-plugin-persistedstate payloads. */
export const settings = ref<Record<string, unknown>>({});

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value));
  } catch {
    // Storage may be unavailable (private mode / quota); settings stay in-memory.
  }
}

/**
 * The storage adapter handed to `createPersistedState`, so individual pinia
 * stores are persisted inside the single settings blob instead of scattering
 * top-level localStorage keys.
 */
export const settingsStorage = {
  getItem(key: string): string | null {
    const stores = settings.value.stores as Record<string, unknown> | undefined;
    if (stores && Object.hasOwn(stores, key)) return JSON.stringify(stores[key]);
    return null;
  },
  setItem(key: string, value: string): void {
    const stores = (settings.value.stores as Record<string, unknown> | undefined) ?? {};
    settings.value = { ...settings.value, stores: { ...stores, [key]: JSON.parse(value) as unknown } };
    persist();
  },
  removeItem(key: string): void {
    const stores = (settings.value.stores as Record<string, unknown> | undefined) ?? {};
    if (!Object.hasOwn(stores, key)) return;
    const next = { ...stores };
    delete next[key];
    settings.value = { ...settings.value, stores: next };
    persist();
  },
};

export type UiTheme = "light" | "dark" | "system";

export const defaultUiSettings = {
  theme: "light" as UiTheme,
  language: "system" as Locale | "system",
  primaryColor: "#007aff",
  fontScale: 100,
  radius: 8,
};

export const uiSettings = computed(() => {
  const raw = settings.value.ui;
  const ui = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    language: normalizeLocale(ui.language) ?? ("system" as const),
    theme: ui.theme === "light" || ui.theme === "dark" || ui.theme === "system" ? ui.theme : defaultUiSettings.theme,
    primaryColor:
      typeof ui.primaryColor === "string" && /^#[\da-f]{6}$/i.test(ui.primaryColor) ? ui.primaryColor : defaultUiSettings.primaryColor,
    fontScale:
      typeof ui.fontScale === "number" && Number.isFinite(ui.fontScale)
        ? Math.min(125, Math.max(85, ui.fontScale))
        : defaultUiSettings.fontScale,
    radius:
      typeof ui.radius === "number" && Number.isFinite(ui.radius) ? Math.min(16, Math.max(0, ui.radius)) : defaultUiSettings.radius,
  };
});

export function updateUiSettings(patch: Partial<typeof defaultUiSettings>): void {
  const current = settings.value.ui;
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  settings.value = { ...settings.value, ui: { ...base, ...patch } };
  persist();
}

/** Load the persisted settings blob from localStorage before the app mounts. */
export async function loadSettings(): Promise<void> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings.value = parsed as Record<string, unknown>;
    }
  } catch {
    settings.value = {};
  }
}
