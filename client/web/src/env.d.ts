/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_HS_URL?: string;
  readonly VITE_SERVER_NAME?: string;
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_AUTH_URL?: string;
  readonly VITE_BOT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
