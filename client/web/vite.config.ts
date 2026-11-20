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
 * - `/supply-probe` (Phase-10.2): POST {type, fields} — the Add-supply cascade's
 *   six provider types each probe their real platform with exactly the fields
 *   the user filled (Bailian/Volcano/Anthropic/OpenAI model lists, remote or
 *   local ComfyUI engine state); upstream errors pass through honestly.
 * In production a reverse proxy / the gateway plays this role (D13).
 */
function providerInfoBridge(): Plugin {
  /** ACT: 已知百炼模型单价（其余模型免费待定价）。 */
  const KNOWN_PRICE: Record<string, CardPrice> = {
    "qwen3-max": { amount: 0.02, currency: "CNY", unit: "ktoken" },
    "qwen-vl-max": { amount: 0.03, currency: "CNY", unit: "ktoken" },
  };

  async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function comfyInfo(base: string, headers: Record<string, string> = {}): Promise<InfoPayload> {
    const [stats, ck] = await Promise.all([
      fetchJson(`${base}/system_stats`, headers),
      fetchJson(`${base}/object_info/CheckpointLoaderSimple`, headers),
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
    return listModels(
      `${BAILIAN_BASE}/compatible-mode/v1/models`,
      { Authorization: `Bearer ${key}` },
      "百炼平台可用模型，经兼容模式 HTTPS API 接入。",
      KNOWN_PRICE,
    );
  }

  /** ACT: OpenAI 兼容模型列表 → 模型卡片（百炼/火山/Anthropic/OpenAI 共用）。 */
  async function listModels(
    url: string,
    headers: Record<string, string>,
    describe: string,
    knownPrice: Record<string, CardPrice> = {},
  ): Promise<{ code: number; body: unknown }> {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { code: res.status, body: { error: `upstream-${res.status}` } };
    const body = (await res.json()) as { data?: unknown };
    const list = Array.isArray(body.data) ? (body.data as unknown[]) : [];
    const cards: ResourceCard[] = list.map((entry, index) => {
      const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const id = typeof row["id"] === "string" && row["id"] !== "" ? row["id"] : `model-${index}`;
      return {
        id,
        kind: "models",
        name: id,
        description: describe,
        modality: "text",
        status: "ready",
        price: knownPrice[id] ?? null,
        meta: { format: "HTTPS API" },
      };
    });
    return { code: 200, body: { cards } };
  }

  /**
   * ACT: 六类供应商探针（/supply-probe）：用字段所填信息真实访问对应平台。
   * 地址/密钥缺省时回退 .env 真源（百炼）或本机默认（ComfyUI）；上游错误透传。
   */
  async function probe(type: string, fields: Record<string, unknown>): Promise<{ code: number; body: unknown }> {
    const field = (key: string): string => {
      const value = fields[key];
      return typeof value === "string" ? value.trim() : "";
    };
    const httpBase = (value: string): string => (/^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : "");
    const bearer = (key: string): Record<string, string> => (key === "" ? {} : { Authorization: `Bearer ${key}` });
    switch (type) {
      case "bailian": {
        const base = httpBase(field("baseUrl")) || BAILIAN_BASE;
        const key = field("apiKey") || (SERVER_ENV["BAILIAN_API_KEY"] ?? "");
        if (key === "") return { code: 503, body: { error: "no-api-key" } };
        const headers: Record<string, string> = { ...bearer(key) };
        const workspace = field("workspaceId");
        if (workspace !== "") headers["X-DashScope-WorkSpace"] = workspace;
        const path = base.endsWith("/compatible-mode/v1") ? "/models" : "/compatible-mode/v1/models";
        return listModels(`${base}${path}`, headers, "百炼平台可用模型，经兼容模式 HTTPS API 接入。", KNOWN_PRICE);
      }
      case "volcano": {
        const base = httpBase(field("baseUrl")) || "https://ark.cn-beijing.volces.com/api/v3";
        const key = field("apiKey");
        if (key === "") return { code: 503, body: { error: "no-api-key" } };
        const result = await listModels(`${base}/models`, bearer(key), "火山方舟可用模型/端点，经 OpenAI 兼容 API 接入。");
        const endpoint = field("endpointId");
        if (result.code === 200 && endpoint !== "") {
          for (const card of (result.body as { cards: ResourceCard[] }).cards) card.meta["endpoint"] = endpoint;
        }
        return result;
      }
      case "anthropic": {
        const base = httpBase(field("baseUrl")) || "https://api.anthropic.com";
        const key = field("apiKey");
        if (key === "") return { code: 503, body: { error: "no-api-key" } };
        const headers: Record<string, string> = {
          "x-api-key": key,
          "anthropic-version": field("apiVersion") || "2023-06-01",
        };
        const path = base.endsWith("/v1") ? "/models" : "/v1/models";
        return listModels(`${base}${path}`, headers, "Anthropic Claude 模型，经原生 Messages API 接入。");
      }
      case "openai": {
        const base = httpBase(field("baseUrl")) || "https://api.openai.com/v1";
        const key = field("apiKey");
        if (key === "") return { code: 503, body: { error: "no-api-key" } };
        const headers: Record<string, string> = { ...bearer(key) };
        const org = field("orgId");
        if (org !== "") headers["OpenAI-Organization"] = org;
        const path = base.endsWith("/v1") ? "/models" : "/v1/models";
        return listModels(`${base}${path}`, headers, "OpenAI 模型，经 OpenAI 兼容 API 接入。");
      }
      case "remote-comfy": {
        const base = httpBase(field("baseUrl"));
        if (base === "") return { code: 503, body: { error: "no-base-url" } };
        return comfyInfo(base, bearer(field("token")))
          .then((payload): { code: number; body: unknown } => ({ code: 200, body: payload }))
          .catch(() => ({ code: 503, body: { error: "engine-offline" } }));
      }
      case "local-comfy": {
        const base = httpBase(field("baseUrl")) || COMFY_BASE;
        return comfyInfo(base, bearer(field("token")))
          .then((payload): { code: number; body: unknown } => ({ code: 200, body: payload }))
          .catch(() => ({ code: 503, body: { error: "engine-offline" } }));
      }
      default:
        return { code: 404, body: { error: "unknown-type" } };
    }
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
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
      comfyInfo(COMFY_BASE)
        .then((payload) => json(200, payload))
        .catch(() => json(503, { error: "engine-offline" }));
      return;
    }
    // ACT: .env 真源下发：客户端据此回填百炼 / 本机 ComfyUI 接入的类型字段（真实上游地址）。
    if (url === "/supply-env" || url.startsWith("/supply-env?")) {
      json(200, {
        bailianApiKey: SERVER_ENV["BAILIAN_API_KEY"] ?? "",
        bailianBaseUrl: BAILIAN_BASE,
        comfyBaseUrl: COMFY_BASE,
      });
      return;
    }
    // ACT: 六类供应商探针：字段所填信息真实访问对应平台（模型列表 / 引擎状态）。
    if (url === "/supply-probe") {
      readBody(req)
        .then((raw) => {
          const parsed = JSON.parse(raw === "" ? "{}" : raw) as { type?: unknown; fields?: unknown };
          const type = typeof parsed.type === "string" ? parsed.type : "";
          const fields = (typeof parsed.fields === "object" && parsed.fields !== null ? parsed.fields : {}) as Record<string, unknown>;
          return probe(type, fields);
        })
        .then(({ code, body }) => json(code, body))
        .catch(() => json(400, { error: "bad-request" }));
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
