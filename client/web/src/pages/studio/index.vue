<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import type { NodeRunStatus, WorkflowGraph, MovieStepResult, MovieStepStatus, MovieStepId } from "@dsh-movie/protocol";
import groupChat from "@/components/groupChat.vue";
import modeSwitcher from "@/components/modeSwitcher.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { useCanvasBridge } from "@/composables/useCanvasBridge";
import { useWorkflowStore } from "@/composables/useWorkflowStore";
import { useRoomRole } from "@/composables/useRoomRole";
import { useWorkspaceGraph } from "@/composables/useWorkspaceGraph";
import { useExecStatus } from "@/composables/useExecStatus";
import { useCanvasScript, type CanvasScriptStage } from "@/composables/useCanvasScript";
import { useMovieRun } from "@/composables/useMovieRun";
import { buildDemoWorkflow, buildDemoPrompt, nodeSchemaForId, findMovieNode } from "@/utils/demoWorkflow";
import { previewKind, type TextPreviewKind } from "@/utils/textPreview";

// ACT: 工作室框架外壳（design doc §4.3，M4）。这是「分步生成」模式的页面骨架：
// 左侧是舞台槽位（当前为占位，M5 把 ComfyUI iframe 落进来）；右侧是常驻的停靠式聊天框，
// 直接复用群聊组件（groupChat），顶部挂就地模式切换器（one-shot ↔ step-by-step）。
// 房间状态是模块级单例，groupChat 内部会自行 bootstrap 并按 ?room= 定位活跃房间。
// 有意不移植 vidsay workspace 的重耦合部分：canvasPanel/documentPanel(ProseMirror)/
// useWorkspaceStore/useRoomSpoke/roomGrants/mcpControl/anonymousData/providerBilling/图形同步。
const auth = useAuthStore();
const router = useRouter();
const { timeline, activeRoomId, teamMembers, sendText } = useMatrixChat();

// ── 画布桥接（M5，design doc §3 Option 1）：舞台嵌入固定版本的 ComfyUI 前端 iframe
//    （同源 /comfy/index.html），父页面通过版本化 postMessage 桥（@dsh-movie/protocol/bridge）
//    驱动图加载、节点状态徽章与多人只读锁；iframe 内运行我们自有的桥接扩展。iframe 就绪后
//    自动加载六步演示工作流；「运行演示生命周期」向网关 POST /comfy/api/prompt，由 Leg B 生命周期
//    事件经 iframe 的 WS 回灌，实时给节点上色，验证 §3 决策门 (a)(b)(c)(d) 四条标准。──
const canvasFrame = ref<HTMLIFrameElement>();
const canvasReady = ref(false);
const selectedNode = ref<number | null>(null);
const runningDemo = ref(false);
const previewReadonly = ref(false);
const paintedCount = ref(0);
const bridge = useCanvasBridge(canvasFrame);

// ── M6：产物检视器 + 图持久化 + 实时状态。
//    execStatus 打开一条父页面侧 Leg B /ws（与 iframe 自有 socket 并存于网关共享的 execClients），
//    把 executing/progress/executed/execution_error 折叠成按节点 id 的状态与产物输出。
//    workflowStore 走 Leg C workflow/get|put：宿主是图的权威（内存、房间级、乐观并发 baseRev）。
//    currentGraph 缓存最近一次加载/导出的图，供节点选中时解析 MOVIE_NODES 架构。──
const execStatus = useExecStatus();
const workflowStore = useWorkflowStore();
const currentGraph = ref<WorkflowGraph | null>(null);

// ── P3-M5：主机独占协作（design doc §4）。roomRole 解析 auth/role 并订阅唯一的
//    workflow/watch mux（实时收敛 + 角色变更）；workspace 承载主机草稿自动保存
//    （workspace/draft.put，防抖）、撤销/重做、提交、历史与回滚，并对非主机观众强制
//    只读（bridge.setReadonly(!isHost)）。程序化加载在 suppress 守卫内进行，避免回灌
//    触发主机自动保存。workflowStore 仅保留给 AI 编排执行器的原子提交（host-only）。──
const roomIdRef = computed(() => activeRoomId.value ?? "");
const roomRole = useRoomRole(roomIdRef);
const workspace = useWorkspaceGraph(roomIdRef, bridge, roomRole);

async function applyGraph(graph: WorkflowGraph): Promise<void> {
  currentGraph.value = graph;
  await workspace.applyGraph(graph);
}

/** Load the room's graph (host draft / committed HEAD, or seed the demo) into the canvas. */
async function hydrate(roomId: string): Promise<void> {
  workspace.reset();
  execStatus.reset();
  if (!roomId) {
    await applyGraph(buildDemoWorkflow());
    return;
  }
  // Ensure the role is fresh before choosing draft (host) vs HEAD (viewer).
  await roomRole.refresh();
  const graph = await workspace.hydrate();
  if (graph) {
    await applyGraph(graph);
    return;
  }
  // Empty room: show the demo locally; only the host seeds it as revision 1.
  const demo = buildDemoWorkflow();
  await applyGraph(demo);
  if (roomRole.isHost.value) await workflowStore.save(roomId, demo).catch(() => {});
}

bridge.onReady(() => {
  canvasReady.value = true;
  void hydrate(activeRoomId.value);
});
bridge.onNodeSelected((id) => { selectedNode.value = id; });
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

// ── 产物检视器派生状态：把选中节点 id 解析成 MOVIE_NODES 架构 + 实时状态 + 产物输出。──
const selectedSchema = computed(() => {
  const id = selectedNode.value;
  if (id === null || !currentGraph.value) return undefined;
  return nodeSchemaForId(currentGraph.value, id);
});
const selectedStatus = computed<NodeRunStatus>(() =>
  selectedNode.value === null ? "idle" : execStatus.statusOf(selectedNode.value),
);
const outputTypes = computed(() => {
  const outputs = selectedSchema.value?.outputs ?? [];
  return outputs.length > 0 ? outputs.map((slot) => slot.type).join(", ") : "—";
});
const outputSummary = computed(() => {
  const id = selectedNode.value;
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
  await workspace.undo();
  if (workspace.lastError.value) ElMessage.error(`${translate("撤销失败")}: ${workspace.lastError.value}`);
}

async function onRedo() {
  await workspace.redo();
  if (workspace.lastError.value) ElMessage.error(`${translate("重做失败")}: ${workspace.lastError.value}`);
}

async function onCommit() {
  const message = window.prompt(translate("提交说明"), "") ?? "";
  const record = await workspace.commit(message.trim());
  if (record === null) {
    ElMessage.error(`${translate("提交失败")}: ${workspace.lastError.value ?? ""}`);
    return;
  }
  ElMessage.success(`${translate("已提交")} r${record.rev}`);
}

async function onRevert(rev: number) {
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

// ── 停靠式聊天框分栏：右列宽度由可拖拽分隔条实时调整，夹紧到 [320, 55vw]；
//    默认取舞台列宽度的 1/3（挂载时按实际容器宽度计算一次），拖拽后以拖拽值为准。聊天框常开。──
const CHAT_MIN = 320;
const studioEl = ref<HTMLElement>();
const chatWidth = ref(400);
const resizing = ref(false);
function applyDefaultChatWidth() {
  const panel = studioEl.value?.clientWidth ?? 0;
  if (!panel) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, Math.round((panel * 2) / 3)));
}
function onResizeDown(event: PointerEvent) {
  event.preventDefault();
  resizing.value = true;
  document.addEventListener("pointermove", onResizeMove);
  document.addEventListener("pointerup", onResizeUp);
}
function onResizeMove(event: PointerEvent) {
  if (!resizing.value) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, window.innerWidth - event.clientX));
}
function onResizeUp() {
  if (!resizing.value) return;
  resizing.value = false;
  document.removeEventListener("pointermove", onResizeMove);
  document.removeEventListener("pointerup", onResizeUp);
}

// ── 媒体查看器：视频 / 图片 / 只读文本预览（与群聊页同一套逻辑）。──
type ViewerKind = "video" | "image" | "text";
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

function goLogin() {
  void router.push({ path: "/account", query: { login: "1", redirect: "/studio" } });
}

onMounted(() => { applyDefaultChatWidth(); });
onScopeDispose(() => { onResizeUp(); });
</script>

<template>
  <div ref="studioEl" class="studio">
    <!-- Signed out: the router guard normally bounces to /account, but keep a guide for safety. -->
    <section v-if="!auth.signedIn" class="signedOut">
      <el-empty :description="translate('登录后即可进入工作室')">
        <el-button type="primary" @click="goLogin">{{ translate("登录") }}</el-button>
      </el-empty>
    </section>

    <template v-else>
      <!-- 左列：舞台（模式切换器 + ComfyUI iframe 画布，M5 已接入）。 -->
      <div class="stageCol">
        <div class="toolbar">
          <modeSwitcher mode="step-by-step" />
        </div>
        <div class="stage">
          <div class="canvasBar">
            <el-button size="small" :disabled="!canvasReady" :loading="runningDemo" @click="runDemoLifecycle">
              {{ translate("运行演示生命周期") }}
            </el-button>
            <el-button size="small" :disabled="!canvasReady || !roomRole.isHost.value" @click="reloadDemo">
              {{ translate("重载演示图") }}
            </el-button>
            <el-input
              v-model="aiIntent"
              class="aiInput"
              size="small"
              :placeholder="translate('用自然语言编排画布，例如：把剧本节点连到分镜节点')"
              :disabled="!canvasReady || aiRunning || !roomRole.isHost.value"
              @keyup.enter="submitAiIntent" />
            <el-button
              size="small"
              type="primary"
              :disabled="!canvasReady || aiIntent.trim() === '' || !roomRole.isHost.value"
              :loading="aiRunning"
              @click="submitAiIntent">
              {{ translate("AI 编排画布") }}
            </el-button>
            <span v-if="aiRunning" class="aiStage">{{ stageLabel(canvasScript.stage.value) }}</span>
            <span
              class="liveDot"
              :class="{ on: execStatus.connected.value }"
              :title="execStatus.connected.value ? translate('实时状态已连接') : translate('实时状态未连接')" />
            <span class="canvasHint">
              <template v-if="!canvasReady">{{ translate("画布正在启动……") }}</template>
              <template v-else-if="selectedNode !== null">{{ translate("已选中节点 #") }}{{ selectedNode }}</template>
              <template v-else>{{ translate("点击画布节点以查看选中项") }}</template>
            </span>
          </div>
          <!-- P3-M5：主机治理条。主持人：撤销/重做/提交/移交 + 只读预览；成员：只读横幅 + 请求移交。
               右侧常驻当前修订号（含草稿标记）与版本历史开关。 -->
          <div class="govBar">
            <template v-if="roomRole.isHost.value">
              <span class="hostBadge" :title="translate('当前主持人')">{{ translate("主持人") }}：{{ hostName }}</span>
              <el-button size="small" :disabled="workspace.undoDepth.value === 0 || workspace.busy.value" @click="onUndo">
                {{ translate("撤销") }}
              </el-button>
              <el-button size="small" :disabled="workspace.redoDepth.value === 0 || workspace.busy.value" @click="onRedo">
                {{ translate("重做") }}
              </el-button>
              <el-button
                size="small"
                type="primary"
                :disabled="!workspace.hasDraft.value || workspace.busy.value"
                @click="onCommit">
                {{ translate("提交版本") }}
              </el-button>
              <el-button size="small" :disabled="transferCandidates.length === 0" @click="openTransferDialog">
                {{ translate("移交主持人") }}
              </el-button>
              <el-button size="small" text :disabled="!canvasReady" @click="togglePreview">
                {{ previewReadonly ? translate("退出只读预览") : translate("只读预览") }}
              </el-button>
            </template>
            <template v-else>
              <span class="readonlyBanner">{{ translate("只读模式：仅主持人可编辑画布") }}</span>
              <el-button size="small" :disabled="!roomRole.host.value" @click="onRequestHost">
                {{ translate("请求成为主持人") }}
              </el-button>
            </template>
            <span class="govSpacer" />
            <span class="revBadge" :title="translate('图修订号')">
              r{{ workspace.rev.value }}<template v-if="workspace.hasDraft.value"> · {{ translate("草稿") }}</template>
            </span>
            <el-button size="small" text @click="historyOpen = !historyOpen">
              {{ historyOpen ? translate("收起历史") : translate("版本历史") }}
            </el-button>
          </div>
          <!-- P3-M5：版本历史面板。点击查看把某个已提交快照载入画布（不移动 HEAD）；主持人可回滚。 -->
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
          <!-- P3-M3：最近一次 AI 编排的逐条操作结果（成功/失败/跳过）。 -->
          <div v-if="canvasScript.opResults.value.length > 0" class="aiResults">
            <span class="aiResultsTitle">{{ translate("AI 操作结果") }}</span>
            <ul class="aiResultsList">
              <li
                v-for="entry in canvasScript.opResults.value"
                :key="entry.index"
                :class="entry.ok ? 'ok' : 'bad'">
                #{{ entry.index }} · {{ entry.op.op }}<template v-if="!entry.ok"> — {{ entry.error }}</template>
              </li>
            </ul>
          </div>
          <!-- P3-M4：影片流水线控制条 + 六步进度带。 -->
          <div class="movieBar">
            <el-input
              v-model="movieIntent"
              class="movieInput"
              size="small"
              :placeholder="translate('描述你想生成的影片，例如：一只猫在月球上跳舞')"
              :disabled="!canvasReady || movieRunning || !roomRole.isHost.value"
              @keyup.enter="submitMovieIntent" />
            <el-button
              size="small"
              type="primary"
              :disabled="!canvasReady || movieIntent.trim() === '' || !roomRole.isHost.value"
              :loading="movieRunning"
              @click="submitMovieIntent">
              {{ translate("运行影片") }}
            </el-button>
            <span v-if="movieRunning" class="movieStage">
              {{ movieStageLabel(movieRun.stage.value) }} · {{ movieDoneCount }}/6
            </span>
          </div>
          <div v-if="movieRun.steps.value.length > 0" class="movieStrip">
            <span class="movieStripTitle">{{ translate("影片流水线") }}</span>
            <ol class="movieSteps">
              <li
                v-for="step in movieRun.steps.value"
                :key="step.step"
                :class="step.status">
                <span class="movieStepIdx">{{ step.step }}</span>
                <span class="movieStepName">{{ movieStepName(step.classType) }}</span>
                <span class="movieStepStatus">{{ movieStepStatusLabel(step.status) }}</span>
                <span v-if="step.media" class="movieStepMedia">{{ translate("占位") }}</span>
              </li>
            </ol>
          </div>
          <div class="stageBody">
            <iframe
              ref="canvasFrame"
              class="canvasFrame"
              :src="bridge.iframeSrc"
              :title="translate('工作流画布')" />
            <!-- M6 产物检视器：选中节点时展示其步骤、产物类型、实时状态与最近输出。 -->
            <aside v-if="selectedNode !== null" class="inspector">
              <div class="inspectorHead">
                <span class="inspectorTitle">
                  {{ selectedSchema?.displayName ?? translate("节点") }} · #{{ selectedNode }}
                </span>
                <el-button text size="small" @click="selectedNode = null">{{ translate("关闭") }}</el-button>
              </div>
              <dl class="inspectorList">
                <div class="row">
                  <dt>{{ translate("步骤") }}</dt>
                  <dd>{{ selectedSchema ? `${selectedSchema.step} / 6` : "—" }}</dd>
                </div>
                <div class="row">
                  <dt>{{ translate("类型") }}</dt>
                  <dd>{{ selectedSchema?.classType ?? "—" }}</dd>
                </div>
                <div class="row">
                  <dt>{{ translate("产物") }}</dt>
                  <dd>{{ outputTypes }}</dd>
                </div>
                <div class="row">
                  <dt>{{ translate("状态") }}</dt>
                  <dd>
                    <el-tag :type="statusTagType(selectedStatus)" size="small" disable-transitions>
                      {{ statusLabel(selectedStatus) }}
                    </el-tag>
                  </dd>
                </div>
              </dl>
              <p v-if="selectedSchema?.description" class="inspectorDesc">{{ selectedSchema.description }}</p>
              <div class="outputBlock">
                <div class="outputLabel">{{ translate("最近产物输出") }}</div>
                <pre class="outputPre">{{ outputSummary || translate("尚无输出，运行演示生命周期后查看") }}</pre>
              </div>
              <div v-if="selectedMovieStep?.artifact" class="outputBlock">
                <div class="outputLabel">
                  {{ translate("影片步骤产物") }}
                  <template v-if="selectedMovieStep.media">（{{ translate("占位") }}）</template>
                </div>
                <pre class="outputPre">{{ selectedMovieStep.artifact }}</pre>
              </div>
            </aside>
          </div>
        </div>
      </div>

      <!-- 可拖拽分隔条：调整右侧停靠聊天框宽度。 -->
      <div
        class="divider"
        :class="{ active: resizing }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="onResizeDown" />

      <!-- 右列：常驻停靠聊天框，复用群聊组件（分步模式）。 -->
      <div class="chatCol" :style="{ width: `${chatWidth}px` }">
        <groupChat
          embedded
          mode="step-by-step"
          @select-video="openVideo($event, false)"
          @play-video="openVideo($event, true)"
          @stage-image="openImage"
          @stage-file="openFile" />
      </div>

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
    </template>

    <!-- 媒体查看器：视频 / 图片 / 只读文本预览。 -->
    <el-dialog
      v-model="viewerVisible"
      :title="viewerName"
      width="70%"
      top="6vh"
      append-to-body
      destroy-on-close
      class="viewerDialog">
      <video v-if="viewerKind === 'video'" :src="viewerUrl" class="viewerMedia" controls :autoplay="autoPlay" />
      <img v-else-if="viewerKind === 'image'" :src="viewerUrl" class="viewerMedia" :alt="viewerName" />
      <pre v-else class="viewerText">{{ viewerText }}</pre>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.studio {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--el-bg-color);
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

.stageCol {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex: 0 0 auto;
}

.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--el-bg-color) 96%, var(--el-text-color-primary));
}

.canvasBar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
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
  flex: 0 0 auto;
  max-height: 220px;
  overflow: auto;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
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

.stageBody {
  flex: 1;
  min-height: 0;
  display: flex;
}

.canvasFrame {
  flex: 1 1 auto;
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 0;
  border: 0;
  background: #202124;
}

.inspector {
  flex: 0 0 300px;
  width: 300px;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  border-inline-start: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.inspectorHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.inspectorTitle {
  font-weight: 600;
  font-size: 14px;
}

.inspectorList {
  margin: 0 0 12px;

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px dashed var(--el-border-color-lighter);
  }

  dt {
    flex: 0 0 48px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  dd {
    margin: 0;
    flex: 1;
    font-size: 13px;
    word-break: break-word;
  }
}

.inspectorDesc {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
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

.divider {
  flex: 0 0 auto;
  width: 6px;
  cursor: col-resize;
  background: var(--el-border-color-lighter);
  transition: background 0.15s ease;

  &:hover,
  &.active {
    background: var(--el-color-primary-light-5);
  }
}

.chatCol {
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
  position: relative;
  border-inline-start: 1px solid var(--el-border-color-lighter);
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
</style>
