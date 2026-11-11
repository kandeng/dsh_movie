<template>
  <section class="chatPanel" :class="{ embedded }">
    <header class="chatHeader">
      <el-select
        class="roomSelect"
        :model-value="activeRoomId || undefined"
        :placeholder="translate('切换群聊')"
        :disabled="!ready"
        @update:model-value="setActiveRoom">
        <el-option v-for="room in joinedRooms" :key="room.id" :label="room.name" :value="room.id" />
      </el-select>
      <span class="chatStatus">
        <el-tag v-if="chatError" type="danger" size="small" effect="plain">{{ translate("连接失败") }}</el-tag>
        <el-tag v-else-if="connecting" type="info" size="small" effect="plain">{{ translate("连接中…") }}</el-tag>
        <el-tag v-else-if="ready" type="success" size="small" effect="plain">{{ translate("已连接") }}</el-tag>
        <el-tag v-else type="info" size="small" effect="plain">{{ translate("未连接") }}</el-tag>
        <el-tag v-if="isHost" type="warning" size="small" effect="plain">{{ translate("主持人") }}</el-tag>
      </span>
      <div class="chatHeaderActions">
        <el-popover v-if="invites.length" placement="bottom-end" :width="260" trigger="click">
          <template #reference>
            <el-badge :value="invites.length" :max="9" class="inviteBadge">
              <button class="roomAction" type="button" :aria-label="translate('待接受邀请')">
                <icon-bell :size="18" aria-hidden="true" />
              </button>
            </el-badge>
          </template>
          <ul class="inviteList">
            <li v-for="room in invites" :key="room.id">
              <span class="inviteName">{{ room.name }}</span>
              <el-button size="small" type="primary" plain :loading="busyRoom === room.id" :disabled="!ready" @click="accept(room.id)">
                {{ translate("加入") }}
              </el-button>
            </li>
          </ul>
        </el-popover>
        <el-tooltip :content="translate('新建群聊')" placement="bottom" :show-after="100">
          <button class="roomAction" type="button" :disabled="!ready" :aria-label="translate('新建群聊')" @click="createVisible = true">
            <icon-plus :size="18" aria-hidden="true" />
          </button>
        </el-tooltip>
      </div>
    </header>

    <el-scrollbar ref="scroller" class="chatBody">
      <div class="messageList">
        <p v-if="!activeRoomId" class="emptyHint">{{ translate("还没有群聊，点右上角新建一个。") }}</p>
        <p v-else-if="!timeline.length" class="emptyHint">{{ translate("还没有消息，发送第一条开始讨论吧。") }}</p>
        <div v-for="msg in timeline" :key="msg.id" class="messageRow" :class="{ mine: msg.mine, anchored: anchoredId === msg.id }" :data-event-id="msg.id" @contextmenu.prevent="openQuoteMenu($event, msg)">
          <!-- ACT: 圆形头像置于气泡外侧（他人左/自己右）；无头像时用首字母占位圆。 -->
          <span v-if="!msg.mine" class="msgAvatar" :aria-label="msg.senderName">
            <img v-if="msg.senderAvatar" :src="msg.senderAvatar" :alt="msg.senderName" />
            <span v-else class="initial">{{ msg.senderName.charAt(0) }}</span>
          </span>
          <div class="bubble">
            <div class="meta">
              <span class="time">{{ formatTime(msg.ts) }}</span>
            </div>
            <button v-if="msg.msgtype === 'm.video' && msg.url" type="button" class="videoCard" :class="{ active: msg.id === selectedVideoId }" @click="selectVideo(msg.id)">
              <!-- ACT: 封面图：优先消息自带缩略图（info.thumbnail_url）；没有时用 <video #t=0.1> 取首帧当默认封面。 -->
              <img v-if="msg.thumb" class="videoCardThumb" :src="msg.thumb" :alt="msg.body || translate('视频')" />
              <video v-else class="videoCardThumb" :src="`${msg.url}#t=0.1`" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true" />
            </button>
            <!-- ACT: 点击图片交主面板（与视频播放器同位）展示；工作室无主面板，保留 el-image 全屏预览。 -->
            <el-image
              v-else-if="msg.msgtype === 'm.image' && msg.url"
              class="media"
              :class="{ clickable: !embedded }"
              :src="msg.url"
              fit="contain"
              :preview-src-list="embedded ? [msg.url] : []"
              @click="openStageImage(msg.id)" />
            <!-- ACT: 附件卡片：可文本预览的（txt/json/md/html/源码等）点击进主面板阅读；其余仍按原文件名下载。 -->
            <button
              v-else-if="msg.msgtype === 'm.file' && msg.url"
              type="button"
              class="fileCard"
              :title="filePreviewable(msg) ? translate('预览') : translate('下载')"
              @click="onFileCard(msg)">
              <span class="fileCardIcon" :style="{ '--tool-icon': `url(&quot;${iconFileUpload}&quot;)` }" aria-hidden="true" />
              <span class="fileCardName">{{ msg.body || translate("文件") }}</span>
            </button>
            <p class="text">{{ msg.body }}</p>
            <!-- ACT: 微信式引用条：回复消息下方以灰底小字展示被引用消息（发送者+正文摘要），点击跳回原文。 -->
            <button v-if="msg.quote" type="button" class="quote" @click="jumpToEvent(msg.quote.id)">
              <span class="quoteSender">{{ msg.quote.senderName }}: </span><span class="quoteBody">{{ msg.quote.body }}</span>
            </button>
          </div>
          <span v-if="msg.mine" class="msgAvatar" :aria-label="msg.senderName">
            <img v-if="msg.senderAvatar" :src="msg.senderAvatar" :alt="msg.senderName" />
            <span v-else class="initial">{{ msg.senderName.charAt(0) }}</span>
          </span>
        </div>
      </div>
    </el-scrollbar>

    <div class="typingBar" aria-live="polite">
      <span v-if="typingNames.length">{{ typingNames.join("、") }} 正在输入…</span>
    </div>

    <!-- ACT: 微信式右键菜单：首项按消息类型变化（视频→播放 / 图片→查看 / 文本→复制 / 附件→查看），
         其后恒为「引用」；视频/图片/附件再加「下载」；自己的消息最后可「删除」。 -->
    <div v-if="quoteMenu" class="quoteMenu" :style="{ left: `${quoteMenu.x}px`, top: `${quoteMenu.y}px` }" role="menu">
      <button v-if="!embedded && quoteMenu.msg.msgtype === 'm.video' && quoteMenu.msg.url" type="button" role="menuitem" @click="playFromMenu">{{ translate("播放") }}</button>
      <button v-else-if="!embedded && quoteMenu.msg.msgtype === 'm.image' && quoteMenu.msg.url" type="button" role="menuitem" @click="viewFromMenu">{{ translate("查看") }}</button>
      <button v-else-if="quoteMenu.msg.msgtype === 'm.text'" type="button" role="menuitem" @click="copyFromMenu">{{ translate("复制") }}</button>
      <!-- ACT: 附件「查看」：可文本预览的进主面板阅读，其余直接落盘；工作室（embedded）无主面板不展示。 -->
      <button v-else-if="!embedded && quoteMenu.msg.msgtype === 'm.file' && quoteMenu.msg.url" type="button" role="menuitem" @click="previewFromMenu">{{ translate("查看") }}</button>
      <button type="button" role="menuitem" @click="applyQuote">{{ translate("引用") }}</button>
      <!-- ACT: 视频/图片/附件都能另存到本地磁盘。 -->
      <button v-if="isDownloadable(quoteMenu.msg)" type="button" role="menuitem" @click="downloadFromMenu">{{ translate("下载") }}</button>
      <!-- ACT: 仅自己的消息可删（Matrix redaction）；危险操作红字展示。 -->
      <button v-if="quoteMenu.msg.mine" type="button" role="menuitem" class="danger" @click="deleteFromMenu">{{ translate("删除") }}</button>
    </div>

    <footer class="chatComposer">
      <!-- ACT: 团队弹层：花名册（缩小头像+昵称三色）+ 添加/删除队友（两段式确认）；遮罩层点外关闭。 -->
      <div v-if="teamVisible" class="teamBackdrop" @click="teamVisible = false"></div>
      <div v-if="teamVisible" class="teamPopover" role="dialog" :aria-label="translate('团队')">
        <header class="teamPopoverTitle">{{ translate("团队") }}</header>
        <ul class="teamList">
          <li v-for="member in teamMembers" :key="member.userId" class="teamMember">
            <!-- ACT: 删除/移交流程共用行左单选 radio：删除模式禁选主持人与 AI 客服，移交模式禁选自己。 -->
            <input
              v-if="deleteMode || transferMode"
              type="radio"
              name="teamPick"
              :disabled="pickDisabled(member)"
              :checked="pickTarget === member.userId"
              :aria-label="member.name"
              @change="onPick(member.userId)" />
            <span class="memberAvatar">
              <img v-if="member.avatar" :src="member.avatar" :alt="member.name" />
              <span v-else class="memberInitial">{{ member.name.charAt(0) }}</span>
            </span>
            <!-- ACT: 昵称三色：主持橙；已连接默认色；未连接 50% 减淡（上线后回默认色）。 -->
            <span class="memberName" :class="{ host: member.host, offline: !member.online }">{{ member.name }}</span>
          </li>
        </ul>
        <p v-if="!teamMembers.length" class="teamEmpty">{{ translate("暂无队友") }}</p>
        <!-- ACT: 添加流程输入区：重名候选头像行 / 不存在警告都挂在输入框下方。 -->
        <div v-if="addMode" class="teamAdd">
          <input
            v-model="addInput"
            class="addInput"
            type="text"
            :placeholder="addPlaceholder"
            :aria-label="translate('输入用户 ID')"
            @input="addNotice = ''"
            @keydown.enter.prevent="onAddButton" />
          <p v-if="addNotice" class="addError">{{ addNoticeText }}</p>
          <div v-if="candidateViews.length" class="candidateRow">
            <button
              v-for="item in candidateViews"
              :key="item.userId"
              type="button"
              class="candidate"
              :title="`${item.name} (${item.userId})`"
              @click="pickCandidate(item)">
              <img v-if="item.avatar" :src="item.avatar" :alt="item.name" />
              <span v-else class="memberInitial">{{ item.name.charAt(0) }}</span>
            </button>
          </div>
        </div>
        <div class="teamActions">
          <button type="button" class="teamAction" :disabled="!ready || !activeRoomId || addBusy" @click="onAddButton">
            {{ addLabel }}
          </button>
          <button type="button" class="teamAction danger" :disabled="!ready || !activeRoomId || addBusy" @click="onDeleteButton">
            {{ deleteLabel }}
          </button>
          <!-- ACT: 「移交群主」仅当前主持人可见：两段式，与添加/删除互斥。 -->
          <button v-if="isHost" type="button" class="teamAction" :disabled="!ready || !activeRoomId || addBusy" @click="onTransferButton">
            {{ transferLabel }}
          </button>
        </div>
      </div>
      <!-- ACT: 发送前引用预览条：输入框上方灰底一条展示被引用消息，可点 × 取消。 -->
      <div v-if="pendingQuote" class="quotePreview">
        <span class="quotePreviewText"><b>{{ pendingQuote.senderName }}: </b>{{ pendingQuote.body }}</span>
        <button type="button" class="quotePreviewClose" :aria-label="translate('取消引用')" :title="translate('取消引用')" @click="pendingQuote = null">×</button>
      </div>
      <div class="composerMain">
        <el-input
          v-model="draft"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 5 }"
          resize="none"
          :disabled="!ready || !activeRoomId"
          :placeholder="translate('输入消息，Enter 发送，Shift+Enter 换行')"
          :aria-label="translate('消息输入')"
          @input="noteTyping"
          @keydown.enter.exact.prevent="send" />
        <el-button class="sendButton" type="primary" :disabled="!ready || !activeRoomId || !draft.trim()" :aria-label="translate('发送')" :title="translate('发送')" @click="send">
          <icon-send :size="18" aria-hidden="true" />
        </el-button>
      </div>

      <div class="composerTools">
        <div class="toolGroup">
          <el-button class="toolButton" :aria-label="translate('团队')" :title="translate('团队')" @click="team">
            <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconUserGroup}&quot;)` }" aria-hidden="true" />
          </el-button>
          <el-button class="toolButton" :aria-label="translate('上传文件')" :title="translate('上传文件')" @click="fileInput?.click()">
            <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconFileUpload}&quot;)` }" aria-hidden="true" />
          </el-button>
          <input ref="fileInput" type="file" multiple hidden :disabled="!ready" @change="onPickFiles" />
        </div>
      </div>
    </footer>

    <!-- 新建群聊：仅群名 + 创建/取消（邀请改由 Team 弹层的添加队友完成） -->
    <el-dialog v-model="createVisible" :title="translate('新建群聊')" width="min(420px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false">
      <el-form class="roomForm" label-position="top" @submit.prevent="submitCreate">
        <el-form-item :label="translate('群聊名称')">
          <el-input v-model="createName" maxlength="60" :disabled="actionBusy" :placeholder="translate('例如：我的剧组')" @keydown.enter="submitCreate" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialogFooter">
          <el-button :disabled="actionBusy" @click="createVisible = false">{{ translate("取消") }}</el-button>
          <el-button type="primary" :loading="actionBusy" :disabled="!createName.trim()" @click="submitCreate">{{ translate("创建") }}</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, type ScrollbarInstance } from "element-plus";
import { IconBell, IconPlus, IconSend } from "@tabler/icons-vue";
import { translate } from "@dsh-movie/i18n/vue";
// ACT: 工具按钮图标统一取自 src/icons（CSS mask + currentColor 着色，与全局外壳一致）。
import iconUserGroup from "@/icons/user_group.svg";
import iconFileUpload from "@/icons/file_upload.svg";
import { previewKind } from "@/utils/textPreview";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat, type ChatMessage, type TeamMember } from "@/composables/useMatrixChat";

// ACT: 可复用的「房间时间线聊天框」（计划 Task 3）。它是 Chat 页与 Studio 页共用的同一个组件，
// 只渲染 Matrix 房间时间线 + 输入区，不含模型选择器/提及/工具气泡——customer_service（服务器侧
// pi-coding Agent）的工具与画布活动都以房间消息形式出现在这里，两个模式下渲染完全一致。
// 模式专属控件（生成入口/模型选择/画布工具）一律放在工作室页面 chrome，聊天框保持纯净（Task 6）。
// Matrix 状态是模块级单例，页面与本组件共享同一份 timeline/rooms/activeRoomId。
const props = withDefaults(defineProps<{
  // 内嵌到工作室时为 true：仅用于外观微调（聊天框本身两模式一致）。
  embedded?: boolean;
  // 视图模式：one-shot（群聊页）| step-by-step（工作室）。仅作语义标记，聊天框本身两模式一致。
  mode?: "one-shot" | "step-by-step";
}>(), { embedded: false, mode: "one-shot" });

const emit = defineEmits<{
  // 点击时间线里的视频卡片：由页面决定加载到视频舞台或预览。
  (event: "select-video", id: string): void;
  // ACT: 右键菜单「播放」：页面把该视频载入左栏视频舞台并自动起播。
  (event: "play-video", id: string): void;
  // ACT: 点击时间线图片 / 右键「查看」：页面把该图片载入主面板（与视频播放器同位）展示。
  (event: "stage-image", id: string): void;
  // ACT: 点击可文本预览的附件：页面在主面板只读展示文件内容（缩放调字号）。
  (event: "stage-file", id: string): void;
}>();

const route = useRoute();
const auth = useAuthStore();
const {
  ready, connecting, error: chatError, joinedRooms, invites,
  activeRoomId, isHost, myUserId, timeline, typingNames, pendingQuote,
  teamMembers, inviteTeammate, kickTeammate, transferHost, searchUsers, mediaUrl,
  bootstrap, setActiveRoom, createRoom, acceptInvite,
  sendText, sendFile, deleteMessage, noteTyping,
} = useMatrixChat();

const draft = ref("");
const scroller = ref<ScrollbarInstance>();
const fileInput = ref<HTMLInputElement>();
const createVisible = ref(false);
const createName = ref("");
const busyRoom = ref("");
const actionBusy = ref(false);
// 当前在视频舞台选中的消息（仅用于卡片高亮）；真正的播放由页面处理。
const selectedVideoId = ref("");

function selectVideo(id: string) {
  selectedVideoId.value = id;
  emit("select-video", id);
}

// ── 广场深链：切到指定房间并滚动到指定消息 ──
// ACT: 广场卡片点击带 ?room=&event= 进来：先切房间，再轮询等事件出现在时间线里，
// 然后 scrollIntoView 到该消息并短暂高亮。锚定期间抑制自动滚底。
const anchoredId = ref("");
let suppressAutoScroll = false;
let anchorTimer: ReturnType<typeof setTimeout> | null = null;

async function anchorFromQuery() {
  const roomId = typeof route.query.room === "string" ? route.query.room : "";
  const eventId = typeof route.query.event === "string" ? route.query.event : "";
  if (!roomId || !auth.signedIn || !ready.value) return;
  suppressAutoScroll = !!eventId;
  if (activeRoomId.value !== roomId) setActiveRoom(roomId);
  if (!eventId) { suppressAutoScroll = false; return; }
  const deadline = Date.now() + 5000;
  while (!timeline.value.some(msg => msg.id === eventId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await nextTick();
  suppressAutoScroll = false;
  const wrap = scroller.value?.wrapRef;
  const target = wrap?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`) ?? null;
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  anchoredId.value = eventId;
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = setTimeout(() => { anchoredId.value = ""; }, 2600);
}

// ACT: 引用条点击：滚到被引用消息并短暂高亮（复用锚定的滚动+高亮逻辑）。
function jumpToEvent(eventId: string) {
  const wrap = scroller.value?.wrapRef;
  const target = wrap?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`) ?? null;
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  anchoredId.value = eventId;
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = setTimeout(() => { anchoredId.value = ""; }, 2600);
}
watch([() => route.query.room, () => route.query.event, ready, () => auth.signedIn], () => { void anchorFromQuery(); }, { immediate: true });

// ── 微信式「引用」：右键消息弹菜单，选择后在输入框上方挂引用条，发送时随 in_reply_to 发出 ──
const quoteMenu = ref<{ x: number; y: number; msg: ChatMessage } | null>(null);

function closeQuoteMenu() { quoteMenu.value = null; }

function onQuoteMenuKey(event: KeyboardEvent) { if (event.key === "Escape") quoteMenu.value = null; }

function openQuoteMenu(event: MouseEvent, msg: ChatMessage) {
  // ACT: 菜单最多四项（类型项/引用/下载/删除，约 128px 高）：贴右键位置弹出，靠边时收回视口内。
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 104));
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 136));
  quoteMenu.value = { x, y, msg };
}

function applyQuote() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  pendingQuote.value = { id: msg.id, senderName: msg.senderName, body: msg.body.replace(/\s+/g, " ").trim() };
}

// ACT: 右键菜单「播放」：复用卡片点选的选择链路，再额外发 play-video 让页面自动起播。
function playFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  selectVideo(msg.id);
  emit("play-video", msg.id);
}

// ACT: 右键菜单「查看」（图片）：与左键点击时间线图片一致，都交主面板（与视频播放器同位）展示。
function viewFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  emit("stage-image", msg.id);
}

// ACT: 点击时间线图片：群聊页交主面板（与视频播放器同位）展示；工作室（embedded）无主面板，
// 直接返回，由 el-image 自带的全屏预览接管。
function openStageImage(id: string) {
  if (props.embedded) return;
  emit("stage-image", id);
}

// ACT: 附件是否可进主面板文本预览：按文件名+MIME 判别；工作室无主面板一律不可。
function filePreviewable(msg: ChatMessage) {
  return !props.embedded && previewKind(msg.body || "", msg.mimetype) !== null;
}

function onFileCard(msg: ChatMessage) {
  if (filePreviewable(msg)) emit("stage-file", msg.id);
  else downloadFile(msg);
}

// ACT: 右键菜单「下载」：视频/图片/附件都能按原文件名落盘。
function isDownloadable(msg: ChatMessage) {
  return (msg.msgtype === "m.video" || msg.msgtype === "m.image" || msg.msgtype === "m.file") && !!msg.url;
}

// ACT: 右键菜单「查看」（附件）：复用卡片点击链路，可预览的进主面板阅读，其余直接下载。
function previewFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  onFileCard(msg);
}

function downloadFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  downloadFile(msg);
}

// ACT: 右键菜单「复制」：文本正文进系统剪贴板，可粘贴到输入框或任何地方。
async function copyFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(msg.body);
    ElMessage.success(translate("已复制到剪贴板"));
  } catch {
    ElMessage.error(translate("复制失败，请手动复制"));
  }
}

// ACT: 右键菜单「删除」：只对自己的消息展示，走 redaction 后刷新时间线；失败时 toast 提示。
async function deleteFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  try {
    await deleteMessage(msg.id);
    ElMessage.success(translate("已删除"));
  } catch {
    ElMessage.error(translate("删除失败，请稍后重试"));
  }
}
onBeforeUnmount(() => {
  if (anchorTimer) clearTimeout(anchorTimer);
  window.removeEventListener("click", closeQuoteMenu);
  window.removeEventListener("keydown", onQuoteMenuKey);
});

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function scrollToBottom() {
  if (suppressAutoScroll) return;
  await nextTick();
  const wrap = scroller.value?.wrapRef;
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

async function send() {
  const text = draft.value.trim();
  if (!text || !ready.value || !activeRoomId.value) return;
  draft.value = "";
  try {
    await sendText(text);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发送失败");
  }
}

async function submitCreate() {
  if (actionBusy.value || !createName.value.trim()) return;
  actionBusy.value = true;
  try {
    await createRoom({ name: createName.value });
    createVisible.value = false;
    createName.value = "";
    ElMessage.success("群聊已创建");
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "创建群聊失败");
  } finally {
    actionBusy.value = false;
  }
}

async function accept(roomId: string) {
  if (busyRoom.value) return;
  busyRoom.value = roomId;
  try {
    await acceptInvite(roomId);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加入群聊失败");
  } finally {
    busyRoom.value = "";
  }
}

// ── 团队弹层：花名册（头像+昵称三色）+ 添加/删除队友（每次一人，两段式确认） ──
const teamVisible = ref(false);
// ACT: 添加/删除互斥的两段流：首次点进输入/单选模式且按钮变「确认」，再点执行。
const addMode = ref(false);
const deleteMode = ref(false);
const transferMode = ref(false);
const addInput = ref("");
// ACT: 输入框下方内联警告：missing＝该队友不存在；inteam＝该队友已在团队中（含直接输入主持人 ID 的情形）。
const addNotice = ref<"" | "missing" | "inteam">("");
const addBusy = ref(false);
const deleteTarget = ref("");
const transferTarget = ref("");
// ACT: 删除/移交共用的单选态：按当前模式读写各自的 target。
const pickTarget = computed(() => (deleteMode.value ? deleteTarget.value : transferTarget.value));
function pickDisabled(member: TeamMember) {
  // ACT: 删除保护＝当前主持人（卸任后可删）+ AI 客服；移交保护＝自己 + AI 客服（群主不能交给 bot）。
  if (deleteMode.value) return member.host || member.bot;
  return member.bot || member.userId === myUserId.value;
}
function onPick(userId: string) {
  if (deleteMode.value) deleteTarget.value = userId;
  else if (transferMode.value) transferTarget.value = userId;
}
type AddCandidate = { userId: string; name: string; avatarMxc: string };
const addCandidates = ref<AddCandidate[]>([]);
// ACT: i18n 抽取器只认 translate(纯字符串)；三元标签统一在 computed 里拆成两次直调，保证词条入字典。
const addPlaceholder = computed(() => (addCandidates.value.length ? translate("请选择正确的队友") : translate("输入用户 ID")));
const addNoticeText = computed(() => (addNotice.value === "inteam" ? translate("该队友已在团队中") : translate("该队友不存在")));
const addLabel = computed(() => (addMode.value ? translate("确认") : translate("添加队友")));
const deleteLabel = computed(() => (deleteMode.value ? translate("确认") : translate("删除队友")));
const transferLabel = computed(() => (transferMode.value ? translate("确认") : translate("移交群主")));
// ACT: 候选头像同属鉴权媒体：经 mediaUrl 读缓存（依赖 mediaTick），blob 落地后自动补图。
const candidateViews = computed(() => addCandidates.value.map(item => ({ ...item, avatar: mediaUrl(item.avatarMxc) })));

function team() {
  teamVisible.value = !teamVisible.value;
  if (!teamVisible.value) resetTeamFlow();
}

function resetTeamFlow() {
  addMode.value = false;
  deleteMode.value = false;
  transferMode.value = false;
  addInput.value = "";
  addNotice.value = "";
  addCandidates.value = [];
  deleteTarget.value = "";
  transferTarget.value = "";
}

// ACT: 「添加队友」两段：首次点展开输入框（按钮变「确认」），再点按用户 ID/昵称解析添加。
function onAddButton() {
  if (!addMode.value) {
    resetTeamFlow();
    addMode.value = true;
    return;
  }
  void confirmAdd();
}

// ACT: 账户页展示的用户 ID 是裸本地名（无 @ 与 :server）；添加队友时允许原样粘贴：
// 无 @ 前缀时按当前服务器域合成完整 mxid，两者一起进比较集合。
function idAliases(term: string): string[] {
  if (term.startsWith("@")) return [term];
  const server = myUserId.value.split(":").slice(1).join(":");
  return server ? [term, `@${term}:${server}`] : [term];
}

async function confirmAdd() {
  const term = addInput.value.trim();
  if (!term || addBusy.value) return;
  const ids = idAliases(term);
  // ACT: 已是成员（含主持人自己）不走用户目录：目录可能漏索引导致误报「不存在」，直接内联报「已在团队中」。
  if (teamMembers.value.some(member => ids.includes(member.userId) || member.name === term)) {
    addCandidates.value = [];
    addNotice.value = "inteam";
    return;
  }
  addBusy.value = true;
  try {
    const results = await searchUsers(term);
    // ACT: 唯一命中＝用户 ID 精确匹配（裸名或全 mxid）或昵称精确匹配仅一人；重名多人给头像候选；零命中报「该队友不存在」。
    const matches = [...new Map(results.filter(item => ids.includes(item.userId) || item.name === term).map(item => [item.userId, item])).values()];
    if (matches.length === 1) {
      const target = matches[0];
      if (teamMembers.value.some(member => member.userId === target.userId)) {
        addNotice.value = "inteam";
      } else {
        await inviteTeammate(target.userId);
        ElMessage.success(translate("已添加队友"));
        resetTeamFlow();
      }
    } else if (matches.length > 1) {
      addCandidates.value = matches;
      addNotice.value = "";
    } else {
      addCandidates.value = [];
      addNotice.value = "missing";
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : translate("添加失败，请稍后重试"));
  } finally {
    addBusy.value = false;
  }
}

// ACT: 重名候选：点谁就按谁的用户 ID 邀请，添加后收回输入模式。
async function pickCandidate(item: AddCandidate) {
  if (addBusy.value) return;
  addBusy.value = true;
  try {
    await inviteTeammate(item.userId);
    ElMessage.success(translate("已添加队友"));
    resetTeamFlow();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : translate("添加失败，请稍后重试"));
  } finally {
    addBusy.value = false;
  }
}

// ACT: 「删除队友」两段：首次点给花名册每行挂单选 radio（按钮变「确认」），再点踢出选中成员。
function onDeleteButton() {
  if (!deleteMode.value) {
    resetTeamFlow();
    deleteMode.value = true;
    return;
  }
  if (!deleteTarget.value) {
    ElMessage.warning(translate("请先选择要删除的队友"));
    return;
  }
  void confirmDelete();
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target || addBusy.value) return;
  addBusy.value = true;
  try {
    await kickTeammate(target);
    ElMessage.success(translate("已删除队友"));
    resetTeamFlow();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : translate("删除失败，请稍后重试"));
  } finally {
    addBusy.value = false;
  }
}

// ACT: 「移交群主」两段（仅主持人可见）：首次点给花名册挂单选 radio（按钮变「确认」），再点提目标到 100 并自降为 0。
function onTransferButton() {
  if (!transferMode.value) {
    resetTeamFlow();
    transferMode.value = true;
    return;
  }
  if (!transferTarget.value) {
    ElMessage.warning(translate("请先选择要移交的队友"));
    return;
  }
  void confirmTransfer();
}

async function confirmTransfer() {
  const target = transferTarget.value;
  if (!target || addBusy.value) return;
  addBusy.value = true;
  try {
    await transferHost(target);
    ElMessage.success(translate("已移交群主"));
    resetTeamFlow();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : translate("移交失败，请稍后重试"));
  } finally {
    addBusy.value = false;
  }
}

// ACT: 附件上传：逐个走 sendFile（按 MIME 分发 m.image/m.video/m.file）；单文件失败提示后继续其余。
async function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  for (const file of files) {
    try {
      await sendFile(file);
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : translate("上传失败，请稍后重试"));
    }
  }
}

// ACT: 文件卡片点击：按原文件名落盘；blob 已经鉴权媒体解析，直接交给 anchor 下载。
function downloadFile(msg: ChatMessage) {
  if (!msg.url) return;
  const anchor = document.createElement("a");
  anchor.href = msg.url;
  anchor.download = msg.body || "file";
  anchor.click();
}

async function start() {
  if (!auth.signedIn) return;
  const ok = await bootstrap();
  if (!ok) ElMessage.error("无法连接 Matrix/Synapse，请确认本地 Synapse 已启动且已配置 config.json 的 synapse 块");
  await scrollToBottom();
}

watch(() => timeline.value.length, scrollToBottom);
watch(activeRoomId, scrollToBottom);
// ACT: 登录/退出都会切换 signedIn；登录后自动接上 Matrix 客户端（退出时的断开由 useMatrixChat 负责）。
watch(() => auth.signedIn, value => { if (value) void start(); });

onMounted(async () => {
  window.addEventListener("click", closeQuoteMenu);
  window.addEventListener("keydown", onQuoteMenuKey);
  await auth.restore();
  await start();
});

defineExpose({ scrollToBottom, activeRoomId });
// props 目前仅用于模板分支；显式引用避免未使用告警。
void props;
</script>

<style lang="scss" scoped>
.chatPanel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  // ACT: 显式钉住基准字号 14px，与设置页/群聊页保持一致（不继承 body 的 16px）。
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.roomAction {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: var(--ui-radius);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.chatHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--shell-page-header-h, 56px);
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  .roomSelect {
    flex-shrink: 1;
    min-width: 0;
    max-width: 180px;
  }

  .chatStatus {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .chatHeaderActions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-inline-start: auto;
    flex-shrink: 0;
  }

  .inviteBadge {
    :deep(.el-badge__content) { z-index: 1; }
  }
}

.inviteList {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;

    &:not(:last-child) { border-bottom: 1px solid var(--el-border-color-lighter); }
  }

  .inviteName {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.chatBody {
  min-height: 0;

  .messageList {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }

  .emptyHint {
    margin: auto;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    text-align: center;
  }

  .messageRow {
    display: flex;
    align-items: flex-end;
    gap: 8px;

    &.mine {
      justify-content: flex-end;

      .bubble {
        background: var(--el-color-primary-light-9);
      }
    }

    &.anchored .bubble {
      background: var(--el-color-primary-light-9);
      outline: 2px solid var(--el-color-primary);
      outline-offset: 2px;
    }
  }

  .msgAvatar {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--el-fill-color);
    color: var(--el-text-color-regular);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .initial {
      font-size: 14px;
      font-weight: 600;
    }
  }

  .bubble {
    max-width: min(72%, 640px);
    padding: 8px 12px;
    border-radius: var(--ui-radius);
    background: var(--el-fill-color-light);

    .meta {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 4px;

      .time {
        font-size: 11px;
        color: var(--el-text-color-secondary);
      }
    }

    .media {
      max-width: 100%;
      border-radius: calc(var(--ui-radius) * 0.75);
      margin-bottom: 4px;

      // ACT: 可点进主面板的图片：手指光标，与视频卡片、文本消息一致。
      &.clickable { cursor: pointer; }
    }

    // ACT: 微信式引用条：灰底、左竖线、最多两行截断；点击跳回被引用消息。
    .quote {
      display: -webkit-box;
      width: 100%;
      margin-top: 6px;
      padding: 4px 8px;
      border: none;
      border-left: 2px solid var(--el-border-color);
      border-radius: 4px;
      background: var(--el-fill-color);
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.5;
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;

      .quoteSender {
        color: var(--el-text-color-regular);
      }
    }

    // ACT: 视频卡片与图片消息同形：封面按原始比例撑到气泡宽（上限气泡宽），右侧不再放文件名；
    // 文件名只保留卡片下方文本行；舞台上选中时用主色外轮廓提示。
    .videoCard {
      display: block;
      width: fit-content;
      max-width: 100%;
      padding: 0;
      margin-bottom: 4px;
      border: none;
      border-radius: calc(var(--ui-radius) * 0.75);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: start;

      &:hover .videoCardThumb { opacity: 0.92; }
      &.active {
        outline: 2px solid var(--el-color-primary);
        outline-offset: 2px;
      }
    }

    .videoCardThumb {
      display: block;
      max-width: 100%;
      height: auto;
      border-radius: calc(var(--ui-radius) * 0.75);
      background: var(--el-fill-color);
      object-fit: cover;
      pointer-events: none;
    }

    // ACT: 附件卡片：与视频卡片同形的通栏边框行；点击按原文件名下载。
    .fileCard {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--el-border-color);
      border-radius: calc(var(--ui-radius) * 0.75);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: start;
      transition: border-color 0.15s ease, background 0.15s ease;

      &:hover {
        background: var(--el-fill-color);
      }
    }

    .fileCardIcon {
      display: block;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
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

    .fileCardName {
      overflow: hidden;
      font-size: 13px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .text {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }
}

.typingBar {
  min-height: 20px;
  padding: 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

// ACT: 微信式右键菜单：浮层小菜单，目前仅「引用」一项。
.quoteMenu {
  position: fixed;
  z-index: 3000;
  min-width: 88px;
  padding: 4px;
  border-radius: 8px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);

  button {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover {
      background: var(--el-fill-color-light);
    }

    // ACT: 菜单里的危险项（删除）：红字，悬停淡红底。
    &.danger {
      color: var(--el-color-danger);

      &:hover {
        background: var(--el-color-danger-light-9);
      }
    }
  }
}

// ACT: 发送前引用预览条：输入框上方灰底一条，单行截断，可取消。
.quotePreview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-size: 12px;

  .quotePreviewText {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quotePreviewClose {
    border: none;
    background: transparent;
    color: var(--el-text-color-secondary);
    font-size: 14px;
    cursor: pointer;
  }
}

.chatComposer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--el-border-color-lighter);

  // ACT: 团队弹层遮罩：全屏透明层，点外关闭（z 30/31 与既有弹层约定一致）。
  .teamBackdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
  }

  // ACT: 团队弹层：错定在输入区上方（bottom: 100% + 8px），只读花名册。
  .teamPopover {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 31;
    width: min(320px, calc(100vw - 32px));
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
    background: var(--el-bg-color-overlay);
    box-shadow: var(--el-box-shadow-light);

    .teamPopoverTitle {
      margin-bottom: 6px;
      font-size: 13px;
      font-weight: 600;
    }

    .teamList {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    // ACT: 花名册行：删除流程的行左 radio + 缩小圆头像 + 昵称；昵称三色见 .memberName。
    .teamMember {
      display: flex;
      align-items: center;
      gap: 8px;

      input[type="radio"] {
        margin: 0;
        accent-color: var(--el-color-primary);
      }
    }

    .memberAvatar {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      overflow: hidden;
      background: var(--el-fill-color);

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    }

    .memberInitial {
      font-size: 11px;
      color: var(--el-text-color-secondary);
    }

    .memberName {
      min-width: 0;
      overflow: hidden;
      font-size: 13px;
      color: var(--el-text-color-primary);
      text-overflow: ellipsis;
      white-space: nowrap;

      // ACT: 主持橙取主题警告色；未连接＝默认色 50% 减淡（color-mix 半透明），上线后回默认色。
      &.host { color: var(--el-color-warning); }
      &.offline { color: color-mix(in srgb, var(--el-text-color-primary) 50%, transparent); }
    }

    .teamEmpty {
      margin: 6px 0 0;
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }

    // ACT: 添加流程：输入框 + 不存在警告 + 重名候选头像行（圆形可点，点谁加谁）。
    .teamAdd {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }

    .addInput {
      width: 100%;
      padding: 5px 8px;
      border: 1px solid var(--el-border-color);
      border-radius: 6px;
      background: var(--el-bg-color);
      color: var(--el-text-color-primary);
      font-size: 12px;
      outline: none;

      &:focus { border-color: var(--el-color-primary); }
    }

    .addError {
      margin: 0;
      font-size: 12px;
      color: var(--el-color-danger);
    }

    .candidateRow {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .candidate {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--el-border-color);
      border-radius: 50%;
      overflow: hidden;
      background: var(--el-fill-color);
      cursor: pointer;

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      &:hover { border-color: var(--el-color-primary); }
    }

    // ACT: 两个动作按钮竖排撑满；删除为危险操作红字提示。
    .teamActions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
    }

    .teamAction {
      padding: 6px 10px;
      border: 1px solid var(--el-border-color);
      border-radius: 6px;
      background: transparent;
      color: var(--el-text-color-regular);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;

      &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
      &:disabled { opacity: 0.5; cursor: not-allowed; }
      &.danger { color: var(--el-color-danger); }
    }
  }

  .composerMain {
    display: flex;
    align-items: flex-end;
    gap: 12px;

    :deep(.el-textarea) {
      flex: 1;
    }

    // ACT: 输入框高度底线（1 行 = 1.5em 行高 + 上下 5px 内边距）：autosize 在个别页面挂载
    // 时机下会算出偏矮的内联 min-height/height（Studio 停靠列复现），内联样式优先级高于普通
    // CSS，故用 !important 钉住与 Chat 页一致的单行高度；多行输入时内联 height 增大不受影响。
    :deep(.el-textarea__inner) {
      min-height: calc(1.5em + 10px) !important;
    }
  }

  .sendButton {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 10px;
  }

  .composerTools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .toolGroup {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-inline-start: auto;
  }

  .toolButton {
    width: 36px;
    height: 36px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--el-border-color);
    border-radius: 10px;
    background: transparent;
    color: var(--el-text-color-primary);

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  }

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

.roomForm {
  :deep(.el-form-item) { margin-bottom: 16px; }
  :deep(.el-form-item:last-child) { margin-bottom: 0; }
}

.dialogFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
