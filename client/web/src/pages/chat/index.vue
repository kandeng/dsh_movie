<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import groupChat from "@/components/groupChat.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { previewKind, type TextPreviewKind } from "@/utils/textPreview";

// Chat page (one-shot view). The room timeline, input area and room management
// all live in the shared groupChat component; this page only keeps page-level
// concerns: the signed-out guide and a lightweight media viewer dialog that
// opens when the user selects/plays a video, views an image, or previews a file.
// Matrix state is a module-level singleton, so we read `timeline` directly here
// and share the same data with groupChat.
const auth = useAuthStore();
const router = useRouter();
const { timeline, activeRoomId } = useMatrixChat();

// ── Media viewer dialog state ──
type ViewerKind = "video" | "image" | "text";
const viewerVisible = ref(false);
const viewerKind = ref<ViewerKind>("video");
const viewerUrl = ref("");
const viewerName = ref("");
const viewerText = ref("");
const viewerTextKind = ref<TextPreviewKind>("text");
// Bumping the play token re-triggers autoplay when "play" is chosen.
const playToken = ref(0);
const autoPlay = computed(() => playToken.value > 0);

// Preview cap of 5MB: larger text files are slow to read/render, prompt download.
const PREVIEW_MAX = 5 * 1024 * 1024;

// Switching rooms or deleting the shown message closes the viewer.
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
  router.push({ path: "/account", query: { login: "1", redirect: "/chat" } });
}
</script>

<template>
  <main class="chat">
    <!-- Signed out: page-level guide only; login itself lives on the account page. -->
    <section v-if="!auth.signedIn" class="signedOut">
      <el-empty :description="translate('登录后即可参与群聊')">
        <el-button type="primary" @click="goLogin">{{ translate("登录") }}</el-button>
      </el-empty>
    </section>

    <!-- Signed in: the shared room-timeline chat fills the page. -->
    <div v-else class="chatColumn">
      <groupChat
        mode="one-shot"
        @select-video="openVideo($event, false)"
        @play-video="openVideo($event, true)"
        @stage-image="openImage"
        @stage-file="openFile"
      />
    </div>

    <!-- Lightweight media viewer: video / image / read-only text preview. -->
    <el-dialog
      v-model="viewerVisible"
      :title="viewerName"
      width="70%"
      top="6vh"
      append-to-body
      destroy-on-close
      class="viewerDialog"
    >
      <video
        v-if="viewerKind === 'video'"
        :src="viewerUrl"
        class="viewerMedia"
        controls
        :autoplay="autoPlay"
      />
      <img v-else-if="viewerKind === 'image'" :src="viewerUrl" class="viewerMedia" :alt="viewerName" />
      <pre v-else class="viewerText">{{ viewerText }}</pre>
    </el-dialog>
  </main>
</template>

<style lang="scss" scoped>
.chat {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  // Pin the base font size to 14px for consistency across pages.
  font-size: 14px;
}

.signedOut {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

.chatColumn {
  position: relative;
  flex: 1;
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
</style>
