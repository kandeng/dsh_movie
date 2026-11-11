import { watch } from "vue";
import { detectLocale, isRtlLocale } from "@dsh-movie/i18n";
import { locale, setLocale } from "@dsh-movie/i18n/vue";
import { uiSettings } from "@/stores/settings";

/**
 * Bind the active locale to the user's UI-language setting and mirror it onto
 * the document element (`lang`/`dir`). Returns a teardown function.
 *
 * Ported from vidsay's `lib/i18n.ts`, trimmed of Toonflow-only concerns
 * (dayjs locale registration, axios Accept-Language interceptor, markdown and
 * chat locale bundles) which are re-added with the Chat port if needed.
 */
export function registerLanguage(): () => void {
  const applyLanguage = () =>
    setLocale(uiSettings.value.language === "system" ? detectLocale(navigator.languages) : uiSettings.value.language);

  const stopSettings = watch(() => uiSettings.value.language, applyLanguage, { immediate: true, flush: "sync" });
  const stopDocument = watch(
    locale,
    (value) => {
      document.documentElement.lang = value;
      document.documentElement.dir = isRtlLocale(value) ? "rtl" : "ltr";
    },
    { immediate: true },
  );
  window.addEventListener("languagechange", applyLanguage);

  return () => {
    stopSettings();
    stopDocument();
    window.removeEventListener("languagechange", applyLanguage);
  };
}
