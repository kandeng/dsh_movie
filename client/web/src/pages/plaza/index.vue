<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { translate } from "@dsh-movie/i18n/vue";
import { IconVideo } from "@tabler/icons-vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat, type VideoCard } from "@/composables/useMatrixChat";

// ACT: 广场＝各群聊已生成视频的瀑布流画廊（多列 masonry 布局对齐 drone 展厅页）。
// 卡片数据来自 useMatrixChat 单例聚合的 m.video 消息：封面用 <video src="blob#t=0.5"> 取首帧，
// 描述读事件里的 description 字段（老事件回落到文件名），底部是所属群聊名称。
// 点击卡片任意位置（封面/描述/群聊名）都跳转群聊页，并定位到该视频所在的那条消息。
// 登录入口改为路由到 /account?login=1（dsh_movie 无 loginDialog，登录表单在账户页）。
const router = useRouter();
const auth = useAuthStore();
const { ready, connecting, videos, bootstrap } = useMatrixChat();

async function start() {
  if (!auth.signedIn) return;
  await bootstrap();
}

// ACT: 登录/退出都会切换 signedIn；登录后自动接上 Matrix 客户端，广场随即有数据。
watch(() => auth.signedIn, value => { if (value) void start(); });

onMounted(async () => {
  if (!auth.restored) await auth.restore();
  await start();
});

function openChat(card: VideoCard) {
  void router.push({ path: "/chat", query: { room: card.roomId, event: card.id } });
}

function goLogin() {
  void router.push({ path: "/account", query: { login: "1", redirect: "/plaza" } });
}
</script>

<template>
  <div class="plaza">
    <div class="plazaScroll">
      <section v-if="!auth.signedIn" class="plazaNote">
        <el-empty :description="translate('登录后即可浏览各群聊生成的视频。')">
          <el-button type="primary" @click="goLogin">{{ translate("登录") }}</el-button>
        </el-empty>
      </section>
      <section v-else-if="connecting && !videos.length" class="plazaNote">
        <p>{{ translate("连接中…") }}</p>
      </section>
      <section v-else-if="ready && !videos.length" class="plazaNote">
        <p>{{ translate("还没有视频，去群聊里让主持人生成一段吧。") }}</p>
      </section>
      <section v-else-if="!ready" class="plazaNote">
        <p>{{ translate("无法连接 Matrix/Synapse，请确认本地 Synapse 已启动且已配置 config.json 的 synapse 块") }}</p>
      </section>

      <!-- ACT: Pinterest 式 masonry：等宽多列、卡片禁止跨列断开，短卡片下方不留行式网格的空隙。 -->
      <div v-if="videos.length" class="plazaGrid">
        <button
          v-for="card in videos" :key="card.id"
          class="vcard" type="button"
          :aria-label="`${card.description}（${card.roomName}）`"
          @click="openChat(card)">
          <span class="vcardCover">
            <!-- ACT: blob 地址拼 #t=0.5 让浏览器把 0.5 秒处的那一帧当封面；解析中先显示占位图标。 -->
            <video v-if="card.videoUrl" :src="`${card.videoUrl}#t=0.5`" preload="metadata" muted playsinline />
            <icon-video v-else class="vcardCoverIcon" :size="28" aria-hidden="true" />
          </span>
          <span class="vcardDesc">{{ card.description }}</span>
          <span class="vcardRoom">{{ card.roomName }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.plaza {
  position: relative;
  display: flex;
  height: 100%;
  overflow: hidden;
  color: var(--el-text-color-primary);
  background: color-mix(in srgb, var(--el-bg-color) 96%, var(--el-text-color-primary));
}

.plazaScroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 28px clamp(20px, 4vw, 48px) 48px;
}

.plazaNote {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 72px 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;

  p { margin: 0; }
}

// ACT: 列宽 450px 与 drone 展厅一致；column-gap 管横向间距，卡片的 margin-bottom 管纵向间距。
.plazaGrid {
  max-width: 1280px;
  margin: 0 auto;
  column-width: 450px;
  column-gap: 24px;
}

.vcard {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0 0 24px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: calc(var(--ui-radius) * 2.5);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
  box-shadow: var(--el-box-shadow-lighter);
  // ACT: 保证一张卡片完整留在同一列内，不被多列布局拦腰截断。
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;

  &:hover { border-color: var(--el-color-primary-light-5); box-shadow: var(--el-box-shadow-light); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) { transition: none; }
}

.vcardCover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: calc(var(--ui-radius) * 1.5);
  background: #000;

  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .vcardCoverIcon { color: rgb(255 255 255 / 45%); }
}

.vcardDesc {
  margin: 14px 2px 0;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.vcardRoom {
  margin: 8px 2px 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}
</style>
