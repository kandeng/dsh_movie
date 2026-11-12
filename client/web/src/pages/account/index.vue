<template>
  <!-- ACT: 账户整页（对齐设置页布局）：左侧双倍加深菜单栏（账户/钱包/账单 + 设置入口）+ 右侧扁平主面板。
       菜单项为锚点：点击平滑滚动到主面板中对应段落，滚动时高亮跟随。
       登录表单直接内联在「账户」段落（dsh_movie 无 loginDialog，Mode-B 登录就在这里）。 -->
  <div class="account">
    <aside class="sidebar" aria-label="账户分类">
      <div class="accountNav">
        <button
          v-for="item in sections"
          :key="item.id"
          class="accountItem"
          type="button"
          :aria-label="translate(item.label)"
          :aria-pressed="activeSection === item.id"
          @click="goTo(item.id)">
          <span>{{ translate(item.label) }}</span>
        </button>
        <button class="accountItem" type="button" :aria-label="translate('设置')" @click="goSettings">
          <span>{{ translate("设置") }}</span>
        </button>
      </div>
    </aside>

    <section class="content" aria-label="账户内容" tabindex="0">
      <div ref="scrollBox" class="panelContent" @scroll.passive="onScroll">
        <!-- ACT: 账户段落：已登录展示资料并支持编辑昵称/头像/改密；未登录内联展示 Mode-B 登录表单。 -->
        <section :id="sectionId(sections[0].id)" class="accountSection" aria-labelledby="accountTitle">
          <h2 id="accountTitle">{{ translate("账户") }}</h2>

          <div v-if="auth.signedIn" class="accountProfile">
            <div class="avatarRow">
              <div class="avatarBox">
                <img
                  v-if="pendingAvatar || auth.avatarHttpUrl"
                  class="avatar"
                  :src="pendingAvatar || auth.avatarHttpUrl"
                  :alt="auth.displayName" />
                <span v-else class="navIcon avatar" :style="{ '--nav-icon': `url(&quot;${iconAccount}&quot;)` }" aria-hidden="true" />
              </div>
              <div class="avatarControls">
                <input ref="fileInput" type="file" accept="image/*" class="avatarFile" @change="onPickAvatar" />
                <el-button size="small" :disabled="saving" @click="pickAvatar">{{ translate("更换头像") }}</el-button>
                <el-text v-if="pendingAvatar" class="avatarHint" type="info" size="small">{{ translate("保存后生效") }}</el-text>
              </div>
            </div>

            <dl class="profileFields">
              <div class="profileRow">
                <dt>{{ translate("昵称") }}</dt>
                <dd>
                  <el-input v-model="editName" size="small" :disabled="saving" :placeholder="translate('群聊中展示的名字')" />
                </dd>
              </div>
              <div class="profileRow">
                <!-- ACT: 用户 ID 只展示裸本地名（站点账号名）；@ 与 :server 是 Matrix 路由后缀，不属于用户 ID，不展示。 -->
                <dt>{{ translate("用户 ID") }}</dt>
                <dd class="mono">{{ localpartOf(auth.myUserId) }}</dd>
              </div>
            </dl>

            <div class="profileActions">
              <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">{{ translate("保存修改") }}</el-button>
              <el-button type="danger" plain :loading="signingOut" @click="signOut">{{ translate("退出登录") }}</el-button>
            </div>

            <!-- ACT: 修改密码：Matrix UIA 流程，成功后所有设备登出，本地会话失效并回落到登录表单。 -->
            <div class="passwordBlock">
              <h3 class="blockTitle">{{ translate("修改密码") }}</h3>
              <div class="passwordForm">
                <el-input v-model="pwForm.oldPassword" type="password" size="small" show-password :placeholder="translate('当前密码')" :disabled="changingPw" />
                <el-input v-model="pwForm.newPassword" type="password" size="small" show-password :placeholder="translate('新密码')" :disabled="changingPw" />
                <el-input v-model="pwForm.confirm" type="password" size="small" show-password :placeholder="translate('确认新密码')" :disabled="changingPw" />
                <el-button type="primary" size="small" :loading="changingPw" :disabled="!pwDirty" @click="submitChangePassword">{{ translate("修改密码") }}</el-button>
              </div>
            </div>
          </div>

          <!-- ACT: 未登录：内联 Mode-B 登录表单（Matrix 用户名 + 密码，直连本地 Synapse）。 -->
          <div v-else class="loginBlock">
            <p class="accountHint">{{ translate("登录后即可创建群聊、邀请成员，并作为主持人生成视频。") }}</p>
            <el-form class="loginForm" label-position="top" @submit.prevent="onSubmit">
              <el-form-item :label="translate('Matrix 用户名')">
                <el-input v-model="form.identifier" placeholder="movie_demo" autocomplete="username" :disabled="auth.busy" />
              </el-form-item>
              <el-form-item :label="translate('密码')">
                <el-input
                  v-model="form.password"
                  type="password"
                  placeholder="••••••••"
                  autocomplete="current-password"
                  show-password
                  :disabled="auth.busy"
                  @keyup.enter="onSubmit" />
              </el-form-item>
              <el-alert v-if="loginError" :title="loginError" type="error" show-icon :closable="false" class="loginAlert" />
              <el-button type="primary" class="loginSubmit" :loading="auth.busy" @click="onSubmit">
                {{ auth.busy ? translate("登录中…") : translate("登录") }}
              </el-button>
            </el-form>
            <div class="loginHint">
              <div>homeserver: <el-tag size="small">{{ clientConfig.homeserverUrl }}</el-tag></div>
            </div>
          </div>
        </section>

        <!-- ACT: 钱包/账单段落：占位内容，作为菜单锚点目标。 -->
        <section :id="sectionId(sections[1].id)" class="accountSection" aria-labelledby="walletTitle">
          <h2 id="walletTitle">{{ translate("钱包") }}</h2>
          <p class="sectionEmpty">{{ translate("钱包功能即将上线，敬请期待。") }}</p>
        </section>

        <section :id="sectionId(sections[2].id)" class="accountSection" aria-labelledby="billingTitle">
          <h2 id="billingTitle">{{ translate("账单") }}</h2>
          <p class="sectionEmpty">{{ translate("账单功能即将上线，敬请期待。") }}</p>
        </section>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import iconAccount from "@/icons/user.svg";
import { useAuthStore, localpartOf } from "@/stores/auth";
import { clientConfig } from "@/config";

// ACT: 账户页：设置页同款整页布局（左菜单栏 + 右扁平主面板），主面板内含「账户/钱包/账单」三个锚点段落。
// 头像上传后在本地裁剪/缩放为 128x128 的 data URI，保存时经 auth.updateProfile 同步到 Matrix（显示名 + 头像）。
// 登录表单内联在账户段落（无 loginDialog）；路由守卫把未登录用户送到 /account?login=1&redirect=<目标>，
// 登录成功后回到目标页。改密走 Matrix UIA，成功后所有设备登出，本地会话失效并回落到登录表单。
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// ── 未登录：Mode-B 登录表单 ──
const form = reactive({ identifier: "", password: "" });
const loginError = ref("");

// ── 已登录：资料编辑 ──
const editName = ref("");
const pendingAvatar = ref(""); // 待保存的头像 data URI 预览
const fileInput = ref<HTMLInputElement | null>(null);
const saving = ref(false);
const signingOut = ref(false);

// ── 已登录：修改密码 ──
const pwForm = reactive({ oldPassword: "", newPassword: "", confirm: "" });
const changingPw = ref(false);
const pwDirty = computed(() => Boolean(pwForm.oldPassword && pwForm.newPassword && pwForm.confirm));

// ACT: 主面板锚点段落（自上而下：账户 -> 钱包 -> 账单），菜单项不带图标。
const sections = [
  { id: "account", label: "账户" },
  { id: "wallet", label: "钱包" },
  { id: "billing", label: "账单" },
];
const activeSection = ref(sections[0].id);
const scrollBox = ref<HTMLElement | null>(null);

function sectionId(id: string) { return `sec-${id}`; }

// ACT: 点击菜单：高亮对应项并把主面板平滑滚动到该段落。
function goTo(id: string) {
  activeSection.value = id;
  document.getElementById(sectionId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function goSettings() { void router.push("/settings"); }

// ACT: 滚动监听（scroll-spy）：以主面板顶部为基准，高亮当前视口内最靠上的段落对应菜单项。
function onScroll() {
  const box = scrollBox.value;
  if (!box) return;
  const boxTop = box.getBoundingClientRect().top;
  let current = sections[0].id;
  for (const item of sections) {
    const el = document.getElementById(sectionId(item.id));
    if (el && el.getBoundingClientRect().top - boxTop <= 24) current = item.id;
  }
  activeSection.value = current;
}

// ACT: 资料就绪后，用昵称初始化可编辑输入框。
watch(() => auth.displayName, value => { editName.value = value; }, { immediate: true });

const dirty = computed(() =>
  editName.value.trim() !== (auth.displayName ?? "") || Boolean(pendingAvatar.value));

function pickAvatar() { fileInput.value?.click(); }

// ACT: 读文件 -> 居中裁剪为正方形 -> 缩放到 128x128 -> 输出 PNG data URI。
async function onPickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许重复选择同一文件
  if (!file) return;
  try {
    pendingAvatar.value = await fileToSquareDataUri(file, 128);
  } catch {
    ElMessage.error(translate("图片读取失败，请换一张试试"));
  }
}

async function fileToSquareDataUri(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  return canvas.toDataURL("image/png");
}

async function save() {
  if (saving.value || auth.busy) return;
  saving.value = true;
  try {
    await auth.updateProfile(editName.value, pendingAvatar.value || undefined);
    pendingAvatar.value = "";
    ElMessage.success(translate("资料已更新"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("资料更新失败，请稍后重试"));
  } finally {
    saving.value = false;
  }
}

async function submitChangePassword() {
  if (changingPw.value) return;
  if (pwForm.newPassword !== pwForm.confirm) {
    ElMessage.error(translate("两次输入的新密码不一致"));
    return;
  }
  changingPw.value = true;
  try {
    await auth.changePassword(pwForm.oldPassword, pwForm.newPassword);
    pwForm.oldPassword = ""; pwForm.newPassword = ""; pwForm.confirm = "";
    pendingAvatar.value = "";
    ElMessage.success(translate("密码已修改，请重新登录"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("密码修改失败，请稍后重试"));
  } finally {
    changingPw.value = false;
  }
}

// ACT: 登录成功后回到守卫给定的目标页（只接受站内绝对路径，避免外站跳转）。
function afterSignIn() {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "";
  if (redirect.startsWith("/") && !redirect.startsWith("//")) { void router.replace(redirect); return; }
  if (route.query.login === "1") void router.replace({ path: "/account" });
}

async function onSubmit() {
  loginError.value = "";
  try {
    await auth.login(form.identifier, form.password);
    ElMessage.success(translate("已登录"));
    form.password = "";
    afterSignIn();
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : String(err);
  }
}

async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await auth.logout();
    pendingAvatar.value = "";
    ElMessage.success(translate("已退出登录"));
  } finally {
    signingOut.value = false;
  }
}

// ACT: 不能只靠 onMounted —— 已停留在 /account 时再被守卫重定向回来（只是 query 变了）
// 会复用同一个组件实例，onMounted 不会再触发。改用 watch(immediate) 覆盖两种情况。
onMounted(async () => {
  if (!auth.restored) await auth.restore();
});
watch(() => route.query.login, () => {
  if (auth.signedIn && route.query.login === "1") afterSignIn();
}, { immediate: true });

onBeforeUnmount(() => { /* nothing to tear down; avatar blob URLs are session-scoped */ });
</script>

<style scoped lang="scss">
// ACT: 与设置页同款的整页网格：左 220px 双倍加深菜单栏 + 右主面板；基准字号 14px 对齐群聊/设置页。
.account {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  font-size: 14px;

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: color-mix(in srgb, var(--el-bg-color) 92%, var(--el-text-color-primary));
    border-inline-end: 1px solid var(--el-border-color-lighter);

    .accountNav {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 2px 2px;
    }

    .accountItem {
      display: flex;
      align-items: center;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: start;
      cursor: pointer;

      > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      &:hover {
        background: var(--el-fill-color-light);
      }

      &[aria-pressed="true"] {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
      }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 20px;
    overflow: hidden;

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 20px 5px 50px;
    }
  }
}

// ACT: 锚点段落：scroll-margin 保证滚动到位后标题不被裁切；段落间留白分隔。
.accountSection {
  scroll-margin-top: 12px;
  margin-bottom: 36px;

  &:last-child { margin-bottom: 0; }

  h2 {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 600;
  }

  .sectionEmpty {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.7;
  }
}

.accountProfile {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 520px;
}

.avatarRow {
  display: flex;
  align-items: center;
  gap: 16px;
}

.avatarBox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  overflow: hidden;

  .avatar {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  // ACT: 与全局外壳一致，用 mask + currentColor 给 icons/user.svg 着色（该图标内置固定填充色）。
  .navIcon {
    width: 32px;
    height: 32px;
    background-color: currentColor;
    mask-image: var(--nav-icon);
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    -webkit-mask-image: var(--nav-icon);
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
  }
}

.avatarControls {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.avatarFile {
  display: none;
}

.avatarHint {
  font-size: 12px;
}

.profileFields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.profileRow {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 12px;
  align-items: center;

  dt {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }

  dd {
    margin: 0;
    font-size: 14px;
    word-break: break-all;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
}

.profileActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

// ACT: 修改密码区块：标题 + 竖排三输入框 + 提交按钮。
.passwordBlock {
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);

  .blockTitle {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
  }

  .passwordForm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 280px;

    :deep(.el-button) { align-self: flex-start; margin-top: 4px; }
  }
}

// ACT: 未登录内联登录表单。
.loginBlock {
  max-width: 420px;
}

.accountHint {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.loginAlert {
  margin-bottom: 12px;
}

.loginSubmit {
  width: 100%;
}

.loginHint {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
