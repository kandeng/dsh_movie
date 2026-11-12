<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import groupChat from "@/components/groupChat.vue";
import modeSwitcher from "@/components/modeSwitcher.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { useCanvasBridge } from "@/composables/useCanvasBridge";
import { buildDemoWorkflow, buildDemoPrompt } from "@/utils/demoWorkflow";
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

bridge.onReady(() => {
  canvasReady.value = true;
  void bridge.loadWorkflow(buildDemoWorkflow());
});
bridge.onNodeSelected((id) => { selectedNode.value = id; });
bridge.onExecPainted(() => { paintedCount.value += 1; });
bridge.onBridgeError(({ message }) => {
  ElMessage.error(`${translate("画布桥接错误")}: ${message}`);
});

async function runDemoLifecycle() {
  if (runningDemo.value) return;
  runningDemo.value = true;
  paintedCount.value = 0;
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
  void bridge.loadWorkflow(buildDemoWorkflow());
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
            <span class="canvasHint">
              <template v-if="!canvasReady">{{ translate("画布正在启动……") }}</template>
              <template v-else-if="selectedNode !== null">{{ translate("已选中节点 #") }}{{ selectedNode }}</template>
              <template v-else>{{ translate("点击画布节点以查看选中项") }}</template>
            </span>
          </div>
          <iframe
            ref="canvasFrame"
            class="canvasFrame"
            :src="bridge.iframeSrc"
            :title="translate('工作流画布')" />
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

.canvasFrame {
  flex: 1 1 auto;
  display: block;
  width: 100%;
  min-height: 0;
  border: 0;
  background: #202124;
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
