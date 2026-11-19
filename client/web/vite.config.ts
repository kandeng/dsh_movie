import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { i18nPlugin } from "@dsh-movie/i18n/vite";
import {
  DEMO_CATALOG,
  LOCAL_COMFY_CARDS,
  type CardPrice,
  type InfoPayload,
  type ResourceCard,
} from "./src/lib/providerCatalog.ts";

/**
 * ACT: 读取 server/.env 凭证层（gitignored）：桥的上游地址与 /supply-env 字段回填真源。
 * 仅 dev/preview 进程可读；生产由网关承担（D13）。
 */
function readServerEnv(): Record<string, string> {
  const path = fileURLToPath(new URL("../../server/.env", import.meta.url));
  const out: Record<string, string> = {};
  try {
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const at = trimmed.indexOf("=");
      if (at <= 0) continue;
      out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
    }
  } catch {
    /* .env 不可读：全部走默认值 */
  }
  return out;
}

const SERVER_ENV = readServerEnv();
/** 本机 ComfyUI 引擎地址（.env 可改），/local-comfy 桥的上游。 */
const COMFY_BASE = (SERVER_ENV["COMFYUI_BASE_URL"] ?? "").replace(/\/+$/, "") || "http://127.0.0.1:8188";
/** 百炼 DashScope 兼容模式基址（.env 可改），/bailian 桥的上游。 */
const BAILIAN_BASE = (SERVER_ENV["BAILIAN_BASE_URL"] ?? "").replace(/\/+$/, "") || "https://dashscope.aliyuncs.com";

/**
 * Phase-9 provider bridge (dev + preview): the proposal's `GET <base>/info`
 * handshake needs same-origin resources the browser can reach without CORS.
 * - `/provider-demo/<id>/info` serves the enterprise demo catalogs.
 * - `/local-comfy/info` synthesizes a live card list from the real local
 *   ComfyUI (`/system_stats` + checkpoint combo), so connecting the local
 *   provider reflects the actually-installed weights. Unreachable engine →
 *   503 `engine-offline` (honest fail-closed status, never canned cards).
 * - `/bailian/info` uses the apiKey typed in the supply field (Authorization
 *   Bearer, falling back to .env) to list real DashScope compatible-mode
 *   models; upstream failures pass through with their status.
 * - `/supply-env` exposes the .env-sourced defaults the client fills into the
 *   two env-backed access blocks (Bailian / local ComfyUI).
 * In production a reverse proxy / the gateway plays this role (D13).
 */
function providerInfoBridge(): Plugin {
  async function fetchJson(url: string): Promise<Record<string, unknown>> {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function localComfyInfo(): Promise<InfoPayload> {
    const [stats, ck] = await Promise.all([
      fetchJson(`${COMFY_BASE}/system_stats`),
      fetchJson(`${COMFY_BASE}/object_info/CheckpointLoaderSimple`),
    ]);
    const nodeInfo = (ck["CheckpointLoaderSimple"] ?? ck) as Record<string, unknown>;
    const required = (nodeInfo["input"] as Record<string, unknown> | undefined)?.["required"] as
      | Record<string, unknown>
      | undefined;
    const combo = required?.["ckpt_name"];
    const names = Array.isArray(combo) && Array.isArray(combo[0]) ? (combo[0] as unknown[]) : [];
    const checkpoints = names.filter((name): name is string => typeof name === "string");
    const cards: ResourceCard[] = checkpoints.map((name, index) => {
      const isSd15 = /v1-5|sd15|sd_1\.5/i.test(name);
      const seed = LOCAL_COMFY_CARDS[0]!;
      return isSd15
        ? { ...seed, meta: { ...seed.meta } }
        : {
            id: `ckpt-${index}`,
            kind: "models",
            name,
            description: "本机 ComfyUI 检查点列表中的模型。",
            modality: "image",
            status: "ready",
            price: null,
            meta: { format: "safetensors" },
          };
    });
    if (!cards.some((card) => card.id === "sd15-fp16")) {
      cards.unshift({ ...LOCAL_COMFY_CARDS[0]!, status: "not-installed", meta: { ...LOCAL_COMFY_CARDS[0]!.meta } });
    }
    const ltxSeed = LOCAL_COMFY_CARDS[1]!;
    const ltxPresent = checkpoints.some((name) => /ltx/i.test(name));
    cards.push({ ...ltxSeed, status: ltxPresent ? "ready" : "not-installed", meta: { ...ltxSeed.meta } });
    const devices = stats["devices"];
    const device = Array.isArray(devices) ? (devices[0] as Record<string, unknown> | undefined) : undefined;
    const system = stats["system"] as Record<string, unknown> | undefined;
    const vramTotal = typeof device?.["vram_total"] === "number" ? device["vram_total"] : 0;
    return {
      cards,
      engine: {
        gpu: typeof device?.["name"] === "string" ? device["name"] : "",
        vramMb: Math.round(vramTotal / 1024 / 1024),
        version: typeof system?.["comfyui_version"] === "string" ? system["comfyui_version"] : "",
      },
    };
  }

  /**
   * ACT: 百炼握手：以供应字段所填 apiKey（Authorization Bearer；缺省时回退 .env）
   * 真实调用 DashScope 兼容模式模型列表并映射为模型卡片；上游错误原样透传状态码。
   */
  async function bailianInfo(req: IncomingMessage): Promise<{ code: number; body: unknown }> {
    const header = req.headers["authorization"];
    const fromField = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const key = fromField !== "" ? fromField : (SERVER_ENV["BAILIAN_API_KEY"] ?? "");
    if (key === "") return { code: 503, body: { error: "no-api-key" } };
    const res = await fetch(`${BAILIAN_BASE}/compatible-mode/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { code: res.status, body: { error: `upstream-${res.status}` } };
    const body = (await res.json()) as { data?: unknown };
    const list = Array.isArray(body.data) ? (body.data as unknown[]) : [];
    const KNOWN_PRICE: Record<string, CardPrice> = {
      "qwen3-max": { amount: 0.02, currency: "CNY", unit: "ktoken" },
      "qwen-vl-max": { amount: 0.03, currency: "CNY", unit: "ktoken" },
    };
    const cards: ResourceCard[] = list.map((entry, index) => {
      const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const id = typeof row["id"] === "string" && row["id"] !== "" ? row["id"] : `model-${index}`;
      return {
        id,
        kind: "models",
        name: id,
        description: "百炼平台可用模型，经兼容模式 HTTPS API 接入。",
        modality: "text",
        status: "ready",
        price: KNOWN_PRICE[id] ?? null,
        meta: { format: "HTTPS API" },
      };
    });
    return { code: 200, body: { cards } };
  }

  function handler(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
    const url = req.url ?? "";
    const json = (code: number, body: unknown): void => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/provider-demo/") && url.endsWith("/info")) {
      const id = url.slice("/provider-demo/".length, -"/info".length);
      const payload = DEMO_CATALOG[id];
      if (payload === undefined) json(404, { error: "unknown-demo" });
      else json(200, payload);
      return;
    }
    if (url === "/local-comfy/info" || url.startsWith("/local-comfy/info?")) {
      localComfyInfo()
        .then((payload) => json(200, payload))
        .catch(() => json(503, { error: "engine-offline" }));
      return;
    }
    // ACT: .env 真源下发：客户端据此回填百炼 / 本机 ComfyUI 接入的输入字段。
    if (url === "/supply-env" || url.startsWith("/supply-env?")) {
      json(200, {
        bailianApiKey: SERVER_ENV["BAILIAN_API_KEY"] ?? "",
        bailianBaseUrl: "/bailian",
        comfyBaseUrl: "/local-comfy",
      });
      return;
    }
    // ACT: 百炼真实握手：用字段所填密钥访问平台模型列表。
    if (url === "/bailian/info" || url.startsWith("/bailian/info?")) {
      bailianInfo(req)
        .then(({ code, body }) => json(code, body))
        .catch(() => json(503, { error: "upstream-unreachable" }));
      return;
    }
    next();
  }

  return {
    name: "dshProviderInfoBridge",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// matrix-js-sdk references the Node `global` binding in a few code paths; alias
// it to `globalThis` so the browser bundle resolves it without a polyfill.
export default defineConfig({
  define: {
    global: "globalThis",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin access to the local Synapse homeserver. The SDK talks to
      // Synapse directly (absolute URL); this proxy also lets relative
      // /_matrix fetches (e.g. authenticated media) work in dev. In production
      // a reverse proxy (Caddy) plays the same role.
      "/_matrix": { target: "http://127.0.0.1:8008", changeOrigin: true },
      // The pinned ComfyUI frontend (Phase-2 M5) is served by the gateway under
      // /comfy/ and derives its API base from location.pathname, so every REST
      // call (/comfy/api/*), static asset (/comfy/*), and the execution WS
      // (/comfy/ws) stays under this single prefix. ws:true upgrades the socket.
      "/comfy": { target: "http://127.0.0.1:8788", changeOrigin: true, ws: true },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    // Auto-extracts/translates CJK string literals under client/web/src into
    // `translate()` calls (vendored from vidsay). English literals are left
    // untouched, so the Phase-2 skeleton is unaffected until the Chat port.
    i18nPlugin(),
    vue(),
    providerInfoBridge(),
  ],
});
