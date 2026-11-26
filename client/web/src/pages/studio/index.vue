<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import type { NodeRunStatus, WorkflowGraph, WorkflowGroup, MovieStepResult, MovieStepStatus, MovieStepId, ImportedSkillRef, SkillTarget } from "@dsh-movie/protocol";
import { FUNCTIONAL_NODES, MOVIE_NODES, templateById } from "@dsh-movie/protocol";
import groupChat from "@/components/groupChat.vue";
import modeSwitcher from "@/components/modeSwitcher.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat, type ChatMessage } from "@/composables/useMatrixChat";
import { useVueFlowBridge } from "@/composables/useVueFlowBridge";
import { useChatSplitWidth } from "@/composables/useChatSplitWidth";
import VueFlowCanvas from "@/canvas/VueFlowCanvas.vue";
import NodeCascade, { type CascadeSelection } from "@/canvas/NodeCascade.vue";
import { expandTemplate } from "@/canvas/expandTemplate";
import { DEFAULT_GROUP_COLOR, GROUP_COLOR_KEYS, groupColor } from "@/canvas/groupOverlay";
import { useWorkflowStore } from "@/composables/useWorkflowStore";
import { useRoomRole } from "@/composables/useRoomRole";
import { useImportStore } from "@/stores/import";
import { useModelPickStore } from "@/stores/modelPick";
import { useWorkspaceGraph } from "@/composables/useWorkspaceGraph";
import { useExecStatus } from "@/composables/useExecStatus";
import { useCanvasScript, type CanvasScriptStage } from "@/composables/useCanvasScript";
import { useMovieRun } from "@/composables/useMovieRun";
import { buildDemoWorkflow, buildDemoPrompt, findMovieNode } from "@/utils/demoWorkflow";
import { mergesInputs, routeInputSlotByType, schemaFor, workflowToPrompt, type MovieNodeData, type NodeWidgetView, type ContentRef } from "@/canvas/graphMapper";
import { fetchMediaBlobUrl } from "@/lib/matrixMedia";
import { nodeSkin } from "@/canvas/nodeSkin";
import { previewKind, type TextPreviewKind } from "@/utils/textPreview";
import type { CanvasToolMode } from "@/canvas/toolContext";
// vidsay studioBar 工具图标：本地 svg 经 mask 渲染，跟随按钮文字颜色。
import iconCanvasAdd from "@/icons/canvas_add.svg";
import iconCanvasCursor from "@/icons/canvas_cursor.svg";
import iconCanvasDelete from "@/icons/canvas_delete.svg";
import iconCanvasEdge from "@/icons/canvas_edge.svg";
import iconCanvasEdit from "@/icons/canvas_edit.svg";
import iconCanvasGrouping from "@/icons/canvas_grouping.svg";
import iconCanvasMove from "@/icons/canvas_move.svg";
import iconCanvasRun from "@/icons/canvas_run.svg";
import iconCanvasSearch from "@/icons/canvas_search.svg";
import iconCanvasVersion from "@/icons/canvas_version.svg";

// ACT: 工作室框架外壳（design doc §4.3，M4）。这是「分步生成」模式的页面骨架：
// 左侧是舞台槽位（当前为占位，M5 把 ComfyUI iframe 落进来）；右侧是常驻的停靠式聊天框，
// 直接复用群聊组件（groupChat），顶部挂就地模式切换器（one-shot ↔ step-by-step）。
// 房间状态是模块级单例，groupChat 内部会自行 bootstrap 并按 ?room= 定位活跃房间。
// 有意不移植 vidsay workspace 的重耦合部分：canvasPanel/documentPanel(ProseMirror)/
// useWorkspaceStore/useRoomSpoke/roomGrants/mcpControl/anonymousData/providerBilling/图形同步。
const auth = useAuthStore();
const router = useRouter();
const { timeline, activeRoomId, teamMembers, sendText, uploadMedia } = useMatrixChat();

// ── 画布桥接（P4-M3，Path B / design doc §3）：舞台改用应用内 Vue Flow 编辑器，取代固定版本的
//    ComfyUI iframe。useVueFlowBridge 实现与旧 iframe 桥完全相同的 CanvasBridge 契约，但底层是
//    一个共享的 Vue Flow store + 纯 graphMapper（VueFlow ⇄ ComfyUI WorkflowGraph），因此 useCanvasScript/
//    useExecStatus/useWorkspaceGraph/useMovieRun/useRoomRole 全部无需改动。图加载、节点状态徽章与
//    多人只读锁语义保持不变；「运行演示生命周期」仍向网关 POST /comfy/api/prompt，由 Leg B 生命周期
//    事件经父页面侧 execStatus socket 回灌，实时给节点上色。──
const canvasReady = ref(false);
// ── Phase-6 D3/D4: the node editor's two ORTHOGONAL states. `editingNodeId` is
//    the LOCK (non-null ⇔ the editor card is open ⇔ the canvas UI is frozen
//    behind the scrim); `editArmed` is the one-shot pick the toolbar Edit Node
//    button arms when nothing is selected. Neither is a tool mode, so closing
//    the editor restores the exact prior `toolMode`/arm state for free. ──
const editingNodeId = ref<number | null>(null);
const editArmed = ref(false);
const runningDemo = ref(false);
const previewReadonly = ref(false);
const paintedCount = ref(0);
const bridge = useVueFlowBridge();

// ── vidsay studioBar 工具态：分组/抓手工具、节点搜索、缩放菜单。缩放与视图直接走共享 Vue Flow store，
//    与 vidsay canvasPanel 暴露的 zoomPercent/applyZoom/zoomIn/zoomOut 同语义。──
// Phase-5 D13/D14: the group-draw and hand (move) tools are ONE-SHOT — each arms
// for a single gesture and disarms when the canvas reports the gesture finished.
const groupArmed = ref(false);
const handArmed = ref(false);
const searchVisible = ref(false);
const searchQuery = ref("");
const zoomMenuVisible = ref(false);
const addNodeVisible = ref(false);
// The searchable palette spans both catalogs: the Phase-5 functional primitives
// and the six deprecated movie steps (D1/D12).
const PALETTE_NODES = [...FUNCTIONAL_NODES, ...MOVIE_NODES];
const filteredNodes = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return PALETTE_NODES;
  return PALETTE_NODES.filter(node => node.displayName.toLowerCase().includes(query) || node.classType.toLowerCase().includes(query));
});
const zoomPercent = computed(() => Math.round(bridge.flow.viewport.value.zoom * 100));
function applyZoom(value: number | undefined) {
  if (value !== undefined && Number.isFinite(value)) void bridge.flow.zoomTo(value / 100);
}
function zoomIn() {
  void bridge.flow.zoomIn();
}
function zoomOut() {
  void bridge.flow.zoomOut();
}

// ── M6：产物检视器 + 图持久化 + 实时状态。
//    execStatus 打开一条父页面侧 Leg B /ws，把 executing/progress/executed/execution_error 折叠成
//    按节点 id 的状态与产物输出。P4-M3：Vue Flow 画布不再有 iframe 内部 socket，故把 execStatus
//    的状态变化直接刷到画布节点徽章（bridge.setNodeStatus）。
//    workflowStore 走 Leg C workflow/get|put：宿主是图的权威（内存、房间级、乐观并发 baseRev）。
//    currentGraph 缓存最近一次加载/导出的图，供节点选中时解析 MOVIE_NODES 架构。──
const execStatus = useExecStatus();
const workflowStore = useWorkflowStore();
const currentGraph = ref<WorkflowGraph | null>(null);

// Paint Leg B lifecycle status onto the Vue Flow node badges (the iframe's own
// socket is gone under Path B, so the parent-side socket now drives the canvas).
watch(execStatus.statusById, (byId) => {
  for (const [id, status] of byId) bridge.setNodeStatus(id, status);
});

// Paint the reviewer verdict line (Phase-5 D5) from each node's executed output.
// Only reviewer-family nodes render it (MovieNode.vue gates on `family`), so the
// verdict is resolved against the live graph and passed through as view-only data.
watch(execStatus.outputById, (byId) => {
  const graph = currentGraph.value;
  for (const [id, output] of byId) bridge.setNodeVerdict(id, reviewerVerdict(graph, id, output));
});

/**
 * Extract a reviewer node's verdict string from its executed output (D5).
 * A reviewer's artifact IS the verdict (`PASS …` / `FAIL …`); non-reviewer nodes
 * and unresolved ids yield `undefined` so no verdict line is painted.
 */
function reviewerVerdict(graph: WorkflowGraph | null, id: number, output: unknown): string | undefined {
  if (graph === null) return undefined;
  // `schemaFor` spans both catalogs, so functional reviewers resolve too (the
  // legacy `nodeSchemaForId` knows only the six deprecated movie steps).
  const classType = graph.nodes.find((node) => node.id === id)?.type ?? "";
  if (schemaFor(classType)?.family !== "reviewer") return undefined;
  const artifact = (output as { artifact?: unknown } | undefined)?.artifact;
  return typeof artifact === "string" && artifact !== "" ? artifact : undefined;
}

// ── P3-M5：主机独占协作（design doc §4）。roomRole 解析 auth/role 并订阅唯一的
//    workflow/watch mux（实时收敛 + 角色变更）；workspace 承载主机草稿自动保存
//    （workspace/draft.put，防抖）、撤销/重做、提交、历史与回滚，并对非主机观众强制
//    只读（bridge.setReadonly(!isHost)）。程序化加载在 suppress 守卫内进行，避免回灌
//    触发主机自动保存。workflowStore 仅保留给 AI 编排执行器的原子提交（host-only）。──
const roomIdRef = computed(() => activeRoomId.value ?? "");
const roomRole = useRoomRole(roomIdRef);
// ACT: 跨路由技能导入暂存（Phase-7 D7 mode-1）：编辑器 Import 跳转 /plugins pick-mode，
// 返回后由此消费已下载的正文与引用。
const importStore = useImportStore();
// ACT: 跨路由模型选择暂存（Phase-1 模型选择器）：编辑器顶部选择器跳转 /plugins
// 模型 pick-mode，返回后由此消费选中的模型 id 写入节点的 `model` widget。
const modelPickStore = useModelPickStore();
// ACT: 会话内模型 id → 展示名映射（pick 返回时填充）；选择器标签优先用展示名，
// 未知名回落到原始 id。widget 只持久化 id，故刷新后仅显示 id（可接受）。
const modelDisplayNames = ref<Record<string, string>>({});
const workspace = useWorkspaceGraph(roomIdRef, bridge, roomRole);

// ── Phase 8 P8-M3: real GPU-generated media. The executor posts the output bytes
//    into the room and attaches `contentRef {origin:'generated'}` to the executed
//    payload. (a) Host-only: persist the provenance onto the canvas node via
//    setNodeMeta (rides the normal draft/commit path). (b) Everyone: resolve an
//    `mxc://` artifact to an authenticated blob URL so the editor's <img>/<video>
//    can render it (Synapse media download requires the Bearer token).
const generatedMediaById = ref<Map<number, string>>(new Map());
const appliedGeneratedRefs = new Set<string>();
watch(execStatus.outputById, (byId) => {
  for (const [id, output] of byId) {
    if (typeof output !== "object" || output === null) continue;
    const refRaw = (output as Record<string, unknown>).contentRef;
    if (typeof refRaw !== "object" || refRaw === null) continue;
    const contentRef = refRaw as ContentRef;
    if (contentRef.origin !== "generated" || typeof contentRef.uri !== "string" || contentRef.uri === "") continue;
    const key = `${id}:${contentRef.uri}`;
    if (roomRole.isHost.value && !appliedGeneratedRefs.has(key)) {
      appliedGeneratedRefs.add(key);
      bridge.setNodeMeta(id, { contentRef });
    }
    if (contentRef.uri.startsWith("mxc://") && !generatedMediaById.value.has(id)) {
      void fetchMediaBlobUrl(contentRef.uri, auth.accessToken)
        .then((blobUrl) => {
          if (!blobUrl) return;
          const next = new Map(generatedMediaById.value);
          next.set(id, blobUrl);
          generatedMediaById.value = next;
        })
        .catch(() => {
          // Media fetch failure degrades to the text/glyph view (R8).
        });
    }
  }
});

async function applyGraph(graph: WorkflowGraph): Promise<void> {
  currentGraph.value = graph;
  await workspace.applyGraph(graph);
}

/** An empty graph for a fresh room (Phase-5 D11: nothing is seeded). */
function emptyWorkflow(): WorkflowGraph {
  return {
    last_node_id: 0,
    last_link_id: 0,
    nodes: [],
    links: [],
    groups: [],
    config: {},
    extra: { ds: { scale: 1, offset: [0, 0] } },
    version: 0.4,
  };
}

/** Load the room's graph (host draft / committed HEAD) into the canvas. */
async function hydrate(roomId: string): Promise<void> {
  workspace.reset();
  execStatus.reset();
  if (!roomId) {
    await applyGraph(emptyWorkflow());
    return;
  }
  // Ensure the role is fresh before choosing draft (host) vs HEAD (viewer).
  await roomRole.refresh();
  const graph = await workspace.hydrate();
  // Phase-5 D11: a fresh room opens on an EMPTY canvas — no demo seed, no host
  // revision 1. The empty-canvas overlay points the user at the Add-node cascade.
  // Existing rooms keep their persisted graph unchanged.
  const loaded = graph ?? emptyWorkflow();
  await applyGraph(loaded);
  // Phase-5 M5: announce (never block) a persisted graph that still references
  // the six deprecated step class types (D1 — executable for one more phase).
  notifyDeprecatedSteps(roomId, loaded);
  // Phase-7 D7 mode-1: on return from the Plugins pick-mode, paste the downloaded
  // skill body into its node + record the additive ref (no-op when none pending).
  consumeReturnedImport();
  // Phase-1 model selector: on return from the Plugins Models pick-mode, write the
  // chosen model id into its node's `model` widget (no-op when none pending).
  consumeReturnedModelPick();
}

/** The deprecated step class types still present in a persisted graph (Phase-5 M5). */
function deprecatedStepsIn(graph: WorkflowGraph): string[] {
  const found = new Set<string>();
  for (const node of graph.nodes) {
    if (findMovieNode(node.type)?.deprecated === true) found.add(node.type);
  }
  return [...found];
}

// Rooms already notified this session, so a load-time notice fires once per room
// (repeated hydrate/room-switch calls do not re-spam the same warning).
const deprecatedNotifiedRooms = ref<Set<string>>(new Set());

/**
 * Show the Phase-5 M5 load-time notice when a persisted graph still uses the
 * deprecated step nodes. They remain executable this phase, so the notice is
 * advisory only — the graph is loaded unchanged (no silent rewrite, D1/R1).
 */
function notifyDeprecatedSteps(roomId: string, graph: WorkflowGraph): void {
  if (roomId === "" || deprecatedNotifiedRooms.value.has(roomId)) return;
  const steps = deprecatedStepsIn(graph);
  if (steps.length === 0) return;
  deprecatedNotifiedRooms.value = new Set(deprecatedNotifiedRooms.value).add(roomId);
  const names = steps.map((type) => findMovieNode(type)?.displayName ?? type).join("、");
  ElMessage.warning({
    message: `${translate("该房间画布仍在使用已弃用的步骤节点")}（${names}）：${translate("本阶段仍可执行，建议改用功能节点或模板重建")}。`,
    duration: 6000,
  });
}

bridge.onReady(() => {
  canvasReady.value = true;
  void hydrate(activeRoomId.value);
});
bridge.onNodeSelected((id) => {
  // A pane click (id === null) drops a pending one-shot Edit Node pick (D3).
  if (id === null) {
    editArmed.value = false;
    return;
  }
  // Only a pure cursor-mode click may select or complete a pick. In every other
  // state — connect (add edge), delete, group draw, hand pan, or the add-node
  // cascade — a node click is a tool action, never a selection.
  if (toolMode.value !== "cursor" || handArmed.value || groupArmed.value || addNodeVisible.value) return;
  // Phase-6 D2: a single click no longer opens any panel. Selection stays (Vue
  // Flow paints it) purely to feed the Edit Node button's state; the editor
  // opens only by double-click or the armed pick.
  if (editingNodeId.value !== null) return;
  if (editArmed.value) {
    editArmed.value = false;
    openEditor(id);
  }
});
bridge.onExecPainted(() => { paintedCount.value += 1; });
bridge.onGraphChanged(({ graph }) => {
  currentGraph.value = graph;
  // Host-only debounced draft autosave; viewers are read-only (no-op inside).
  workspace.autosave(graph);
});
bridge.onBridgeError(({ message }) => {
  ElMessage.error(`${translate("画布桥接错误")}: ${message}`);
});

watch(activeRoomId, (roomId) => {
  if (canvasReady.value) void hydrate(roomId);
});

// ── P3-M3：AI 编排画布。自然语言意图经 Leg C `canvas/script` POST 提交给宿主真实 LLM，
//    生成的 op-script 通过 mux 流（按 txnId 关联）回灌，由确定性执行器完成
//    快照→逐条应用→后置校验→（瞬时错误退避重试 / 硬失败回滚快照）→成功单次保存→回报。
//    P3-M5：canvas/script 现为主机独占；应用期间复用 workspace 的 suppress 守卫抑制自动保存，
//    保证执行器的单次显式保存（workflow/put = 主机提交）为权威写入。──
const canvasScript = useCanvasScript({
  bridge,
  workflowStore,
  onApplyStart: () => { workspace.beginSuppress(); },
  onApplyEnd: () => { workspace.endSuppress(); },
});
const aiIntent = ref("");
const aiRunning = computed(() => canvasScript.busy.value);

function stageLabel(stage: CanvasScriptStage): string {
  switch (stage) {
    case "submitting": return translate("提交中");
    case "generating": return translate("AI 生成中");
    case "applying": return translate("应用操作中");
    case "saving": return translate("保存中");
    case "reporting": return translate("回报结果中");
    case "done": return translate("已完成");
    case "error": return translate("出错");
    default: return "";
  }
}

async function submitAiIntent() {
  const intent = aiIntent.value.trim();
  if (intent === "" || !canvasReady.value || aiRunning.value) return;
  const roomId = activeRoomId.value;
  if (!roomId) {
    ElMessage.warning(translate("请先进入一个房间再使用 AI 编排"));
    return;
  }
  const result = await canvasScript.runIntent(roomId, intent);
  if (result === null) {
    ElMessage.error(`${translate("AI 编排失败")}: ${canvasScript.error.value ?? ""}`);
    return;
  }
  const okCount = result.opResults.filter((entry) => entry.ok).length;
  if (result.committed) {
    ElMessage.success(`${translate("AI 编排已应用")} (${okCount}/${result.opResults.length})`);
    aiIntent.value = "";
  } else {
    ElMessage.warning(`${translate("AI 编排已回滚，存在无法应用的操作")} (${okCount}/${result.opResults.length})`);
  }
}

// ── P3-M4：影片流水线。自然语言意图经 Leg C `movie/run` POST 提交给宿主导演代理，
//    六步流水线（剧本→分镜→资产→故事板→片段→合成）的进度通过 mux 流（按 runId 关联）
//    逐步回灌：文本步产出真实 Bailian 文本，媒体步产出罐头占位（media:true）。每个 step
//    映射回画布节点徽章（复用 Leg B 的 node.setStatus 上色语义），文本产物在检视器展示。──
function movieStatusToNode(status: MovieStepStatus): NodeRunStatus {
  switch (status) {
    case "running": return "running";
    case "success": return "success";
    case "error": return "error";
    case "skipped": return "idle";
    default: return "idle";
  }
}

/** Paint one streamed movie step onto its matching canvas node badge. */
function paintMovieStep(step: MovieStepResult): void {
  const graph = currentGraph.value;
  if (!graph) return;
  const node = graph.nodes.find((candidate) => candidate.type === step.classType);
  if (node) bridge.setNodeStatus(node.id, movieStatusToNode(step.status));
}

const movieRun = useMovieRun({ onStep: paintMovieStep });
const movieIntent = ref("");
const movieRunning = computed(() => movieRun.busy.value);
const movieDoneCount = computed(
  () => movieRun.steps.value.filter((step) => step.status === "success" || step.status === "error" || step.status === "skipped").length,
);

function movieStageLabel(stage: string): string {
  switch (stage) {
    case "submitting": return translate("提交中");
    case "running": return translate("流水线执行中");
    case "done": return translate("已完成");
    case "error": return translate("出错");
    default: return "";
  }
}

function movieStepName(classType: MovieStepId): string {
  return findMovieNode(classType)?.displayName ?? classType;
}

function movieStepStatusLabel(status: MovieStepStatus): string {
  switch (status) {
    case "pending": return translate("等待中");
    case "running": return translate("执行中");
    case "success": return translate("已完成");
    case "error": return translate("出错");
    case "skipped": return translate("已跳过");
    default: return "";
  }
}

/** The movie artifact for the currently selected node's classType (inspector). */
const selectedMovieStep = computed<MovieStepResult | undefined>(() => {
  const classType = selectedSchema.value?.classType;
  if (classType === undefined) return undefined;
  return movieRun.steps.value.find((step) => step.classType === classType);
});

async function submitMovieIntent() {
  const intent = movieIntent.value.trim();
  if (intent === "" || !canvasReady.value || movieRunning.value) return;
  const roomId = activeRoomId.value;
  if (!roomId) {
    ElMessage.warning(translate("请先进入一个房间再运行影片"));
    return;
  }
  const result = await movieRun.runIntent(roomId, intent);
  if (result === null) {
    ElMessage.error(`${translate("影片流水线失败")}: ${movieRun.error.value ?? ""}`);
    return;
  }
  const okCount = result.steps.filter((step) => step.status === "success").length;
  ElMessage.success(`${translate("影片流水线已完成")} (${okCount}/${result.steps.length})`);
  movieIntent.value = "";
}

// ── 编辑器卡派生状态（Phase-6 D2：原产物检视器）：把被编辑节点 id 解析成架构 + 实时状态 + 产物输出。──
/** The `class_type` of the node being edited, read from the live store. */
const editorClassType = computed(() => {
  const id = editingNodeId.value;
  if (id === null) return "";
  const data = bridge.flow.findNode(String(id))?.data as MovieNodeData | undefined;
  return data?.classType ?? "";
});

/** The edited node's schema. `schemaFor` spans BOTH catalogs, so functional
 *  nodes resolve too (the legacy `nodeSchemaForId` knows only the six steps). */
const selectedSchema = computed(() => schemaFor(editorClassType.value));

/** D11 row 1: the same identity skin the card renders (icon + family hue). */
const editorSkin = computed(() => nodeSkin(editorClassType.value));
const editorTypeLabel = computed(() => translate(selectedSchema.value?.displayName ?? editorClassType.value));
const selectedStatus = computed<NodeRunStatus>(() =>
  editingNodeId.value === null ? "idle" : execStatus.statusOf(editingNodeId.value),
);
const outputSummary = computed(() => {
  const id = editingNodeId.value;
  if (id === null) return "";
  const output = execStatus.outputOf(id);
  if (output === undefined) return "";
  if (typeof output === "object" && output !== null && (output as Record<string, unknown>).fixture === true) {
    return translate("原型占位产物：真实推理将在 Phase 3 由离主机代理生成");
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
});

/**
 * The selected node's last executed output, parsed for the modality renderers
 * (Phase-5 M4: text / image / video / audio player). A real media artifact is a
 * URL (e.g. a Bailian `video_url`), so `isUrl` gates the `<img>/<video>/<audio>`
 * elements; a canned placeholder falls back to the text view.
 */
const selectedOutput = computed<{ modality: string; artifact: string; media: string; isUrl: boolean } | undefined>(() => {
  const id = editingNodeId.value;
  if (id === null) return undefined;
  const raw = execStatus.outputOf(id);
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const rawArtifact = typeof record.artifact === "string" ? record.artifact : "";
  // P8-M3: a generated `mxc://` artifact renders via its resolved blob URL.
  const resolved = generatedMediaById.value.get(id);
  const artifact = rawArtifact.startsWith("mxc://") && resolved !== undefined ? resolved : rawArtifact;
  const modality = typeof record.modality === "string"
    ? record.modality
    : (selectedSchema.value?.modality ?? "");
  const media = typeof record.media === "string" ? record.media : "";
  return { modality, artifact, media, isUrl: /^(https?:|data:|blob:)/i.test(artifact) };
});

/** True when the editor should render a media element instead of raw text. */
const outputMediaKind = computed<"image" | "video" | "audio" | "">(() => {
  const output = selectedOutput.value;
  if (output === undefined || !output.isUrl) return "";
  if (output.modality === "image" || output.modality === "video" || output.modality === "audio") return output.modality;
  return "";
});

function statusTagType(status: NodeRunStatus): "success" | "danger" | "warning" | "info" {
  if (status === "success") return "success";
  if (status === "error") return "danger";
  if (status === "running" || status === "progress") return "warning";
  return "info";
}
function statusLabel(status: NodeRunStatus): string {
  switch (status) {
    case "queued": return translate("排队中");
    case "running": return translate("执行中");
    case "progress": return translate("生成中");
    case "success": return translate("已完成");
    case "error": return translate("出错");
    default: return translate("空闲");
  }
}

// ── Phase-6 D2/D3/D4/D6: the docked editor card. Entry is a double-click (the
//    canvas gates it to the pure cursor state) or the toolbar Edit Node button;
//    the lock is `editingNodeId`; edits live in a PRIVATE draft and reach
//    canonical node data only on Save, so one Save = one undo entry = one sync
//    broadcast (the bridge coalesces the writes into a single `graphChanged`). ──

/** Flow ids of the selected nodes (the Edit Node button's D3 state input). */
const selectedIds = computed<number[]>(() =>
  bridge.flow.getNodes.value
    .filter((node) => node.selected === true)
    .map((node) => Number(node.id))
    .filter((id) => Number.isFinite(id)),
);

/** Guests get a read-only editor (D7): only the host publishes. */
const editorReadonly = computed(() => !roomRole.isHost.value);

/** One editor draft buffer (D6) plus the canonical snapshot it was loaded from,
 *  so the dirty check needs no deep watching of live node data. */
interface EditorDraft {
  title: string;
  description: string;
  widgets: NodeWidgetView[];
  contentRef?: ContentRef;
  /** Phase-7 D7: additive imported-skill refs, persisted under node properties. */
  importedSkills?: ImportedSkillRef[];
}
const editorDraft = ref<EditorDraft | null>(null);
const editorBase = ref<EditorDraft | null>(null);
const discardVisible = ref(false);
const nameError = ref(false);

/** The Edit Node button's D3 state: disabled whenever another tool or one-shot
 *  arm owns node clicks, or more than one node is selected. */
const editDisabled = computed(
  () =>
    !canvasReady.value ||
    editingNodeId.value !== null ||
    toolMode.value !== "cursor" ||
    handArmed.value ||
    groupArmed.value ||
    addNodeVisible.value ||
    (!editArmed.value && selectedIds.value.length > 1),
);

/** Save is blocked while the node is in flight (D8): edits apply to the next run. */
const saveDisabled = computed(
  () =>
    editorReadonly.value ||
    workspace.busy.value ||
    selectedStatus.value === "queued" ||
    selectedStatus.value === "running" ||
    selectedStatus.value === "progress",
);

const editorDirty = computed(() => {
  const draft = editorDraft.value;
  const base = editorBase.value;
  if (draft === null || base === null) return false;
  if (draft.title !== base.title || draft.description !== base.description) return true;
  if ((draft.importedSkills?.length ?? 0) !== (base.importedSkills?.length ?? 0)) return true;
  return draft.widgets.some((widget, index) => widget.value !== base.widgets[index]?.value);
});

/** The header status chip renders ONLY when non-idle (D13). */
const editorStatusChip = computed(() => (selectedStatus.value === "idle" ? "" : statusLabel(selectedStatus.value)));

function cloneDraft(source: EditorDraft): EditorDraft {
  return {
    title: source.title,
    description: source.description,
    widgets: source.widgets.map((widget): NodeWidgetView => ({ ...widget })),
    ...(source.contentRef !== undefined ? { contentRef: { ...source.contentRef } } : {}),
    ...(source.importedSkills !== undefined ? { importedSkills: source.importedSkills.map((skill) => ({ ...skill })) } : {}),
  };
}

/** Open the editor for a node: snapshot the canonical data into a fresh draft. */
function openEditor(id: number): void {
  const data = bridge.flow.findNode(String(id))?.data as MovieNodeData | undefined;
  if (data === undefined) return;
  // One editor instance (D8): nothing else may stack over it, so every overlay
  // and one-shot arm closes first. `toolMode` itself is left untouched (D4).
  addNodeVisible.value = false;
  searchVisible.value = false;
  versionMenuVisible.value = false;
  zoomMenuVisible.value = false;
  historyOpen.value = false;
  groupPopover.value = null;
  handArmed.value = false;
  groupArmed.value = false;
  editArmed.value = false;
  const base: EditorDraft = {
    title: data.title ?? "",
    description: data.description ?? "",
    widgets: (data.widgets ?? []).map((widget): NodeWidgetView => ({ ...widget })),
    ...(data.contentRef !== undefined ? { contentRef: { ...data.contentRef } } : {}),
    ...(data.importedSkills !== undefined ? { importedSkills: data.importedSkills.map((skill) => ({ ...skill })) } : {}),
  };
  editorBase.value = base;
  editorDraft.value = cloneDraft(base);
  nameError.value = false;
  editingNodeId.value = id;
}

function resetEditor(): void {
  editingNodeId.value = null;
  editorDraft.value = null;
  editorBase.value = null;
  nameError.value = false;
}

/** Close (button / Esc): a dirty draft raises the discard confirm (D6). */
function closeEditor(): void {
  if (editorDirty.value) {
    discardVisible.value = true;
    return;
  }
  resetEditor();
}

function discardDraft(): void {
  discardVisible.value = false;
  resetEditor();
}

/** Save/Publish = one canonical mutation (D6): name + description + changed widgets. */
function saveEditor(): void {
  const id = editingNodeId.value;
  const draft = editorDraft.value;
  const base = editorBase.value;
  if (id === null || draft === null || base === null) return;
  // D7 single writer by construction: a guest never publishes, even if the
  // disabled Save button were somehow bypassed (the autosave is a viewer no-op,
  // so guarding here also avoids a local-only desync of canonical node data).
  if (editorReadonly.value) return;
  // D11: the name cannot be empty — block Save with an inline hint.
  if (draft.title.trim() === "") {
    nameError.value = true;
    return;
  }
  nameError.value = false;
  bridge.setNodeMeta(id, {
    title: draft.title.trim(),
    description: draft.description,
    ...(draft.contentRef !== undefined ? { contentRef: draft.contentRef } : {}),
    ...(draft.importedSkills !== undefined ? { importedSkills: draft.importedSkills } : {}),
  });
  draft.widgets.forEach((widget, index) => {
    if (widget.value !== base.widgets[index]?.value) {
      bridge.sendCommand("node.setWidget", { id, key: widget.name, value: widget.value });
    }
  });
  // Rebase so the editor stays open with a clean dirty state.
  editorBase.value = cloneDraft({ title: draft.title.trim(), description: draft.description, widgets: draft.widgets, contentRef: draft.contentRef, importedSkills: draft.importedSkills });
}

/** Widget values are `unknown`; the draft controls need concrete types. */
function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function asBool(value: unknown): boolean {
  return value === true;
}
function setDraftWidget(index: number, value: unknown): void {
  const widget = editorDraft.value?.widgets[index];
  if (widget !== undefined) widget.value = value;
}

/** Draft setters for the name/description rows (D11 rows 2–3). */
function setDraftTitle(value: string): void {
  if (editorDraft.value !== null) editorDraft.value.title = value;
}
function setDraftDescription(value: string): void {
  if (editorDraft.value !== null) editorDraft.value.description = value;
}

// ── Phase-7 D7 mode-1: the editor Import flow. A node whose schema declares
//    `supportsSkillImport` (Text Input, the four generators, the legacy six) gets
//    an Import button that stashes the pick context, routes to the Plugins page in
//    pick-mode, and — on return — pastes the downloaded SKILL.md body into the
//    node's primary text widget and records the additive `importedSkills` ref. ──

/** True when the edited node's schema opts into skill imports (D7/D11). */
const editorCanImport = computed(() => selectedSchema.value?.supportsSkillImport === true);

/** The primary text widget to paste a skill body into ("" when the node has none). */
const editorImportWidget = computed<string>(() => {
  const widgets = editorDraft.value?.widgets ?? [];
  const multiline = widgets.find((widget) => widget.type === "STRING" && widget.multiline === true);
  if (multiline !== undefined) return multiline.name;
  const single = widgets.find((widget) => widget.type === "STRING");
  return single?.name ?? "";
});

/** Map a node's class type to the skill target used to pre-rank the Skills view (D10). */
function importTargetFor(classType: string): SkillTarget {
  if (classType === "MovieShotPlan") return "shot-plan";
  if (classType === "MovieScript" || classType === "TextGenerator") return "script";
  if (classType === "TextInput") return "text";
  return "any";
}

/** Import button: stash the pick context (intent-prefilled) and route to /plugins. */
function startImport(): void {
  const id = editingNodeId.value;
  const draft = editorDraft.value;
  if (editorReadonly.value || id === null || draft === null) return;
  const roomId = roomIdRef.value;
  if (roomId === "") {
    ElMessage.warning(translate("请先进入一个房间再导入技能"));
    return;
  }
  // Persist in-flight edits so the return re-opens from the saved canonical data.
  if (editorDirty.value) saveEditor();
  const widgetName = editorImportWidget.value;
  const seed = widgetName === ""
    ? ""
    : asString(draft.widgets.find((widget) => widget.name === widgetName)?.value ?? "").trim();
  importStore.begin({
    roomId,
    nodeId: String(id),
    widgetName,
    insertionPoint: -1,
    query: seed.slice(0, 60),
    target: importTargetFor(editorClassType.value),
  });
  void router.push({ path: "/plugins", query: { category: "skills", mode: "pick" } });
}

/** Remove one imported-skill ref from the draft (the pasted snapshot stays). */
function removeImportedSkill(index: number): void {
  const draft = editorDraft.value;
  if (editorReadonly.value || draft === null) return;
  const next = [...(draft.importedSkills ?? [])];
  next.splice(index, 1);
  draft.importedSkills = next;
}

/**
 * Splice a downloaded skill body into the open draft's target widget and append
 * its additive `importedSkills` ref. This is the ONE paste path, used by the
 * cross-route pick-mode return ({@link consumeReturnedImport}).
 * Mutates the DRAFT only: Save stays the single canonical mutation (D6).
 * @param body - the sanitized SKILL.md body to paste.
 * @param skillRef - the version-pinned ref recorded under `properties.importedSkills`.
 * @param widgetName - the target text widget ("" skips the paste, still records the ref).
 * @param insertionPoint - character offset to splice at; `-1` appends to the end.
 * @returns `true` when a draft was open and the ref was recorded.
 */
function applySkillToDraft(
  body: string,
  skillRef: ImportedSkillRef,
  widgetName: string,
  insertionPoint: number,
): boolean {
  const draft = editorDraft.value;
  if (draft === null) return false;
  if (widgetName !== "") {
    const widget = draft.widgets.find((candidate) => candidate.name === widgetName);
    if (widget !== undefined) {
      const current = asString(widget.value);
      const point = insertionPoint < 0 ? current.length : Math.min(insertionPoint, current.length);
      widget.value = `${current.slice(0, point)}${body}${current.slice(point)}`;
    }
  }
  draft.importedSkills = [...(draft.importedSkills ?? []), skillRef];
  return true;
}

/**
 * Consume a completed pick-mode download exactly once (called after hydrate so the
 * target node exists): re-open its editor, splice the body into the target widget
 * and append the additive ref — as a DIRTY DRAFT, not an auto-commit. Save stays
 * the single canonical mutation (D6): the user reviews the pasted skill and clicks
 * Save to publish (Cancel offers the discard confirm). Auto-saving here rebased
 * the draft clean and left Save disabled, which read as a dead button. Guest
 * returns and vanished nodes are silent no-ops (D7).
 */
function consumeReturnedImport(): void {
  if (importStore.completed === null) return;
  const taken = importStore.takeCompleted();
  if (taken === null) return;
  if (editorReadonly.value) return;
  const nodeId = Number(taken.nodeId);
  if (!Number.isFinite(nodeId) || bridge.flow.findNode(taken.nodeId) === undefined) return;
  openEditor(nodeId);
  if (!applySkillToDraft(taken.body, taken.ref, taken.widgetName, taken.insertionPoint)) return;
  ElMessage.success(translate("技能已导入编辑器，点击保存生效"));
}

// ── Phase-1 model selector. A node whose schema declares a `model` widget (the
//    Text Generator) renders a selector row at the TOP of the editor card. It
//    behaves like the skill Import button: clicking it stashes the pick context,
//    routes to the Plugins page Models view in pick-mode, and — on return — writes
//    the chosen model id into the node's `model` widget as a DIRTY DRAFT (Save
//    stays the single canonical mutation, D6). Empty = the executor's default. ──

/** The draft index of the `model` widget, or -1 when the node has none. */
const editorModelIndex = computed<number>(() =>
  (editorDraft.value?.widgets ?? []).findIndex((widget) => widget.name === "model"),
);

/** True when the edited node exposes a model selector (schema declares `model`). */
const editorHasModel = computed(() => editorModelIndex.value >= 0);

/** The currently selected model id ("" = default). */
const editorModelValue = computed<string>(() => {
  const index = editorModelIndex.value;
  if (index < 0) return "";
  return asString(editorDraft.value?.widgets[index]?.value ?? "");
});

/** The selector label: the picked display name when known, else the raw id, else a
 *  "default model" placeholder. */
const editorModelLabel = computed<string>(() => {
  const id = editorModelValue.value;
  if (id === "") return translate("默认模型");
  return modelDisplayNames.value[id] ?? id;
});

/**
 * The generic Row-4b parameter widgets, EXCLUDING the `model` widget (rendered
 * separately as the top selector). Each entry keeps its ORIGINAL draft index so
 * {@link setDraftWidget} still writes to the correct slot.
 */
const editorParamWidgets = computed<Array<{ widget: NodeWidgetView; index: number }>>(() =>
  (editorDraft.value?.widgets ?? [])
    .map((widget, index) => ({ widget, index }))
    .filter((entry) => entry.widget.name !== "model"),
);

/** Model selector: stash the pick context and route to /plugins Models pick-mode. */
function startModelPick(): void {
  const id = editingNodeId.value;
  if (editorReadonly.value || id === null || !editorHasModel.value) return;
  const roomId = roomIdRef.value;
  if (roomId === "") {
    ElMessage.warning(translate("请先进入一个房间再选择模型"));
    return;
  }
  // Persist in-flight edits so the return re-opens from the saved canonical data.
  if (editorDirty.value) saveEditor();
  modelPickStore.begin({ roomId, nodeId: String(id), classType: editorClassType.value });
  void router.push({ path: "/plugins", query: { category: "models", mode: "pick" } });
}

/** Revert the selector to the executor default (close the model chip). */
function clearModelPick(): void {
  const index = editorModelIndex.value;
  if (editorReadonly.value || index < 0) return;
  setDraftWidget(index, "");
}

/**
 * Consume a completed model pick exactly once (called after hydrate so the target
 * node exists): re-open its editor and write the chosen model id into the `model`
 * widget as a DIRTY DRAFT. Save stays the single canonical mutation (D6). Guest
 * returns and vanished nodes are silent no-ops (D7).
 */
function consumeReturnedModelPick(): void {
  if (modelPickStore.completed === null) return;
  const taken = modelPickStore.takeCompleted();
  if (taken === null) return;
  if (editorReadonly.value) return;
  const nodeId = Number(taken.nodeId);
  if (!Number.isFinite(nodeId) || bridge.flow.findNode(taken.nodeId) === undefined) return;
  if (taken.modelId !== "" && taken.modelName !== "") {
    modelDisplayNames.value = { ...modelDisplayNames.value, [taken.modelId]: taken.modelName };
  }
  openEditor(nodeId);
  const index = editorModelIndex.value;
  if (index < 0) return;
  setDraftWidget(index, taken.modelId);
  ElMessage.success(translate("模型已选择，点击保存生效"));
}

/** Double-click entry (D3): the canvas already gated this to the cursor state. */
function onNodeDblClick(id: number): void {
  if (editingNodeId.value !== null) return;
  openEditor(id);
}

/** Edit Node button (D3): one selection → open now; none → arm the pick; armed → cancel. */
function armEdit(): void {
  if (editDisabled.value) return;
  if (editArmed.value) {
    editArmed.value = false;
    return;
  }
  if (selectedIds.value.length === 1) {
    const id = selectedIds.value[0];
    if (id !== undefined) openEditor(id);
    return;
  }
  editArmed.value = true;
}

// D8: the node being edited can vanish (a remote delete or a graph reload); the
// local lock cannot stop remote ops, so watch existence and auto-close.
watch(
  () => (editingNodeId.value === null ? undefined : bridge.flow.findNode(String(editingNodeId.value))),
  (node) => {
    if (editingNodeId.value === null || node !== undefined) return;
    resetEditor();
    discardVisible.value = false;
    ElMessage.info(translate("正在编辑的节点已被移除"));
  },
);

// Esc releases the lock (or cancels the armed pick). The scrim absorbs pointer
// input but not the keyboard, so this is the lock's keyboard escape hatch.
function onEditorKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || discardVisible.value) return;
  if (editingNodeId.value !== null) {
    closeEditor();
    return;
  }
  editArmed.value = false;
}
window.addEventListener("keydown", onEditorKeydown);
onUnmounted(() => window.removeEventListener("keydown", onEditorKeydown));

/**
 * Run the CURRENT canvas graph over Leg B (Phase-5 P5-M3 acceptance: drop, wire,
 * run, badges paint). The live {@link WorkflowGraph} is flattened to a
 * {@link PromptGraph} (`workflowToPrompt`) and POSTed to `/comfy/api/prompt` with
 * the active `room_id`, so the gateway can echo executed artifacts (D8) and post
 * the D15 "no such model" notice into the room for an unbacked generator. The
 * shared Leg B `/ws` lifecycle frames paint the node badges via `execStatus`.
 */
async function runCurrentGraph() {
  if (editingNodeId.value !== null) return;
  if (runningDemo.value) return;
  const graph = currentGraph.value;
  if (graph === null || graph.nodes.length === 0) {
    ElMessage.warning(translate("画布为空，请先添加节点"));
    return;
  }
  runningDemo.value = true;
  paintedCount.value = 0;
  execStatus.reset();
  try {
    const body: Record<string, unknown> = { prompt: workflowToPrompt(graph) };
    const roomId = activeRoomId.value;
    if (roomId) body["room_id"] = roomId;
    const resp = await fetch("/comfy/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    ElMessage.success(translate("已提交工作流，观察节点状态徽章"));
  } catch {
    ElMessage.error(translate("工作流提交失败"));
  } finally {
    runningDemo.value = false;
  }
}

async function runDemoLifecycle() {
  if (runningDemo.value) return;
  runningDemo.value = true;
  paintedCount.value = 0;
  execStatus.reset();
  try {
    const resp = await fetch("/comfy/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: buildDemoPrompt() }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    ElMessage.success(translate("已提交演示工作流，观察节点状态徽章"));
  } catch {
    ElMessage.error(translate("演示生命周期提交失败"));
  } finally {
    runningDemo.value = false;
  }
}

function reloadDemo() {
  void applyGraph(buildDemoWorkflow());
}

/** Nominal MovieNode footprint used to center a fresh drop: the card width is
 *  fixed at 220px in MovieNode.vue; the Phase-6 three-row card (title bar +
 *  name + 48px stub) settles around 120px, verdict line aside. */
const NODE_W = 220;
const NODE_H_EST = 120;

/** Flow-space point at the center of the *visible* pane (the part of the canvas
 *  shown in the main panel), not the whole graph: map the viewport element's
 *  client-rect center through the current pan/zoom transform. */
function viewportCenter(): { x: number; y: number } {
  const el = bridge.flow.viewportRef.value;
  if (el) {
    const rect = el.getBoundingClientRect();
    return bridge.flow.screenToFlowCoordinate({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }
  return { x: 0, y: 0 };
}

/** Drop position for a new node/template: the visible-viewport center, centered
 *  on the node footprint. If an existing node already occupies that center, drop
 *  exactly on top of the most recent such node so the new one stacks in front at
 *  the center instead of scattering to empty space. */
function nextDropPos(): [number, number] {
  const c = viewportCenter();
  let occupied: { x: number; y: number } | undefined;
  for (const n of bridge.flow.getNodes.value) {
    const w = n.dimensions?.width ?? 0;
    const h = n.dimensions?.height ?? 0;
    if (c.x >= n.position.x && c.x <= n.position.x + w && c.y >= n.position.y && c.y <= n.position.y + h) {
      occupied = { x: n.position.x, y: n.position.y };
    }
  }
  if (occupied) return [occupied.x, occupied.y];
  return [c.x - NODE_W / 2, c.y - NODE_H_EST / 2];
}

/**
 * Add a node to the canvas from the palette (host-only). Routes through the
 * bridge's `node.add` command so the change is applied to the shared Vue Flow
 * store, coalesced into a `graphChanged`, and host-autosaved like any other
 * manual edit. Works for both functional primitives and legacy movie steps.
 */
function addMovieNode(classType: string) {
  if (!canvasReady.value || !roomRole.isHost.value) return;
  void bridge.request("node.add", { nodeType: classType, pos: nextDropPos() }).catch(() => {
    ElMessage.error(translate("添加节点失败"));
  });
}

/**
 * Handle a cascade leaf pick (D12): a class type drops one node; a template id
 * expands the pre-wired functional subgraph at the drop point (D6). The server
 * never sees templates — expansion rides the same bridge `node.add`/`edge.add`
 * commands as a manual edit.
 */
async function onCascadeSelect(selection: CascadeSelection) {
  if (!canvasReady.value || !roomRole.isHost.value) return;
  if (selection.classType !== undefined) {
    addMovieNode(selection.classType);
    return;
  }
  if (selection.templateId === undefined) return;
  const template = templateById(selection.templateId);
  if (template === undefined) return;
  try {
    const result = await expandTemplate(bridge, template, nextDropPos());
    ElMessage.success(`${translate("已展开模板")} ${template.displayName}（${result.nodeIds.length} ${translate("节点")}）`);
  } catch {
    ElMessage.error(translate("展开模板失败"));
  }
}

/** Pick from the cascade popover: close it, then drop/expand. */
function onCascadePicked(selection: CascadeSelection) {
  addNodeVisible.value = false;
  void onCascadeSelect(selection);
}

// ── Phase-5 D13: group boxes. The 分组节点 tool arms ONE rectangle draw; the
//    canvas reports the finished box, which the bridge stores and serializes into
//    `WorkflowGraph.groups` so it survives a room reload. Clicking a group's title
//    chip opens a rename/recolor popover anchored at the click. ──
function armGroup() {
  if (!canvasReady.value || !roomRole.isHost.value) return;
  if (editingNodeId.value !== null) return;
  handArmed.value = false;
  editArmed.value = false;
  groupArmed.value = true;
}

function onGroupDraw(bounding: WorkflowGroup["bounding"]) {
  if (editingNodeId.value !== null) return;
  bridge.addGroup({ title: translate("新分组"), bounding, color: DEFAULT_GROUP_COLOR, collapsed: false });
  groupArmed.value = false;
}

const groupPopover = ref<{ index: number; x: number; y: number } | null>(null);
const groupTitleDraft = ref("");

function onGroupClick(payload: { index: number; x: number; y: number }) {
  if (editingNodeId.value !== null) return;
  if (!roomRole.isHost.value) return;
  // Delete tool: clicking a group chip removes the whole group and, like the
  // node/edge deletes, returns the canvas to cursor mode (one-shot).
  if (toolMode.value === "delete") {
    toolMode.value = "cursor";
    bridge.removeGroup(payload.index);
    return;
  }
  groupTitleDraft.value = bridge.groups.value[payload.index]?.title ?? "";
  groupPopover.value = payload;
}

function commitGroupTitle() {
  if (groupPopover.value === null) return;
  bridge.updateGroup(groupPopover.value.index, { title: groupTitleDraft.value.trim() || translate("新分组") });
}

function recolorGroup(color: string) {
  if (groupPopover.value === null) return;
  bridge.updateGroup(groupPopover.value.index, { color });
}

function deleteGroup() {
  if (groupPopover.value === null) return;
  bridge.removeGroup(groupPopover.value.index);
  groupPopover.value = null;
}

function closeGroupPopover() {
  commitGroupTitle();
  groupPopover.value = null;
}

// ── Phase-5 D14: 移动画布 arms hand mode for ONE pan gesture; the canvas reports
//    the finished gesture (`hand-done`) and we disarm, so it is not a sticky toggle. ──
function armHand() {
  if (!canvasReady.value) return;
  if (editingNodeId.value !== null) return;
  groupArmed.value = false;
  editArmed.value = false;
  handArmed.value = true;
}
function onHandDone() {
  handArmed.value = false;
}

// ── 画布指针工具：cursor（悬停高亮节点边框/连线弧，点选）、connect（先点源节点再点
//    目标节点建连线）、delete（点击高亮的节点/连线即删除）。connect 与 delete 为一次性：
//    完成一次拾取/删除后自动回到 cursor 模式。高亮由画布组件内部实现（MovieNode 边框
//    + edge CSS :hover），这里只维护模式与提交 bridge 命令（仅主持人可改图）。──
const toolMode = ref<CanvasToolMode>("cursor");
const versionMenuVisible = ref(false);

// The pressed accent is exclusive: Move Canvas / Group Nodes are one-shot arms
// layered on top of the tool mode, and the Add Node cascade is its own transient
// "add" mode, so while any of those is active the Cursor button must NOT look
// pressed. Once the gesture finishes (hand-done / group-draw) or the cascade
// closes after dropping a node, the arm clears and Cursor regains the accent.
const cursorPressed = computed(
  () => toolMode.value === "cursor" && !handArmed.value && !groupArmed.value && !addNodeVisible.value && !editArmed.value,
);

// Opening the Add Node cascade is a transient "add" mode: drop pointer-tool modes
// and one-shot arms so the pressed accent stays exclusive (Add Node only). While
// the cascade is open Add Node reads pressed; picking a node closes it and the
// accent falls back to Cursor.
function enterAddMode() {
  if (editingNodeId.value !== null) return;
  toolMode.value = "cursor";
  handArmed.value = false;
  groupArmed.value = false;
  editArmed.value = false;
}

function setToolMode(mode: CanvasToolMode) {
  if (!canvasReady.value) return;
  // D4 guard: while the editor lock is up every tool setter is inert.
  if (editingNodeId.value !== null) return;
  if (mode !== "cursor" && !roomRole.isHost.value) return;
  // Picking any pointer tool cancels a pending one-shot arm (hand/group/edit).
  handArmed.value = false;
  groupArmed.value = false;
  editArmed.value = false;
  toolMode.value = mode;
}

/** One type-compatible (source output → target input) slot pair. */
interface ConnectPair {
  fromSlot: number;
  toSlot: number;
  name: string;
  type: string;
}

/** Slot types connect when equal, or when either side is the `*` wildcard. */
function slotTypesMatch(outType: string, inType: string): boolean {
  return outType === "*" || inType === "*" || outType === inType;
}

/**
 * Every type-compatible slot pair between two nodes, one per input slot (the
 * first matching output wins). Roles come from the schema slot NAMES, so a
 * Text Input → Image Generator pick offers `prompt` and `skill` explicitly
 * instead of silently hard-coding slot 0 — wiring by anonymous dot index was
 * the error-prone path this replaces.
 */
function compatiblePairs(fromId: number, toId: number): ConnectPair[] {
  const fromData = bridge.flow.findNode(String(fromId))?.data as MovieNodeData | undefined;
  const toData = bridge.flow.findNode(String(toId))?.data as MovieNodeData | undefined;
  const outputs = fromData?.outputs ?? [];
  const pairs: ConnectPair[] = [];
  (toData?.inputs ?? []).forEach((inSlot, toSlot) => {
    const fromSlot = outputs.findIndex((outSlot) => slotTypesMatch(outSlot.type ?? "*", inSlot.type ?? "*"));
    if (fromSlot >= 0) {
      pairs.push({ fromSlot, toSlot, name: inSlot.name ?? `in ${toSlot}`, type: inSlot.type ?? "*" });
    }
  });
  return pairs;
}

function addConnectEdge(fromId: number, toId: number, pair: ConnectPair): void {
  void bridge
    .request("edge.add", { fromId, fromSlot: pair.fromSlot, toId, toSlot: pair.toSlot })
    .catch(() => {
      ElMessage.error(translate("添加连线失败"));
    });
}

/** Port-chooser state: raised when a picked pair admits several compatible inputs. */
const connectChooserVisible = ref(false);
const connectChoice = ref<{ fromId: number; toId: number; pairs: ConnectPair[] } | null>(null);

function onConnectPick(payload: { source: number; target: number }) {
  if (editingNodeId.value !== null) return;
  // Defer the return-to-cursor out of this click's synchronous phase: the bridge's
  // node-click selection hook also runs during this same click and must still see
  // `connect` so it does not open the inspector for the second picked node.
  void nextTick(() => {
    toolMode.value = "cursor";
  });
  if (!roomRole.isHost.value) return;
  // Orient the picked pair by type feasibility, never by click order alone:
  // prefer first.out → second.in; flip when only the reverse direction has a
  // compatible slot pair; neither → refuse instead of drawing a dangling edge.
  let fromId = payload.source;
  let toId = payload.target;
  let pairs = compatiblePairs(fromId, toId);
  if (pairs.length === 0) {
    const reversed = compatiblePairs(payload.target, payload.source);
    if (reversed.length === 0) {
      ElMessage.error(translate("无法在这两个节点间建立连线"));
      return;
    }
    fromId = payload.target;
    toId = payload.source;
    pairs = reversed;
  }
  // A merged-input target hides its slots behind ONE handle, so auto-route by
  // the source's output type instead of raising the port chooser: TEXT -> the
  // first TEXT slot (`prompt`), IMAGE -> the `image` slot.
  const toClassType = bridge.flow.findNode(String(toId))?.data?.classType ?? "";
  if (mergesInputs(toClassType)) {
    const fromOutputs = bridge.flow.findNode(String(fromId))?.data?.outputs ?? [];
    const routed = pairs.find((pair) => {
      const outType = fromOutputs[pair.fromSlot]?.type ?? "*";
      return pair.toSlot === routeInputSlotByType(toClassType, outType);
    });
    if (routed !== undefined) {
      addConnectEdge(fromId, toId, routed);
      return;
    }
  }
  const only = pairs[0];
  if (pairs.length === 1 && only !== undefined) {
    addConnectEdge(fromId, toId, only);
    return;
  }
  // Several roles fit (e.g. `prompt` vs `skill`): the human picks the port by name.
  connectChoice.value = { fromId, toId, pairs };
  connectChooserVisible.value = true;
}

/** Chooser row pick: draw the edge into the chosen input slot, then close. */
function onChoosePort(pair: ConnectPair): void {
  const choice = connectChoice.value;
  connectChooserVisible.value = false;
  connectChoice.value = null;
  if (choice !== null) addConnectEdge(choice.fromId, choice.toId, pair);
}

function onDeleteNode(id: number) {
  // D4: the motivating hazard — deleting the node whose editor is open.
  if (editingNodeId.value !== null) return;
  // Defer return-to-cursor so the same click's selection hook still sees `delete`.
  void nextTick(() => {
    toolMode.value = "cursor";
  });
  if (!roomRole.isHost.value) return;
  void bridge.request("node.remove", { id }).catch(() => {
    ElMessage.error(translate("删除节点失败"));
  });
}

function onDeleteEdge(edgeId: string) {
  if (editingNodeId.value !== null) return;
  // Defer return-to-cursor so the same click's selection hook still sees `delete`.
  void nextTick(() => {
    toolMode.value = "cursor";
  });
  if (!roomRole.isHost.value) return;
  const edge = bridge.flow.findEdge(edgeId);
  const linkId = Number((edge?.data as { linkId?: unknown } | undefined)?.linkId ?? edgeId.replace("link-", ""));
  if (!Number.isFinite(linkId)) return;
  void bridge.request("edge.remove", { id: linkId }).catch(() => {
    ElMessage.error(translate("删除连线失败"));
  });
}

// ── P3-M5：主机治理（撤销/重做/提交/移交 + 版本历史）与成员只读交互。
//    只读由角色驱动（useWorkspaceGraph 内 watch role.isHost → bridge.setReadonly(!isHost)）；
//    主持人可选「只读预览」临时锁定自己的画布。移交从房间花名册挑选继任者，经
//    room/transferHost 改写 Matrix 权限级并广播 role 帧；成员只能发群聊请求移交。──
const historyOpen = ref(false);
const transferDialogVisible = ref(false);

/** The current host's display name (falls back to the mxid). */
const hostName = computed(() => {
  const id = roomRole.host.value;
  if (!id) return translate("未知");
  return teamMembers.value.find((member) => member.userId === id)?.name ?? id;
});

/** Roster members eligible to receive the host seat (not the host, not bots). */
const transferCandidates = computed(() =>
  teamMembers.value.filter((member) => !member.host && !member.bot),
);

function togglePreview() {
  if (!roomRole.isHost.value) return;
  previewReadonly.value = !previewReadonly.value;
  bridge.setReadonly(previewReadonly.value);
}

// Leaving/entering the host seat clears any host preview lock (role watch re-asserts readonly).
watch(() => roomRole.isHost.value, () => { previewReadonly.value = false; });

function formatCommitTime(timestamp: number): string {
  if (!timestamp) return "—";
  try { return new Date(timestamp).toLocaleString(); } catch { return "—"; }
}

async function onUndo() {
  if (editingNodeId.value !== null) return;
  await workspace.undo();
  if (workspace.lastError.value) ElMessage.error(`${translate("撤销失败")}: ${workspace.lastError.value}`);
}

async function onRedo() {
  if (editingNodeId.value !== null) return;
  await workspace.redo();
  if (workspace.lastError.value) ElMessage.error(`${translate("重做失败")}: ${workspace.lastError.value}`);
}

async function onCommit() {
  if (editingNodeId.value !== null) return;
  const message = window.prompt(translate("提交说明"), "") ?? "";
  const record = await workspace.commit(message.trim());
  if (record === null) {
    ElMessage.error(`${translate("提交失败")}: ${workspace.lastError.value ?? ""}`);
    return;
  }
  ElMessage.success(`${translate("已提交")} r${record.rev}`);
}

async function onRevert(rev: number) {
  if (editingNodeId.value !== null) return;
  const message = window.prompt(translate("回滚说明"), `${translate("回滚到")} r${rev}`) ?? "";
  const record = await workspace.revert(rev, message.trim());
  if (record === null) {
    ElMessage.error(`${translate("回滚失败")}: ${workspace.lastError.value ?? ""}`);
    return;
  }
  ElMessage.success(`${translate("已回滚到")} r${rev} → r${record.rev}`);
}

/** Load a committed revision into the canvas for viewing (does not move HEAD). */
async function onViewCommit(rev: number) {
  const entry = await workspace.getCommit(rev);
  if (entry === null) {
    ElMessage.error(`${translate("读取历史版本失败")}: ${workspace.lastError.value ?? ""}`);
    return;
  }
  await applyGraph(entry.graph);
  ElMessage.success(`${translate("已载入历史版本")} r${rev}`);
}

function openTransferDialog() {
  if (!roomRole.isHost.value) return;
  transferDialogVisible.value = true;
}

async function onTransferHost(targetUserId: string) {
  const ok = await roomRole.transferHost(targetUserId);
  transferDialogVisible.value = false;
  if (ok) ElMessage.success(translate("已移交主持人"));
  else ElMessage.error(`${translate("移交主持人失败")}: ${roomRole.error.value ?? ""}`);
}

function onRequestHost() {
  void sendText(translate("我请求成为主持人，请把主持权限移交给我。"));
  ElMessage.success(translate("已在群聊中发送移交请求"));
}

// ── 停靠式聊天框分栏：右列宽度由可拖拽分隔条实时调整。宽度与拖拽逻辑收敛到
//    useChatSplitWidth（模块级单例）：默认分隔条位于面板左起 2/3（聊天列 = 1/3），
//    夹紧到 [320, 55vw]，且在 Chat / Studio 之间跳转时保留上一次拖拽位置。聊天框常开。──
const studioEl = ref<HTMLElement>();
const { chatWidth, resizing, onResizeDown } = useChatSplitWidth(studioEl);

// ── 媒体查看器：视频 / 图片 / 只读文本预览（与群聊页同一套逻辑）。──
type ViewerKind = "video" | "image" | "audio" | "text";
const viewerVisible = ref(false);
const viewerKind = ref<ViewerKind>("video");
const viewerUrl = ref("");
const viewerName = ref("");
const viewerText = ref("");
const viewerTextKind = ref<TextPreviewKind>("text");
const playToken = ref(0);
const autoPlay = computed(() => playToken.value > 0);
const PREVIEW_MAX = 5 * 1024 * 1024;

watch(activeRoomId, () => { viewerVisible.value = false; });
watch(timeline, list => {
  if (viewerVisible.value && viewerUrl.value && !list.some(m => m.url === viewerUrl.value)) {
    viewerVisible.value = false;
  }
});

function openVideo(id: string, play: boolean) {
  const msg = timeline.value.find(m => m.id === id);
  if (!msg?.url) return;
  viewerKind.value = "video";
  viewerUrl.value = msg.url;
  viewerName.value = msg.body || translate("视频");
  viewerText.value = "";
  if (play) playToken.value++;
  viewerVisible.value = true;
}

function openImage(id: string) {
  const msg = timeline.value.find(m => m.id === id);
  if (!msg?.url) return;
  viewerKind.value = "image";
  viewerUrl.value = msg.url;
  viewerName.value = msg.body || translate("图片");
  viewerText.value = "";
  viewerVisible.value = true;
}

async function openFile(id: string) {
  const msg = timeline.value.find(m => m.id === id);
  if (!msg?.url) return;
  const kind = previewKind(msg.body || "", msg.mimetype);
  if (!kind) return;
  if (msg.size && msg.size > PREVIEW_MAX) {
    ElMessage.error(translate("文件较大，无法预览，请下载后查看"));
    return;
  }
  try {
    const resp = await fetch(msg.url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const content = await resp.text();
    viewerKind.value = "text";
    viewerUrl.value = msg.url;
    viewerName.value = msg.body || translate("文件");
    viewerText.value = content;
    viewerTextKind.value = kind;
    viewerVisible.value = true;
  } catch {
    ElMessage.error(translate("读取文件失败，请稍后重试"));
  }
}

/** Open the viewer dialog straight from a URL (the editor's content area, D2). */
function openViewerUrl(kind: ViewerKind, url: string, name: string): void {
  viewerKind.value = kind;
  viewerUrl.value = url;
  viewerName.value = name;
  viewerText.value = "";
  playToken.value = 0;
  viewerVisible.value = true;
}

/** The name used for viewer titles while the editor is open. */
const editorNodeName = computed(() => {
  const title = editorDraft.value?.title.trim() ?? "";
  return title !== "" ? title : editorTypeLabel.value;
});

/**
 * "Open" on the produced output (D2): media artifacts go to their native viewer
 * branch (image / video / audio); text goes to the viewer's text pane, fetched
 * when the artifact is a URL and inlined when it is literal text.
 */
async function openOutputViewer(): Promise<void> {
  const output = selectedOutput.value;
  if (output === undefined || output.artifact === "") return;
  const kind = outputMediaKind.value;
  const name = editorNodeName.value;
  if (kind !== "") {
    openViewerUrl(kind, output.artifact, name);
    return;
  }
  if (output.isUrl) {
    try {
      const resp = await fetch(output.artifact);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      viewerText.value = await resp.text();
    } catch {
      ElMessage.error(translate("读取文件失败，请稍后重试"));
      return;
    }
    viewerKind.value = "text";
    viewerUrl.value = output.artifact;
    viewerName.value = name;
    viewerTextKind.value = previewKind(name, output.modality) ?? "text";
    viewerVisible.value = true;
    return;
  }
  viewerKind.value = "text";
  viewerUrl.value = "";
  viewerName.value = name;
  viewerText.value = output.artifact;
  viewerTextKind.value = "text";
  viewerVisible.value = true;
}

// ── Phase-6 D5/D12: the editor's content-source pipeline. A source node's single
//    modality widget IS its content, so every provenance (upload / chat / market /
//    inline) resolves to writing that widget plus a `contentRef` provenance record
//    into the draft; Save publishes both as one canonical mutation. ──

/** Source-family nodes drive the dedicated content UI; others keep the parameter loop. */
const editorIsSource = computed(() => selectedSchema.value?.family === "source");
const editorModality = computed(() => selectedSchema.value?.modality ?? "text");
/** A media source (image/video/audio) gets upload/paste/pick controls; text gets the inline editor. */
const editorContentIsMedia = computed(() => editorIsSource.value && editorModality.value !== "text");
/** The source node's content lives in widget[0] (its single modality widget). */
const draftContentUrl = computed(() => asString(editorDraft.value?.widgets[0]?.value ?? ""));
const contentAccept = computed(() => {
  const modality = editorModality.value;
  if (modality === "image") return "image/*";
  if (modality === "video") return "video/*";
  if (modality === "audio") return "audio/*";
  return "*/*";
});

/** Per-modality MIME whitelist + a size cap keep uploads sane (D5). */
const CONTENT_MAX_BYTES = 64 * 1024 * 1024;
function mimeMatchesModality(mime: string, modality: string): boolean {
  if (mime === "") return false;
  if (modality === "image") return mime.startsWith("image/");
  if (modality === "video") return mime.startsWith("video/");
  if (modality === "audio") return mime.startsWith("audio/");
  return true;
}

/** Write a content reference into the draft: the widget value AND the provenance. */
function setDraftContent(ref: ContentRef): void {
  const draft = editorDraft.value;
  if (draft === null) return;
  draft.contentRef = ref;
  const widget = draft.widgets[0];
  if (widget !== undefined) widget.value = ref.origin === "inline" ? (ref.text ?? "") : (ref.uri ?? "");
}

const contentFileInput = ref<HTMLInputElement>();
const contentBusy = ref(false);
function pickContentFile(): void {
  if (editorReadonly.value || contentBusy.value) return;
  contentFileInput.value?.click();
}
async function onContentFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file !== undefined) await applyUploadedFile(file);
}
function onContentDrop(event: DragEvent): void {
  if (editorReadonly.value || contentBusy.value) return;
  const file = event.dataTransfer?.files?.[0];
  if (file !== undefined) void applyUploadedFile(file);
}
/** Upload through the shared chat media pipeline, then reference the resolved URL. */
async function applyUploadedFile(file: File): Promise<void> {
  if (!mimeMatchesModality(file.type, editorModality.value)) {
    ElMessage.warning(translate("文件类型与节点模态不匹配"));
    return;
  }
  if (file.size > CONTENT_MAX_BYTES) {
    ElMessage.warning(translate("文件过大，无法上传"));
    return;
  }
  contentBusy.value = true;
  try {
    const uploaded = await uploadMedia(file);
    if (uploaded.uri === "") throw new Error("unresolved media");
    setDraftContent({ origin: "upload", uri: uploaded.uri, mime: uploaded.mime, name: uploaded.name });
  } catch {
    ElMessage.error(translate("上传失败，请稍后重试"));
  } finally {
    contentBusy.value = false;
  }
}
/** Clipboard paste into the content area (D12a): a copied image becomes an upload. */
async function onContentPaste(event: ClipboardEvent): Promise<void> {
  if (editorReadonly.value || !editorContentIsMedia.value || contentBusy.value) return;
  const items = event.clipboardData?.items;
  if (items === undefined) return;
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file !== null) {
        event.preventDefault();
        await applyUploadedFile(file);
        return;
      }
    }
  }
}

// ── Pick from chat (D12b): reference an existing room message's media/text. ──
const pickVisible = ref(false);
function msgtypeForModality(modality: string): string {
  if (modality === "image") return "m.image";
  if (modality === "video") return "m.video";
  if (modality === "audio") return "m.audio";
  return "m.text";
}
const pickMessages = computed<ChatMessage[]>(() => {
  const want = msgtypeForModality(editorModality.value);
  return timeline.value
    .filter((message) => message.msgtype === want && (message.url !== "" || want === "m.text"))
    .slice(-50)
    .reverse();
});
function openPickFromChat(): void {
  if (editorReadonly.value) return;
  pickVisible.value = true;
}
function onPickMessage(message: ChatMessage): void {
  pickVisible.value = false;
  if (editorModality.value === "text") {
    setDraftContent({ origin: "chat", text: message.body, name: message.body, msgId: message.id });
  } else {
    setDraftContent({ origin: "chat", uri: message.url, mime: message.mimetype, name: message.body, msgId: message.id });
  }
}

/** Open the content area's media in the viewer dialog (image/video/audio). */
function openContentViewer(): void {
  const url = draftContentUrl.value;
  if (url === "") return;
  openViewerUrl(editorModality.value as ViewerKind, url, editorNodeName.value);
}

// ── Text focus mode (D2): long text edits in a full-height viewer textarea. ──
const viewerEditable = ref(false);
const viewerTextDraft = ref("");
function openTextFocus(): void {
  viewerTextDraft.value = asString(editorDraft.value?.widgets[0]?.value ?? "");
  viewerKind.value = "text";
  viewerUrl.value = "";
  viewerName.value = editorNodeName.value;
  viewerText.value = viewerTextDraft.value;
  viewerEditable.value = true;
  viewerVisible.value = true;
}
function applyTextFocus(): void {
  setDraftContent({ origin: "inline", text: viewerTextDraft.value });
  viewerEditable.value = false;
  viewerVisible.value = false;
}

// ── EXP(textinput-toonflow): Toonflow-style TextInput upgrade (test build, no
//    i18n — labels are hard-coded literals). Two mechanisms: local text upload
//    into the primary widget, and reference chips derived from incoming edges
//    on the new optional `ref` input slot (the server appends a resolved ref as
//    a labeled block). Rollback = delete this branch; nothing here persists
//    beyond the normal widget values. ──

/** True when the edited node is a TextInput (the experiment's only target). */
const editorIsTextInput = computed(() => selectedSchema.value?.classType === "TextInput");

/** Hidden picker behind the Upload button; text files only, 256 KB cap. */
const textFileInput = ref<HTMLInputElement | null>(null);
const TEXT_UPLOAD_MAX_BYTES = 256 * 1024;
function pickTextFile(): void {
  textFileInput.value?.click();
}
function onTextFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file === undefined) return;
  if (file.size > TEXT_UPLOAD_MAX_BYTES) {
    ElMessage.error("Text file too large (256 KB max)");
    return;
  }
  const reader = new FileReader();
  reader.onload = (): void => {
    const widgets = editorDraft.value?.widgets ?? [];
    const index = widgets.findIndex((widget) => widget.type === "STRING" && widget.multiline === true);
    setDraftWidget(index >= 0 ? index : 0, String(reader.result ?? ""));
  };
  reader.readAsText(file);
}

/** One incoming-edge reference chip (Toonflow's refList, edge-derived). */
interface RefChip {
  linkId: number;
  slot: string;
  label: string;
}

/** Chips for every edge into the edited node, or null when it has no input
 *  slots (the References row stays hidden for such nodes). */
const editorRefChips = computed<RefChip[] | null>(() => {
  const id = editingNodeId.value;
  const schema = selectedSchema.value;
  if (id === null || schema === undefined || schema.inputs.length === 0) return null;
  return bridge.flow.getEdges.value
    .filter((edge) => edge.target === String(id))
    .map((edge): RefChip => {
      const source = bridge.flow.findNode(edge.source)?.data as MovieNodeData | undefined;
      const slotIndex = Number(edge.targetHandle?.split("-")[1] ?? -1);
      return {
        linkId: Number((edge.data as { linkId?: unknown } | undefined)?.linkId ?? 0),
        slot: schema.inputs[slotIndex]?.name ?? `in ${String(slotIndex)}`,
        label: source?.title ?? source?.classType ?? edge.source,
      };
    });
});

/** Chip close = remove the underlying edge (Toonflow's removeReference). */
function removeRefChip(linkId: number): void {
  if (editorReadonly.value || !Number.isFinite(linkId) || linkId <= 0) return;
  void bridge.request("edge.remove", { id: linkId }).catch(() => {
    ElMessage.error("Failed to remove the reference link");
  });
}

function goLogin() {
  void router.push({ path: "/account", query: { login: "1", redirect: "/studio" } });
}

</script>

<template>
  <div ref="studioEl" class="studio" :style="{ '--chat-w': `${chatWidth}px` }">
    <!-- Signed out: the router guard normally bounces to /account, but keep a guide for safety. -->
    <section v-if="!auth.signedIn" class="signedOut">
      <el-empty :description="translate('登录后即可进入工作室')">
        <el-button type="primary" @click="goLogin">{{ translate("登录") }}</el-button>
      </el-empty>
    </section>

    <template v-else>
      <!-- 网格 1/1：画布单元（Vue Flow 画布 + 检视器浮层 + 版本历史浮层）。 -->
      <div class="canvasPanel">
        <VueFlowCanvas
          :hand-mode="handArmed"
          :group-mode="groupArmed"
          :groups="bridge.groups.value"
          :tool-mode="toolMode"
          @group-draw="onGroupDraw"
          @group-click="onGroupClick"
          @hand-done="onHandDone"
          @connect-pick="onConnectPick"
          @delete-node="onDeleteNode"
          @delete-edge="onDeleteEdge"
          @node-double-click="onNodeDblClick" />
        <!-- Phase-6 D4: the edit lock's freeze layer. Everything behind it — the
             canvas, the toolbar, the docked chat — becomes unreachable while the
             editor card is open (left/right/middle click and wheel are absorbed,
             `@contextmenu.prevent` stops the browser menu). The editor renders
             ABOVE it, so a dimmed canvas + bright editor reads as “you are editing”. -->
        <div v-if="editingNodeId !== null" class="editScrim" @contextmenu.prevent @wheel.prevent />

        <!-- Phase-6 D2/D11: the docked editor card (the converted inspector).
             Rows: identity (read-only) → name → description → content/parameters
             → produced output → footer (publish). Status is the D13 residue:
             a header chip only when non-idle. -->
        <aside v-if="editingNodeId !== null" class="editor" :style="{ '--node-accent': editorSkin.accent }">
          <div class="editorHead">
            <component :is="editorSkin.icon" class="editorIcon" :size="16" aria-hidden="true" />
            <span class="editorType" :title="editorTypeLabel">{{ editorTypeLabel }}</span>
            <el-tag v-if="editorStatusChip !== ''" :type="statusTagType(selectedStatus)" size="small" disable-transitions>
              {{ editorStatusChip }}
            </el-tag>
            <span v-if="editorDirty" class="dirtyDot" :title="translate('未保存更改')" />
            <el-button text size="small" aria-label="关闭编辑器" @click="closeEditor">{{ translate("关闭") }}</el-button>
          </div>

          <!-- D7: guests read canonical content but cannot publish. -->
          <p v-if="editorReadonly" class="readonlyBanner">
            {{ translate("只读：只有主持人可以编辑，请在聊天中提出修改建议") }}
          </p>

          <!-- Phase-1 model selector (at TOP, decision a): laid out EXACTLY like the
               Skills group — the gray text "选择" button sits to the RIGHT of the
               "模型" title (same as Skills/Import), and the current choice renders
               as a success chip identical to an imported-skill chip. Clicking the
               button jumps to Plugins → Models pick-mode; empty = default model. -->
          <div v-if="editorHasModel" class="fieldGroup">
            <div class="outputLabel">
              {{ translate("模型") }}
              <el-button
                class="openButton"
                text
                size="small"
                :disabled="editorReadonly"
                @click="startModelPick">
                {{ translate("选择") }}
              </el-button>
            </div>
            <div class="skillChips">
              <el-tag
                class="skillChip"
                size="small"
                type="success"
                effect="plain"
                :closable="!editorReadonly && editorModelValue !== ''"
                @close="clearModelPick">
                {{ editorModelLabel }}
              </el-tag>
            </div>
          </div>

          <!-- Row 2: the node name (D11: it cannot be empty). -->
          <div class="fieldRow">
            <label class="fieldLabel" for="editorNodeName">{{ translate("节点名称") }}</label>
            <el-input
              id="editorNodeName"
              :model-value="editorDraft?.title ?? ''"
              :placeholder="editorTypeLabel"
              :disabled="editorReadonly"
              maxlength="80"
              @update:model-value="setDraftTitle" />
            <span v-if="nameError" class="fieldHint">{{ translate("名称不能为空") }}</span>
          </div>

          <!-- Row 3: the description (optional; it is the card's text stub). -->
          <div class="fieldRow">
            <label class="fieldLabel" for="editorNodeDesc">{{ translate("节点描述") }}</label>
            <el-input
              id="editorNodeDesc"
              type="textarea"
              :rows="2"
              resize="none"
              :model-value="editorDraft?.description ?? ''"
              :disabled="editorReadonly"
              maxlength="280"
              show-word-limit
              @update:model-value="setDraftDescription" />
          </div>

          <!-- Row 4a: a MEDIA source node's content (D5/D12) — upload / paste /
               pick-from-chat / market, a preview, and Open-in-viewer. The single
               modality widget holds the resolved URL; the card stub reads it. -->
          <div v-if="editorContentIsMedia" class="fieldGroup">
            <div class="outputLabel">{{ translate("内容") }}</div>
            <div
              class="contentPreview"
              tabindex="0"
              @paste="onContentPaste"
              @drop.prevent="onContentDrop"
              @dragover.prevent>
              <img
                v-if="editorModality === 'image' && draftContentUrl !== ''"
                class="outputMedia"
                :src="draftContentUrl"
                :alt="translate('图像内容')" />
              <video
                v-else-if="editorModality === 'video' && draftContentUrl !== ''"
                class="outputMedia"
                :src="`${draftContentUrl}#t=0.5`"
                preload="metadata"
                muted
                playsinline />
              <audio
                v-else-if="editorModality === 'audio' && draftContentUrl !== ''"
                class="outputAudio"
                :src="draftContentUrl"
                controls />
              <div v-else class="contentEmpty">
                <component :is="editorSkin.icon" :size="28" aria-hidden="true" />
                <span>{{ translate("尚无内容") }}</span>
              </div>
            </div>
            <div v-if="editorDraft?.contentRef?.name" class="contentName">{{ editorDraft.contentRef.name }}</div>
            <div class="contentActions">
              <input
                ref="contentFileInput"
                type="file"
                class="fileInput"
                :accept="contentAccept"
                @change="onContentFile" />
              <el-button size="small" :disabled="editorReadonly || contentBusy" @click="pickContentFile">
                {{ contentBusy ? translate("上传中…") : translate("上传本地文件") }}
              </el-button>
              <el-button size="small" :disabled="editorReadonly" @click="openPickFromChat">
                {{ translate("选择聊天消息") }}
              </el-button>
              <el-button v-if="draftContentUrl !== ''" size="small" text @click="openContentViewer">
                {{ translate("打开") }}
              </el-button>
            </div>
            <p class="contentHint">{{ translate("也可直接把聊天里复制的图片粘贴到此处") }}</p>
          </div>

          <!-- Row 4b: every OTHER node's widgets (text source + generator/reviewer/
               combiner parameters) are edited HERE — the card has no input DOM (D1).
               A text source additionally offers the full-height focus editor (D2). -->
          <div v-else-if="editorParamWidgets.length > 0" class="fieldGroup">
            <div class="outputLabel">
              {{ translate("内容") }}
              <el-button
                v-if="editorIsSource"
                class="openButton"
                text
                size="small"
                :disabled="editorReadonly"
                @click="openTextFocus">
                {{ translate("展开编辑") }}
              </el-button>
              <el-button
                v-if="editorIsTextInput"
                text
                size="small"
                :disabled="editorReadonly"
                @click="pickTextFile">
                Upload
              </el-button>
            </div>
            <input
              ref="textFileInput"
              type="file"
              class="fileInput"
              accept=".md,.markdown,.txt,text/plain,text/markdown"
              @change="onTextFile" />
            <div v-for="{ widget, index } in editorParamWidgets" :key="widget.name" class="fieldRow">
              <label class="fieldLabel">{{ widget.name }}</label>
              <el-input
                v-if="widget.type === 'STRING' && widget.multiline === true"
                class="nowheel"
                type="textarea"
                :rows="4"
                resize="vertical"
                :model-value="asString(widget.value)"
                :disabled="editorReadonly"
                @update:model-value="(value) => setDraftWidget(index, value)" />
              <el-input
                v-else-if="widget.type === 'STRING'"
                :model-value="asString(widget.value)"
                :disabled="editorReadonly"
                @update:model-value="(value) => setDraftWidget(index, value)" />
              <el-select
                v-else-if="widget.type === 'COMBO'"
                :model-value="asString(widget.value)"
                :disabled="editorReadonly"
                @update:model-value="(value) => setDraftWidget(index, value)">
                <el-option v-for="option in widget.options ?? []" :key="option" :label="option" :value="option" />
              </el-select>
              <el-input-number
                v-else-if="widget.type === 'INT' || widget.type === 'FLOAT'"
                class="numberField"
                :model-value="asNumber(widget.value)"
                :min="widget.min"
                :max="widget.max"
                :step="widget.type === 'INT' ? 1 : 0.1"
                :precision="widget.type === 'INT' ? 0 : undefined"
                :disabled="editorReadonly"
                controls-position="right"
                @update:model-value="(value) => setDraftWidget(index, value ?? 0)" />
              <el-switch
                v-else-if="widget.type === 'BOOLEAN'"
                :model-value="asBool(widget.value)"
                :disabled="editorReadonly"
                @update:model-value="(value) => setDraftWidget(index, value)" />
              <span v-else class="fieldRaw">{{ asString(widget.value) }}</span>
            </div>
          </div>

          <!-- EXP(textinput-toonflow): reference chips for nodes with input slots
               (TextInput's `ref`). One chip per incoming edge; close removes the
               edge, mirroring Toonflow's removeReference. -->
          <div v-if="editorRefChips !== null" class="fieldGroup">
            <div class="outputLabel">References</div>
            <div v-if="editorRefChips.length > 0" class="skillChips">
              <el-tag
                v-for="chip in editorRefChips"
                :key="chip.linkId"
                class="skillChip"
                size="small"
                type="info"
                effect="plain"
                :closable="!editorReadonly"
                @close="removeRefChip(chip.linkId)">
                {{ chip.slot }} ← {{ chip.label }}
              </el-tag>
            </div>
            <p v-else class="contentHint">No wired reference — connect a TEXT output into the ref port.</p>
          </div>

          <!-- Row 4c: imported craft skills (Phase-7 D7). Shown for any node whose
               schema opts into skill imports — “Search skill” retrieves in place
               (Task 6), while “Import” stashes the pick context and routes to the
               Plugins page; downloaded skills appear as removable chips (the pasted
               body snapshot lives in the text widget). -->
          <div v-if="editorCanImport" class="fieldGroup">
            <div class="outputLabel">
              {{ translate("技能") }}
              <el-button
                class="openButton"
                text
                size="small"
                :disabled="editorReadonly"
                @click="startImport">
                {{ translate("导入") }}
              </el-button>
            </div>
            <div v-if="(editorDraft?.importedSkills?.length ?? 0) > 0" class="skillChips">
              <el-tag
                v-for="(skill, index) in editorDraft?.importedSkills ?? []"
                :key="`${skill.id}-${index}`"
                class="skillChip"
                size="small"
                type="success"
                effect="plain"
                :closable="!editorReadonly"
                @close="removeImportedSkill(index)">
                {{ skill.id }}
              </el-tag>
            </div>
            <p v-else class="contentHint">{{ translate("尚未导入技能") }}</p>
          </div>

          <!-- Row 5: the produced output — read-only; re-run to change it. -->
          <div class="outputBlock">
            <div class="outputLabel">
              {{ translate("最近产物输出") }}
              <el-button
                v-if="selectedOutput?.artifact"
                class="openButton"
                text
                size="small"
                @click="openOutputViewer">
                {{ translate("打开") }}
              </el-button>
            </div>
            <!-- Modality renderers (Phase-5 M4): a real media artifact is a URL, so
                 image/video/audio render their native element (audio = a player);
                 text and canned placeholders fall back to the raw text view. -->
            <img
              v-if="outputMediaKind === 'image'"
              class="outputMedia"
              :src="selectedOutput?.artifact"
              :alt="translate('图像产物')" />
            <video
              v-else-if="outputMediaKind === 'video'"
              class="outputMedia"
              :src="selectedOutput?.artifact"
              controls />
            <audio
              v-else-if="outputMediaKind === 'audio'"
              class="outputAudio"
              :src="selectedOutput?.artifact"
              controls />
            <pre v-else class="outputPre">{{ outputSummary || translate("尚无输出，运行工作流后查看") }}</pre>
          </div>
          <div v-if="selectedMovieStep?.artifact" class="outputBlock">
            <div class="outputLabel">
              {{ translate("影片步骤产物") }}
              <template v-if="selectedMovieStep.media">（{{ translate("占位") }}）</template>
            </div>
            <pre class="outputPre">{{ selectedMovieStep.artifact }}</pre>
          </div>

          <!-- Footer: publish the draft as one canonical mutation (D6). -->
          <div class="editorFoot">
            <el-button size="small" @click="closeEditor">{{ translate("取消") }}</el-button>
            <el-button
              size="small"
              type="primary"
              :disabled="saveDisabled || !editorDirty"
              @click="saveEditor">
              {{ translate("保存") }}
            </el-button>
          </div>
        </aside>
        <!-- P3-M5：版本历史浮层（画布右上）：查看把某个已提交快照载入画布（不移动 HEAD）；主持人可回滚。 -->
        <div v-if="historyOpen" class="historyPanel">
          <div class="historyHead">
            <span class="historyTitle">{{ translate("版本历史") }}</span>
            <span class="historyCount">{{ workspace.commits.value.length }} {{ translate("个版本") }}</span>
          </div>
          <ul v-if="workspace.commits.value.length > 0" class="historyList">
            <li
              v-for="entry in [...workspace.commits.value].reverse()"
              :key="entry.rev"
              class="historyItem">
              <span class="historyRev" :class="{ head: entry.rev === workspace.rev.value }">r{{ entry.rev }}</span>
              <span class="historyMsg">{{ entry.message || translate("（无说明）") }}</span>
              <span class="historyMeta">{{ formatCommitTime(entry.timestamp) }}</span>
              <span class="historyActions">
                <el-button size="small" text @click="onViewCommit(entry.rev)">{{ translate("查看") }}</el-button>
                <el-button
                  v-if="roomRole.isHost.value"
                  size="small"
                  text
                  type="warning"
                  :disabled="entry.rev === workspace.rev.value || workspace.busy.value"
                  @click="onRevert(entry.rev)">
                  {{ translate("回滚") }}
                </el-button>
              </span>
            </li>
          </ul>
          <p v-else class="historyEmpty">{{ translate("尚无提交版本") }}</p>
        </div>
      </div>

      <!-- vidsay workspaceTools：模式切换器在画布列内水平居中，不遮挡画布交互。 -->
      <div class="workspaceTools">
        <modeSwitcher class="modeSwitch" mode="step-by-step" />
      </div>

      <!-- vidsay studioBar：底部按钮条（第二行第一列），单工具卡：运行 | 光标/移动/添加/连线/删除/分组/搜索/版本/缩放。 -->
      <div class="studioBar">
        <el-card class="toolMenu" shadow="never" :body-style="{ padding: '4px' }">
          <div class="barRow" role="toolbar" aria-label="画布工具">
            <el-tooltip :content="translate('运行（执行当前工作流）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton runButton"
                :disabled="!canvasReady || !roomRole.isHost.value || runningDemo || (currentGraph?.nodes.length ?? 0) === 0"
                aria-label="运行工作流"
                @click="runCurrentGraph">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasRun}&quot;)` }" aria-hidden="true" />
                <span class="barLabel">{{ runningDemo ? translate("运行中…") : translate("运行") }}</span>
              </button>
            </el-tooltip>
            <!-- 三倍间隔：把「运行」动词与指针工具组分开。 -->
            <span class="barGapTriple" aria-hidden="true" />
            <el-tooltip :content="translate('光标（悬停高亮节点与连线）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="cursorPressed"
                :disabled="!canvasReady"
                aria-label="光标"
                @click="setToolMode('cursor')">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasCursor}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('移动画布（拖拽一次平移画布）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="handArmed"
                :disabled="!canvasReady"
                aria-label="移动画布"
                @click="armHand">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasMove}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('添加节点（级联菜单创建节点或模板）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <span class="popTrigger">
                <el-popover
                  v-model:visible="addNodeVisible"
                  trigger="click"
                  placement="top-start"
                  width="auto"
                  :disabled="!canvasReady || !roomRole.isHost.value">
                  <template #reference>
                    <button
                      type="button"
                      class="barButton iconOnly"
                      :aria-pressed="addNodeVisible"
                      :disabled="!canvasReady || !roomRole.isHost.value"
                      aria-label="添加节点"
                      aria-haspopup="menu"
                      @click="enterAddMode">
                      <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasAdd}&quot;)` }" aria-hidden="true" />
                    </button>
                  </template>
                  <NodeCascade @select="onCascadePicked" />
                </el-popover>
              </span>
            </el-tooltip>
            <el-tooltip :content="translate('编辑节点（双击节点也可打开编辑器）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="editArmed"
                :disabled="editDisabled"
                aria-label="编辑节点"
                @click="armEdit">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasEdit}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('添加连线（点选两个节点，自动从输出连到输入）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="toolMode === 'connect'"
                :disabled="!canvasReady || !roomRole.isHost.value"
                aria-label="添加连线"
                @click="setToolMode('connect')">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasEdge}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('删除（点击节点或连线将其删除）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="toolMode === 'delete'"
                :disabled="!canvasReady || !roomRole.isHost.value"
                aria-label="删除"
                @click="setToolMode('delete')">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasDelete}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('分组节点（拖拽矩形框选节点成组）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="groupArmed"
                :disabled="!canvasReady || !roomRole.isHost.value"
                aria-label="分组节点"
                @click="armGroup">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasGrouping}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :content="translate('搜索节点（按名称搜索并添加节点）')" placement="top" :show-arrow="false" :hide-after="0" :enterable="false">
              <span class="popTrigger">
                <el-popover v-model:visible="searchVisible" trigger="click" placement="top-end" :width="240">
                  <template #reference>
                    <button type="button" class="barButton iconOnly" :disabled="!canvasReady" aria-label="搜索节点">
                      <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasSearch}&quot;)` }" aria-hidden="true" />
                    </button>
                  </template>
                  <div class="searchMenu">
                    <el-input v-model="searchQuery" size="small" placeholder="搜索节点" clearable />
                    <ul class="searchList">
                      <li v-for="node in filteredNodes" :key="node.classType">
                        <button
                          type="button"
                          class="searchItem"
                          @click="
                            searchVisible = false;
                            addMovieNode(node.classType);
                          ">
                          {{ node.displayName }}
                        </button>
                      </li>
                      <li v-if="filteredNodes.length === 0" class="searchEmpty">无匹配节点</li>
                    </ul>
                  </div>
                </el-popover>
              </span>
            </el-tooltip>
            <el-tooltip
              :content="translate('版本（撤销 / 重做 / 提交 / 历史）')"
              placement="top"
              :show-arrow="false"
              :hide-after="0"
              :enterable="false"
              :disabled="versionMenuVisible">
              <span class="popTrigger">
                <el-popover v-model:visible="versionMenuVisible" trigger="click" placement="top-end" width="auto">
                  <template #reference>
                    <button type="button" class="barButton iconOnly" aria-label="版本" aria-haspopup="menu">
                      <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasVersion}&quot;)` }" aria-hidden="true" />
                    </button>
                  </template>
                  <div class="versionMenu">
                    <button
                      type="button"
                      class="versionItem"
                      :disabled="workspace.undoDepth.value === 0 || workspace.busy.value"
                      @click="
                        versionMenuVisible = false;
                        onUndo();
                      ">
                      <span>{{ translate("撤销") }}</span>
                    </button>
                    <button
                      type="button"
                      class="versionItem"
                      :disabled="workspace.redoDepth.value === 0 || workspace.busy.value"
                      @click="
                        versionMenuVisible = false;
                        onRedo();
                      ">
                      <span>{{ translate("重做") }}</span>
                    </button>
                    <button
                      type="button"
                      class="versionItem"
                      :disabled="!workspace.hasDraft.value || workspace.busy.value"
                      @click="
                        versionMenuVisible = false;
                        onCommit();
                      ">
                      <span>{{ translate("提交版本") }}</span>
                    </button>
                    <button
                      type="button"
                      class="versionItem"
                      @click="
                        versionMenuVisible = false;
                        historyOpen = !historyOpen;
                      ">
                      <span>{{ historyOpen ? translate("收起历史") : translate("版本历史") }}</span>
                    </button>
                  </div>
                </el-popover>
              </span>
            </el-tooltip>
            <el-tooltip
              :content="translate('缩放（滚轮或菜单调整画布缩放）')"
              placement="top"
              :show-arrow="false"
              :hide-after="0"
              :enterable="false"
              :disabled="zoomMenuVisible">
              <span class="zoomTrigger">
                <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-end" :width="216">
                  <template #reference>
                    <button
                      type="button"
                      class="barButton zoomButton"
                      aria-label="缩放菜单"
                      @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(20, Math.round(zoomPercent * ($event.deltaY < 0 ? 1.2 : 1 / 1.2)))))">
                      {{ zoomPercent }}%
                    </button>
                  </template>
                  <div class="zoomMenu">
                    <el-input-number
                      class="zoomInput"
                      :model-value="zoomPercent"
                      :min="20"
                      :max="800"
                      :controls="false"
                      aria-label="缩放百分比"
                      @change="applyZoom">
                      <template #suffix>%</template>
                    </el-input-number>
                    <button type="button" class="zoomAction" @click="zoomIn()">放大</button>
                    <button type="button" class="zoomAction" @click="zoomOut()">缩小</button>
                  </div>
                </el-popover>
              </span>
            </el-tooltip>
          </div>
        </el-card>
      </div>

      <!-- 可拖拽分隔条（第二列，跨两行）：4px 命中区居中常显 1px 竖直分割线。 -->
      <div
        class="chatResize"
        :class="{ dragging: resizing }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="onResizeDown" />

      <!-- 右列：常驻停靠聊天框（第三列，跨两行），复用群聊组件（分步模式）。 -->
      <groupChat
        class="studioChat"
        embedded
        mode="step-by-step"
        @select-video="openVideo($event, false)"
        @play-video="openVideo($event, true)"
        @stage-image="openImage"
        @stage-file="openFile" />

      <!-- P3-M5：主持人移交选择器（从房间花名册挑选继任者）。 -->
      <el-dialog
        v-model="transferDialogVisible"
        :title="translate('移交主持人')"
        width="420px"
        append-to-body
        destroy-on-close>
        <ul v-if="transferCandidates.length > 0" class="transferList">
          <li v-for="member in transferCandidates" :key="member.userId" class="transferItem">
            <span class="transferName">{{ member.name }}</span>
            <el-button size="small" type="primary" @click="onTransferHost(member.userId)">
              {{ translate("移交") }}
            </el-button>
          </li>
        </ul>
        <p v-else class="transferEmpty">{{ translate("没有可移交的成员") }}</p>
      </el-dialog>

      <!-- Phase-6 D6: closing a dirty draft raises this one-shot confirm. -->
      <el-dialog
        v-model="discardVisible"
        :title="translate('未保存更改')"
        width="360px"
        append-to-body
        destroy-on-close>
        <p class="discardBody">{{ translate("编辑器中有未保存的更改，确定丢弃吗？") }}</p>
        <template #footer>
          <el-button size="small" @click="discardVisible = false">{{ translate("取消") }}</el-button>
          <el-button size="small" type="danger" @click="discardDraft">{{ translate("丢弃更改") }}</el-button>
        </template>
      </el-dialog>

      <!-- Phase-6 D12b: pick a recent room message as the node's content source. -->
      <el-dialog
        v-model="pickVisible"
        :title="translate('选择聊天消息')"
        width="480px"
        append-to-body
        destroy-on-close>
        <ul v-if="pickMessages.length > 0" class="pickList">
          <li v-for="message in pickMessages" :key="message.id">
            <button type="button" class="pickItem" @click="onPickMessage(message)">
              <img
                v-if="message.msgtype === 'm.image' && message.url !== ''"
                class="pickThumb"
                :src="message.url"
                :alt="message.body" />
              <video
                v-else-if="message.msgtype === 'm.video' && message.url !== ''"
                class="pickThumb"
                :src="`${message.url}#t=0.5`"
                preload="metadata"
                muted
                playsinline />
              <component v-else :is="editorSkin.icon" class="pickGlyph" :size="20" aria-hidden="true" />
              <span class="pickBody">{{ message.body }}</span>
              <span class="pickSender">{{ message.senderName }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="transferEmpty">{{ translate("没有可用的聊天消息") }}</p>
      </el-dialog>

      <!-- Connect tool: when a picked node pair admits several type-compatible
           input slots (Text Input → Image Generator can mean `prompt` OR
           `skill`), the human picks the target port by name instead of
           guessing anonymous dots; a single compatible slot connects directly. -->
      <el-dialog
        v-model="connectChooserVisible"
        :title="translate('选择输入端口')"
        width="360px"
        append-to-body
        destroy-on-close>
        <p class="contentHint">{{ translate("有多个类型匹配的输入端口，选择要连接的一个。") }}</p>
        <ul class="portChoiceList">
          <li v-for="pair in connectChoice?.pairs ?? []" :key="pair.toSlot">
            <button type="button" class="portChoice" @click="onChoosePort(pair)">
              <span class="portChoiceName">{{ pair.name }}</span>
              <span class="portChoiceType">{{ pair.type }}</span>
            </button>
          </li>
        </ul>
        <template #footer>
          <el-button size="small" @click="connectChooserVisible = false">{{ translate("取消") }}</el-button>
        </template>
      </el-dialog>

    </template>

    <!-- 媒体查看器：视频 / 图片 / 只读文本预览。 -->
    <el-dialog
      v-model="viewerVisible"
      :title="viewerName"
      width="70%"
      top="6vh"
      append-to-body
      destroy-on-close
      class="viewerDialog"
      @close="viewerEditable = false">
      <video v-if="viewerKind === 'video'" :src="viewerUrl" class="viewerMedia" controls :autoplay="autoPlay" />
      <img v-else-if="viewerKind === 'image'" :src="viewerUrl" class="viewerMedia" :alt="viewerName" />
      <audio v-else-if="viewerKind === 'audio'" :src="viewerUrl" class="viewerAudio" controls :autoplay="autoPlay" />
      <el-input
        v-else-if="viewerEditable"
        v-model="viewerTextDraft"
        class="viewerTextEditor nowheel"
        type="textarea"
        :rows="22"
        resize="none" />
      <pre v-else class="viewerText">{{ viewerText }}</pre>
      <template v-if="viewerEditable" #footer>
        <el-button size="small" @click="viewerVisible = false">{{ translate("取消") }}</el-button>
        <el-button size="small" type="primary" :disabled="editorReadonly" @click="applyTextFocus">
          {{ translate("应用") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Phase-5 D13: group rename/recolor popover, anchored at the title-chip click. -->
    <teleport to="body">
      <div
        v-if="groupPopover"
        class="groupEdit"
        :style="{ left: `${groupPopover.x}px`, top: `${groupPopover.y}px` }"
        @click.stop>
        <div class="groupEditHead">
          <span>{{ translate("编辑分组") }}</span>
          <button type="button" class="groupEditClose" aria-label="关闭" @click="closeGroupPopover">×</button>
        </div>
        <input
          v-model="groupTitleDraft"
          class="groupEditTitle"
          type="text"
          :placeholder="translate('分组名称')"
          @change="commitGroupTitle" />
        <div class="groupSwatches">
          <button
            v-for="key in GROUP_COLOR_KEYS"
            :key="key"
            type="button"
            class="groupSwatch"
            :style="{ background: groupColor(key) }"
            :aria-label="`color-${key}`"
            @click="recolorGroup(key)" />
        </div>
        <div class="groupEditActions">
          <el-button size="small" type="danger" text @click="deleteGroup">{{ translate("删除分组") }}</el-button>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style lang="scss" scoped>
.studio {
  position: relative;
  display: grid;
  // vidsay：三列（画布/工具叠加单元 + 4px 分隔条 + 聊天框）两行（面板 + 57px 底部按钮条）。
  grid-template-columns: minmax(0, 1fr) 4px var(--chat-w, 400px);
  grid-template-rows: minmax(0, 1fr) 57px;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-size: 14px;
}

.signedOut {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

// Phase-5 D13: the floating group rename/recolor popover (teleported to body,
// anchored at the title-chip click point).
.groupEdit {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 220px;
  padding: 10px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);
  transform: translate(-50%, 8px);
}

.groupEditHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 600;
}

.groupEditClose {
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.groupEditTitle {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-small, 4px);
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 12px;
}

.groupSwatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.groupSwatch {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
  cursor: pointer;

  &:hover { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
}

.groupEditActions {
  display: flex;
  justify-content: flex-end;
}

// vidsay：画布/工具叠加单元（网格 1/1）。
.canvasPanel {
  grid-area: 1 / 1;
  position: relative;
  min-width: 0;
  min-height: 0;
}

// vidsay workspaceTools：与画布同网格单元，指针穿透，仅模式切换器可点。
.workspaceTools {
  grid-area: 1 / 1;
  position: relative;
  z-index: 5;
  width: 100%;
  height: 100%;
  pointer-events: none;

  .modeSwitch {
    position: absolute;
    top: 15px;
    left: 50%;
    z-index: 5;
    transform: translateX(-50%);
    pointer-events: auto;
  }
}

// vidsay studioBar：底部按钮条（第二行第一列）；顶边 1px 描边即水平分割线。
.studioBar {
  grid-area: 2 / 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  // Clip the tool cards at the column edge: when the divider is dragged left the
  // right-hand card (zoom % etc.) must hide at the divider, never bleed into the
  // docked chatbox column. Popovers/tooltips are teleported to <body>, unaffected.
  overflow: hidden;
  padding: 0 15px;
  border-top: 1px solid var(--el-border-color);
  background: var(--el-bg-color);

  .toolMenu {
    flex-shrink: 0;
    background: color-mix(in srgb, var(--el-bg-color-overlay) 70%, transparent);
    backdrop-filter: blur(6px);
    border-color: var(--el-border-color-light);
    box-shadow: var(--el-box-shadow-light);
  }

  .barRow {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  // 三倍间隔（3 × 6px barRow gap）：把「运行」与指针工具组分开。
  .barGapTriple {
    flex: 0 0 auto;
    width: 18px;
  }

  .dropTrigger,
  .popTrigger,
  .zoomTrigger {
    display: inline-flex;
  }

  .barButton {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    height: 32px;
    margin: 0;
    padding: 0 10px;
    gap: 6px;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
    &:disabled { opacity: 0.45; cursor: not-allowed; }

    &.iconOnly { width: 32px; padding: 0; }

    &[aria-pressed="true"] {
      border-color: var(--el-color-primary);
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
    }

    .barLabel { font-size: 12px; line-height: 1; }

    .toolIcon {
      display: block;
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      background-color: currentColor;
      mask-image: var(--tool-icon);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--tool-icon);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
    }
  }

  .zoomButton {
    min-width: 46px;
    font-variant-numeric: tabular-nums;
  }
}

.canvasHint {
  margin-inline-start: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.liveDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-danger);
  flex: 0 0 auto;

  &.on {
    background: var(--el-color-success);
  }
}

.revBadge {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.govBar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.govSpacer {
  flex: 1 1 auto;
}

.hostBadge {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-warning);
}

.readonlyBanner {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.historyPanel {
  position: absolute;
  top: 56px;
  left: 12px;
  z-index: 6;
  width: 320px;
  max-height: 260px;
  overflow: auto;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--ui-radius, 8px);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 88%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--el-box-shadow-light);
}

.historyHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.historyTitle {
  font-size: 13px;
  font-weight: 600;
}

.historyCount {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.historyList {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.historyItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);
  font-size: 12px;
}

.historyRev {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);

  &.head {
    color: var(--el-color-primary);
    font-weight: 600;
  }
}

.historyMsg {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.historyMeta {
  flex: 0 0 auto;
  color: var(--el-text-color-placeholder);
}

.historyActions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}

.historyEmpty {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.transferList {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.transferItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.transferName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transferEmpty {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.aiInput {
  width: 280px;
  flex: 0 1 auto;
}

.aiStage {
  font-size: 12px;
  color: var(--el-color-primary);
}

.aiResults {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
}

.aiResultsTitle {
  flex: 0 0 auto;
  color: var(--el-text-color-secondary);
}

.aiResultsList {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;

  li.ok { color: var(--el-color-success); }
  li.bad { color: var(--el-color-danger); }
}

.movieBar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.movieInput {
  width: 320px;
  flex: 0 1 auto;
}

.movieStage {
  font-size: 12px;
  color: var(--el-color-primary);
}

.movieStrip {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
}

.movieStripTitle {
  flex: 0 0 auto;
  color: var(--el-text-color-secondary);
}

.movieSteps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;

  li {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--el-text-color-secondary);
  }

  li.running { color: var(--el-color-warning); }
  li.success { color: var(--el-color-success); }
  li.error { color: var(--el-color-danger); }
}

.movieStepIdx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--el-fill-color);
  font-variant-numeric: tabular-nums;
}

.movieStepMedia {
  color: var(--el-text-color-placeholder);
}

// Phase-6 D4: the edit-lock freeze layer. Fixed to the viewport so it covers the
// canvas, the toolbar and the docked chat; it sits below the editor (1300) and
// below element-plus teleports (≥2000). Wheel/contextmenu are absorbed in template.
.editScrim {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: color-mix(in srgb, var(--el-bg-color) 55%, transparent);
}

// Phase-6 D2/D11: the docked editor card (the converted inspector). Wider than the
// old inspector because it now hosts every widget; it renders above the scrim, and
// its left edge carries the node's family accent so card and editor never drift.
.editor {
  position: absolute;
  top: 56px;
  right: 12px;
  z-index: 1300;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 400px;
  max-height: calc(100% - 72px);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--el-border-color-light);
  border-left: 3px solid var(--node-accent, var(--el-color-primary));
  border-radius: var(--ui-radius, 8px);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 92%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--el-box-shadow-light);
}

.editorHead {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editorIcon {
  flex: 0 0 auto;
  color: var(--node-accent, var(--el-color-primary));
}

.editorType {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 14px;
}

.dirtyDot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-warning);
}

.readonlyBanner {
  margin: 0;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: var(--ui-radius, 8px);
}

.fieldRow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fieldLabel {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.fieldHint {
  font-size: 12px;
  color: var(--el-color-danger);
}

.fieldGroup {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.numberField {
  width: 100%;
}

.fieldRaw {
  font-size: 13px;
  word-break: break-word;
  color: var(--el-text-color-regular);
}

.openButton {
  margin-left: 8px;
}

.editorFoot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.discardBody {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

// Phase-6 D5/D12: the media source node's content area — a focusable paste/drop
// zone, a preview, and the provenance buttons (upload / pick / market / open).
.contentPreview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 96px;
  padding: 6px;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--ui-radius, 8px);
  background: var(--el-fill-color-lighter);
  outline: none;

  &:focus-visible {
    border-color: var(--node-accent, var(--el-color-primary));
  }
}

.contentEmpty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}

.contentName {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.contentActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.fileInput {
  display: none;
}

.skillChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.skillChip {
  max-width: 100%;
}

.contentHint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
}

// Pick-from-chat dialog (D12b): a scrollable list of recent room media/text.
.pickList {
  margin: 0;
  padding: 0;
  max-height: 56vh;
  overflow: auto;
  list-style: none;
}

// Connect-tool port chooser: one row per type-compatible input slot, naming the
// role the edge would land in (`prompt` / `skill` / …) plus its slot type.
.portChoiceList {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.portChoice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ui-radius, 8px);
  background: var(--el-fill-color-light);
  cursor: pointer;

  &:hover {
    border-color: var(--el-color-primary);
    color: var(--el-color-primary);
  }
}

.portChoiceName {
  font-size: 13px;
  font-weight: 600;
}

.portChoiceType {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.pickItem {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px;
  border: none;
  border-radius: var(--ui-radius, 8px);
  background: transparent;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: var(--el-fill-color);
  }
}

.pickThumb {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--el-fill-color-darker);
}

.pickGlyph {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  border-radius: 6px;
}

.pickBody {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.pickSender {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.viewerTextEditor {
  width: 100%;
}

.outputBlock {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.outputLabel {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.outputPre {
  margin: 0;
  padding: 8px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  background: var(--el-fill-color-light);
  border-radius: var(--ui-radius, 8px);
}

// Modality renderers (Phase-5 M4): image/video fill the inspector width; the
// audio player spans full width so its transport controls are usable.
.outputMedia {
  width: 100%;
  max-height: 240px;
  object-fit: contain;
  background: var(--el-fill-color-light);
  border-radius: var(--ui-radius, 8px);
}

.outputAudio {
  width: 100%;
}

// vidsay：4px 命中区居中常显 1px 竖直分割线；悬停/拖拽亮主色。
.chatResize {
  grid-area: 1 / 2 / 3 / 3;
  position: relative;
  width: 4px;
  cursor: col-resize;
  background: transparent;

  &::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--el-border-color);
    transition: background 0.15s ease;
  }

  &:hover,
  &.dragging {
    &::before { background: var(--el-color-primary); }
  }
}

// vidsay：停靠式聊天框（第三列，跨两行）。
.studioChat {
  grid-area: 1 / 3 / 3 / 4;
  min-width: 0;
  min-height: 0;
}

.viewerMedia {
  display: block;
  width: 100%;
  max-height: 72vh;
  object-fit: contain;
  background: #000;
}

.viewerText {
  max-height: 72vh;
  overflow: auto;
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.6;
  background: var(--el-fill-color-light);
  border-radius: var(--ui-radius, 8px);
}

.viewerAudio {
  display: block;
  width: 100%;
}

// vidsay：缩放菜单 / 节点搜索 / 素材库占位 渲染在 teleport 到 body 的 popover 内，作用域样式需置于根级。
.zoomMenu {
  display: flex;
  flex-direction: column;
  gap: 4px;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    margin: 0;
    padding: 5px 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 1;
    text-align: left;
    cursor: pointer;

    &:hover { background: var(--el-fill-color); }
  }
}

.searchMenu {
  display: flex;
  flex-direction: column;
  gap: 6px;

  .searchList {
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow: auto;
    list-style: none;
  }

  .searchItem {
    display: block;
    width: 100%;
    margin: 0;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;

    &:hover { background: var(--el-fill-color); }
  }

  .searchEmpty {
    padding: 6px 8px;
    color: var(--el-text-color-placeholder);
    font-size: 12px;
  }
}

.versionMenu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 148px;

  .versionItem {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin: 0;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;

    &:hover:not(:disabled) { background: var(--el-fill-color); }
    &:disabled { opacity: 0.45; cursor: not-allowed; }
  }
}
</style>
