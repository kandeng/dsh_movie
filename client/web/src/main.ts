import { createApp, h, nextTick } from "vue";
import { ElButton, ElResult } from "element-plus";
import ElementPlus from "element-plus";
import { createPinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import { translate } from "@dsh-movie/i18n/vue";

import App from "./App.vue";
import router from "@/router";
import { loadSettings, settingsStorage } from "@/stores/settings";
import { registerLanguage } from "@/lib/i18n";

import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "@/assets/main.scss";

const app = createApp(App);
app.use(ElementPlus);
app.onUnmount(registerLanguage());

let isMounted = false;

// Load persisted settings, then wire pinia (with the shared settings storage),
// the router, and mount. On a fatal boot error, render an Element Plus result
// with a reload affordance instead of a blank page.
loadSettings()
  .then(async () => {
    app.use(createPinia().use(createPersistedState({ storage: settingsStorage })));
    app.use(router);
    await router.isReady();
    app.mount("#app");
    isMounted = true;
  })
  .catch(async (error: unknown) => {
    console.error("App initialization failed:", error);
    if (isMounted) app.unmount();
    createApp({
      render: () =>
        h(
          ElResult,
          {
            icon: "error",
            title: translate("启动失败"),
            subTitle: error instanceof Error ? error.message : translate("无法加载应用，请重试。"),
          },
          {
            extra: () => [
              h(ElButton, { type: "primary", onClick: () => window.location.reload() }, () => translate("重试")),
            ],
          },
        ),
    }).mount("#app");
    await nextTick();
  });
