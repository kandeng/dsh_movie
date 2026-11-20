<!-- ACT: 设置 → 问题面板：直连 GitHub REST API 读取公开仓库 kandeng/dsh_movie 的
     Issue 列表（仓库公开、api.github.com 对 CORS 开放），无需服务端代理与令牌；
     网络不可达（如 GFW 内安装）时降级为引导文案，指引用户直接到仓库提交 Issue。
     列表仅读：详情/评论点击行外链到 GitHub 页面，避免在端内渲染不可信 Markdown。 -->
<template>
  <div class="issuesPanel">
    <div class="issuesBar">
      <div class="stateSwitch" role="group" :aria-label="translate('问题')">
        <button type="button" :aria-pressed="state === 'open'" @click="switchState('open')">{{ translate("开放中") }}</button>
        <button type="button" :aria-pressed="state === 'closed'" @click="switchState('closed')">{{ translate("已关闭") }}</button>
      </div>
      <el-button size="small" text type="primary" :loading="loading" @click="load(true)">
        <template #icon><icon-refresh :size="14" aria-hidden="true" /></template>
        {{ translate("刷新") }}
      </el-button>
      <!-- ACT: 新建 Issue 走 GitHub 原生新建页（提交需 GitHub 会话/鉴权，端内无令牌
           不代填）；GFW 内不可达时该外链同时充当降级提交入口。 -->
      <a class="newIssue" :href="NEW_ISSUE_HTML" target="_blank" rel="noopener noreferrer">
        <icon-circle-plus :size="14" aria-hidden="true" />{{ translate("新建 Issue") }}
      </a>
      <a class="ghLink" :href="ISSUES_HTML" target="_blank" rel="noopener noreferrer">
        {{ translate("在 GitHub 上查看") }}<icon-external-link :size="14" aria-hidden="true" />
      </a>
    </div>

    <p v-if="failed" class="issuesFallback" role="alert">
      <icon-alert-triangle :size="16" class="fallbackIcon" aria-hidden="true" />
      <span>
        {{ translate("当前网络无法访问 GitHub，问题列表加载失败。如需反馈问题，请直接前往项目仓库提交 Issue：") }}
        <a :href="ISSUES_HTML" target="_blank" rel="noopener noreferrer">{{ ISSUES_HTML }}</a>
      </span>
    </p>

    <p v-else-if="loading && rows.length === 0" class="issuesEmpty">{{ translate("正在加载问题列表…") }}</p>

    <ul v-else-if="rows.length > 0" class="issueList">
      <li v-for="row in rows" :key="row.number">
        <a class="issueRow" :href="row.html_url" target="_blank" rel="noopener noreferrer">
          <span class="issueState" :class="row.state">
            <icon-circle-dot v-if="row.state === 'open'" :size="16" aria-hidden="true" />
            <icon-circle-check v-else :size="16" aria-hidden="true" />
          </span>
          <span class="issueMain">
            <span class="issueTitle">
              <b class="issueNumber">#{{ row.number }}</b>{{ row.title }}<i
                v-for="label in row.labels"
                :key="label.name"
                class="issueLabel"
                :style="{ borderColor: `#${label.color ?? '8b949e'}`, color: `#${label.color ?? '8b949e'}` }">{{ label.name }}</i>
            </span>
            <span class="issueMeta">
              <span>{{ row.author }} · {{ row.created }}</span>
              <span class="issueComments"><icon-message :size="13" aria-hidden="true" /> {{ row.comments }}</span>
            </span>
          </span>
          <icon-external-link :size="14" class="issueGo" aria-hidden="true" />
        </a>
      </li>
    </ul>

    <p v-else class="issuesEmpty">{{ translate("暂无问题记录") }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  IconAlertTriangle, IconCircleCheck, IconCircleDot, IconCirclePlus, IconExternalLink, IconMessage, IconRefresh,
} from "@tabler/icons-vue";
import { translate } from "@dsh-movie/i18n/vue";

const ISSUES_HTML = "https://github.com/kandeng/dsh_movie/issues";
const NEW_ISSUE_HTML = "https://github.com/kandeng/dsh_movie/issues/new";
const ISSUES_API = "https://api.github.com/repos/kandeng/dsh_movie/issues";
// ACT: 未鉴权配额 60 次/小时/IP，60s TTL 缓存足够面板反复切换不超配。
const CACHE_TTL = 60_000;

type IssueState = "open" | "closed";

interface IssueLabel { name: string; color?: string }
interface IssueRow {
  number: number;
  title: string;
  state: IssueState;
  html_url: string;
  author: string;
  created: string;
  comments: number;
  labels: IssueLabel[];
}
interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  comments: number;
  created_at: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
  labels?: unknown;
}

const state = ref<IssueState>("open");
const rows = ref<IssueRow[]>([]);
const loading = ref(false);
const failed = ref(false);
const cache = new Map<IssueState, { at: number; rows: IssueRow[] }>();

function mapIssue(raw: GhIssue): IssueRow | undefined {
  // ACT: GitHub 的 /issues 端点混带 pull request，用 pull_request 字段存在性剔除。
  if (raw.pull_request !== undefined) return;
  const labels: IssueLabel[] = Array.isArray(raw.labels)
    ? raw.labels
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          name: typeof item.name === "string" ? item.name : "?",
          color: typeof item.color === "string" && /^[\da-f]{6}$/i.test(item.color) ? item.color : undefined,
        }))
    : [];
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === "closed" ? "closed" : "open",
    html_url: raw.html_url,
    author: raw.user?.login ?? "ghost",
    created: raw.created_at.slice(0, 10),
    comments: raw.comments,
    labels,
  };
}

async function load(force = false): Promise<void> {
  const hit = cache.get(state.value);
  if (!force && hit !== undefined && Date.now() - hit.at < CACHE_TTL) {
    rows.value = hit.rows;
    failed.value = false;
    return;
  }
  loading.value = true;
  try {
    const res = await fetch(`${ISSUES_API}?state=${state.value}&per_page=50&sort=created&direction=desc`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
    const body = (await res.json()) as GhIssue[];
    const mapped = body.map(mapIssue).filter((row): row is IssueRow => row !== undefined);
    cache.set(state.value, { at: Date.now(), rows: mapped });
    rows.value = mapped;
    failed.value = false;
  }
  catch {
    // ACT: 网络不可达（GFW 内直连失败、离线、配额耗尽等）不抛错码，改示提交引导。
    rows.value = [];
    failed.value = true;
  }
  finally {
    loading.value = false;
  }
}

function switchState(next: IssueState): void {
  if (state.value === next) return;
  state.value = next;
  const hit = cache.get(next);
  rows.value = hit !== undefined && Date.now() - hit.at < CACHE_TTL ? hit.rows : [];
  void load();
}

onMounted(() => { void load(); });
</script>

<style scoped lang="scss">
.issuesPanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.issuesBar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;

  .stateSwitch {
    display: inline-flex;
    border: 1px solid var(--el-border-color);
    border-radius: var(--el-border-radius-base);
    overflow: hidden;

    button {
      padding: 6px 14px;
      border: 0;
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      font-size: 13px;
      cursor: pointer;

      & + button { border-inline-start: 1px solid var(--el-border-color); }
      &[aria-pressed="true"] { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
      &:hover { background: var(--el-fill-color-light); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
    }
  }

  .newIssue {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    border: 1px solid var(--el-color-primary);
    border-radius: var(--el-border-radius-base);
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
    font-size: 12px;
    line-height: 1;
    text-decoration: none;
    transition: background-color 0.18s;

    &:hover { background: var(--el-color-primary-light-8); }
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
  }

  .ghLink {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-inline-start: auto;
    color: var(--el-color-primary);
    font-size: 13px;
    text-decoration: none;

    &:hover { text-decoration: underline; }
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
  }
}

.issuesFallback {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 8px;
  background: var(--el-color-warning-light-9);
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.7;

  .fallbackIcon { flex-shrink: 0; margin-top: 3px; color: var(--el-color-warning); }
  a { color: var(--el-color-primary); word-break: break-all; }
}

.issueList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;

  .issueRow {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
    background: var(--el-bg-color-overlay);
    color: inherit;
    text-decoration: none;
    transition: border-color 0.18s, background-color 0.18s;

    &:hover { border-color: var(--el-color-primary-light-5); background: var(--el-fill-color-extra-light); }
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

    .issueState {
      flex-shrink: 0;
      margin-top: 2px;

      &.open { color: var(--el-color-success); }
      &.closed { color: var(--el-color-info); }
    }

    .issueMain {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 4px;
      min-width: 0;

      .issueTitle {
        font-size: 14px;
        line-height: 1.5;
        overflow-wrap: anywhere;

        .issueNumber { margin-inline-end: 6px; color: var(--el-text-color-secondary); font-weight: 600; }
        .issueLabel {
          display: inline-block;
          margin-inline-start: 6px;
          padding: 0 8px;
          border: 1px solid;
          border-radius: 999px;
          font-size: 11px;
          font-style: normal;
          line-height: 18px;
          vertical-align: 1px;
        }
      }

      .issueMeta {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--el-text-color-secondary);
        font-size: 12px;

        .issueComments { display: inline-flex; align-items: center; gap: 4px; }
      }
    }

    .issueGo { flex-shrink: 0; margin-top: 3px; color: var(--el-text-color-secondary); }
  }
}

.issuesEmpty {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
}

@media (max-width: 700px) {
  .issuesBar .ghLink { margin-inline-start: 0; }
}
</style>
