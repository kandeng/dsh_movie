<script setup lang="ts">
// ACT: 插件市场页（Phase-7 P7-M5, D6）。左栏分类（工具 / 技能）+ 右栏瀑布流卡片，
// 布局对齐设置页。工具卡：名称/来源/种类徽章/状态徽章/警告徽章/定价与授权提示/
// 启用开关/安装·卸载；技能卡：标题/描述/目标 chip/来源工具/版本/许可/警告徽章，
// pick-mode 下出现「确认」按钮（D7 mode-1 触发）。顶部一次性社区内容警告横幅（D8）。
// 访客只读：安装/卸载/启用/举报/确认均为主机动作（D6/D2），由 useRoomRole.isHost 网关。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { translate } from "@dsh-movie/i18n/vue";
import {
  IconSearch,
  IconAlertTriangle,
  IconShieldLock,
  IconDownload,
  IconPlayerPlay,
} from "@tabler/icons-vue";
import type {
  SkillArtifact,
  SkillProfile,
  SkillTarget,
  ToolInstallSpec,
  ToolManifest,
  ToolRecord,
  ToolStatus,
  WarningLevel,
} from "@dsh-movie/protocol";
import { usePlugins } from "@/composables/usePlugins";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { useRoomRole } from "@/composables/useRoomRole";
import { useImportStore } from "@/stores/import";

type Category = "tools" | "skills";

const route = useRoute();
const router = useRouter();
const plugins = usePlugins();
const importStore = useImportStore();
const { activeRoomId, bootstrap } = useMatrixChat();

// ACT: 房间与角色。pick-mode 的下载目标房间优先取暂存的 pending.roomId（跨路由往返），
// 否则回落到当前活动房间；访客判定始终基于活动房间的主机席位。
const roomIdRef = computed(() => activeRoomId.value ?? "");
const roomRole = useRoomRole(roomIdRef);
const canManage = computed(() => roomRole.isHost.value);

const pickMode = computed(() => route.query.mode === "pick");
const pending = computed(() => importStore.pending);
const pickRoomId = computed(() => pending.value?.roomId ?? activeRoomId.value ?? "");

// ACT: 左栏分类，初值来自路由 query.category（编辑器 Import 跳转时带 category=skills）。
const activeCategory = ref<Category>(route.query.category === "skills" ? "skills" : "tools");

// ACT: 技能搜索框，pick-mode 下由 pending.query 意图预填（D10）。
const searchQuery = ref<string>(pending.value?.query ?? "");
const searched = ref(false);

// ACT: 左栏「技能」子菜单 = 电影管线七阶段；activeSub=null 表示父级「技能」（全部）。
const SKILL_SUBCATS: ReadonlyArray<{ id: string; label: string; targets: readonly string[] }> = [
  { id: "script", label: "剧本", targets: ["script"] },
  { id: "shot-plan", label: "分镜", targets: ["shot-plan"] },
  { id: "asset", label: "角色与资产", targets: ["asset"] },
  { id: "storyboard", label: "故事板", targets: ["storyboard"] },
  { id: "clip", label: "片段", targets: ["clip"] },
  { id: "montage", label: "蒙太奇", targets: ["montage"] },
  { id: "others", label: "其他", targets: ["text", "review", "any"] },
];
function subForTarget(target: SkillTarget | undefined): string | null {
  if (target === "script") return "script";
  if (target === "shot-plan") return "shot-plan";
  return null;
}
const activeSub = ref<string | null>(subForTarget(pending.value?.target));
// ACT: 内容面板 = 搜索结果按当前子菜单 scope 过滤；父级「技能」显示全部。
const visibleSkills = computed(() => {
  const sub = SKILL_SUBCATS.find((entry) => entry.id === activeSub.value);
  if (sub === undefined) return plugins.skills.value;
  return plugins.skills.value.filter((skill) => sub.targets.includes(skill.target));
});

// ACT: 一次性社区内容警告横幅（D8）。用 localStorage 记住已读，跨会话只出现一次。
const BANNER_KEY = "dsh-movie.plugins.bannerSeen";
const bannerVisible = ref(false);

// ACT: 安装第三方工具对话框。
const installVisible = ref(false);
const installName = ref("");
const installCommand = ref("");
const installArgs = ref("");
const installAllowlist = ref("");
const installMemory = ref<number | undefined>(undefined);

// ACT: 举报技能对话框（D8 用户报告，任意用户可举报，仅主机可清除）。
const reportVisible = ref(false);
const reportSkill = ref<SkillProfile | null>(null);
const reportLevel = ref<Exclude<WarningLevel, "clean">>("yellow");
const reportReason = ref("");

// ACT: 内联反馈（本项目不使用 ElMessage，沿用 error/notice ref 就地提示）。
const notice = ref<string | null>(null);

// ACT: 可执行技能运行（D9a）。「运行」在技能卡上触发 plugins/skills.run，输出以
// 结果对话框展示；橙色技能先弹授权对话框，记录同意后再运行；红色技能按钮禁用。
const runVisible = ref(false);
const runContent = ref("");
const runArtifacts = ref<SkillArtifact[]>([]);
const consentVisible = ref(false);
const consentSkill = ref<SkillProfile | null>(null);

onMounted(async () => {
  bannerVisible.value = localStorage.getItem(BANNER_KEY) === null;
  await bootstrap();
  await refresh();
  if (activeCategory.value === "skills" || pickMode.value) await runSearch();
});

async function refresh(): Promise<void> {
  notice.value = null;
  try {
    await Promise.all([plugins.loadTools(), plugins.loadSources()]);
  } catch {
    /* plugins.error 已记录，模板就地渲染 */
  }
}

async function runSearch(): Promise<void> {
  notice.value = null;
  searched.value = true;
  try {
    await plugins.search(searchQuery.value);
  } catch {
    /* plugins.error 已记录 */
  }
}

function dismissBanner(): void {
  bannerVisible.value = false;
  localStorage.setItem(BANNER_KEY, "1");
}

function switchCategory(category: Category): void {
  activeCategory.value = category;
  void router.replace({
    path: "/plugins",
    query: {
      ...(category === "skills" ? { category: "skills" } : {}),
      ...(pickMode.value ? { mode: "pick" } : {}),
    },
  });
  // ACT: 进入「技能」父级 = 清空子菜单与查询，浏览全部技能卡（需求 4）。
  if (category === "skills") {
    activeSub.value = null;
    searchQuery.value = "";
    void runSearch();
  }
}

// ACT: 点击子菜单 = 限定 scope 并浏览该子类别全部技能卡（无需输入查询，需求 3/4）。
function selectSub(id: string): void {
  activeSub.value = id;
  searchQuery.value = "";
  void runSearch();
}

function cancelPick(): void {
  importStore.clearPending();
  void router.push({ path: "/studio" });
}

// ACT: pick-mode「确认」→ 下载技能正文写入房间工作区（D7 mode-1）→ 暂存 completed →
// 回到 Studio 由其消费粘贴（b5/b6）。
async function confirmImport(skill: SkillProfile): Promise<void> {
  const target = pending.value;
  const roomId = pickRoomId.value;
  if (target === null || roomId === "") {
    notice.value = translate("下载失败");
    return;
  }
  notice.value = null;
  try {
    const download = await plugins.download(skill.id, roomId);
    importStore.complete({
      nodeId: target.nodeId,
      widgetName: target.widgetName,
      insertionPoint: target.insertionPoint,
      body: download.body,
      ref: {
        id: skill.id,
        toolId: skill.toolId,
        version: download.profile.version,
        path: download.path,
        downloadedAt: Date.now(),
      },
    });
    importStore.clearPending();
    await router.push({ path: "/studio" });
  } catch {
    notice.value = translate("下载失败");
  }
}

// ACT: 启用/停用工具（主机动作）。
async function toggleEnabled(tool: ToolRecord, enabled: boolean): Promise<void> {
  notice.value = null;
  try {
    await plugins.setEnabled(tool.id, enabled);
    await refresh();
  } catch {
    /* plugins.error 已记录 */
  }
}

// ACT: 卸载用户/第三方工具（主机动作）。
async function uninstallTool(tool: ToolRecord): Promise<void> {
  notice.value = null;
  try {
    await plugins.uninstall(tool.id);
    await refresh();
  } catch {
    /* plugins.error 已记录 */
  }
}

function openInstall(): void {
  installName.value = "";
  installCommand.value = "";
  installArgs.value = "";
  installAllowlist.value = "";
  installMemory.value = undefined;
  installVisible.value = true;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// ACT: 提交安装。manifest 的可选字段在 exactOptionalPropertyTypes 下需按需省略。
async function submitInstall(): Promise<void> {
  const manifest: ToolManifest = {
    networkAllowlist: splitList(installAllowlist.value),
    ...(installMemory.value === undefined ? {} : { memoryMaxMb: installMemory.value }),
  };
  const args = splitList(installArgs.value);
  const spec: ToolInstallSpec = {
    name: installName.value.trim(),
    command: installCommand.value.trim(),
    ...(args.length === 0 ? {} : { args }),
    manifest,
  };
  notice.value = null;
  try {
    await plugins.install(spec);
    installVisible.value = false;
    await refresh();
    notice.value = translate("已安装");
  } catch {
    /* plugins.error 已记录 */
  }
}

function openReport(skill: SkillProfile): void {
  reportSkill.value = skill;
  reportLevel.value = "yellow";
  reportReason.value = "";
  reportVisible.value = true;
}

async function submitReport(): Promise<void> {
  const skill = reportSkill.value;
  if (skill === null) return;
  notice.value = null;
  try {
    await plugins.flag(skill.id, reportLevel.value, reportReason.value.trim());
    reportVisible.value = false;
    await runSearch();
    notice.value = translate("已举报");
  } catch {
    /* plugins.error 已记录 */
  }
}

// ACT: 运行一个可执行技能（D9a）。状态判别：ok→结果对话框；consent-required→
// 授权对话框；blocked（红）/not-executable/not-found→就地提示。房间取 pick 目标或活动房间。
async function runSkill(skill: SkillProfile): Promise<void> {
  const roomId = pickRoomId.value;
  if (roomId === "") {
    notice.value = translate("运行失败");
    return;
  }
  notice.value = null;
  try {
    const { run, status } = await plugins.run(skill.id, roomId);
    if (status === "ok" && run !== null) {
      runContent.value = run.content;
      runArtifacts.value = run.artifacts;
      runVisible.value = true;
      return;
    }
    if (status === "consent-required") {
      consentSkill.value = skill;
      consentVisible.value = true;
      return;
    }
    if (status === "blocked") {
      notice.value = translate("恶意内容已被阻止运行");
      return;
    }
    if (status === "not-executable") {
      notice.value = translate("此技能不可执行");
      return;
    }
    notice.value = translate("运行失败");
  } catch {
    notice.value = translate("运行失败");
  }
}

// ACT: 橙色技能授权后记录服务器全局同意（D9），随即重试运行。
async function submitConsent(): Promise<void> {
  const skill = consentSkill.value;
  if (skill === null) return;
  try {
    await plugins.consent(skill.id, true);
    consentVisible.value = false;
    await runSkill(skill);
  } catch {
    /* plugins.error 已记录 */
  }
}

// ── 徽章/标签映射 ──────────────────────────────────────────────────────────
function warningLabel(level: WarningLevel): string {
  if (level === "yellow") return translate("疑似风险");
  if (level === "orange") return translate("需要授权");
  if (level === "red") return translate("恶意");
  return "";
}

function warningClass(level: WarningLevel): string {
  return `warnBadge warn-${level}`;
}

function statusLabel(status: ToolStatus): string {
  if (status === "running") return translate("运行中");
  if (status === "stopped") return translate("已停止");
  if (status === "degraded") return translate("已降级");
  if (status === "error") return translate("错误");
  return translate("已禁用");
}

function statusType(status: ToolStatus): "success" | "info" | "warning" | "danger" {
  if (status === "running") return "success";
  if (status === "degraded") return "warning";
  if (status === "error") return "danger";
  return "info";
}

function kindLabel(kind: ToolRecord["kind"]): string {
  if (kind === "builtin") return translate("内置");
  if (kind === "third-party") return translate("第三方");
  return translate("用户");
}

function targetLabel(target: SkillTarget): string {
  if (target === "script") return translate("剧本");
  if (target === "shot-plan") return translate("分镜");
  if (target === "text") return translate("文本");
  if (target === "review") return translate("审阅");
  return translate("通用");
}

function sourceStatus(toolId: string): ToolStatus | null {
  return plugins.sources.value.find((row) => row.toolId === toolId)?.status ?? null;
}
</script>

<template>
  <main class="pluginsGrid">
    <aside class="pluginsSidebar">
      <div class="sidebarHeader">
        <h2>{{ translate("插件") }}</h2>
      </div>
      <nav class="pluginsNav" :aria-label="translate('插件')">
        <button
          type="button"
          class="navButton"
          :aria-current="activeCategory === 'tools' ? 'page' : undefined"
          @click="switchCategory('tools')">
          <span>{{ translate("工具") }}</span>
        </button>
        <button
          type="button"
          class="navButton"
          :aria-current="activeCategory === 'skills' && activeSub === null ? 'page' : undefined"
          @click="switchCategory('skills')">
          <span>{{ translate("技能") }}</span>
        </button>
        <div v-if="activeCategory === 'skills'" class="subNav">
          <button
            v-for="sub in SKILL_SUBCATS"
            :key="sub.id"
            type="button"
            class="navButton subButton"
            :aria-current="activeSub === sub.id ? 'page' : undefined"
            @click="selectSub(sub.id)">
            <span>{{ translate(sub.label) }}</span>
          </button>
        </div>
      </nav>
    </aside>

    <section class="pluginsMain">
      <!-- ACT: pick-mode 顶部条：说明正在为哪个节点挑选技能，并提供取消返回。 -->
      <div v-if="pickMode" class="pickBar">
        <icon-download :size="16" aria-hidden="true" />
        <span>{{ translate("选择一个技能导入到编辑器") }}</span>
        <el-button size="small" text @click="cancelPick">{{ translate("取消") }}</el-button>
      </div>

      <!-- ACT: 一次性社区内容警告横幅（D8）。 -->
      <el-alert
        v-if="bannerVisible"
        class="banner"
        type="warning"
        :closable="true"
        show-icon
        @close="dismissBanner">
        <template #title>{{ translate("社区内容未经审计") }}</template>
        <p class="bannerBody">
          {{ translate("注册表中的技能由社区发布，未经审计，请留意警告标记。") }}
        </p>
      </el-alert>

      <!-- ACT: 内联反馈：错误优先，其次成功提示。 -->
      <el-alert
        v-if="plugins.error.value"
        class="banner"
        type="error"
        :closable="false"
        show-icon
        :title="plugins.error.value" />
      <el-alert
        v-else-if="notice"
        class="banner"
        type="success"
        :closable="false"
        show-icon
        :title="notice" />

      <!-- ── 工具视图 ── -->
      <template v-if="activeCategory === 'tools'">
        <div class="viewHeader">
          <h3>{{ translate("工具") }}</h3>
          <el-button type="primary" size="small" :disabled="!canManage" @click="openInstall">
            {{ translate("安装") }}
          </el-button>
        </div>
        <p v-if="!canManage" class="readonlyHint">{{ translate("仅主持人可管理工具") }}</p>
        <div v-if="plugins.loading.value && plugins.tools.value.length === 0" class="empty">
          {{ translate("连接中…") }}
        </div>
        <div v-else-if="plugins.tools.value.length === 0" class="empty">
          {{ translate("暂无工具") }}
        </div>
        <div v-else class="masonry">
          <article v-for="tool in plugins.tools.value" :key="tool.id" class="card">
            <header class="cardHead">
              <span class="cardTitle">{{ tool.name }}</span>
              <span
                v-if="tool.warningLevel !== 'clean'"
                :class="warningClass(tool.warningLevel)"
                :title="translate('警告')">
                <icon-alert-triangle :size="13" aria-hidden="true" />
                {{ warningLabel(tool.warningLevel) }}
              </span>
            </header>
            <p class="cardProvider">{{ translate("来源") }}：{{ tool.provider }}</p>
            <div class="chipRow">
              <el-tag size="small" type="info" effect="plain">{{ kindLabel(tool.kind) }}</el-tag>
              <el-tag size="small" :type="statusType(sourceStatus(tool.id) ?? tool.status)" effect="plain">
                {{ statusLabel(sourceStatus(tool.id) ?? tool.status) }}
              </el-tag>
              <el-tag v-if="tool.installed" size="small" type="success" effect="plain">
                {{ translate("已安装") }}
              </el-tag>
            </div>
            <p v-if="tool.pricing" class="cardNote">{{ tool.pricing }}</p>
            <p v-if="tool.requiresCredentials" class="cardNote credential">
              <icon-shield-lock :size="13" aria-hidden="true" />
              {{ translate("需要授权") }}
            </p>
            <footer class="cardActions">
              <el-switch
                :model-value="tool.enabled"
                :disabled="!canManage || !tool.installed || plugins.busy.value"
                @update:model-value="(value: boolean | string | number) => toggleEnabled(tool, value === true)" />
              <span class="switchLabel">{{ translate("启用") }}</span>
              <span class="spacer" />
              <el-button
                v-if="tool.installed && tool.kind !== 'builtin'"
                size="small"
                text
                type="danger"
                :disabled="!canManage || plugins.busy.value"
                @click="uninstallTool(tool)">
                {{ translate("卸载") }}
              </el-button>
            </footer>
          </article>
        </div>
      </template>

      <!-- ── 技能视图 ── -->
      <template v-else>
        <div class="viewHeader">
          <h3>{{ translate("技能") }}</h3>
        </div>
        <div class="searchRow">
          <el-input
            v-model="searchQuery"
            class="searchInput"
            :placeholder="translate('搜索技能')"
            clearable
            @keyup.enter="runSearch">
            <template #prefix><icon-search :size="15" aria-hidden="true" /></template>
          </el-input>
          <el-button type="primary" :loading="plugins.loading.value" @click="runSearch">
            {{ translate("搜索") }}
          </el-button>
        </div>
        <div v-if="plugins.loading.value && visibleSkills.length === 0" class="empty">
          {{ translate("连接中…") }}
        </div>
        <div v-else-if="searched && visibleSkills.length === 0" class="empty">
          {{ translate("无匹配技能") }}
        </div>
        <div v-else class="masonry">
          <article v-for="skill in visibleSkills" :key="skill.id" class="card">
            <header class="cardHead">
              <span class="cardTitle">{{ skill.title }}</span>
              <span
                v-if="skill.warningLevel !== 'clean'"
                :class="warningClass(skill.warningLevel)"
                :title="translate('警告')">
                <icon-alert-triangle :size="13" aria-hidden="true" />
                {{ warningLabel(skill.warningLevel) }}
              </span>
            </header>
            <p class="cardDesc">{{ skill.description }}</p>
            <div class="chipRow">
              <el-tag size="small" type="primary" effect="plain">{{ targetLabel(skill.target) }}</el-tag>
              <el-tag size="small" type="info" effect="plain">v{{ skill.version }}</el-tag>
              <el-tag v-if="skill.license" size="small" type="info" effect="plain">{{ skill.license }}</el-tag>
            </div>
            <p class="cardProvider">{{ translate("来源") }}：{{ skill.provider }}</p>
            <footer class="cardActions">
              <el-button
                size="small"
                text
                :disabled="!canManage"
                @click="openReport(skill)">
                {{ translate("举报") }}
              </el-button>
              <span class="spacer" />
              <!-- ACT: 运行（D9a）。红色技能禁用并提示；其余主机可运行。 -->
              <el-tooltip
                v-if="skill.executable && skill.warningLevel === 'red'"
                :content="translate('恶意内容已被阻止运行')"
                placement="top"
                :show-arrow="false"
                :hide-after="0">
                <span class="marketWrap">
                  <el-button size="small" type="warning" plain disabled>
                    <icon-player-play :size="14" aria-hidden="true" />
                    {{ translate("运行") }}
                  </el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else-if="skill.executable"
                size="small"
                type="warning"
                plain
                :loading="plugins.busy.value"
                :disabled="!canManage"
                @click="runSkill(skill)">
                <icon-player-play :size="14" aria-hidden="true" />
                {{ translate("运行") }}
              </el-button>
              <el-tooltip
                v-if="skill.warningLevel === 'red'"
                :content="translate('恶意内容已被阻止导入')"
                placement="top"
                :show-arrow="false"
                :hide-after="0">
                <span class="marketWrap">
                  <el-button size="small" type="primary" disabled>{{ translate("确认") }}</el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else-if="pickMode"
                size="small"
                type="primary"
                :loading="plugins.busy.value"
                :disabled="!canManage"
                @click="confirmImport(skill)">
                {{ translate("确认") }}
              </el-button>
            </footer>
          </article>
        </div>
      </template>
    </section>

    <!-- ACT: 安装第三方工具对话框。 -->
    <el-dialog v-model="installVisible" :title="translate('安装')" width="480px">
      <el-form label-position="top">
        <el-form-item :label="translate('名称')">
          <el-input v-model="installName" :placeholder="translate('名称')" />
        </el-form-item>
        <el-form-item :label="translate('命令')">
          <el-input v-model="installCommand" placeholder="node /path/to/mcp-server.js" />
        </el-form-item>
        <el-form-item :label="translate('参数')">
          <el-input v-model="installArgs" :placeholder="translate('以逗号分隔')" />
        </el-form-item>
        <el-form-item :label="translate('网络白名单')">
          <el-input v-model="installAllowlist" :placeholder="translate('以逗号分隔')" />
        </el-form-item>
        <el-form-item :label="translate('内存上限（MB）')">
          <el-input-number v-model="installMemory" :min="0" :step="64" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="installVisible = false">{{ translate("取消") }}</el-button>
        <el-button
          type="primary"
          :loading="plugins.busy.value"
          :disabled="installName.trim() === '' || installCommand.trim() === ''"
          @click="submitInstall">
          {{ translate("安装") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ACT: 举报技能对话框（D8）。 -->
    <el-dialog v-model="reportVisible" :title="translate('举报')" width="440px">
      <el-form label-position="top">
        <el-form-item :label="translate('警告')">
          <el-select v-model="reportLevel" class="targetSelect">
            <el-option :label="translate('疑似风险')" value="yellow" />
            <el-option :label="translate('需要授权')" value="orange" />
            <el-option :label="translate('恶意')" value="red" />
          </el-select>
        </el-form-item>
        <el-form-item :label="translate('理由')">
          <el-input v-model="reportReason" type="textarea" :rows="3" :placeholder="translate('理由')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reportVisible = false">{{ translate("取消") }}</el-button>
        <el-button type="primary" :loading="plugins.busy.value" @click="submitReport">
          {{ translate("举报") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ACT: 运行结果对话框（D9a）。展示技能执行的文本输出与写入房间的产物。 -->
    <el-dialog v-model="runVisible" :title="translate('运行结果')" width="560px">
      <pre class="runOutput">{{ runContent }}</pre>
      <div v-if="runArtifacts.length > 0" class="runArtifacts">
        <p class="runArtifactsTitle">{{ translate("执行输出") }}</p>
        <ul class="runArtifactList">
          <li v-for="artifact in runArtifacts" :key="artifact.path">{{ artifact.path }}</li>
        </ul>
      </div>
      <template #footer>
        <el-button type="primary" @click="runVisible = false">{{ translate("关闭") }}</el-button>
      </template>
    </el-dialog>

    <!-- ACT: 橙色技能授权对话框（D9）。运行前需用户明确授权，记录到服务器全局同意存储。 -->
    <el-dialog v-model="consentVisible" :title="translate('授权运行')" width="440px">
      <el-alert type="warning" :closable="false" show-icon :title="translate('需要授权后运行')">
        <p class="bannerBody">{{ translate("该技能为可疑内容，运行前需要你的授权。") }}</p>
      </el-alert>
      <template #footer>
        <el-button @click="consentVisible = false">{{ translate("拒绝") }}</el-button>
        <el-button type="warning" :loading="plugins.busy.value" @click="submitConsent">
          {{ translate("授权运行") }}
        </el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style lang="scss" scoped>
.pluginsGrid {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  height: 100%;
  padding: 16px;
}

.pluginsSidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;

  .sidebarHeader h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }
}

.pluginsNav {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .navButton {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--el-border-radius-base);
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover { background: var(--el-fill-color-light); }

    &[aria-current="page"] {
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      font-weight: 600;
    }
  }
}

.pluginsMain {
  min-width: 0;
  overflow-y: auto;
}

.pickBar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 13px;

  .el-button { margin-left: auto; }
}

.banner { margin-bottom: 12px; }

.bannerBody {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.viewHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;

  h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }
}

.readonlyHint {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.searchRow {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;

  .searchInput { flex: 1; min-width: 0; }
  .targetSelect { width: 140px; }
}

.empty {
  padding: 64px 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  text-align: center;
}

// ACT: Pinterest 式瀑布流，对齐广场页：等宽多列，卡片禁止跨列断开。
.masonry {
  column-width: 320px;
  column-gap: 20px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  margin: 0 0 20px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: calc(var(--ui-radius) * 2.5);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 80%, transparent);
  box-shadow: var(--el-box-shadow-lighter);
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
}

.cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cardTitle {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  word-break: break-word;
}

.cardDesc {
  margin: 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.cardProvider {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.cardNote {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;

  &.credential {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--el-color-warning);
  }
}

.chipRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cardActions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;

  .spacer { flex: 1; }
  .switchLabel {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}

// ACT: 警告徽章配色（D8 阶梯）。
.warnBadge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;

  &.warn-yellow {
    background: var(--el-color-warning-light-9);
    color: var(--el-color-warning);
  }

  &.warn-orange {
    background: color-mix(in srgb, var(--el-color-warning) 22%, var(--el-bg-color));
    color: #d46b08;
  }

  &.warn-red {
    background: var(--el-color-danger-light-9);
    color: var(--el-color-danger);
  }
}

.marketWrap { display: inline-flex; }

// ACT: 运行结果对话框（D9a）的输出与产物样式。
.runOutput {
  margin: 0;
  padding: 12px;
  max-height: 280px;
  overflow: auto;
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.runArtifacts {
  margin-top: 12px;

  .runArtifactsTitle {
    margin: 0 0 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .runArtifactList {
    margin: 0;
    padding-left: 18px;
    color: var(--el-text-color-regular);
    font-size: 12px;
    line-height: 1.7;
    word-break: break-all;
  }
}

.subNav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 12px;
}

.pluginsNav .subButton { font-size: 12px; }

@media (max-width: 700px) {
  .pluginsGrid {
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 10px;
  }

  .sidebarHeader { display: none; }

  .navButton span { display: none; }

  .navButton {
    justify-content: center;
    padding: 10px 0;
  }
}
</style>
