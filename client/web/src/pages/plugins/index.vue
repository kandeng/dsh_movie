<script setup lang="ts">
// ACT: 插件市场页（Phase-7 P7-M5, D6）。左栏分类（工具 / 技能）+ 右栏瀑布流卡片，
// 布局对齐设置页。工具卡：名称/来源/种类徽章/状态徽章/警告徽章/定价与授权提示/
// 启用开关/安装·卸载；技能卡：标题/描述/目标 chip/来源工具/版本/许可/警告徽章，
// pick-mode 下出现「选择」按钮（D7 mode-1 触发）。顶部一次性社区内容警告横幅（D8）。
// 访客只读：安装/卸载/启用/举报/确认均为主机动作（D6/D2），由 useRoomRole.isHost 网关。
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { translate } from "@dsh-movie/i18n/vue";
import {
  IconSearch,
  IconAlertTriangle,
  IconShieldLock,
  IconDownload,
  IconPlayerPlay,
  IconExternalLink,
} from "@tabler/icons-vue";
import type {
  SkillArtifact,
  SkillProfile,
  SkillTarget,
  ToolInstallSpec,
  ToolManifest,
  ToolRecord,
  ToolStatus,
  WarningLevel,
} from "@dsh-movie/protocol";
import { usePlugins } from "@/composables/usePlugins";
import { useProviders, type CardFeedRow } from "@/composables/useProviders";
import type { CardKind, Modality, ResourceCard } from "@/lib/providerCatalog";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { useRoomRole } from "@/composables/useRoomRole";
import { useImportStore } from "@/stores/import";
import { useModelPickStore } from "@/stores/modelPick";

type Category = "models" | "tools" | "skills" | "assets";

const route = useRoute();
const router = useRouter();
const plugins = usePlugins();
const importStore = useImportStore();
const modelPickStore = useModelPickStore();
const { activeRoomId, bootstrap } = useMatrixChat();

// ACT: 房间与角色。pick-mode 的下载目标房间优先取暂存的 pending.roomId（跨路由往返），
// 否则回落到当前活动房间；访客判定始终基于活动房间的主机席位。
const roomIdRef = computed(() => activeRoomId.value ?? "");
const roomRole = useRoomRole(roomIdRef);
const canManage = computed(() => roomRole.isHost.value);

const pickMode = computed(() => route.query.mode === "pick");
const pending = computed(() => importStore.pending);
const pickRoomId = computed(() => pending.value?.roomId ?? activeRoomId.value ?? "");
// ACT: 模型 pick-mode（编辑器模型选择器跳转）：与技能 pick 共用 mode=pick，
// 由 query.category 区分两种往返；pendingModel 非空 = 正在为某节点挑选模型。
const pendingModel = computed(() => modelPickStore.pending);
const modelPickMode = computed(() => pickMode.value && pendingModel.value !== null);
// ACT: pick-mode 的目标模态由发起节点类型决定：ImageGenerator 挑图像模型，
// VideoGenerator 挑视频模型，AudioGenerator 挑音频模型，文本节点（TextGenerator）挑文本模型；候选过滤与顶部条文案共用该值。
const pickModality = computed<"text" | "image" | "video" | "audio">(() =>
  pendingModel.value?.classType === "ImageGenerator" ? "image"
  : pendingModel.value?.classType === "VideoGenerator" ? "video"
  : pendingModel.value?.classType === "AudioGenerator" ? "audio"
  : "text",
);

// ACT: 左栏分类（Phase-9 §4 顺序：模型→工具→技能→资产）；初值来自路由 query.category
// （编辑器 Import 跳转时带 category=skills，模型选择器跳转时带 category=models）；
// pick-mode 下 category 决定强制视图（skills 强制技能，models 强制模型）。
const queryCategory = route.query.category;
const initialCategory: Category =
  route.query.mode === "pick"
    ? queryCategory === "models" ? "models" : "skills"
    : queryCategory === "tools" || queryCategory === "skills" || queryCategory === "assets" ? queryCategory
    : "models";
const activeCategory = ref<Category>(initialCategory);

// ACT: 技能搜索框，pick-mode 下由 pending.query 意图预填（D10）。
const searchQuery = ref<string>(pending.value?.query ?? "");
const searched = ref(false);

// ACT: 左栏「技能」子菜单 = 电影管线七阶段；activeSub=null 表示父级「技能」（全部）。
const SKILL_SUBCATS: ReadonlyArray<{ id: string; label: string; targets: readonly string[] }> = [
  { id: "script", label: "剧本", targets: ["script"] },
  { id: "shot-plan", label: "分镜", targets: ["shot-plan"] },
  { id: "asset", label: "角色与资产", targets: ["asset"] },
  { id: "storyboard", label: "故事板", targets: ["storyboard"] },
  { id: "clip", label: "片段", targets: ["clip"] },
  { id: "montage", label: "蒙太奇", targets: ["montage"] },
  { id: "others", label: "其他", targets: ["text", "review", "any"] },
];
function subForTarget(target: SkillTarget | undefined): string | null {
  if (target === "script") return "script";
  if (target === "shot-plan") return "shot-plan";
  return null;
}
const activeSub = ref<string | null>(subForTarget(pending.value?.target));
// ACT: 内容面板 = 搜索结果按当前子菜单 scope 过滤；父级「技能」显示全部。
const visibleSkills = computed(() => {
  const sub = SKILL_SUBCATS.find((entry) => entry.id === activeSub.value);
  if (sub === undefined) return plugins.skills.value;
  return plugins.skills.value.filter((skill) => sub.targets.includes(skill.target));
});

// ACT: 一次性社区内容警告横幅（D8）。用 localStorage 记住已读，跨会话只出现一次。
const BANNER_KEY = "dsh-movie.plugins.bannerSeen";
const bannerVisible = ref(false);

// ACT: 安装第三方工具对话框。
const installVisible = ref(false);
const installName = ref("");
const installCommand = ref("");
const installArgs = ref("");
const installAllowlist = ref("");
const installMemory = ref<number | undefined>(undefined);

// ACT: 举报技能对话框（D8 用户报告，任意用户可举报，仅主机可清除）。
const reportVisible = ref(false);
const reportSkill = ref<SkillProfile | null>(null);
const reportLevel = ref<Exclude<WarningLevel, "clean">>("yellow");
const reportReason = ref("");

// ACT: 内联反馈（本项目不使用 ElMessage，沿用 error/notice ref 就地提示）。
const notice = ref<string | null>(null);

// ACT: 可执行技能运行（D9a）。「运行」在技能卡上触发 plugins/skills.run，输出以
// 结果对话框展示；橙色技能先弹授权对话框，记录同意后再运行；红色技能按钮禁用。
const runVisible = ref(false);
const runContent = ref("");
const runArtifacts = ref<SkillArtifact[]>([]);
const consentVisible = ref(false);
const consentSkill = ref<SkillProfile | null>(null);

onMounted(async () => {
  bannerVisible.value = localStorage.getItem(BANNER_KEY) === null;
  await bootstrap();
  await refresh();
  if (activeCategory.value === "skills" || (pickMode.value && !modelPickMode.value)) await runSearch();
  focusModelFromQuery();
});

async function refresh(): Promise<void> {
  notice.value = null;
  try {
    await Promise.all([plugins.loadTools(), plugins.loadSources()]);
  } catch {
    /* plugins.error 已记录，模板就地渲染 */
  }
}

async function runSearch(): Promise<void> {
  notice.value = null;
  searched.value = true;
  try {
    await plugins.search(searchQuery.value);
  } catch {
    /* plugins.error 已记录 */
  }
}

function dismissBanner(): void {
  bannerVisible.value = false;
  localStorage.setItem(BANNER_KEY, "1");
}

function switchCategory(category: Category): void {
  activeCategory.value = category;
  void router.replace({
    path: "/plugins",
    query: {
      ...(category === "models" ? {} : { category }),
      ...(pickMode.value ? { mode: "pick" } : {}),
    },
  });
  // ACT: 进入「技能」父级 = 清空子菜单与查询，浏览全部技能卡（需求 4）。
  if (category === "skills") {
    activeSub.value = null;
    searchQuery.value = "";
    void runSearch();
  }
}

// ACT: 点击子菜单 = 限定 scope 并浏览该子类别全部技能卡（无需输入查询，需求 3/4）。
function selectSub(id: string): void {
  activeSub.value = id;
  searchQuery.value = "";
  void runSearch();
}

function cancelPick(): void {
  importStore.clearPending();
  modelPickStore.clearPending();
  void router.push({ path: "/studio" });
}

/**
 * ACT: 模型 pick-mode「选择」：把选中的模型 id/名称暂存为 completed，回到 Studio
 * 由其消费写入节点的 `model` widget（脏草稿，保存仍是唯一权威变更）。
 */
function confirmModelPick(row: CardFeedRow): void {
  const target = pendingModel.value;
  if (target === null) return;
  modelPickStore.complete({
    nodeId: target.nodeId,
    modelId: row.card.id,
    modelName: row.card.name,
  });
  modelPickStore.clearPending();
  void router.push({ path: "/studio" });
}

// ACT: pick-mode「选择」→ 下载技能正文写入房间工作区（D7 mode-1）→ 暂存 completed →
// 回到 Studio 由其消费粘贴（b5/b6）。
async function confirmImport(skill: SkillProfile): Promise<void> {
  const target = pending.value;
  const roomId = pickRoomId.value;
  if (target === null || roomId === "") {
    notice.value = translate("下载失败");
    return;
  }
  notice.value = null;
  try {
    const download = await plugins.download(skill.id, roomId);
    importStore.complete({
      nodeId: target.nodeId,
      widgetName: target.widgetName,
      insertionPoint: target.insertionPoint,
      body: download.body,
      ref: {
        id: skill.id,
        toolId: skill.toolId,
        version: download.profile.version,
        path: download.path,
        downloadedAt: Date.now(),
      },
    });
    importStore.clearPending();
    await router.push({ path: "/studio" });
  } catch {
    notice.value = translate("下载失败");
  }
}

// ACT: 启用/停用工具（主机动作）。
async function toggleEnabled(tool: ToolRecord, enabled: boolean): Promise<void> {
  notice.value = null;
  try {
    await plugins.setEnabled(tool.id, enabled);
    await refresh();
  } catch {
    /* plugins.error 已记录 */
  }
}

// ACT: 卸载用户/第三方工具（主机动作）。
async function uninstallTool(tool: ToolRecord): Promise<void> {
  notice.value = null;
  try {
    await plugins.uninstall(tool.id);
    await refresh();
  } catch {
    /* plugins.error 已记录 */
  }
}

function openInstall(): void {
  installName.value = "";
  installCommand.value = "";
  installArgs.value = "";
  installAllowlist.value = "";
  installMemory.value = undefined;
  installVisible.value = true;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// ACT: 提交安装。manifest 的可选字段在 exactOptionalPropertyTypes 下需按需省略。
async function submitInstall(): Promise<void> {
  const manifest: ToolManifest = {
    networkAllowlist: splitList(installAllowlist.value),
    ...(installMemory.value === undefined ? {} : { memoryMaxMb: installMemory.value }),
  };
  const args = splitList(installArgs.value);
  const spec: ToolInstallSpec = {
    name: installName.value.trim(),
    command: installCommand.value.trim(),
    ...(args.length === 0 ? {} : { args }),
    manifest,
  };
  notice.value = null;
  try {
    await plugins.install(spec);
    installVisible.value = false;
    await refresh();
    notice.value = translate("已安装");
  } catch {
    /* plugins.error 已记录 */
  }
}

function openReport(skill: SkillProfile): void {
  reportSkill.value = skill;
  reportLevel.value = "yellow";
  reportReason.value = "";
  reportVisible.value = true;
}

async function submitReport(): Promise<void> {
  const skill = reportSkill.value;
  if (skill === null) return;
  notice.value = null;
  try {
    await plugins.flag(skill.id, reportLevel.value, reportReason.value.trim());
    reportVisible.value = false;
    await runSearch();
    notice.value = translate("已举报");
  } catch {
    /* plugins.error 已记录 */
  }
}

// ACT: 运行一个可执行技能（D9a）。状态判别：ok→结果对话框；consent-required→
// 授权对话框；blocked（红）/not-executable/not-found→就地提示。房间取 pick 目标或活动房间。
async function runSkill(skill: SkillProfile): Promise<void> {
  const roomId = pickRoomId.value;
  if (roomId === "") {
    notice.value = translate("运行失败");
    return;
  }
  notice.value = null;
  try {
    const { run, status } = await plugins.run(skill.id, roomId);
    if (status === "ok" && run !== null) {
      runContent.value = run.content;
      runArtifacts.value = run.artifacts;
      runVisible.value = true;
      return;
    }
    if (status === "consent-required") {
      consentSkill.value = skill;
      consentVisible.value = true;
      return;
    }
    if (status === "blocked") {
      notice.value = translate("恶意内容已被阻止运行");
      return;
    }
    if (status === "not-executable") {
      notice.value = translate("此技能不可执行");
      return;
    }
    notice.value = translate("运行失败");
  } catch {
    notice.value = translate("运行失败");
  }
}

// ACT: 橙色技能授权后记录服务器全局同意（D9），随即重试运行。
async function submitConsent(): Promise<void> {
  const skill = consentSkill.value;
  if (skill === null) return;
  try {
    await plugins.consent(skill.id, true);
    consentVisible.value = false;
    await runSkill(skill);
  } catch {
    /* plugins.error 已记录 */
  }
}

// ── 徽章/标签映射 ──────────────────────────────────────────────────────────
function warningLabel(level: WarningLevel): string {
  if (level === "yellow") return translate("疑似风险");
  if (level === "orange") return translate("需要授权");
  if (level === "red") return translate("恶意");
  return "";
}

function warningClass(level: WarningLevel): string {
  return `warnBadge warn-${level}`;
}

function statusLabel(status: ToolStatus): string {
  if (status === "running") return translate("运行中");
  if (status === "stopped") return translate("已停止");
  if (status === "degraded") return translate("已降级");
  if (status === "error") return translate("错误");
  return translate("已禁用");
}

function statusType(status: ToolStatus): "success" | "info" | "warning" | "danger" {
  if (status === "running") return "success";
  if (status === "degraded") return "warning";
  if (status === "error") return "danger";
  return "info";
}

function kindLabel(kind: ToolRecord["kind"]): string {
  if (kind === "builtin") return translate("内置");
  if (kind === "third-party") return translate("第三方");
  return translate("用户");
}

function targetLabel(target: SkillTarget): string {
  if (target === "script") return translate("剧本");
  if (target === "shot-plan") return translate("分镜");
  if (target === "text") return translate("文本");
  if (target === "review") return translate("审阅");
  return translate("通用");
}

function sourceStatus(toolId: string): ToolStatus | null {
  return plugins.sources.value.find((row) => row.toolId === toolId)?.status ?? null;
}

// ── Phase-9 §4：模型/资产子页 + 提供商卡片_feed（状态 + 价格）─────────────
const registry = useProviders();

const modelQuery = ref("");
const modelModality = ref<"all" | Modality>("all");
// ACT: 供应排序器（模型视图）：取值 "all" 或供应商 id；选项实时对齐 Supply 页已连接供应（见 supplyOptions）。
const modelSupply = ref<string>("all");
const assetQuery = ref("");
const assetModality = ref<"all" | Modality>("all");

// ACT: 供应卡模型名深链（/plugins?category=models&model=<cardId>）：重置筛选保证
// 目标卡可见，滚动到视口中央并短暂高亮； Supply 页点击模型名 chip 跳入。
function focusModelFromQuery(): void {
  const id = typeof route.query.model === "string" ? route.query.model : "";
  if (id === "") return;
  activeCategory.value = "models";
  modelQuery.value = "";
  modelModality.value = "all";
  modelSupply.value = "all";
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(id)}"]`);
    if (el === null) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("deepLinked");
    window.setTimeout(() => el.classList.remove("deepLinked"), 1800);
  });
}
watch(() => route.query.model, (value) => {
  if (typeof value === "string" && value !== "") focusModelFromQuery();
});

const MODEL_MODALITIES: ReadonlyArray<{ id: "all" | Modality; label: string }> = [
  { id: "all", label: "全部" },
  { id: "text", label: "文本" },
  { id: "image", label: "图像" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
];
const ASSET_MODALITIES: ReadonlyArray<{ id: "all" | Modality; label: string }> = [
  { id: "all", label: "全部" },
  { id: "image", label: "图像" },
  { id: "video", label: "视频" },
  { id: "3dgs", label: "3DGS" },
  { id: "mesh", label: "网格" },
];

function matchesQuery(row: CardFeedRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  return row.card.name.toLowerCase().includes(needle) || row.card.description.toLowerCase().includes(needle);
}
// ACT: 排序器选项：Supply 页当前已连接的供应（实时）+ 额外“全部”项（默认选中）。
const supplyOptions = computed(() => [
  { value: "all", label: translate("全部") },
  ...registry.providers.value
    .filter((provider) => provider.status === "connected")
    .map((provider) => ({ value: provider.id, label: provider.name })),
]);
// ACT: 所选供应断开连接后选项消失：回退默认“全部”，避免选择悬空。
watch(supplyOptions, (options) => {
  if (!options.some((option) => option.value === modelSupply.value)) modelSupply.value = "all";
});

// ACT: 文本生成节点（TextGenerator）的候选模型过滤：文本模态 + 卡片就绪。pick-mode
// 与普通浏览共用同一卡片源（cardsOf），保证「直接进 Model 页能看到什么，挑选页就能
// 看到什么」，仅额外限定 text/ready；之前按 provider.kind==='llm' 另取源会在百炼
// 未返回卡片（未配 API Key）而模型实际挂在 ComfyUI 供应下时把挑选页滤空。
const visibleModels = computed(() =>
  registry.cardsOf("models").filter((row) =>
    (!modelPickMode.value || (row.card.modality === pickModality.value && row.card.status === "ready")) &&
    (modelModality.value === "all" || row.card.modality === modelModality.value) &&
    (modelSupply.value === "all" || row.provider.id === modelSupply.value) &&
    matchesQuery(row, modelQuery.value)),
);
const visibleAssets = computed(() =>
  registry.cardsOf("assets").filter((row) =>
    (assetModality.value === "all" || row.card.modality === assetModality.value) && matchesQuery(row, assetQuery.value)),
);
// ACT: Phase-9 §4 提供商供给的工具/技能卡片（带价格与连接状态）。
const providerToolRows = computed(() => registry.cardsOf("tools"));
const providerSkillRows = computed(() =>
  registry.cardsOf("skills").filter((row) => matchesQuery(row, searchQuery.value)),
);

function modalityLabel(modality: Modality | undefined): string {
  if (modality === "text") return translate("文本");
  if (modality === "image") return translate("图像");
  if (modality === "video") return translate("视频");
  if (modality === "audio") return translate("音频");
  if (modality === "3dgs") return "3DGS";
  if (modality === "mesh") return translate("网格");
  return "";
}
function stateLabel(state: "ready" | "not-installed" | "offline" | null): string {
  if (state === "ready") return translate("就绪");
  if (state === "not-installed") return translate("未安装");
  if (state === "offline") return translate("离线");
  return "";
}
function stateType(state: "ready" | "not-installed" | "offline" | null): "success" | "warning" | "info" {
  if (state === "ready") return "success";
  if (state === "not-installed") return "warning";
  return "info";
}
function priceText(card: ResourceCard): string {
  const price = card.price;
  // ACT: price 为 null = 上游未发布价格（如百炼 /models 仅有 id），不再谎报“免费”；
  // 空串使模板的 v-if 直接隐藏价格标签。
  if (price === null) return "";
  if (price.amount === 0) return translate("免费");
  const symbol = price.currency === "USD" ? "$" : "¥";
  const units: Record<string, string> = {
    image: "每张图",
    second: "每秒",
    call: "每次调用",
    download: "每次下载",
    ktoken: "每千 token",
    mtoken: "每百万 token",
  };
  return `${symbol}${price.amount} / ${translate(units[price.unit] ?? "")}`;
}
function metaLabel(key: string): string {
  if (key === "license") return translate("许可");
  if (key === "vram") return translate("显存");
  if (key === "size") return translate("大小");
  if (key === "version") return translate("版本");
  if (key === "format") return translate("格式");
  if (key === "target") return translate("阶段");
  return key;
}
function metaEntries(card: ResourceCard): Array<[string, string]> {
  return Object.entries(card.meta).slice(0, 4);
}
function usageOf(row: CardFeedRow): number {
  return row.provider.usage[row.card.id] ?? 0;
}

// ACT: 工具/技能卡的价格与连接状态叠加：按名称匹配提供商目录中的同名卡片。
function feedRowFor(kind: CardKind, name: string): CardFeedRow | undefined {
  return registry.cardsOf(kind).find((row) => row.card.name === name);
}
function feedPriceText(kind: CardKind, name: string): string {
  const row = feedRowFor(kind, name);
  return row === undefined ? "" : priceText(row.card);
}
function feedStateLabel(kind: CardKind, name: string): string {
  const row = feedRowFor(kind, name);
  return row === undefined ? "" : stateLabel(registry.cardState(row));
}
function feedStateType(kind: CardKind, name: string): "success" | "warning" | "info" {
  const row = feedRowFor(kind, name);
  return row === undefined ? "info" : stateType(registry.cardState(row));
}

// ACT: 模型详情抽屉（规格/价格/用量）。
const drawerVisible = ref(false);
const drawerRow = ref<CardFeedRow | null>(null);

function openModel(row: CardFeedRow): void {
  drawerRow.value = row;
  drawerVisible.value = true;
}
function drawerMemLabel(): string {
  const gpu = drawerRow.value?.provider.engine?.gpu ?? "";
  return gpu.toLowerCase().includes("cpu") ? translate("内存") : translate("显存");
}

// ACT: 资产预览与下载（下载计一次账单用量）。
const assetPreviewVisible = ref(false);
const assetPreview = ref<CardFeedRow | null>(null);
function openAsset(row: CardFeedRow): void {
  assetPreview.value = row;
  assetPreviewVisible.value = true;
}
async function downloadAsset(row: CardFeedRow): Promise<void> {
  const thumb = row.card.thumb;
  if (thumb === undefined) return;
  try {
    const blob = await (await fetch(thumb)).blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${row.card.id}.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
    registry.recordUsage(row.provider.id, row.card.id, 1);
    notice.value = translate("已下载");
  } catch {
    notice.value = translate("下载失败");
  }
}
</script>

<template>
  <main class="pluginsGrid">
    <aside class="pluginsSidebar">
      <div class="sidebarHeader">
        <h2>{{ translate("插件") }}</h2>
      </div>
      <nav class="pluginsNav" :aria-label="translate('插件')">
        <button
          type="button"
          class="navButton"
          :aria-current="activeCategory === 'models' ? 'page' : undefined"
          @click="switchCategory('models')">
          <span>{{ translate("模型") }}</span>
        </button>
        <button
          type="button"
          class="navButton"
          :aria-current="activeCategory === 'tools' ? 'page' : undefined"
          @click="switchCategory('tools')">
          <span>{{ translate("工具") }}</span>
        </button>
        <button
          type="button"
          class="navButton"
          :aria-current="activeCategory === 'skills' && activeSub === null ? 'page' : undefined"
          @click="switchCategory('skills')">
          <span>{{ translate("技能") }}</span>
        </button>
        <div v-if="activeCategory === 'skills'" class="subNav">
          <button
            v-for="sub in SKILL_SUBCATS"
            :key="sub.id"
            type="button"
            class="navButton subButton"
            :aria-current="activeSub === sub.id ? 'page' : undefined"
            @click="selectSub(sub.id)">
            <span>{{ translate(sub.label) }}</span>
          </button>
        </div>
        <button
          type="button"
          class="navButton"
          :aria-current="activeCategory === 'assets' ? 'page' : undefined"
          @click="switchCategory('assets')">
          <span>{{ translate("资产") }}</span>
        </button>
      </nav>
    </aside>

    <section class="pluginsMain">
      <!-- ACT: pick-mode 顶部条：说明正在为哪个节点挑选技能/模型，并提供取消返回。 -->
      <div v-if="pickMode" class="pickBar">
        <icon-download :size="16" aria-hidden="true" />
        <span>{{ translate(modelPickMode ? (pickModality === "audio" ? "选择一个音频生成模型供音频生成节点使用" : pickModality === "video" ? "选择一个视频生成模型供视频生成节点使用" : pickModality === "image" ? "选择一个图像生成模型供图像生成节点使用" : "选择一个模型供文本生成节点使用") : "选择一个技能导入到编辑器") }}</span>
        <el-button size="small" text @click="cancelPick">{{ translate("取消") }}</el-button>
      </div>

      <!-- ACT: 一次性社区内容警告横幅（D8）。 -->
      <el-alert
        v-if="bannerVisible"
        class="banner"
        type="warning"
        :closable="true"
        show-icon
        @close="dismissBanner">
        <template #title>{{ translate("社区内容未经审计") }}</template>
        <p class="bannerBody">
          {{ translate("注册表中的技能由社区发布，未经审计，请留意警告标记。") }}
        </p>
      </el-alert>

      <!-- ACT: 内联反馈：错误优先，其次成功提示。 -->
      <el-alert
        v-if="plugins.error.value"
        class="banner"
        type="error"
        :closable="false"
        show-icon
        :title="plugins.error.value" />
      <el-alert
        v-else-if="notice"
        class="banner"
        type="success"
        :closable="false"
        show-icon
        :title="notice" />

      <!-- ── 模型视图（Phase-9 §4：提供商 /info 卡片 + 连接状态 + 价格）── -->
      <template v-if="activeCategory === 'models'">
        <div class="viewHeader">
          <h3>{{ translate("模型") }}</h3>
        </div>
        <div class="filterRow">
          <button
            v-for="m in MODEL_MODALITIES" :key="m.id"
            type="button" class="chipFilter" :class="{ on: modelModality === m.id }"
            @click="modelModality = m.id">
            {{ translate(m.label) }}
          </button>
          <el-input
            v-model="modelQuery" class="searchInput" clearable
            :placeholder="translate('搜索模型')">
            <template #prefix><icon-search :size="15" aria-hidden="true" /></template>
          </el-input>
          <!-- ACT: 供应排序器：选项 = Supply 页已连接供应 + “全部”（默认）；搜索框 flex:1 将其推至行右端。 -->
          <el-select v-model="modelSupply" class="supplySelect" :aria-label="translate('来源')">
            <el-option v-for="option in supplyOptions" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </div>
        <div v-if="visibleModels.length === 0" class="empty">{{ translate("无匹配模型") }}</div>
        <div v-else class="masonry">
          <article v-for="row in visibleModels" :key="row.provider.id + ':' + row.card.id" class="card" :data-model-id="row.card.id">
            <header class="cardHead">
              <a
                v-if="row.card.url"
                class="cardTitle cardLink"
                :href="row.card.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="row.card.name"
              >
                {{ row.card.name }}<icon-external-link :size="12" aria-hidden="true" />
              </a>
              <span v-else class="cardTitle">{{ row.card.name }}</span>
              <el-tag size="small" :type="stateType(registry.cardState(row))" effect="plain">
                {{ stateLabel(registry.cardState(row)) }}
              </el-tag>
            </header>
            <p v-if="row.card.description" class="cardDesc">{{ translate(row.card.description) }}</p>
            <div class="chipRow">
              <el-tag v-if="row.card.modality" size="small" type="primary" effect="plain">
                {{ modalityLabel(row.card.modality) }}
              </el-tag>
              <el-tag v-if="priceText(row.card)" size="small" type="warning" effect="plain">{{ priceText(row.card) }}</el-tag>
              <el-tag v-for="entry in metaEntries(row.card)" :key="entry[0]" size="small" type="info" effect="plain">
                {{ metaLabel(entry[0]) }} {{ entry[1] }}
              </el-tag>
            </div>
            <p class="cardProvider">{{ translate("来源") }}：{{ row.provider.name }}</p>
            <footer class="cardActions">
              <el-button v-if="!row.card.url" size="small" text @click="openModel(row)">{{ translate("详情") }}</el-button>
              <el-button
                v-if="modelPickMode"
                size="small"
                type="primary"
                @click="confirmModelPick(row)">
                {{ translate("选择") }}
              </el-button>
            </footer>
          </article>
        </div>
      </template>

      <!-- ── 工具视图 ── -->
      <template v-else-if="activeCategory === 'tools'">
        <div class="viewHeader">
          <h3>{{ translate("工具") }}</h3>
          <el-button type="primary" size="small" :disabled="!canManage" @click="openInstall">
            {{ translate("安装") }}
          </el-button>
        </div>
        <p v-if="!canManage" class="readonlyHint">{{ translate("仅主持人可管理工具") }}</p>
        <div v-if="plugins.loading.value && plugins.tools.value.length === 0" class="empty">
          {{ translate("连接中…") }}
        </div>
        <div v-else-if="plugins.tools.value.length === 0 && providerToolRows.length === 0" class="empty">
          {{ translate("暂无工具") }}
        </div>
        <div v-if="plugins.tools.value.length > 0" class="masonry">
          <article v-for="tool in plugins.tools.value" :key="tool.id" class="card">
            <header class="cardHead">
              <span class="cardTitle">{{ tool.name }}</span>
              <span
                v-if="tool.warningLevel !== 'clean'"
                :class="warningClass(tool.warningLevel)"
                :title="translate('警告')">
                <icon-alert-triangle :size="13" aria-hidden="true" />
                {{ warningLabel(tool.warningLevel) }}
              </span>
            </header>
            <p class="cardProvider">{{ translate("来源") }}：{{ tool.provider }}</p>
            <div class="chipRow">
              <el-tag size="small" type="info" effect="plain">{{ kindLabel(tool.kind) }}</el-tag>
              <el-tag size="small" :type="statusType(sourceStatus(tool.id) ?? tool.status)" effect="plain">
                {{ statusLabel(sourceStatus(tool.id) ?? tool.status) }}
              </el-tag>
              <el-tag v-if="tool.installed" size="small" type="success" effect="plain">
                {{ translate("已安装") }}
              </el-tag>
              <el-tag v-if="feedPriceText('tools', tool.name)" size="small" type="warning" effect="plain">
                {{ feedPriceText('tools', tool.name) }}
              </el-tag>
              <el-tag v-if="feedStateLabel('tools', tool.name)" size="small" :type="feedStateType('tools', tool.name)" effect="plain">
                {{ feedStateLabel('tools', tool.name) }}
              </el-tag>
            </div>
            <p v-if="tool.pricing" class="cardNote">{{ tool.pricing }}</p>
            <p v-if="tool.requiresCredentials" class="cardNote credential">
              <icon-shield-lock :size="13" aria-hidden="true" />
              {{ translate("需要授权") }}
            </p>
            <footer class="cardActions">
              <el-switch
                :model-value="tool.enabled"
                :disabled="!canManage || !tool.installed || plugins.busy.value"
                @update:model-value="(value: boolean | string | number) => toggleEnabled(tool, value === true)" />
              <span class="switchLabel">{{ translate("启用") }}</span>
              <span class="spacer" />
              <el-button
                v-if="tool.installed && tool.kind !== 'builtin'"
                size="small"
                text
                type="danger"
                :disabled="!canManage || plugins.busy.value"
                @click="uninstallTool(tool)">
                {{ translate("卸载") }}
              </el-button>
            </footer>
          </article>
        </div>
        <div v-if="providerToolRows.length > 0" class="masonry">
          <article v-for="row in providerToolRows" :key="row.provider.id + ':' + row.card.id" class="card">
            <header class="cardHead">
              <span class="cardTitle">{{ row.card.name }}</span>
              <el-tag size="small" :type="stateType(registry.cardState(row))" effect="plain">
                {{ stateLabel(registry.cardState(row)) }}
              </el-tag>
            </header>
            <p v-if="row.card.description" class="cardDesc">{{ translate(row.card.description) }}</p>
            <div class="chipRow">
              <el-tag v-if="priceText(row.card)" size="small" type="warning" effect="plain">{{ priceText(row.card) }}</el-tag>
              <el-tag v-for="entry in metaEntries(row.card)" :key="entry[0]" size="small" type="info" effect="plain">
                {{ metaLabel(entry[0]) }} {{ entry[1] }}
              </el-tag>
            </div>
            <p class="cardProvider">{{ translate("来源") }}：{{ row.provider.name }}</p>
          </article>
        </div>
      </template>

      <!-- ── 技能视图 ── -->
      <template v-else-if="activeCategory === 'skills'">
        <div class="viewHeader">
          <h3>{{ translate("技能") }}</h3>
        </div>
        <div class="searchRow">
          <el-input
            v-model="searchQuery"
            class="searchInput"
            :placeholder="translate('搜索技能')"
            clearable
            @keyup.enter="runSearch">
            <template #prefix><icon-search :size="15" aria-hidden="true" /></template>
          </el-input>
          <el-button type="primary" :loading="plugins.loading.value" @click="runSearch">
            {{ translate("搜索") }}
          </el-button>
        </div>
        <div v-if="plugins.loading.value && visibleSkills.length === 0 && providerSkillRows.length === 0" class="empty">
          {{ translate("连接中…") }}
        </div>
        <div v-else-if="searched && visibleSkills.length === 0 && providerSkillRows.length === 0" class="empty">
          {{ translate("无匹配技能") }}
        </div>
        <div v-if="visibleSkills.length > 0" class="masonry">
          <article v-for="skill in visibleSkills" :key="skill.id" class="card">
            <header class="cardHead">
              <span class="cardTitle">{{ skill.title }}</span>
              <span
                v-if="skill.warningLevel !== 'clean'"
                :class="warningClass(skill.warningLevel)"
                :title="translate('警告')">
                <icon-alert-triangle :size="13" aria-hidden="true" />
                {{ warningLabel(skill.warningLevel) }}
              </span>
            </header>
            <p class="cardDesc">{{ skill.description }}</p>
            <div class="chipRow">
              <el-tag size="small" type="primary" effect="plain">{{ targetLabel(skill.target) }}</el-tag>
              <el-tag size="small" type="info" effect="plain">v{{ skill.version }}</el-tag>
              <el-tag v-if="skill.license" size="small" type="info" effect="plain">{{ skill.license }}</el-tag>
              <el-tag v-if="feedPriceText('skills', skill.title)" size="small" type="warning" effect="plain">
                {{ feedPriceText('skills', skill.title) }}
              </el-tag>
              <el-tag v-if="feedStateLabel('skills', skill.title)" size="small" :type="feedStateType('skills', skill.title)" effect="plain">
                {{ feedStateLabel('skills', skill.title) }}
              </el-tag>
            </div>
            <p class="cardProvider">{{ translate("来源") }}：{{ skill.provider }}</p>
            <footer class="cardActions">
              <el-button
                size="small"
                text
                :disabled="!canManage"
                @click="openReport(skill)">
                {{ translate("举报") }}
              </el-button>
              <span class="spacer" />
              <!-- ACT: 运行（D9a）。红色技能禁用并提示；其余主机可运行。 -->
              <el-tooltip
                v-if="skill.executable && skill.warningLevel === 'red'"
                :content="translate('恶意内容已被阻止运行')"
                placement="top"
                :show-arrow="false"
                :hide-after="0">
                <span class="marketWrap">
                  <el-button size="small" type="warning" plain disabled>
                    <icon-player-play :size="14" aria-hidden="true" />
                    {{ translate("运行") }}
                  </el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else-if="skill.executable"
                size="small"
                type="warning"
                plain
                :loading="plugins.busy.value"
                :disabled="!canManage"
                @click="runSkill(skill)">
                <icon-player-play :size="14" aria-hidden="true" />
                {{ translate("运行") }}
              </el-button>
              <el-tooltip
                v-if="skill.warningLevel === 'red'"
                :content="translate('恶意内容已被阻止导入')"
                placement="top"
                :show-arrow="false"
                :hide-after="0">
                <span class="marketWrap">
                  <el-button size="small" type="primary" disabled>{{ translate("选择") }}</el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else-if="pickMode"
                size="small"
                type="primary"
                :loading="plugins.busy.value"
                :disabled="!canManage"
                @click="confirmImport(skill)">
                {{ translate("选择") }}
              </el-button>
            </footer>
          </article>
        </div>
        <div v-if="providerSkillRows.length > 0" class="masonry">
          <article v-for="row in providerSkillRows" :key="row.provider.id + ':' + row.card.id" class="card">
            <header class="cardHead">
              <span class="cardTitle">{{ row.card.name }}</span>
              <el-tag size="small" :type="stateType(registry.cardState(row))" effect="plain">
                {{ stateLabel(registry.cardState(row)) }}
              </el-tag>
            </header>
            <p v-if="row.card.description" class="cardDesc">{{ translate(row.card.description) }}</p>
            <div class="chipRow">
              <el-tag v-if="priceText(row.card)" size="small" type="warning" effect="plain">{{ priceText(row.card) }}</el-tag>
              <el-tag v-for="entry in metaEntries(row.card)" :key="entry[0]" size="small" type="info" effect="plain">
                {{ metaLabel(entry[0]) }} {{ entry[1] }}
              </el-tag>
            </div>
            <p class="cardProvider">{{ translate("来源") }}：{{ row.provider.name }}</p>
          </article>
        </div>
      </template>

      <!-- ── 资产视图（Phase-9 §4：图像/视频/3DGS/网格 + 价格）── -->
      <template v-else-if="activeCategory === 'assets'">
        <div class="viewHeader">
          <h3>{{ translate("资产") }}</h3>
        </div>
        <div class="filterRow">
          <button
            v-for="m in ASSET_MODALITIES" :key="m.id"
            type="button" class="chipFilter" :class="{ on: assetModality === m.id }"
            @click="assetModality = m.id">
            {{ translate(m.label) }}
          </button>
          <el-input
            v-model="assetQuery" class="searchInput" clearable
            :placeholder="translate('搜索资产')">
            <template #prefix><icon-search :size="15" aria-hidden="true" /></template>
          </el-input>
        </div>
        <div v-if="visibleAssets.length === 0" class="empty">{{ translate("无匹配资产") }}</div>
        <div v-else class="masonry">
          <article v-for="row in visibleAssets" :key="row.provider.id + ':' + row.card.id" class="card">
            <img v-if="row.card.thumb" class="assetThumb" :src="row.card.thumb" :alt="row.card.name" />
            <header class="cardHead">
              <span class="cardTitle">{{ row.card.name }}</span>
              <el-tag size="small" :type="stateType(registry.cardState(row))" effect="plain">
                {{ stateLabel(registry.cardState(row)) }}
              </el-tag>
            </header>
            <p v-if="row.card.description" class="cardDesc">{{ translate(row.card.description) }}</p>
            <div class="chipRow">
              <el-tag v-if="row.card.modality" size="small" type="primary" effect="plain">
                {{ modalityLabel(row.card.modality) }}
              </el-tag>
              <el-tag v-if="priceText(row.card)" size="small" type="warning" effect="plain">{{ priceText(row.card) }}</el-tag>
              <el-tag v-for="entry in metaEntries(row.card)" :key="entry[0]" size="small" type="info" effect="plain">
                {{ metaLabel(entry[0]) }} {{ entry[1] }}
              </el-tag>
            </div>
            <p class="cardProvider">{{ translate("来源") }}：{{ row.provider.name }}</p>
            <footer class="cardActions">
              <el-button size="small" text @click="openAsset(row)">{{ translate("预览") }}</el-button>
              <span class="spacer" />
              <el-button size="small" type="primary" plain @click="downloadAsset(row)">
                <icon-download :size="14" aria-hidden="true" />
                {{ translate("下载") }}
              </el-button>
            </footer>
          </article>
        </div>
      </template>
    </section>

    <!-- ACT: 安装第三方工具对话框。 -->
    <el-dialog v-model="installVisible" :title="translate('安装')" width="480px">
      <el-form label-position="top">
        <el-form-item :label="translate('名称')">
          <el-input v-model="installName" :placeholder="translate('名称')" />
        </el-form-item>
        <el-form-item :label="translate('命令')">
          <el-input v-model="installCommand" placeholder="node /path/to/mcp-server.js" />
        </el-form-item>
        <el-form-item :label="translate('参数')">
          <el-input v-model="installArgs" :placeholder="translate('以逗号分隔')" />
        </el-form-item>
        <el-form-item :label="translate('网络白名单')">
          <el-input v-model="installAllowlist" :placeholder="translate('以逗号分隔')" />
        </el-form-item>
        <el-form-item :label="translate('内存上限（MB）')">
          <el-input-number v-model="installMemory" :min="0" :step="64" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="installVisible = false">{{ translate("取消") }}</el-button>
        <el-button
          type="primary"
          :loading="plugins.busy.value"
          :disabled="installName.trim() === '' || installCommand.trim() === ''"
          @click="submitInstall">
          {{ translate("安装") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ACT: 举报技能对话框（D8）。 -->
    <el-dialog v-model="reportVisible" :title="translate('举报')" width="440px">
      <el-form label-position="top">
        <el-form-item :label="translate('警告')">
          <el-select v-model="reportLevel" class="targetSelect">
            <el-option :label="translate('疑似风险')" value="yellow" />
            <el-option :label="translate('需要授权')" value="orange" />
            <el-option :label="translate('恶意')" value="red" />
          </el-select>
        </el-form-item>
        <el-form-item :label="translate('理由')">
          <el-input v-model="reportReason" type="textarea" :rows="3" :placeholder="translate('理由')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reportVisible = false">{{ translate("取消") }}</el-button>
        <el-button type="primary" :loading="plugins.busy.value" @click="submitReport">
          {{ translate("举报") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ACT: 运行结果对话框（D9a）。展示技能执行的文本输出与写入房间的产物。 -->
    <el-dialog v-model="runVisible" :title="translate('运行结果')" width="560px">
      <pre class="runOutput">{{ runContent }}</pre>
      <div v-if="runArtifacts.length > 0" class="runArtifacts">
        <p class="runArtifactsTitle">{{ translate("执行输出") }}</p>
        <ul class="runArtifactList">
          <li v-for="artifact in runArtifacts" :key="artifact.path">{{ artifact.path }}</li>
        </ul>
      </div>
      <template #footer>
        <el-button type="primary" @click="runVisible = false">{{ translate("关闭") }}</el-button>
      </template>
    </el-dialog>

    <!-- ACT: 橙色技能授权对话框（D9）。运行前需用户明确授权，记录到服务器全局同意存储。 -->
    <el-dialog v-model="consentVisible" :title="translate('授权运行')" width="440px">
      <el-alert type="warning" :closable="false" show-icon :title="translate('需要授权后运行')">
        <p class="bannerBody">{{ translate("该技能为可疑内容，运行前需要你的授权。") }}</p>
      </el-alert>
      <template #footer>
        <el-button @click="consentVisible = false">{{ translate("拒绝") }}</el-button>
        <el-button type="warning" :loading="plugins.busy.value" @click="submitConsent">
          {{ translate("授权运行") }}
        </el-button>
      </template>
    </el-dialog>
    <!-- ACT: 模型详情抽屉（Phase-9 §4）：规格/价格/用量 + 真实测试生成。 -->
    <el-drawer v-model="drawerVisible" :title="drawerRow?.card.name ?? ''" size="420px">
      <div v-if="drawerRow" class="drawerBody">
        <div class="chipRow">
          <el-tag size="small" :type="stateType(registry.cardState(drawerRow))" effect="dark">
            {{ stateLabel(registry.cardState(drawerRow)) }}
          </el-tag>
          <el-tag v-if="drawerRow.card.modality" size="small" type="primary" effect="plain">
            {{ modalityLabel(drawerRow.card.modality) }}
          </el-tag>
          <el-tag v-if="priceText(drawerRow.card)" size="small" type="warning" effect="plain">{{ priceText(drawerRow.card) }}</el-tag>
        </div>
        <p v-if="drawerRow.card.description" class="cardDesc">{{ translate(drawerRow.card.description) }}</p>
        <p class="cardProvider">{{ translate("来源") }}：{{ drawerRow.provider.name }}</p>
        <!-- ACT: 本机 ComfyUI：呈现“服务”身份（版本），不强调 GPU/显存等 CUDA 硬件。 -->
        <p v-if="drawerRow.provider.engine && drawerRow.provider.providerType === 'local-comfy'" class="cardProvider">
          {{ translate("本机 ComfyUI 服务") }} · ComfyUI {{ drawerRow.provider.engine.version }}
        </p>
        <p v-else-if="drawerRow.provider.engine" class="cardProvider">
          {{ drawerRow.provider.engine.gpu }} · {{ (drawerRow.provider.engine.vramMb / 1024).toFixed(1) }} GB {{ drawerMemLabel() }}
        </p>
        <table class="specTable">
          <tbody>
            <tr v-for="entry in metaEntries(drawerRow.card)" :key="entry[0]">
              <td>{{ metaLabel(entry[0]) }}</td>
              <td>{{ entry[1] }}</td>
            </tr>
            <tr>
              <td>{{ translate("用量（本月）") }}</td>
              <td>{{ usageOf(drawerRow) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-drawer>

    <!-- ACT: 资产预览对话框：大图 + 规格 + 下载。 -->
    <el-dialog v-model="assetPreviewVisible" :title="assetPreview?.card.name ?? ''" width="560px">
      <div v-if="assetPreview" class="assetPreviewBody">
        <img v-if="assetPreview.card.thumb" class="assetPreviewImage" :src="assetPreview.card.thumb" :alt="assetPreview.card.name" />
        <p v-if="assetPreview.card.description" class="cardDesc">{{ translate(assetPreview.card.description) }}</p>
        <div class="chipRow">
          <el-tag v-if="assetPreview.card.modality" size="small" type="primary" effect="plain">
            {{ modalityLabel(assetPreview.card.modality) }}
          </el-tag>
          <el-tag v-if="priceText(assetPreview.card)" size="small" type="warning" effect="plain">{{ priceText(assetPreview.card) }}</el-tag>
          <el-tag v-for="entry in metaEntries(assetPreview.card)" :key="entry[0]" size="small" type="info" effect="plain">
            {{ metaLabel(entry[0]) }} {{ entry[1] }}
          </el-tag>
        </div>
        <p class="cardProvider">{{ translate("来源") }}：{{ assetPreview.provider.name }}</p>
      </div>
      <template #footer>
        <el-button @click="assetPreviewVisible = false">{{ translate("关闭") }}</el-button>
        <el-button v-if="assetPreview" type="primary" @click="downloadAsset(assetPreview)">
          <icon-download :size="14" aria-hidden="true" />
          {{ translate("下载") }}
        </el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style lang="scss" scoped>
.pluginsGrid {
  // ACT: 页面四周留白单一真源：.pluginsMain 的右留白复用该变量，保证“卡片→滚动条”
  // 间距恒等于“滚动条→页面右边框”间距。
  --page-gutter: 16px;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  height: 100%;
  padding: var(--page-gutter);
}

.pluginsSidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;

  .sidebarHeader h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }
}

.pluginsNav {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .navButton {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--el-border-radius-base);
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover { background: var(--el-fill-color-light); }

    &[aria-current="page"] {
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      font-weight: 600;
    }
  }
}

.pluginsMain {
  min-width: 0;
  overflow-y: auto;
  // ACT: 卡片右缘与垂直滚动条之间留出与“滚动条→页面右边框”等宽的留白（需求 1）。
  padding-right: var(--page-gutter);
}

.pickBar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 13px;

  .el-button { margin-left: auto; }
}

.banner { margin-bottom: 12px; }

.bannerBody {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.viewHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;

  h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }
}

.readonlyHint {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.searchRow {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;

  .searchInput { flex: 1; min-width: 0; }
  .targetSelect { width: 140px; }
}

.empty {
  padding: 64px 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  text-align: center;
}

// ACT: Pinterest 式瀑布流，对齐广场页：等宽多列，卡片禁止跨列断开。
.masonry {
  column-width: 320px;
  column-gap: 20px;
}

// ACT: 供应卡模型名深链高亮：主色描边 + 一次性背景淡出（1.8s 后移除类）。
.card.deepLinked {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
  animation: deepLinkFade 1.8s ease-out;
}

@keyframes deepLinkFade {
  0% { background-color: var(--el-color-primary-light-9); }
  100% { background-color: transparent; }
}

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  margin: 0 0 20px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: calc(var(--ui-radius) * 2.5);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
  box-shadow: var(--el-box-shadow-lighter);
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
}

.cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cardTitle {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  word-break: break-word;
}

.cardDesc {
  margin: 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  /* ACT: 简介最多两行（用户要求“two lines of the introduction”）。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ACT: 模型名外链（跳转供应商模型卡页）：继承标题样式 + 外链小图标。 */
.cardLink {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
}
.cardLink:hover {
  color: var(--el-color-primary);
  text-decoration: underline;
}

.cardProvider {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.cardNote {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;

  &.credential {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--el-color-warning);
  }
}

.chipRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cardActions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;

  .spacer { flex: 1; }
  .switchLabel {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}

// ACT: 警告徽章配色（D8 阶梯）。
.warnBadge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;

  &.warn-yellow {
    background: var(--el-color-warning-light-9);
    color: var(--el-color-warning);
  }

  &.warn-orange {
    background: color-mix(in srgb, var(--el-color-warning) 22%, var(--el-bg-color));
    color: #d46b08;
  }

  &.warn-red {
    background: var(--el-color-danger-light-9);
    color: var(--el-color-danger);
  }
}

.marketWrap { display: inline-flex; }

// ACT: 运行结果对话框（D9a）的输出与产物样式。
.runOutput {
  margin: 0;
  padding: 12px;
  max-height: 280px;
  overflow: auto;
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.runArtifacts {
  margin-top: 12px;

  .runArtifactsTitle {
    margin: 0 0 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .runArtifactList {
    margin: 0;
    padding-left: 18px;
    color: var(--el-text-color-regular);
    font-size: 12px;
    line-height: 1.7;
    word-break: break-all;
  }
}

.subNav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 12px;
}

.pluginsNav .subButton { font-size: 12px; }

// ACT: Phase-9 模型/资产视图：模态过滤 chips + 搜索行。
.filterRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 16px;

  .searchInput { flex: 1; min-width: 180px; }
  .supplySelect { flex: none; width: 190px; }
}

.chipFilter {
  padding: 4px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 14px;
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;

  &:hover { background: var(--el-fill-color-light); }

  &.on {
    border-color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
    font-weight: 600;
  }
}

.assetThumb {
  width: 100%;
  aspect-ratio: 8 / 5;
  object-fit: cover;
  border-radius: calc(var(--ui-radius) * 1.5);
  border: 1px solid var(--el-border-color-lighter);
}

.drawerBody {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.specTable {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--el-border-color-lighter);
    color: var(--el-text-color-regular);

    &:first-child { color: var(--el-text-color-secondary); width: 40%; }
  }
}

.assetPreviewBody {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.assetPreviewImage {
  width: 100%;
  border-radius: calc(var(--ui-radius) * 1.5);
  border: 1px solid var(--el-border-color-lighter);
}

@media (max-width: 700px) {
  .pluginsGrid {
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 10px;
  }

  .sidebarHeader { display: none; }

  .navButton span { display: none; }

  .navButton {
    justify-content: center;
    padding: 10px 0;
  }
}
</style>
