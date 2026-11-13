<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { locale, translate } from "@dsh-movie/i18n/vue";
// ACT: 左栏与顶栏图标统一取自 src/icons（以 CSS mask 着色，跟随 currentColor）。
import iconPlaza from "@/icons/photo.svg";
// ACT: 一键生成/分步生成的左栏图标与模式切换器共用同一对 generator SVG；mask 只取 alpha，
// 文件内固化的 fill 不参与渲染，颜色仍随 currentColor（常规/悬停/激活态）。
import iconOneShot from "@/icons/generator_one_shot.svg";
import iconStepByStep from "@/icons/generator_step_by_step.svg";
import iconAccount from "@/icons/user.svg";
import iconSettings from "@/icons/settings.svg";
import languageSelect from "@/components/languageSelect.vue";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
// ACT: 顶栏账户入口走 auth store：未登录跳转账户页登录，已登录显示头像与下拉菜单。
const auth = useAuthStore();

// ACT: 上组为内容页（广场/一键生成/分步生成），下组为账户/设置；左栏为图标导航（悬停显示文字）。
const topNav: { path: string; label: string; icon: string; size?: number }[] = [
  // ACT: photo.svg 的字形内切于圆，横向仅占 viewBox 的 ~0.917，放大到 24px 与同栏 22px 满高图标光学对齐。
  { path: "/plaza", label: "广场", icon: iconPlaza, size: 24 },
  // ACT: 一键生成字形竖向占 ~96.4%：按需求放大 120% → 容器 28.4px。
  { path: "/chat", label: "一键生成", icon: iconOneShot, size: 28.4 },
  // ACT: 分步生成字形高度满幅：按需求放大 120% → 容器 26.4px。
  { path: "/studio", label: "分步生成", icon: iconStepByStep, size: 26.4 },
];
const bottomNav = [
  { path: "/account", label: "账户", icon: iconAccount },
];

function isActive(path: string) { return route.path === path; }
function go(path: string) { if (route.path !== path) void router.push(path); }

async function onAccountCommand(command: string) {
  if (command === "account") { go("/account"); return; }
  if (command !== "logout") return;
  await auth.logout();
  ElMessage.success(translate("已退出登录"));
  // ACT: 退出后若正停留在需要登录的页面，退回账户页并重新弹出登录。
  if (route.meta.requiresAuth === true) void router.replace({ path: "/account", query: { login: "1" } });
}

// ACT: 品牌区取「主面板左边界 ↔ host 账户图标最左缘」的中点：host 图标位置随语言按钮宽度变化，
// 用 ResizeObserver 实测后写入 --brand-x（绝对定位 + translateX(-50%) 落点）。
// 注意只能观测顶栏与右侧区：若观测品牌自身，定位→尺寸变化→重算会形成反馈环。
const topbarRef = ref<HTMLElement>();
const topbarRightRef = ref<HTMLElement>();
const brandX = ref<number | null>(null);
let topbarObserver: ResizeObserver | null = null;

function updateBrandX() {
  const topbar = topbarRef.value;
  // ACT: 登录态切换会替换账户按钮（v-if/v-else），每次实时查询而非缓存 ref。
  const account = topbar?.querySelector<HTMLElement>("[data-account-button]");
  if (!topbar || !account) return;
  const topbarRect = topbar.getBoundingClientRect();
  const accountRect = account.getBoundingClientRect();
  // ACT: 中点 = (主面板左边界 + host 图标最左缘) / 2；顶栏左缘即主面板左边界。
  brandX.value = (accountRect.left - topbarRect.left) / 2;
}

onMounted(() => {
  updateBrandX();
  if (typeof ResizeObserver !== "undefined" && topbarRef.value) {
    topbarObserver = new ResizeObserver(updateBrandX);
    topbarObserver.observe(topbarRef.value);
    // ACT: 右侧区宽度变化（语言按钮换图标/窗口变窄）会推移 host 图标，需靠它触发重算。
    if (topbarRightRef.value) topbarObserver.observe(topbarRightRef.value);
  }
});
onBeforeUnmount(() => { topbarObserver?.disconnect(); topbarObserver = null; });
// ACT: 登录/退出会替换账户按钮，头像异步加载也会改变右侧布局；顶栏自身尺寸不变时需额外补算。
watch([() => auth.signedIn, () => auth.avatarHttpUrl, locale], () => { void nextTick(updateBrandX); });
</script>

<template>
  <div class="appShell">
    <!-- 左栏：上组导航 + 弹性间隔 + 分隔线 + 下组导航（品牌已移至顶栏居中） -->
    <aside class="shellLeft">
      <nav class="shellNav shellNavTop" :aria-label="translate('主导航')">
        <!-- ACT: 导航项图标化，仅悬停时通过 el-tooltip 显示文字。 -->
        <el-tooltip
          v-for="item in topNav" :key="item.path"
          :content="translate(item.label)" placement="right" :show-after="100">
          <button
            class="shellNavItem" :class="{ active: isActive(item.path) }"
            type="button" :aria-current="isActive(item.path) ? 'page' : undefined"
            :aria-label="translate(item.label)"
            @click="go(item.path)">
            <!-- ACT: Vite 将小体积 svg 内联为 data URI（内含单引号），url() 必须加双引号否则整条 mask-image 失效。 -->
            <span class="navIcon" :style="{ '--nav-icon': `url(&quot;${item.icon}&quot;)`, ...(item.size ? { width: item.size + 'px', height: item.size + 'px' } : {}) }" aria-hidden="true" />
          </button>
        </el-tooltip>
      </nav>

      <div class="shellSpacer" />
      <div class="shellDivider" />

      <nav class="shellNav" :aria-label="translate('账户导航')">
        <el-tooltip
          v-for="item in bottomNav" :key="item.path"
          :content="translate(item.label)" placement="right" :show-after="100">
          <button
            class="shellNavItem" :class="{ active: isActive(item.path) }"
            type="button" :aria-current="isActive(item.path) ? 'page' : undefined"
            :aria-label="translate(item.label)"
            @click="go(item.path)">
            <span class="navIcon" :style="{ '--nav-icon': `url(&quot;${item.icon}&quot;)` }" aria-hidden="true" />
          </button>
        </el-tooltip>
        <el-tooltip :content="translate('设置')" placement="right" :show-after="100">
          <!-- ACT: 设置为整页路由 /settings；路由命中时高亮。 -->
          <button
            class="shellNavItem"
            :class="{ active: isActive('/settings') }"
            type="button"
            :aria-label="translate('设置')"
            @click="go('/settings')">
            <span class="navIcon" :style="{ '--nav-icon': `url(&quot;${iconSettings}&quot;)` }" aria-hidden="true" />
          </button>
        </el-tooltip>
      </nav>
    </aside>

    <!-- 右列：顶栏 + 主面板 -->
    <div class="shellRight">
      <header ref="topbarRef" class="shellTopbar">
        <div class="shellTopbarLeft" aria-hidden="true" />

        <!-- ACT: 品牌标识水平中心落在「主面板左边界 ↔ host 图标最左缘」的中点。 -->
        <div class="shellTopbarCenter" :style="brandX !== null ? { '--brand-x': `${brandX}px` } : undefined">
          <div class="shellBrand">
            <span class="brandName">DSH Movie</span>
          </div>
          <div class="shellTopbarNotices">
            <div id="shell-notices" style="display: contents" />
          </div>
        </div>

        <div ref="topbarRightRef" class="shellTopbarRight">
          <!-- ACT: 已登录显示头像（无头像时回落 icons/user.svg）并挂下拉菜单；未登录则点击跳转账户页登录。 -->
          <el-dropdown v-if="auth.signedIn" trigger="click" @command="onAccountCommand">
            <button class="shellRound" type="button" data-account-button :aria-label="translate('账户')" :title="auth.displayName">
              <img v-if="auth.avatarHttpUrl" class="roundAvatar" :src="auth.avatarHttpUrl" :alt="auth.displayName" />
              <span v-else class="navIcon roundIcon" :style="{ '--nav-icon': `url(&quot;${iconAccount}&quot;)` }" aria-hidden="true" />
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ auth.displayName }}</el-dropdown-item>
                <el-dropdown-item divided command="account">{{ translate("账户") }}</el-dropdown-item>
                <el-dropdown-item command="logout">{{ translate("退出登录") }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <button v-else class="shellRound" type="button" data-account-button :aria-label="translate('登录')" :title="translate('登录')" @click="go('/account')">
            <span class="navIcon roundIcon" :style="{ '--nav-icon': `url(&quot;${iconAccount}&quot;)` }" aria-hidden="true" />
          </button>
          <languageSelect popover />
        </div>
      </header>

      <main class="shellMain">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped lang="scss">
.appShell {
  // ACT: 顶栏与页面头部的固定高度；左栏首枚图标要与页面头部里的标题垂直居中对齐。
  --shell-topbar-h: 56px;
  --shell-page-header-h: 56px;
  --shell-nav-item: 42px;
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
}

.shellLeft {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  // ACT: 固定窄栏：42px 图标 + 两侧各 12px 留白 + 1px 分隔边框 = 67px。
  width: 67px;
  // ACT: 上组图标整体下移到顶栏之下，首枚图标垂直中心落在页面标题水平线上。
  padding: calc(var(--shell-topbar-h) + (var(--shell-page-header-h) - 1px - var(--shell-nav-item)) / 2) 0 16px;
  overflow-x: hidden;
  overflow-y: auto;
  border-inline-end: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color) 96%, var(--el-text-color-primary));
}

.shellBrand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  height: 32px;

  .brandName {
    overflow: hidden;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.shellNav {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

// ACT: 顶组三枚图标之间的间距加到 8px；下组间距不变。
.shellNavTop {
  gap: 8px;
}

.shellNavItem {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--shell-nav-item);
  height: var(--shell-nav-item);
  padding: 0;
  border: 0;
  border-radius: var(--ui-radius);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
  &.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
}

// ACT: 图标统一用 mask + currentColor 着色，随主题与激活态变色。
.navIcon {
  display: block;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  background-color: currentColor;
  mask-image: var(--nav-icon);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--nav-icon);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;

  &.roundIcon { width: 20px; height: 20px; }
}

// ACT: 登录后的头像填满圆形按钮，与未登录的图标态保持同一尺寸。
.roundAvatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.shellSpacer { flex: 1 1 auto; }

.shellDivider {
  height: 1px;
  flex-shrink: 0;
  margin: 12px;
  background: var(--el-border-color-lighter);
}

.shellRight {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.shellTopbar {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  column-gap: 12px;
  min-height: var(--shell-topbar-h);
  padding: 8px 16px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
  z-index: 20;
}

.shellTopbarLeft {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 12px;
}

// ACT: 品牌区绝对定位：水平中心落在 --brand-x；未测得前回落 50%（顶栏正中）。
.shellTopbarCenter {
  position: absolute;
  top: 0;
  bottom: 1px; // ACT: 避开顶栏下边框，保持垂直居中。
  left: var(--brand-x, 50%);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  max-width: 60%;
  pointer-events: none; // ACT: 悬浮在左右两区之上，不拦截空白处的点击。

  .shellBrand,
  .shellTopbarNotices { pointer-events: auto; }
}

.shellTopbarNotices {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}

.shellTopbarRight {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.shellRound {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
}

.shellMain {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .shellNavItem,
  .shellRound { transition: none; }
}
</style>
