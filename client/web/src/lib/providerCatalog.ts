/**
 * Provider catalog (Phase-9 proposal): the shared, node-safe card inventory.
 *
 * Five concepts are kept distinct (proposal §1): provider (access to a
 * resource), model (LLM / image / video / audio), tool (sandboxed software),
 * skill (prose guiding a model) and asset (image / video / 3DGS / mesh).
 * A provider answers `GET <base>/info` with card lists; this module holds
 * (a) the seeded last-known catalogs so the UI opens populated, and (b) the
 * enterprise demo payloads served by the vite dev/preview bridge middleware.
 *
 * Pure data + string helpers only: imported by BOTH the browser store and
 * `vite.config.ts` (node), so it must never import vue / i18n / DOM APIs.
 * Chinese literals are i18n keys translated at render time by the UI.
 */

/** What a provider gives access to (proposal §1.1). */
export type ProviderKind = "comfy" | "llm" | "mcp" | "skills" | "assets";
/** The four Plugins subpages a card can land in (proposal §4). */
export type CardKind = "models" | "tools" | "skills" | "assets";
/** Modality / asset flavor shown as a card chip. */
export type Modality = "text" | "image" | "video" | "audio" | "3dgs" | "mesh";
/** Billing unit keys; the UI translates them (per image / per second / …). */
export type PriceUnit = "image" | "second" | "call" | "download" | "ktoken";

/** Unit price of one card; `null` means free (local weights, community prose). */
export interface CardPrice {
  amount: number;
  currency: "CNY" | "USD";
  unit: PriceUnit;
}

/** One model / tool / skill / asset card as replied by `/info`. */
export interface ResourceCard {
  id: string;
  kind: CardKind;
  name: string;
  description: string;
  modality?: Modality;
  /** `not-installed` = engine reachable but weights/files missing on it. */
  status: "ready" | "not-installed";
  price: CardPrice | null;
  /** Free-form spec rows (license / vram / size / version / format …). */
  meta: Record<string, string>;
  /** Data-URI thumbnail (assets only). */
  thumb?: string;
}

/** Live engine facts synthesized by the local ComfyUI bridge. */
export interface EngineInfo {
  gpu: string;
  vramMb: number;
  version: string;
}

/** The `/info` reply shape (flat card list + optional usage + engine facts). */
export interface InfoPayload {
  cards: ResourceCard[];
  usage?: Record<string, number>;
  engine?: EngineInfo;
}

/** One configured provider access (proposal §2/§3 cascade block). */
export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  password: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error: string | null;
  connectedAt: number | null;
  cards: ResourceCard[];
  usage: Record<string, number>;
  engine?: EngineInfo;
  /**
   * ACT: 演示目录源标记：仅向 Plugin 子页供给卡片，不在 Supply 页列为可管理接入
   * （Supply 页只展示 env 驱动的真实接入与用户自添接入）。
   */
  demo?: boolean;
}

/* ── thumbnails: crafted inline SVG, palette-consistent, node-safe ───────── */

function svgUri(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Dusk-coast concept frame: layered teal/amber gradient + sun + sea bands. */
export function thumbImage(): string {
  return svgUri(
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#123a5c"/><stop offset=".55" stop-color="#e8842c"/>` +
      `<stop offset="1" stop-color="#f6c667"/></linearGradient></defs>` +
      `<rect width="320" height="200" fill="url(#s)"/>` +
      `<circle cx="210" cy="112" r="26" fill="#fff3d6" opacity=".95"/>` +
      `<rect y="128" width="320" height="72" fill="#0d2b40"/>` +
      `<path d="M0 132q40 8 80 0t80 0 80 0 80 0v68H0z" fill="#155e75" opacity=".8"/>` +
      `<path d="M0 150q40 10 80 0t80 0 80 0 80 0v50H0z" fill="#0f766e" opacity=".7"/>` +
      `<rect x="196" y="132" width="28" height="60" fill="#f6c667" opacity=".35"/>`,
  );
}

/** Aerial city clip: film sprockets + skyline + play glyph. */
export function thumbVideo(): string {
  return svgUri(
    `<rect width="320" height="200" fill="#0b1526"/>` +
      `<g fill="#1e3a5f"><rect x="20" y="70" width="34" height="90"/>` +
      `<rect x="62" y="46" width="40" height="114"/><rect x="110" y="86" width="30" height="74"/>` +
      `<rect x="148" y="30" width="46" height="130"/><rect x="202" y="64" width="36" height="96"/>` +
      `<rect x="246" y="92" width="52" height="68"/></g>` +
      `<g fill="#f6c667" opacity=".8"><rect x="70" y="56" width="6" height="6"/>` +
      `<rect x="84" y="72" width="6" height="6"/><rect x="158" y="44" width="6" height="6"/>` +
      `<rect x="172" y="66" width="6" height="6"/><rect x="212" y="76" width="6" height="6"/></g>` +
      `<g fill="#0b1526"><rect width="320" height="18"/><rect y="182" width="320" height="18"/></g>` +
      `<g fill="#3b82f6"><rect x="12" y="5" width="16" height="8"/><rect x="44" y="5" width="16" height="8"/>` +
      `<rect x="76" y="5" width="16" height="8"/><rect x="108" y="5" width="16" height="8"/>` +
      `<rect x="140" y="5" width="16" height="8"/><rect x="172" y="5" width="16" height="8"/>` +
      `<rect x="204" y="5" width="16" height="8"/><rect x="236" y="5" width="16" height="8"/>` +
      `<rect x="268" y="5" width="16" height="8"/><rect x="296" y="5" width="16" height="8"/></g>` +
      `<circle cx="160" cy="100" r="30" fill="#0b1526" opacity=".65"/>` +
      `<path d="M150 84l30 16-30 16z" fill="#22d3ee"/>`,
  );
}

/** 3DGS scene: gaussian splat cloud over a dark stage. */
export function thumbSplat(): string {
  const dots: string[] = [];
  const hues = ["#22d3ee", "#f472b6", "#f6c667", "#34d399", "#60a5fa"];
  for (let i = 0; i < 90; i++) {
    const x = 30 + ((i * 53) % 260);
    const y = 40 + ((i * 37) % 120);
    const r = 3 + ((i * 7) % 9);
    dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${hues[i % 5]}" opacity=".${3 + (i % 5)}"/>`);
  }
  return svgUri(
    `<rect width="320" height="200" fill="#101426"/>` +
      `<ellipse cx="160" cy="168" rx="130" ry="16" fill="#1c2340"/>` +
      dots.join("") +
      `<path d="M40 168h240" stroke="#22d3ee" stroke-width="1" opacity=".5"/>`,
  );
}

/** Wireframe mesh: triangulated drone-ish surface in electric blue. */
export function thumbMesh(): string {
  const pts: [number, number][] = [
    [40, 150], [90, 90], [150, 60], [210, 84], [270, 140], [230, 168], [150, 178], [80, 172], [160, 120],
  ];
  const tris: [number, number, number][] = [
    [0, 1, 8], [1, 2, 8], [2, 3, 8], [3, 4, 8], [4, 5, 8], [5, 6, 8], [6, 7, 8], [7, 0, 8],
  ];
  const lines = tris
    .map(([a, b, c]) => {
      const p = pts[a]!;
      const q = pts[b]!;
      const r = pts[c]!;
      return `<path d="M${p[0]} ${p[1]}L${q[0]} ${q[1]}L${r[0]} ${r[1]}Z" fill="none" stroke="#3b82f6" stroke-width="1.2"/>`;
    })
    .join("");
  const nodes = pts
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#22d3ee"/>`)
    .join("");
  return svgUri(
    `<rect width="320" height="200" fill="#0b1526"/>` +
      `<g opacity=".35" stroke="#1e3a5f"><path d="M0 50h320M0 100h320M0 150h320M80 0v200M160 0v200M240 0v200"/></g>` +
      lines +
      nodes,
  );
}

/* ── enterprise demo payloads (served by the vite bridge at /provider-demo) ─ */

const GPU_CARDS: ResourceCard[] = [
  {
    id: "sdxl-base",
    kind: "models",
    name: "SDXL 1.0 Base",
    description: "企业内网 GPU 服务器上的 SDXL 基础模型，1024 分辨率出图。",
    modality: "image",
    status: "ready",
    price: { amount: 0.08, currency: "CNY", unit: "image" },
    meta: { license: "OpenRAIL++-M", vram: "6.5 GB", size: "6.9 GB", version: "1.0" },
  },
  {
    id: "flux-schnell",
    kind: "models",
    name: "Flux.1 schnell",
    description: "四步快速出图模型，Apache-2.0 许可，适合分镜草图。",
    modality: "image",
    status: "ready",
    price: { amount: 0.04, currency: "CNY", unit: "image" },
    meta: { license: "Apache-2.0", vram: "5.8 GB", size: "11.5 GB", version: "schnell" },
  },
  {
    id: "wan21-fp8",
    kind: "models",
    name: "Wan 2.1 14B (fp8)",
    description: "量化版文生视频模型，480p · 5 秒片段，内网计费按秒。",
    modality: "video",
    status: "ready",
    price: { amount: 0.6, currency: "CNY", unit: "second" },
    meta: { license: "Apache-2.0", vram: "11.2 GB", size: "14.8 GB", version: "2.1" },
  },
  {
    id: "ltxv-2b",
    kind: "models",
    name: "LTX-Video 2B",
    description: "实时级文生视频模型，512×320 · 49 帧。",
    modality: "video",
    status: "ready",
    price: { amount: 0.35, currency: "CNY", unit: "second" },
    meta: { license: "LTXV-License", vram: "5.1 GB", size: "6.0 GB", version: "0.9.5" },
  },
];

const LLM_CARDS: ResourceCard[] = [
  {
    id: "qwen3-max",
    kind: "models",
    name: "Qwen3-Max",
    description: "百炼平台文本大模型，剧本与分镜推理经企业代理接入。",
    modality: "text",
    status: "ready",
    price: { amount: 0.02, currency: "CNY", unit: "ktoken" },
    meta: { license: "商用授权", version: "3-max", format: "HTTPS API" },
  },
  {
    id: "qwen-vl-max",
    kind: "models",
    name: "Qwen-VL-Max",
    description: "视觉理解模型，用于镜头审阅与画面一致性检查。",
    modality: "text",
    status: "ready",
    price: { amount: 0.03, currency: "CNY", unit: "ktoken" },
    meta: { license: "商用授权", version: "vl-max", format: "HTTPS API" },
  },
];

const MCP_CARDS: ResourceCard[] = [
  {
    id: "ffmpeg-bench",
    kind: "tools",
    name: "FFmpeg 剪辑台",
    description: "沙箱内运行的剪辑工具：拼接、转码、抽帧与音轨混合。",
    status: "ready",
    price: { amount: 0.01, currency: "CNY", unit: "call" },
    meta: { version: "7.1", format: "MCP stdio" },
  },
  {
    id: "blender-node",
    kind: "tools",
    name: "Blender 渲染节点",
    description: "headless Blender 渲染服务，输出 PNG 序列与相机轨迹。",
    status: "ready",
    price: { amount: 0.12, currency: "CNY", unit: "call" },
    meta: { version: "4.2", format: "MCP stdio" },
  },
  {
    id: "whisper-asr",
    kind: "tools",
    name: "Whisper 转录",
    description: "语音转文字工具，按音频秒数计费，支持字幕时间轴。",
    status: "ready",
    price: { amount: 0.005, currency: "CNY", unit: "second" },
    meta: { version: "large-v3", format: "MCP stdio" },
  },
];

const SKILL_CARDS: ResourceCard[] = [
  {
    id: "noir-shot-plan",
    kind: "skills",
    name: "黑色电影分镜指南",
    description: "引导模型产出高对比布光、低机位与雨夜反射的分镜 prose。",
    modality: "text",
    status: "ready",
    price: { amount: 0.5, currency: "CNY", unit: "download" },
    meta: { version: "2.1", license: "CC-BY-4.0", target: "shot-plan" },
  },
  {
    id: "character-consistency",
    kind: "skills",
    name: "角色一致性提示词",
    description: "跨镜头保持角色外貌与服装一致的提示词技法合集。",
    modality: "image",
    status: "ready",
    price: { amount: 0.3, currency: "CNY", unit: "download" },
    meta: { version: "1.4", license: "CC-BY-4.0", target: "asset" },
  },
  {
    id: "montage-rhythm",
    kind: "skills",
    name: "蒙太奇节奏指南",
    description: "以节拍与视线匹配组织剪辑点的 prose，供蒙太奇节点导入。",
    modality: "video",
    status: "ready",
    price: { amount: 0.2, currency: "CNY", unit: "download" },
    meta: { version: "1.0", license: "CC0-1.0", target: "montage" },
  },
];

const ASSET_CARDS: ResourceCard[] = [
  {
    id: "dusk-coast",
    kind: "assets",
    name: "黄昏海岸 · 概念图",
    description: "4K 概念设定图，含色彩脚本与机位标注。",
    modality: "image",
    status: "ready",
    price: { amount: 0.8, currency: "CNY", unit: "download" },
    meta: { license: "CC-BY-4.0", format: "PNG 4096×2560", size: "18.2 MB" },
    thumb: thumbImage(),
  },
  {
    id: "city-aerial",
    kind: "assets",
    name: "城市航拍 · 片段",
    description: "10 秒 4K 航拍素材，Log 色彩，附 LUT。",
    modality: "video",
    status: "ready",
    price: { amount: 2.5, currency: "CNY", unit: "download" },
    meta: { license: "商用授权", format: "MP4 3840×2160", size: "96.4 MB" },
    thumb: thumbVideo(),
  },
  {
    id: "office-splat",
    kind: "assets",
    name: "办公室 · 3DGS 场景",
    description: "高斯泼溅重建的室内场景，可自由机位漫游。",
    modality: "3dgs",
    status: "ready",
    price: { amount: 12, currency: "CNY", unit: "download" },
    meta: { license: "CC-BY-NC-4.0", format: ".splat 1.2M 点", size: "210 MB" },
    thumb: thumbSplat(),
  },
  {
    id: "drone-mesh",
    kind: "assets",
    name: "无人机 · 网格",
    description: "四旋翼无人机低模网格，含 UV 与 PBR 贴图。",
    modality: "mesh",
    status: "ready",
    price: { amount: 6, currency: "CNY", unit: "download" },
    meta: { license: "CC-BY-4.0", format: "glTF 2.0", size: "8.6 MB" },
    thumb: thumbMesh(),
  },
];

/** Demo enterprise resources keyed by bridge path segment. */
export const DEMO_CATALOG: Record<string, InfoPayload> = {
  gpu: {
    cards: GPU_CARDS,
    usage: { "sdxl-base": 148, "flux-schnell": 262, "wan21-fp8": 74, "ltxv-2b": 31 },
    engine: { gpu: "NVIDIA RTX 6000 Ada", vramMb: 49152, version: "0.45.0" },
  },
  llm: { cards: LLM_CARDS, usage: { "qwen3-max": 1860, "qwen-vl-max": 420 } },
  mcp: { cards: MCP_CARDS, usage: { "ffmpeg-bench": 96, "blender-node": 18, "whisper-asr": 640 } },
  skills: { cards: SKILL_CARDS, usage: { "noir-shot-plan": 7, "character-consistency": 12, "montage-rhythm": 4 } },
  assets: { cards: ASSET_CARDS, usage: { "dusk-coast": 3, "city-aerial": 1, "office-splat": 0, "drone-mesh": 2 } },
};

/** Cached last-known catalog of the local ComfyUI provider (pre-connect). */
export const LOCAL_COMFY_CARDS: ResourceCard[] = [
  {
    id: "sd15-fp16",
    kind: "models",
    name: "Stable Diffusion 1.5 (fp16)",
    description: "本机 ComfyUI 已安装的 SD1.5 fp16 精简模型，支持 512×512 出图。",
    modality: "image",
    status: "ready",
    price: null,
    meta: { license: "OpenRAIL-M", vram: "2.4 GB", size: "2.0 GB", version: "1.5" },
  },
  {
    id: "ltxv-2b-local",
    kind: "models",
    name: "LTX-Video 2B（本机）",
    description: "视频模板已就绪，权重尚未下载到本机 ComfyUI。",
    modality: "video",
    status: "not-installed",
    price: null,
    meta: { license: "LTXV-License", vram: "5.1 GB", size: "6.0 GB", version: "0.9.5" },
  },
];

/** Seeded provider accesses: populated catalogs, honest disconnected status. */
export function seedProviders(): ProviderRecord[] {
  const mk = (
    id: string,
    name: string,
    kind: ProviderKind,
    baseUrl: string,
    payload: InfoPayload,
    apiKey = "",
  ): ProviderRecord => ({
    id,
    name,
    kind,
    baseUrl,
    apiKey,
    password: "",
    status: "disconnected",
    error: null,
    connectedAt: null,
    cards: payload.cards.map((card) => ({ ...card, meta: { ...card.meta } })),
    usage: { ...(payload.usage ?? {}) },
    ...(payload.engine === undefined ? {} : { engine: { ...payload.engine } }),
  });
  return [
    // ACT: 本机 ComfyUI：端点为同源桥 /local-comfy（桥上游地址取自 server/.env 的
    // COMFYUI_BASE_URL）；连接握手用字段所填信息真实访问本机引擎。
    mk("local-comfy", "本机 ComfyUI GPU", "comfy", "/local-comfy", {
      cards: LOCAL_COMFY_CARDS,
      usage: { "sd15-fp16": 12, "ltxv-2b-local": 0 },
    }),
    // ACT: 百炼平台接入（env 驱动）：端点为同源桥 /bailian，apiKey 由 server/.env 的
    // BAILIAN_API_KEY 运行时回填（useProviders.applyEnvDefaults）；连接时桥以字段所填
    // 密钥真实调用 DashScope 兼容模式模型列表。种子目录为最后一次已知清单。
    mk("bailian", "百炼平台", "llm", "/bailian", DEMO_CATALOG.llm!),
    // ACT: 以下为演示目录源：卡片继续供给 Plugin 子页，但不在 Supply 页列为接入块。
    { ...mk("ent-gpu", "企业 GPU 服务器 · 实验楼 B", "comfy", "/provider-demo/gpu", DEMO_CATALOG.gpu!, "ent-lab-b-2026"), demo: true },
    { ...mk("ent-mcp", "内网 MCP 工具服务器", "mcp", "/provider-demo/mcp", DEMO_CATALOG.mcp!), demo: true },
    { ...mk("community-skills", "社区技能注册表", "skills", "/provider-demo/skills", DEMO_CATALOG.skills!), demo: true },
    { ...mk("asset-store", "素材资产库", "assets", "/provider-demo/assets", DEMO_CATALOG.assets!), demo: true },
  ];
}