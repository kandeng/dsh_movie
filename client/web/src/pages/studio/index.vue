<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import type { NodeRunStatus, WorkflowGraph } from "@dsh-movie/protocol";
import groupChat from "@/components/groupChat.vue";
import modeSwitcher from "@/components/modeSwitcher.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { useCanvasBridge } from "@/composables/useCanvasBridge";
import { useWorkflowStore } from "@/composables/useWorkflowStore";
import { useExecStatus } from "@/composables/useExecStatus";
import { buildDemoWorkflow, buildDemoPrompt, nodeSchemaForId } from "@/utils/demoWorkflow";
import { previewKind, type TextPreviewKind } from "@/utils/textPreview";

// ACT: 工作室框架外壳（design doc §4.3，M4）。这是「分步生成」模式的页面骨架：
// 左侧是舞台槽位（当前为占位，M5 把 ComfyUI iframe 落进来）；右侧是常驻的停靠式聊天框，
// 直接复用群聊组件（groupChat），顶部挂就地模式切换器（one-shot ↔ step-by-step）。
// 房间状态是模块级单例，groupChat 内部会自行 bootstrap 并按 ?room= 定位活跃房间。
// 有意不移植 vidsay workspace 的重耦合部分：canvasPanel/documentPanel(ProseMirror)/
// useWorkspaceStore/useRoomSpoke/roomGrants/mcpControl/anonymousData/providerBilling/图形同步。
const auth = useAuthStore();
const router = useRouter();
const { timeline, activeRoomId } = useMatrixChat();

// ── 画布桥接（M5，design doc §3 Option 1）：舞台嵌入固定版本的 ComfyUI 前端 iframe
//    （同源 /comfy/index.html），父页面通过版本化 postMessage 桥（@dsh-movie/protocol/bridge）
//    驱动图加载、节点状态徽章与多人只读锁；iframe 内运行我们自有的桥接扩展。iframe 就绪后
//    自动加载六步演示工作流；「运行演示生命周期」向网关 POST /comfy/api/prompt，由 Leg B 生命周期
//    事件经 iframe 的 WS 回灌，实时给节点上色，验证 §3 决策门 (a)(b)(c)(d) 四条标准。──
const canvasFrame = ref<HTMLIFrameElement>();
const canvasReady = ref(false);
const selectedNode = ref<number | null>(null);
const runningDemo = ref(false);
const readonlyLock = ref(false);
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
// Suppress the save round-trip while a programmatic load settles (the bridge
// debounces `graphChanged` 400ms, so a 600ms guard covers the echo).
let suppressSave = false;

async function applyGraph(graph: WorkflowGraph): Promise<void> {
  suppressSave = true;
  currentGraph.value = graph;
  try {
    await bridge.loadWorkflow(graph);
  } finally {
    setTimeout(() => { suppressSave = false; }, 600);
  }
}

/** Load the room's persisted graph (or seed + save the demo) into the canvas. */
async function hydrate(roomId: string): Promise<void> {
  workflowStore.reset();
  execStatus.reset();
  if (!roomId) {
    await applyGraph(buildDemoWorkflow());
    return;
  }
  try {
    const record = await workflowStore.load(roomId);
    if (record) {
      await applyGraph(record.graph);
    } else {
      const demo = buildDemoWorkflow();
      await applyGraph(demo);
      await workflowStore.save(roomId, demo).catch(() => {});
    }
  } catch {
    // Persistence unavailable (e.g. signed-out token): fall back to a local demo.
    await applyGraph(buildDemoWorkflow());
  }
}

bridge.onReady(() => {
  canvasReady.value = true;
  void hydrate(activeRoomId.value);
});
bridge.onNodeSelected((id) => { selectedNode.value = id; });
bridge.onExecPainted(() => { paintedCount.value += 1; });
bridge.onGraphChanged(({ graph }) => {
  currentGraph.value = graph;
  if (suppressSave) return;
  const roomId = activeRoomId.value;
  if (roomId) void workflowStore.save(roomId, graph).catch(() => {});
});
bridge.onBridgeError(({ message }) => {
  ElMessage.error(`${translate("画布桥接错误")}: ${message}`);
});

// Another collaborator won the write: adopt the host's current graph.
workflowStore.onConflict(({ current }) => {
  void applyGraph(current.graph);
  ElMessage.warning(translate("画布已被其他协作者更新，已同步最新版本"));
});

watch(activeRoomId, (roomId) => {
  if (canvasReady.value) void hydrate(roomId);
});

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

function toggleReadonly() {
  readonlyLock.value = !readonlyLock.value;
  bridge.setReadonly(readonlyLock.value);
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
            <el-button size="small" :disabled="!canvasReady" @click="reloadDemo">
              {{ translate("重载演示图") }}
            </el-button>
            <el-button size="small" :disabled="!canvasReady" @click="toggleReadonly">
              {{ readonlyLock ? translate("解除只读锁") : translate("设为只读") }}
            </el-button>
            <span
              class="liveDot"
              :class="{ on: execStatus.connected.value }"
              :title="execStatus.connected.value ? translate('实时状态已连接') : translate('实时状态未连接')" />
            <span class="revBadge" :title="translate('图修订号')">
              r{{ workflowStore.currentRev.value }}<template v-if="workflowStore.saving.value">…</template>
            </span>
            <span class="canvasHint">
              <template v-if="!canvasReady">{{ translate("画布正在启动……") }}</template>
              <template v-else-if="selectedNode !== null">{{ translate("已选中节点 #") }}{{ selectedNode }}</template>
              <template v-else>{{ translate("点击画布节点以查看选中项") }}</template>
            </span>
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
