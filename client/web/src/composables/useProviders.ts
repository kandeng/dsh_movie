/**
 * Supply registry (Phase-9 proposal §2/§3, Phase-10 per-user isolation):
 * each signed-in user owns his supply accesses (internal/external resources
 * that provide models, tools, skills, assets). Records are persisted under a
 * per-user key so one user can never see or edit another user's supplies.
 *
 * One module-level reactive registry owns the cascade rendered by the
 * Account → Supply panel and the card feeds consumed by Plugins → Models/
 * Tools/Skills/Assets. Connecting performs the proposal's handshake: `GET
 * <baseUrl>/info` replies card lists (+ optional usage/engine facts); the
 * reply replaces the cached catalog and flips the status tag. Billing is
 * derived per provider from unit price × recorded usage (cascade fold).
 *
 * Persistence is browser-local for this phase (per-user secrets stay on the
 * user's machine); a server-side registry is the Phase-9 backend follow-up.
 * Mutations are optimistic and persisted immediately; delete is undoable.
 */

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import {
  seedProviders,
  adoptFields,
  inferProviderType,
  providerTypeSpec,
  type CardKind,
  type CardPrice,
  type InfoPayload,
  type ProviderKind,
  type ProviderRecord,
  type ResourceCard,
} from "@/lib/providerCatalog";

const STORAGE_PREFIX = "dsh-movie.supply.v1:";
/** Active per-user storage key; null while signed out (registry empty). */
let storageKey: string | null = null;

/** A card joined with its owning provider (Plugins subpage feed row). */
export interface CardFeedRow {
  card: ResourceCard;
  provider: ProviderRecord;
}

/** Snapshot kept for undo-after-delete (proposal: destructive actions undo). */
export interface ProviderSnapshot {
  record: ProviderRecord;
  index: number;
}

/** The handle returned by {@link useProviders}. */
export interface ProvidersHandle {
  providers: Ref<ProviderRecord[]>;
  /** Load one user's supplies (empty string = signed out → clear). */
  loadFor(userId: string): void;
  /** True while any connect handshake is in flight. */
  busy: ComputedRef<boolean>;
  /** Cards of one kind across every provider, in provider order. */
  cardsOf(kind: CardKind): CardFeedRow[];
  /** Live connection state of a card: ready / not-installed / offline. */
  cardState(row: CardFeedRow): "ready" | "not-installed" | "offline";
  byId(id: string): ProviderRecord | undefined;
  connect(id: string): Promise<void>;
  disconnect(id: string): void;
  /** Create or update one provider access (optimistic + persisted). */
  save(record: ProviderRecord): void;
  /** Remove one provider; returns the snapshot for undo. */
  remove(id: string): ProviderSnapshot | null;
  /** Re-insert a deleted provider at its original position. */
  restore(snapshot: ProviderSnapshot): void;
  /** Record billable usage of one card (n units, default 1). */
  recordUsage(providerId: string, cardId: string, n?: number): void;
  /** Month-to-date cost of one provider (price × usage, free cards = 0). */
  costOf(provider: ProviderRecord): number;
  /** Sum of {@link costOf} across providers. */
  totalCost: ComputedRef<number>;
  /** Display amount of a unit price ("免费" key, or "¥0.08" / "$0.04"). */
  priceLabel(price: CardPrice | null): string;
}

function load(key: string): ProviderRecord[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return seedProviders();
    const parsed = JSON.parse(raw) as ProviderRecord[];
    if (!Array.isArray(parsed) || parsed.length === 0) return seedProviders();
    // ACT: Phase-10.1 迁移：旧“百炼平台 · 企业代理”演示接入（ent-llm）升级为 env 驱动
    // 的 bailian 接入（端点 /bailian，密钥留空待 .env 回填）。
    for (const row of parsed) {
      if (row.id === "ent-llm") {
        row.id = "bailian";
        row.name = "百炼平台";
        if (row.baseUrl === "/provider-demo/llm") row.baseUrl = "/bailian";
        if (row.apiKey === "ent-proxy-key") row.apiKey = "";
      }
    }
    // ACT: Phase-10.2 迁移：无类型旧行升级为六类供应商之一（种子 id / comfy / llm），
    // 并按 schema 生成 fields（旧 baseUrl/apiKey 列回填，密钥与地址不丢失）；
    // mcp/skills/assets 旧行保持无类型（旧三字段网格 + 旧握手）。
    for (const row of parsed) {
      if (row.demo === true || row.providerType !== undefined) continue;
      if (row.id !== "bailian" && row.id !== "local-comfy" && row.kind !== "comfy" && row.kind !== "llm") continue;
      row.providerType = inferProviderType(row);
      const spec = providerTypeSpec(row.providerType);
      if (spec !== undefined) row.fields = adoptFields(spec, row);
    }
    // ACT: 历史存档迁移可能产生同 id 行（如 ent-llm 改名 bailian 与已存种子行
    // 相撞）：按 id 保留首现、丢弃后续同 id 行，消除 Vue key 冲突与同名双块。
    const seenIds = new Set<string>();
    const rows = parsed.filter((row) => {
      if (seenIds.has(row.id)) return false;
      seenIds.add(row.id);
      return true;
    });
    // Merge seeds for ids the stored copy lacks (catalog grew between phases);
    // ACT: 已存记录按种子同步 demo 标记（旧存档无该字段）。
    const seeds = seedProviders();
    for (const seed of seeds) {
      const stored = rows.find((row) => row.id === seed.id);
      if (stored === undefined) {
        rows.push(seed);
        continue;
      }
      if (seed.demo === true) stored.demo = true;
    }
    return rows.map((row) => ({ ...row, status: row.status === "connecting" ? "disconnected" : row.status }));
  } catch {
    return seedProviders();
  }
}

/**
 * ACT: env 驱动接入（百炼 / 本机 ComfyUI）的输入项以 server/.env 为真源：开发桥
 * /supply-env 返回 .env 中的密钥与真实上游地址，这里回填到对应接入的类型字段
 * （仅在字段为空时回填，尊重用户手工修改）。回填后的字段值即连接握手所用信息。
 */
async function applyEnvDefaults(): Promise<void> {
  if (storageKey === null) return;
  try {
    const res = await fetch("/supply-env", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return;
    const env = (await res.json()) as {
      bailianApiKey?: string;
      bailianBaseUrl?: string;
      comfyBaseUrl?: string;
    };
    for (const provider of providers.value) {
      if (provider.fields === undefined) continue;
      if (provider.providerType === "bailian") {
        if (provider.fields["apiKey"] === "" && typeof env.bailianApiKey === "string" && env.bailianApiKey !== "") {
          provider.fields["apiKey"] = env.bailianApiKey;
        }
        if (provider.fields["baseUrl"] === "" && typeof env.bailianBaseUrl === "string" && env.bailianBaseUrl !== "") {
          provider.fields["baseUrl"] = env.bailianBaseUrl;
        }
        provider.baseUrl = provider.fields["baseUrl"];
        provider.apiKey = provider.fields["apiKey"];
      }
      if (provider.providerType === "local-comfy") {
        if (provider.fields["baseUrl"] === "" && typeof env.comfyBaseUrl === "string" && env.comfyBaseUrl !== "") {
          provider.fields["baseUrl"] = env.comfyBaseUrl;
        }
        provider.baseUrl = provider.fields["baseUrl"];
      }
    }
  } catch {
    /* 桥不可用（非 dev/preview 环境）：保留现有配置 */
  }
}

const providers = ref<ProviderRecord[]>([]);
watch(
  providers,
  (value) => {
    if (storageKey === null) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage full / private mode: registry stays in-memory */
    }
  },
  { deep: true },
);

/**
 * Swap the registry to one user's supplies (called by the shell whenever the
 * signed-in user changes). Signed out → empty registry; each user gets his
 * own persisted copy, seeded on first visit.
 */
function loadFor(userId: string): void {
  if (userId === "") {
    storageKey = null;
    providers.value = [];
    return;
  }
  const key = STORAGE_PREFIX + userId;
  if (key === storageKey) return;
  storageKey = key;
  providers.value = load(key);
  // ACT: 载入后立即以 .env 真源回填 env 驱动接入的输入字段。
  void applyEnvDefaults();
}

/** Guarded read of one `/info` card entry (external payloads are untrusted). */
function readCard(raw: unknown, kind: CardKind, index: number): ResourceCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row["name"] === "string" ? row["name"] : "";
  if (name === "") return null;
  const id = typeof row["id"] === "string" && row["id"] !== "" ? row["id"] : `${kind}-${index}`;
  const priceRaw = row["price"];
  let price: CardPrice | null = null;
  if (typeof priceRaw === "object" && priceRaw !== null) {
    const p = priceRaw as Record<string, unknown>;
    const amount = typeof p["amount"] === "number" ? p["amount"] : 0;
    const currency = p["currency"] === "USD" ? "USD" : "CNY";
    const unit = p["unit"];
    const units = ["image", "second", "call", "download", "ktoken"];
    if (typeof unit === "string" && units.includes(unit)) {
      price = { amount, currency, unit: unit as CardPrice["unit"] };
    }
  }
  const meta: Record<string, string> = {};
  if (typeof row["meta"] === "object" && row["meta"] !== null) {
    for (const [key, value] of Object.entries(row["meta"] as Record<string, unknown>)) {
      if (typeof value === "string") meta[key] = value;
    }
  }
  const modality = row["modality"];
  const modalities = ["text", "image", "video", "audio", "3dgs", "mesh"];
  const status = row["status"] === "not-installed" ? "not-installed" : "ready";
  return {
    id,
    kind,
    name,
    description: typeof row["description"] === "string" ? row["description"] : "",
    ...(typeof modality === "string" && modalities.includes(modality)
      ? { modality: modality as ResourceCard["modality"] }
      : {}),
    status,
    price,
    meta,
    ...(typeof row["thumb"] === "string" ? { thumb: row["thumb"] } : {}),
  };
}

/** Normalize both `/info` shapes: flat `cards` or per-kind arrays. */
function readPayload(body: unknown): InfoPayload {
  if (typeof body !== "object" || body === null) return { cards: [] };
  const row = body as Record<string, unknown>;
  const cards: ResourceCard[] = [];
  if (Array.isArray(row["cards"])) {
    row["cards"].forEach((entry, index) => {
      const kindRaw = (entry as Record<string, unknown> | null)?.["kind"];
      const kind: CardKind =
        kindRaw === "models" || kindRaw === "tools" || kindRaw === "skills" || kindRaw === "assets"
          ? kindRaw
          : "models";
      const card = readCard(entry, kind, index);
      if (card !== null) cards.push(card);
    });
  } else {
    for (const kind of ["models", "tools", "skills", "assets"] as CardKind[]) {
      const list = row[kind];
      if (!Array.isArray(list)) continue;
      list.forEach((entry, index) => {
        const card = readCard(entry, kind, index);
        if (card !== null) cards.push(card);
      });
    }
  }
  const usage: Record<string, number> = {};
  if (typeof row["usage"] === "object" && row["usage"] !== null) {
    for (const [key, value] of Object.entries(row["usage"] as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
    }
  }
  const engineRaw = row["engine"];
  const engine =
    typeof engineRaw === "object" && engineRaw !== null
      ? {
          gpu: typeof (engineRaw as Record<string, unknown>)["gpu"] === "string" ? String((engineRaw as Record<string, unknown>)["gpu"]) : "",
          vramMb: typeof (engineRaw as Record<string, unknown>)["vramMb"] === "number" ? Number((engineRaw as Record<string, unknown>)["vramMb"]) : 0,
          version: typeof (engineRaw as Record<string, unknown>)["version"] === "string" ? String((engineRaw as Record<string, unknown>)["version"]) : "",
        }
      : undefined;
  return { cards, usage, ...(engine === undefined ? {} : { engine }) };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "连接超时";
    return error.message;
  }
  return String(error);
}

/**
 * Create (or reuse) the singleton provider registry handle.
 * @returns the {@link ProvidersHandle}.
 */
export function useProviders(): ProvidersHandle {
  const busy = computed(() => providers.value.some((row) => row.status === "connecting"));

  function byId(id: string): ProviderRecord | undefined {
    return providers.value.find((row) => row.id === id);
  }

  function cardsOf(kind: CardKind): CardFeedRow[] {
    const rows: CardFeedRow[] = [];
    for (const provider of providers.value) {
      for (const card of provider.cards) {
        if (card.kind === kind) rows.push({ card, provider });
      }
    }
    return rows;
  }

  function cardState(row: CardFeedRow): "ready" | "not-installed" | "offline" {
    if (row.provider.status !== "connected") return "offline";
    return row.card.status === "ready" ? "ready" : "not-installed";
  }

  async function connect(id: string): Promise<void> {
    const provider = byId(id);
    if (provider === undefined || provider.status === "connecting") return;
    provider.status = "connecting";
    provider.error = null;
    try {
      let payload: InfoPayload;
      if (provider.providerType !== undefined) {
        // ACT: 类型化接入：把字段所填信息交给同源桥 /supply-probe，由桥按供应商类型
        // 真实访问对应平台（百炼/火山/Anthropic/OpenAI 模型列表，ComfyUI 引擎状态）；
        // 上游错误原样透传，绝不伪造卡片。
        const res = await fetch("/supply-probe", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ type: provider.providerType, fields: provider.fields ?? {} }),
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(typeof body?.error === "string" && body.error !== "" ? body.error : `HTTP ${res.status}`);
        }
        payload = readPayload(await res.json());
      } else {
        const base = provider.baseUrl.trim().replace(/\/+$/, "");
        const headers: Record<string, string> = {};
        if (provider.apiKey.trim() !== "") headers["Authorization"] = `Bearer ${provider.apiKey.trim()}`;
        const res = await fetch(`${base}/info`, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        payload = readPayload(await res.json());
      }
      provider.cards = payload.cards;
      // Keep recorded usage; seed counts for cards newly appeared in /info.
      const usage: Record<string, number> = { ...provider.usage };
      for (const card of payload.cards) {
        if (usage[card.id] === undefined) usage[card.id] = payload.usage?.[card.id] ?? 0;
      }
      provider.usage = usage;
      if (payload.engine !== undefined) provider.engine = payload.engine;
      provider.status = "connected";
      provider.connectedAt = Date.now();
    } catch (caught) {
      provider.status = "error";
      provider.error = describeError(caught);
    }
  }

  function disconnect(id: string): void {
    const provider = byId(id);
    if (provider === undefined) return;
    provider.status = "disconnected";
    provider.error = null;
  }

  function save(record: ProviderRecord): void {
    const index = providers.value.findIndex((row) => row.id === record.id);
    if (index === -1) providers.value.push(record);
    else providers.value[index] = record;
  }

  function remove(id: string): ProviderSnapshot | null {
    const index = providers.value.findIndex((row) => row.id === id);
    if (index === -1) return null;
    const record = providers.value[index]!;
    providers.value.splice(index, 1);
    return { record, index };
  }

  function restore(snapshot: ProviderSnapshot): void {
    if (providers.value.some((row) => row.id === snapshot.record.id)) return;
    const at = Math.min(snapshot.index, providers.value.length);
    providers.value.splice(at, 0, snapshot.record);
  }

  function recordUsage(providerId: string, cardId: string, n = 1): void {
    const provider = byId(providerId);
    if (provider === undefined) return;
    provider.usage = { ...provider.usage, [cardId]: (provider.usage[cardId] ?? 0) + n };
  }

  function costOf(provider: ProviderRecord): number {
    let total = 0;
    for (const card of provider.cards) {
      if (card.price === null) continue;
      total += card.price.amount * (provider.usage[card.id] ?? 0);
    }
    return total;
  }

  const totalCost = computed(() => providers.value.reduce((sum, row) => sum + costOf(row), 0));

  function priceLabel(price: CardPrice | null): string {
    if (price === null || price.amount === 0) return "免费";
    const symbol = price.currency === "USD" ? "$" : "¥";
    return `${symbol}${price.amount}`;
  }

  return {
    providers,
    loadFor,
    busy,
    cardsOf,
    cardState,
    byId,
    connect,
    disconnect,
    save,
    remove,
    restore,
    recordUsage,
    costOf,
    totalCost,
    priceLabel,
  };
}

/** Kind display keys shared by Provider page filters and badges. */
export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  comfy: "ComfyUI GPU",
  llm: "大模型平台",
  mcp: "MCP 工具",
  skills: "技能注册表",
  assets: "资产库",
};

/** Billing-unit display keys; the UI wraps them in translate(). */
export const PRICE_UNIT_LABEL: Record<CardPrice["unit"], string> = {
  image: "每张图",
  second: "每秒",
  call: "每次调用",
  download: "每次下载",
  ktoken: "每千 token",
};