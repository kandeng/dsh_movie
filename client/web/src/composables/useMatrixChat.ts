import { computed, ref, shallowRef, watch } from "vue";
import * as sdk from "matrix-js-sdk";
import { translate } from "@dsh-movie/i18n/vue";
import { authenticatedMediaUrl } from "@/lib/matrixMedia";
import { useAuthStore } from "@/stores/auth";
import { clientConfig } from "@/config";

// ACT: 群聊状态单例（计划 Task 2 + Task 3）。
// Task 2：凭据不再由服务端代签隐藏账号，改为读取 auth store —— 用户自己用密码登录 Matrix 得到的令牌；
//         未登录时 error 置为 'signed-out'，由页面引导登录，不再回落到 /api/matrix/token。
// Task 3：从「单一演示房间」升级为多房间 —— 房间列表（含待接受邀请）、切换活动房间、创建/加入房间，
//         并暴露 isHost（当前房间创建者）供群聊页显示只有主持人可见的生成视频入口。
// 保留原有实现要点：bootstrap/sync 生命周期、safe() 包裹的事件绑定、时间线映射、
// v42 基于成员（RoomMember.typing）的输入状态、已读回执、鉴权媒体的 blob 解析与缓存。

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar: string; // 发送者头像的 blob 地址（鉴权媒体解析后）；无头像为空串
  msgtype: string; // m.text / m.image / m.video / ...
  body: string;
  url: string; // 媒体消息解析出的可播放 blob 地址；文本消息为空串
  // ACT: 视频封面（info.thumbnail_url 鉴权媒体解析后）；无缩略图为空串，卡片端回退首帧。
  thumb: string;
  // ACT: 附件 MIME 与字节数（info.mimetype / info.size）：主面板文本预览按 MIME+文件名判别渲染形态。
  mimetype: string;
  size: number;
  ts: number;
  mine: boolean;
  // ACT: 引用回复（m.relates_to.m.in_reply_to）：被回复消息的发送者与正文摘要，
  // 供气泡下方渲染微信式引用条；原消息不在本地时间线时为 undefined（不臆造）。
  quote?: { id: string; senderName: string; body: string };
};

// 房间列表项：邀请排在最前，其余按最后一条消息时间倒序。
export type RoomSummary = {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  unread: number;
  lastTs: number;
  invited: boolean;
};

// 广场卡片：聚合自已加入房间的 m.video 消息，新者在前。
export type VideoCard = {
  id: string; // 事件 ID，群聊页靠它定位到具体消息
  roomId: string;
  roomName: string;
  description: string; // 生成时写入事件的 description，老事件回落到文件名
  videoUrl: string; // 已解析的 blob 地址；解析中为空串（卡片先占位）
  ts: number;
};

/* 模块级单例：所有组件实例共享同一份响应式状态。 */
const ready = ref(false);
const connecting = ref(false);
const error = ref(""); // '' | 'signed-out' | 'unavailable'
const myUserId = ref("");
const activeRoomId = ref("");
const rooms = ref<RoomSummary[]>([]);
const timeline = ref<ChatMessage[]>([]);
const videos = ref<VideoCard[]>([]);
const typingNames = ref<string[]>([]);
// ACT: 待发送的引用（微信式「引用」）：右键消息选「引用」后暂存于此，输入框上方显示引用条；
// 发送时随 m.relates_to.m.in_reply_to 一起发出并清空；切换房间时一并清空。
const pendingQuote = ref<ChatMessage["quote"] | null>(null);

let client: sdk.MatrixClient | null = null;
// ACT: client 是普通变量，computed 无法感知它由 null 变成实例。
// 这里保留一份 shallowRef 镜像专供 computed 依赖，两者只能通过 assignClient() 同时更新。
const activeClient = shallowRef<sdk.MatrixClient | null>(null);
function assignClient(next: sdk.MatrixClient | null) {
  client = next;
  activeClient.value = next;
}
let bootPromise: Promise<boolean> | null = null;
let authWired = false;

const joinedRooms = computed(() => rooms.value.filter(room => !room.invited));
const invites = computed(() => rooms.value.filter(room => room.invited));

/* ─── 鉴权媒体缓存 ───
 * ACT: Synapse 1.157 默认启用「鉴权媒体」，旧的 /_matrix/media/v3/download 会返回 404；
 * 且 <video>/<img> 的 src 无法携带 Bearer 令牌，故用访问令牌把 mxc:// 媒体拉成 blob，
 * 再以 objectURL 供内联播放。解析结果按 mxc 缓存，teardown 时统一 revoke。
 */
const mediaCache = new Map<string, string>(); // mxc -> blobUrl（"" 表示解析失败，不再重试）
const mediaPending = new Set<string>();
const objectUrls = new Set<string>();
// ACT: 媒体解析完成计数器：computed/模板里经 mediaUrl() 读取缓存时依赖它，blob 落地后自动重渲染。
const mediaTick = ref(0);

// 同步读取已解析的 blob 地址；未解析或失败返回空串。
function cachedMediaUrl(mxc: unknown): string {
  return typeof mxc === "string" && mxc.startsWith("mxc://") ? mediaCache.get(mxc) ?? "" : "";
}

// ACT: 响应式媒体读取：头像等在 blob 解析完成后需要重渲染的消费方走这里（依赖 mediaTick）。
function mediaUrl(mxc: unknown): string {
  void mediaTick.value;
  return cachedMediaUrl(mxc);
}

// 异步解析单个 mxc 媒体；完成后刷新时间线（此时缓存已命中，不会重复触发）。
function resolveMedia(mxc: string) {
  if (!client || mediaCache.has(mxc) || mediaPending.has(mxc)) return;
  const url = authenticatedMediaUrl(mxc);
  const token = client.getAccessToken();
  if (!url || !token) { mediaCache.set(mxc, ""); return; }
  mediaPending.add(mxc);
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then(resp => { if (!resp.ok) throw new Error(`media HTTP ${resp.status}`); return resp.blob(); })
    .then(blob => { const objectUrl = URL.createObjectURL(blob); objectUrls.add(objectUrl); mediaCache.set(mxc, objectUrl); })
    .catch(err => { console.warn("[matrix] 媒体解析失败:", mxc, err); mediaCache.set(mxc, ""); })
    .finally(() => { mediaPending.delete(mxc); safe(() => { refreshTimeline(); refreshVideos(); mediaTick.value++; }); });
}

/* ─── 房间与时间线映射 ─── */
// 读取房间的主题状态事件；缺失或格式异常时返回空串。
function roomTopic(room: sdk.Room): string {
  const topic = (room.currentState.getStateEvents("m.room.topic", "")?.getContent() as { topic?: unknown } | undefined)?.topic;
  return typeof topic === "string" ? topic : "";
}

// 未读数在不同版本/线程下可能为 null，这里统一收敛成非负整数，异常一律视为 0。
function unreadCount(room: sdk.Room): number {
  try {
    const value = room.getUnreadNotificationCount() as unknown;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

// 人数统计：getJoinedMemberCount() 只算已加入的，刚建的房邀请还未接受时会显示 1 人，
// 这里把待接受的邀请一并计入，取两者的较大值，避免列表上的人数看起来不对劲。
function memberCount(room: sdk.Room): number {
  const joined = room.getJoinedMemberCount();
  const joinedSafe = typeof joined === "number" && Number.isFinite(joined) ? joined : 0;
  const pending = room.getMembers().filter(member => member.membership === "join" || member.membership === "invite").length;
  return Math.max(joinedSafe, pending);
}

function summarize(room: sdk.Room): RoomSummary {
  let lastTs = 0;
  for (const event of room.getLiveTimeline().getEvents()) {
    const ts = event.getTs();
    if (ts > lastTs) lastTs = ts;
  }
  return {
    id: room.roomId,
    name: room.name || room.roomId,
    topic: roomTopic(room),
    memberCount: memberCount(room),
    unread: unreadCount(room),
    lastTs,
    invited: room.getMyMembership() === "invite",
  };
}

function refreshRooms() {
  if (!client) { rooms.value = []; return; }
  rooms.value = client.getRooms()
    .filter(room => room.getMyMembership() === "join" || room.getMyMembership() === "invite")
    .map(summarize)
    .sort((a, b) => Number(b.invited) - Number(a.invited) || b.lastTs - a.lastTs);
}

// 首次进入且没有指定房间时，默认打开最近活跃的一个已加入房间。
function pickInitialRoom() {
  if (activeRoomId.value && client?.getRoom(activeRoomId.value)) return;
  activeRoomId.value = rooms.value.find(room => !room.invited)?.id ?? "";
}

function updateTyping(room: sdk.Room | null) {
  if (!room || !client) { typingNames.value = []; return; }
  const me = client.getUserId();
  // matrix-js-sdk v42：输入状态基于成员（RoomMember.typing），Room.getTypingMembers() 已移除。
  typingNames.value = room.getMembers()
    .filter(member => member.typing && member.userId !== me)
    .map(member => member.name);
}

// 解析引用回复：取 m.relates_to.m.in_reply_to.event_id，在本地时间线里找原消息，
// 抽出发送者显示名与单行化正文摘要；找不到原消息或原消息无正文时返回 undefined。
function resolveQuote(room: sdk.Room, content: Record<string, unknown>): ChatMessage["quote"] {
  const relates = content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: unknown } } | undefined;
  const eventId = relates?.["m.in_reply_to"]?.event_id;
  if (typeof eventId !== "string" || !eventId) return undefined;
  const quoted = room.findEventById(eventId);
  if (!quoted || quoted.getType() !== "m.room.message") return undefined;
  const quotedBody = (quoted.getContent() ?? {}).body;
  if (typeof quotedBody !== "string" || !quotedBody.trim()) return undefined;
  const sender = quoted.getSender() ?? "";
  return {
    id: eventId,
    senderName: room.getMember(sender)?.name || sender,
    body: quotedBody.replace(/\s+/g, " ").trim(),
  };
}

function refreshTimeline() {
  if (!client || !activeRoomId.value) { timeline.value = []; typingNames.value = []; return; }
  const room = client.getRoom(activeRoomId.value);
  if (!room) { timeline.value = []; typingNames.value = []; return; }
  const me = client.getUserId();
  const msgs: ChatMessage[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.getType() !== "m.room.message") continue;
    const content = ev.getContent() ?? {};
    const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
    if (!msgtype) continue;
    const senderId = ev.getSender() ?? "";
    const mxc = typeof content.url === "string" && content.url.startsWith("mxc://") ? content.url : "";
    // ACT: 媒体消息异步解析成 blob URL（鉴权媒体）；解析完成后会再次刷新时间线。
    if (mxc && !mediaCache.has(mxc)) resolveMedia(mxc);
    // ACT: 视频缩略图同属鉴权媒体：有则解析，卡片优先用它做封面。
    const info = (content.info ?? {}) as { thumbnail_url?: unknown; mimetype?: unknown; size?: unknown };
    const thumbMxc = typeof info.thumbnail_url === "string" && info.thumbnail_url.startsWith("mxc://") ? info.thumbnail_url : "";
    if (thumbMxc && !mediaCache.has(thumbMxc)) resolveMedia(thumbMxc);
    const member = room.getMember(senderId);
    // ACT: 头像同属鉴权媒体：mxc -> blob；解析完成的回调会再刷一次时间线把头像填上。
    const avatarMxc = member?.getMxcAvatarUrl() ?? "";
    if (avatarMxc && !mediaCache.has(avatarMxc)) resolveMedia(avatarMxc);
    msgs.push({
      id: ev.getId() ?? `${ev.getTs()}-${senderId}`,
      senderId,
      senderName: member?.name || senderId,
      senderAvatar: cachedMediaUrl(avatarMxc),
      msgtype,
      body: typeof content.body === "string" ? content.body : "",
      url: cachedMediaUrl(mxc),
      thumb: cachedMediaUrl(thumbMxc),
      mimetype: typeof info.mimetype === "string" ? info.mimetype : "",
      size: typeof info.size === "number" ? info.size : 0,
      ts: ev.getTs(),
      mine: senderId === me,
      quote: resolveQuote(room, content),
    });
  }
  timeline.value = msgs;
  updateTyping(room);
}

/* ─── 广场视频聚合 ───
 * ACT: 扫描所有已加入房间的实时时间线，把 m.video 消息汇成卡片（新者在前）。
 * 服务端不上传缩略图，封面由卡片端用 <video src="blob#t=0.5"> 取首帧；
 * 这里只负责把视频本体解析成 blob，解析完成后会再跑一次本函数填上 videoUrl。
 * 注意：live timeline 只含 initialSyncLimit 内的近期事件，更早的视频不会出现在广场。
 */
function refreshVideos() {
  if (!client) { videos.value = []; return; }
  const cards: VideoCard[] = [];
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    for (const ev of room.getLiveTimeline().getEvents()) {
      if (ev.getType() !== "m.room.message") continue;
      const content = ev.getContent() ?? {};
      if (content.msgtype !== "m.video") continue;
      const mxc = typeof content.url === "string" && content.url.startsWith("mxc://") ? content.url : "";
      if (mxc && !mediaCache.has(mxc)) resolveMedia(mxc);
      const rawDescription = typeof content.description === "string" && content.description.trim() ? content.description.trim() : "";
      cards.push({
        id: ev.getId() ?? `${ev.getTs()}-${ev.getSender()}`,
        roomId: room.roomId,
        roomName: room.name || room.roomId,
        description: rawDescription || (typeof content.body === "string" ? content.body : ""),
        videoUrl: cachedMediaUrl(mxc),
        ts: ev.getTs(),
      });
    }
  }
  cards.sort((a, b) => b.ts - a.ts);
  videos.value = cards;
}

/* ─── 事件绑定 ───
 * 每个处理函数都经过 safe()：UI 映射异常绝不能回灌进 SDK —— Room.timeline 处理内抛错
 * 会破坏 sendTextMessage（pending-event 路径）并中断 /sync 的房间处理。
 */
function safe(fn: () => void) {
  try { fn(); } catch (err) { console.error("[matrix] UI refresh failed:", err); }
}

function wireEvents(c: sdk.MatrixClient) {
  c.on(sdk.RoomEvent.Timeline, (event, room) => safe(() => {
    refreshRooms();
    refreshVideos();
    if (room?.roomId === activeRoomId.value) {
      refreshTimeline();
      if (event.getSender() && event.getSender() !== c.getUserId()) markRead();
    }
  }));
  c.on(sdk.RoomMemberEvent.Typing, (_event, member) => safe(() => {
    if (member.roomId === activeRoomId.value) updateTyping(c.getRoom(activeRoomId.value) ?? null);
  }));
  // ACT: 成员进出（invite/kick/leave）、在线状态、改名/换头像都实时刷新团队弹层花名册。
  c.on(sdk.RoomMemberEvent.Membership, (_event, member) => safe(() => {
    if (member.roomId === activeRoomId.value) { membersTick.value++; refreshRooms(); }
  }));
  // ACT: v42 的 presence 挂在 User 对象上（UserEvent.Presence）；只在该用户属于当前房间时刷花名册。
  c.on(sdk.UserEvent.Presence, (_event, user) => safe(() => {
    if (activeRoomId.value && c.getRoom(activeRoomId.value)?.getMember(user.userId)) membersTick.value++;
  }));
  c.on(sdk.RoomMemberEvent.Name, (_event, member) => safe(() => {
    if (member.roomId === activeRoomId.value) membersTick.value++;
  }));
  // ACT: v42 没有 PowerLevel 枚举；状态批次更新（RoomStateEvent.Update，含权限级变化）驱动花名册与 isHost 重算。
  c.on(sdk.RoomStateEvent.Update, room => safe(() => {
    if (room?.roomId === activeRoomId.value) membersTick.value++;
  }));
  c.on(sdk.RoomEvent.Name, room => safe(() => {
    if (room?.roomId === activeRoomId.value || rooms.value.some(item => item.id === room?.roomId)) refreshRooms();
  }));
  c.on(sdk.RoomEvent.MyMembership, (room, membership) => safe(() => {
    // ACT: 不再自动接受邀请 —— 邀请要在房间列表里可见，由用户显式点「加入」。
    if (room.roomId === activeRoomId.value && membership !== "join") activeRoomId.value = "";
    refreshRooms();
    pickInitialRoom();
    refreshTimeline();
    refreshVideos();
  }));
}

// 退出登录（或令牌失效被清空）时立即断开客户端；重新登录后由页面再次调用 bootstrap。
function wireAuth() {
  if (authWired) return;
  authWired = true;
  const auth = useAuthStore();
  watch(() => auth.session?.accessToken, token => { if (!token) teardown(); }, { flush: "sync" });
}

/* ─── 生命周期 ─── */
async function bootstrap(): Promise<boolean> {
  const auth = useAuthStore();
  if (!auth.session?.accessToken) {
    error.value = "signed-out";
    ready.value = false;
    return false;
  }
  if (client) return true;
  if (bootPromise) return bootPromise;
  wireAuth();

  bootPromise = (async () => {
    try {
      connecting.value = true;
      error.value = "";
      const session = auth.session!;
      const c = sdk.createClient({
        baseUrl: window.location.origin, // 同源 /_matrix 代理（Vite dev / 生产 Caddy）
        accessToken: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId || undefined,
      });
      wireEvents(c);
      const synced = new Promise<boolean>(resolve => {
        const onSync = (state: sdk.SyncState, _prev: sdk.SyncState | null, data?: sdk.SyncStateData) => {
          if (state === sdk.SyncState.Prepared) { c.removeListener(sdk.ClientEvent.Sync, onSync); resolve(true); }
          // 令牌已失效（例如 Synapse 数据库被重置）：清空登录态，交回登录弹窗。
          if (state === sdk.SyncState.Error && (data?.error as { errcode?: string } | undefined)?.errcode === "M_UNKNOWN_TOKEN") {
            c.removeListener(sdk.ClientEvent.Sync, onSync);
            auth.invalidate();
            resolve(false);
          }
        };
        c.on(sdk.ClientEvent.Sync, onSync);
      });
      await c.startClient({ initialSyncLimit: 30 });
      assignClient(c);
      myUserId.value = session.userId;
      if (!(await synced)) {
        teardown();
        error.value = auth.signedIn ? "unavailable" : "signed-out";
        return false;
      }
      ready.value = true;
      refreshRooms();
      pickInitialRoom();
      refreshTimeline();
      refreshVideos();
      void loadBotUserId();
      return true;
    } catch (err) {
      console.error("[matrix] bootstrap failed:", err);
      teardown();
      error.value = auth.signedIn ? "unavailable" : "signed-out";
      return false;
    } finally {
      connecting.value = false;
      bootPromise = null;
    }
  })();
  return bootPromise;
}

function teardown() {
  if (client) {
    try { client.stopClient(); } catch { /* noop */ }
    assignClient(null);
  }
  // ACT: 释放本次会话创建的所有 blob URL，避免内存泄漏。
  for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
  objectUrls.clear();
  mediaCache.clear();
  mediaPending.clear();
  ready.value = false;
  connecting.value = false;
  error.value = "";
  myUserId.value = "";
  activeRoomId.value = "";
  rooms.value = [];
  timeline.value = [];
  videos.value = [];
  typingNames.value = [];
}

/* ─── 房间操作 ─── */
// 切换活动房间：重算时间线与输入状态，并把未读清零。
function setActiveRoom(roomId: string) {
  if (!roomId || activeRoomId.value === roomId) { refreshTimeline(); return; }
  activeRoomId.value = roomId;
  pendingQuote.value = null;
  refreshTimeline();
  markRead();
  refreshRooms();
}

// 轮询等待房间出现在本地（createRoom/joinRoom 之后 sync 尚未推送到本地状态时的兜底）。
async function waitForRoom(roomId: string, timeout = 8000): Promise<sdk.Room | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const room = client?.getRoom(roomId);
    if (room && room.getMyMembership() === "join") return room;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return client?.getRoom(roomId) ?? null;
}

// ACT: Invite the configured DSH agent bot into a freshly created room using the
// creator's own Matrix identity (mode B). dsh_movie has no Toonflow-style
// `/api/matrix/agent` broker, so this is a direct Matrix invite. Failure only
// logs - the room stays usable without the bot.
async function addAgentToRoom(roomId: string) {
  if (!client || !clientConfig.botUserId) return;
  try {
    const invite = client.invite.bind(client) as unknown as (roomId: string, userId: string) => Promise<unknown>;
    await invite(roomId, clientConfig.botUserId);
  } catch (err) {
    console.warn("[chat] agent bot invite failed:", err);
  }
}

async function createRoom(options: { name: string; invite?: string[] }): Promise<string> {
  if (!client) throw new Error(translate("尚未连接到聊天服务"));
  const name = options.name.trim();
  if (!name) throw new Error(translate("请输入群聊名称"));
  const created = await client.createRoom({
    name,
    visibility: sdk.Visibility.Private,
    preset: sdk.Preset.PrivateChat,
    invite: options.invite ?? [],
  });
  await waitForRoom(created.room_id);
  // ACT: 先等自己入群（成为房内成员）再拉 AI 客服，否则后端的代签邀请会因邀请人不在房内而 403。
  await addAgentToRoom(created.room_id);
  refreshRooms();
  setActiveRoom(created.room_id);
  return created.room_id;
}

// 支持房间 ID（!abc:server）与房间别名（#abc:server）两种输入。
async function joinRoom(idOrAlias: string): Promise<string> {
  if (!client) throw new Error(translate("尚未连接到聊天服务"));
  const target = idOrAlias.trim();
  if (!target) throw new Error(translate("请输入房间 ID 或别名"));
  const room = await client.joinRoom(target);
  await waitForRoom(room.roomId);
  refreshRooms();
  setActiveRoom(room.roomId);
  return room.roomId;
}

async function acceptInvite(roomId: string) {
  if (!client || !roomId) return;
  await client.joinRoom(roomId);
  await waitForRoom(roomId);
  refreshRooms();
  setActiveRoom(roomId);
}

/* ─── 聊天动作 ─── */
function markRead() {
  if (!client || !activeRoomId.value) return;
  const events = client.getRoom(activeRoomId.value)?.getLiveTimeline().getEvents() ?? [];
  const last = events[events.length - 1];
  if (last) client.sendReadReceipt(last).catch(() => {});
}

async function sendText(body: string) {
  const text = (body || "").trim();
  if (!client || !activeRoomId.value || !text) return;
  const quote = pendingQuote.value;
  pendingQuote.value = null;
  if (quote) {
    // ACT: 引用回复：与服务器侧 roomPost 相同的 m.relates_to.m.in_reply_to 结构；
    // sendTextMessage 不支持附加 relates_to，故直接发事件（sendEvent 需 bind 保住 this）。
    const sendEvent = client.sendEvent.bind(client) as unknown as (roomId: string, eventType: string, content: Record<string, unknown>) => Promise<unknown>;
    await sendEvent(activeRoomId.value, "m.room.message", {
      msgtype: "m.text",
      body: text,
      "m.relates_to": { "m.in_reply_to": { event_id: quote.id } },
    });
  } else {
    await client.sendTextMessage(activeRoomId.value, text);
  }
  refreshTimeline();
  refreshRooms();
}

// ACT: 截图发送：上传二进制到 Matrix 内容仓库，再发 m.image 事件。
async function sendImage(file: File, name: string, width: number, height: number) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const uploaded = await client.uploadContent(file, { name, type: file.type });
  const mxc = typeof uploaded === "string" ? uploaded : (uploaded as { content_uri?: string })?.content_uri;
  if (!mxc) throw new Error(translate("上传失败，请稍后重试"));
  await client.sendMessage(activeRoomId.value, {
    msgtype: sdk.MsgType.Image,
    body: name,
    url: mxc,
    info: { mimetype: file.type, size: file.size, w: width, h: height },
  });
  refreshTimeline();
  refreshRooms();
}

// 读取图片自然尺寸；解码失败时回落 0（info 里仅作提示，不影响投递）。
function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { const { naturalWidth, naturalHeight } = img; URL.revokeObjectURL(url); resolve({ width: naturalWidth, height: naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ width: 0, height: 0 }); };
    img.src = url;
  });
}

// ACT: 删除自己发出的消息（右键菜单「删除」）：走 Matrix redaction——服务端抹去内容，
// 所有客户端同步后该事件不再带 msgtype，refreshTimeline 会把它从时间线上过滤掉；
// 同时刷新广场视频聚合，被删的 m.video 也会从广场消失。仅消息发送者本人可用（服务端按权限校验）。
async function deleteMessage(eventId: string) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const redactEvent = client.redactEvent.bind(client) as unknown as (roomId: string, eventId: string, txnId?: string, content?: Record<string, unknown>) => Promise<unknown>;
  await redactEvent(activeRoomId.value, eventId);
  refreshTimeline();
  refreshVideos();
  refreshRooms();
}

// ACT: 附件上传（聊天框「上传文件」按钮）：按 MIME 分发——图片 m.image（带宽高）、
// 视频 m.video（时间线渲染为可播卡片、广场可聚合）、其余 m.file（时间线渲染为可下载卡片）。
async function sendFile(file: File) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const uploaded = await client.uploadContent(file, { name: file.name, type: file.type });
  const mxc = typeof uploaded === "string" ? uploaded : (uploaded as { content_uri?: string })?.content_uri;
  if (!mxc) throw new Error(translate("上传失败，请稍后重试"));
  // ACT: 三分支字面量发送：matrix-js-sdk v42 的 RoomMessageEventContent 是严格判别联合，
  // 用变量传 msgtype 会丢失窄化而报类型错，故按 MIME 直接写字面量。
  if (file.type.startsWith("image/")) {
    const { width, height } = await imageSize(file);
    await client.sendMessage(activeRoomId.value, { msgtype: sdk.MsgType.Image, body: file.name, url: mxc, info: { mimetype: file.type, size: file.size, w: width, h: height } });
  } else if (file.type.startsWith("video/")) {
    await client.sendMessage(activeRoomId.value, { msgtype: sdk.MsgType.Video, body: file.name, url: mxc, info: { mimetype: file.type, size: file.size } });
  } else {
    await client.sendMessage(activeRoomId.value, { msgtype: sdk.MsgType.File, body: file.name, url: mxc, info: { mimetype: file.type, size: file.size } });
  }
  refreshTimeline();
  refreshRooms();
}

// ACT: 团队弹层「添加队友」：把用户邀请进当前房间；membership 事件会让花名册实时补人。
async function inviteTeammate(userId: string) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const invite = client.invite.bind(client) as unknown as (roomId: string, userId: string) => Promise<unknown>;
  await invite(activeRoomId.value, userId);
  membersTick.value++;
  refreshRooms();
}

// ACT: 团队弹层「删除队友」：把成员踢出当前房间；服务端按权限校验（非主持人会 403）。
async function kickTeammate(userId: string) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const kick = client.kick.bind(client) as unknown as (roomId: string, userId: string, reason?: string) => Promise<unknown>;
  await kick(activeRoomId.value, userId);
  membersTick.value++;
  refreshRooms();
}

// ACT: 团队弹层「移交群主」：先提目标到 100 再把自己降回 0——先降自己就没有权限再提别人了。
async function transferHost(userId: string) {
  if (!client || !activeRoomId.value) throw new Error(translate("尚未连接到聊天服务"));
  const setPowerLevel = client.setPowerLevel.bind(client) as unknown as (roomId: string, userId: string, powerLevel: number) => Promise<unknown>;
  await setPowerLevel(activeRoomId.value, userId, 100);
  const me = client.getUserId();
  if (me && me !== userId) await setPowerLevel(activeRoomId.value, me, 0);
  membersTick.value++;
}

// ACT: 团队弹层候选搜索：Synapse 用户目录，对用户 ID 与昵称都做匹配；头像 mxc 交由消费方解析。
export type UserCandidate = { userId: string; name: string; avatarMxc: string };
async function searchUsers(term: string): Promise<UserCandidate[]> {
  if (!client) throw new Error(translate("尚未连接到聊天服务"));
  const search = client.searchUserDirectory.bind(client) as unknown as (opts: { term: string; limit?: number }) => Promise<{ results?: { user_id: string; display_name?: string | null; avatar_url?: string | null }[] }>;
  const resp = await search({ term, limit: 50 });
  return (resp.results ?? []).map(item => ({
    userId: item.user_id,
    name: item.display_name || item.user_id,
    avatarMxc: typeof item.avatar_url === "string" ? item.avatar_url : "",
  }));
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;
function noteTyping() {
  if (!client || !activeRoomId.value) return;
  client.sendTyping(activeRoomId.value, true, 4000).catch(() => {});
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    client?.sendTyping(activeRoomId.value, false, 0).catch(() => {});
  }, 4000);
}

// ACT: 依赖必须来自响应式来源（activeClient / activeRoomId）。
// 早先写成 `client ? client.getRoom(activeRoomId.value) : null`：client 为 null 时短路求值
// 根本不会读取 activeRoomId，于是这个 computed 没有任何依赖、永久缓存 null，
// 表现为群聊标题退化成房间 ID、「主持人」标签与两个生成视频入口始终不渲染。
const activeRoom = computed(() => {
  const current = activeClient.value;
  const roomId = activeRoomId.value;
  return current && roomId ? (current.getRoom(roomId) ?? null) : null;
});
// ACT: 标题取 rooms 快照中的名字（refreshRooms 随 Timeline/Name 事件刷新，是响应式来源）。
// 不能直接读 activeRoom.name：SDK 会对 room 对象原地改名，computed 对其无响应式依赖、不会重算，
// 标题会停在进房瞬间的默认名（如 "Empty room"），与左栏列表显示的群名不一致。
const roomName = computed(() => {
  const id = activeRoomId.value;
  return rooms.value.find(room => room.id === id)?.name || activeRoom.value?.name || id;
});
// ACT: 主持人＝当前房间内权限级 ≥100 的自己（移交群主后随 PowerLevel 事件转移）；
// 缺失成员记录的古怪房回落到 m.room.create 发送者判定。
const isHost = computed(() => {
  void membersTick.value;
  const room = activeRoom.value;
  if (!room || !myUserId.value) return false;
  const me = room.getMember(myUserId.value);
  if (me) return me.powerLevel >= 100;
  return room.currentState.getStateEvents("m.room.create", "")?.getSender() === myUserId.value;
});

/* ─── 团队花名册（Team 弹层） ───
 * ACT: 成员＝当前房间 join+invite 两种 membership；主持人＝权限级 ≥100 者（新房即创建者），
 * 无人 ≥100 的异常房回落到 m.room.create 发送者。bot 标记 AI 客服（/api/matrix/status 的 botUserId），
 * 花名册里与主持人一样不可被删除。online 取 Matrix presence（User 对象），
 * 弹层据此三色渲染昵称：主持橙 / 已连接默认色 / 未连接半透明（上线后回默认色）。
 */
export type TeamMember = { userId: string; name: string; avatar: string; host: boolean; bot: boolean; online: boolean };
const membersTick = ref(0);
// ACT: dsh_movie configures the agent bot mxid in the client config (there is no
// `/api/matrix/status` endpoint); read it directly so the roster can protect it.
const botUserId = ref("");
async function loadBotUserId() {
  botUserId.value = clientConfig.botUserId;
  membersTick.value++;
}
const teamMembers = computed<TeamMember[]>(() => {
  void membersTick.value;
  const room = activeRoom.value;
  if (!room) return [];
  const roster = room.getMembers().filter(member => member.membership === "join" || member.membership === "invite");
  const hostIds = new Set(roster.filter(member => member.powerLevel >= 100).map(member => member.userId));
  if (!hostIds.size) {
    const creator = room.currentState.getStateEvents("m.room.create", "")?.getSender() ?? "";
    if (creator) hostIds.add(creator);
  }
  const me = myUserId.value;
  return roster
    .map(member => {
      const avatarMxc = member.getMxcAvatarUrl() ?? "";
      if (avatarMxc && !mediaCache.has(avatarMxc)) resolveMedia(avatarMxc);
      const presence = member.user?.presence ?? client?.getUser(member.userId)?.presence;
      return {
        userId: member.userId,
        name: member.name || member.userId,
        avatar: mediaUrl(avatarMxc),
        host: hostIds.has(member.userId),
        bot: member.userId === botUserId.value,
        // ACT: presence 事件不一定覆盖自己；已登录且能看到房间即视为已连接。
        online: presence === "online" || (member.userId === me && ready.value),
      };
    })
    .sort((a, b) => Number(b.host) - Number(a.host));
});

export function useMatrixChat() {
  return {
    ready, connecting, error, myUserId,
    rooms, joinedRooms, invites, activeRoomId, roomName, isHost,
    timeline, videos, typingNames, pendingQuote,
    teamMembers, inviteTeammate, kickTeammate, transferHost, searchUsers, mediaUrl,
    bootstrap, teardown, refreshRooms,
    setActiveRoom, createRoom, joinRoom, acceptInvite,
    sendText, sendImage, sendFile, deleteMessage, noteTyping, markRead,
  };
}
