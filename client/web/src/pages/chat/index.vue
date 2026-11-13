<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import groupChat from "@/components/groupChat.vue";
import modeSwitcher from "@/components/modeSwitcher.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { previewKind, type TextPreviewKind } from "@/utils/textPreview";
import videoStage from "./components/videoStage.vue";

// Chat page (one-shot view). The room timeline, input area and room management all
// live in the shared groupChat component; this page keeps the page-level concerns:
// the signed-out guide, the left media stage (video player + image + in-stage text
// reader + pencil/screenshot toolbox), and the draggable divider between the stage
// and the docked chatbox. Matrix state is a module-level singleton, so we read
// `timeline` directly here and share the same data with groupChat.
const auth = useAuthStore();
const router = useRouter();
const { timeline, activeRoomId } = useMatrixChat();

// ── Stage selection state ──
const selectedVideoId = ref("");
const videoItems = computed(() =>
  timeline.value.filter(m => m.msgtype === "m.video" && m.url).map(m => ({ id: m.id, url: m.url!, name: m.body })),
);
// Bumping the play token (right-click "play") auto-starts playback; plain card select does not.
const playToken = ref(0);
// Image state for the main panel: shown in place of the player until a video is
// selected/played, the room changes, or the message is redacted.
const stageImage = ref<{ id: string; url: string; name: string } | null>(null);
// Read-only text state for the main panel (mutually exclusive with the image state).
const stageText = ref<{ id: string; name: string; content: string; kind: TextPreviewKind } | null>(null);
// Preview cap of 5MB: larger text files are slow to read/render, prompt download.
const PREVIEW_MAX = 5 * 1024 * 1024;
watch(activeRoomId, () => { stageImage.value = null; stageText.value = null; });
// If the shown image/file message is redacted, the timeline no longer has that id:
// retract the stage display so we never dangle a stale blob.
watch(timeline, list => {
  const shownImage = stageImage.value;
  if (shownImage && !list.some(m => m.id === shownImage.id)) stageImage.value = null;
  const shownText = stageText.value;
  if (shownText && !list.some(m => m.id === shownText.id)) stageText.value = null;
});

function onSelectVideo(id: string) {
  stageImage.value = null;
  stageText.value = null;
  selectedVideoId.value = id;
}

function onPlayVideo(id: string) {
  stageImage.value = null;
  stageText.value = null;
  selectedVideoId.value = id;
  playToken.value++;
}

function onStageImage(id: string) {
  const msg = timeline.value.find(m => m.id === id);
  if (!msg?.url) return;
  stageText.value = null;
  stageImage.value = { id, url: msg.url, name: msg.body || translate("图片") };
}

// Attachment text preview: the blob is already an authenticated-media local URL, so
// fetch it directly; the render form comes from previewKind (text/json/markdown/html).
async function onStageFile(id: string) {
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
    stageImage.value = null;
    stageText.value = { id, name: msg.body || translate("文件"), content, kind };
  } catch {
    ElMessage.error(translate("读取文件失败，请稍后重试"));
  }
}

function goLogin() {
  router.push({ path: "/account", query: { login: "1", redirect: "/chat" } });
}

// ── Draggable divider between the stage and the chat column ──
// pointerdown records the start; pointermove derives the right-column width from
// window width - clientX, clamped to [CHAT_MIN, vw*0.55].
const CHAT_MIN = 320;
const chatWidth = ref(400);
const resizing = ref(false);
const chatEl = ref<HTMLElement>();

// Default right-column (chatbox) width is 1/3 of the main panel width, computed once
// on mount; after the user drags, the dragged value wins.
function applyDefaultChatWidth() {
  const panel = chatEl.value?.clientWidth ?? 0;
  if (!panel) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, Math.round(panel / 3)));
}
onMounted(applyDefaultChatWidth);

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
onBeforeUnmount(onResizeUp);
</script>

<template>
  <main ref="chatEl" class="chat" :style="{ '--chat-w': chatWidth + 'px' }">
    <!-- Signed out: page-level guide only; login itself lives on the account page. -->
    <section v-if="!auth.signedIn" class="signedOut">
      <el-empty :description="translate('登录后即可参与群聊')">
        <el-button type="primary" @click="goLogin">{{ translate("登录") }}</el-button>
      </el-empty>
    </section>

    <template v-else>
      <!-- Left column: the video-play & screenshot stage; clicking an image or a
           previewable attachment swaps the same slot to image / text display. -->
      <videoStage :items="videoItems" v-model="selectedVideoId" :play-token="playToken" :image="stageImage" :text="stageText" />

      <!-- In-place mode switcher: one-shot (this page) ↔ step-by-step (/studio),
           floating over the horizontal center of the stage without affecting the grid. -->
      <modeSwitcher class="modeSwitch" mode="one-shot" />

      <!-- Draggable vertical divider: drag left/right to resize the chat column live. -->
      <div class="chatResize" :class="{ dragging: resizing }" @pointerdown="onResizeDown" />

      <!-- Right column: the shared room-timeline chatbox (same component as Studio).
           Image/text preview now happens in the main panel, not overlaid here. -->
      <div class="chatColumn">
        <groupChat
          mode="one-shot"
          @select-video="onSelectVideo"
          @play-video="onPlayVideo"
          @stage-image="onStageImage"
          @stage-file="onStageFile"
        />
      </div>
    </template>
  </main>
</template>

<style lang="scss" scoped>
.chat {
  position: relative;
  display: grid;
  // Three columns: stage (flex fill) + 4px divider + chatbox (width from --chat-w).
  grid-template-columns: minmax(0, 1fr) 4px var(--chat-w, 400px);
  height: 100%;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  // Pin the base font size to 14px for consistency across pages.
  font-size: 14px;
}

.signedOut {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

// Right column container: the chatbox fills it.
.chatColumn {
  position: relative;
  min-width: 0;
  min-height: 0;
}

// Mode switcher floats over the horizontal center of the stage (left column):
// left-column width = 100% - divider(4px) - right column(--chat-w).
.modeSwitch {
  position: absolute;
  top: 12px;
  left: calc((100% - var(--chat-w, 400px) - 4px) / 2);
  z-index: 6;
  transform: translateX(-50%);
}

// Same divider treatment as the Studio page: a 4px hit area with a centered 1px
// vertical line that lights up primary on hover/drag.
.chatResize {
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
</style>
