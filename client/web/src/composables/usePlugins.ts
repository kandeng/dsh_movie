/**
 * Plugins-marketplace data access over Leg C (Phase-7 P7-M5).
 *
 * The browser half of the `plugins/*` namespace (protocol D5, gateway handlers
 * M4). One composable owns the reactive Tools/Skills/sources state the Plugins
 * page renders and the mutations (install/uninstall/enable, search, profile,
 * download, flag) it drives. The caller's Matrix access token is read fresh per
 * RPC from the auth store, so a re-validated session propagates automatically
 * (Leg C is stateless).
 *
 * Governance (D2/D6): tool lifecycle writes and skill flags are host actions the
 * gateway enforces; the composable simply surfaces a {@link LegCError} (`forbidden`)
 * so the page can render read-only for guests. Skill **download** is room-scoped
 * (D7 mode 1): it writes `<roomDir>/skills/<id>.md` server-side and returns the
 * sanitized body + version-pinned profile the editor pastes into the node.
 */

import { ref, type Ref } from "vue";
import { LegCError, RpcClient } from "@dsh-movie/sdk";
import type {
  SkillDownload,
  SkillProfile,
  SkillRunResult,
  SkillRunStatus,
  SkillTarget,
  SourceStatus,
  ToolInstallSpec,
  ToolRecord,
  WarningLevel,
} from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";

/** The handle returned by {@link usePlugins}. */
export interface PluginsHandle {
  /** Every server-global tool (Tools view). */
  tools: Ref<ToolRecord[]>;
  /** Per-tool health rows driving badges/chips (D5). */
  sources: Ref<SourceStatus[]>;
  /** The last skill search result (Skills view). */
  skills: Ref<SkillProfile[]>;
  /** True while a read round-trip is in flight. */
  loading: Ref<boolean>;
  /** True while a write/mutation round-trip is in flight. */
  busy: Ref<boolean>;
  /** The last surfaced error message, or `null`. */
  error: Ref<string | null>;
  /** Refresh {@link tools} (`plugins/tools.list`). */
  loadTools(): Promise<ToolRecord[]>;
  /** Refresh {@link sources} (`plugins/sources.status`). */
  loadSources(): Promise<SourceStatus[]>;
  /** Fan out a skill search (`plugins/skills.search`). */
  search(q: string, target?: SkillTarget, toolId?: string): Promise<SkillProfile[]>;
  /** Resolve one skill profile (`plugins/skills.profile`). */
  profile(id: string): Promise<SkillProfile | null>;
  /** Download one skill into a room (D7 mode 1, `plugins/skills.download`). */
  download(id: string, roomId: string): Promise<SkillDownload>;
  /** Raise/clear a server-global skill flag (host action, `plugins/skills.flag`). */
  flag(id: string, level: WarningLevel, reason: string): Promise<WarningLevel>;
  /**
   * Run an executable skill into a room (D9a, host action, `plugins/skills.run`).
   * Returns the typed `{ run, status }` envelope: `status === "ok"` carries the
   * run content + written artifacts; `consent-required` means the skill is orange
   * and the caller must record consent (then retry); the rest are refusals.
   */
  run(id: string, roomId: string, args?: Record<string, unknown>): Promise<{ run: SkillRunResult | null; status: SkillRunStatus }>;
  /** Record/revoke execution consent for an orange skill (`plugins/skills.consent`). */
  consent(id: string, granted: boolean): Promise<boolean>;
  /** Install a third-party/user tool (host action, `plugins/tools.install`). */
  install(spec: ToolInstallSpec): Promise<ToolRecord>;
  /** Uninstall a user tool (host action, `plugins/tools.uninstall`). */
  uninstall(toolId: string): Promise<boolean>;
  /** Enable/disable a tool (host action, `plugins/tools.enable`). */
  setEnabled(toolId: string, enabled: boolean): Promise<ToolRecord>;
  /** One tool's live status (`plugins/tools.status`). */
  status(toolId: string): Promise<SourceStatus | null>;
}

/** Turn an unknown throw into a short human-readable message. */
function describeError(error: unknown): string {
  if (error instanceof LegCError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create a plugins-marketplace handle bound to the auth store.
 * @returns the {@link PluginsHandle}.
 */
export function usePlugins(): PluginsHandle {
  const auth = useAuthStore();
  const rpc = new RpcClient(sdkConfig, {
    getToken: () => auth.session?.accessToken ?? null,
  });

  const tools = ref<ToolRecord[]>([]);
  const sources = ref<SourceStatus[]>([]);
  const skills = ref<SkillProfile[]>([]);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);

  async function loadTools(): Promise<ToolRecord[]> {
    loading.value = true;
    try {
      const res = await rpc.call("plugins/tools.list", {});
      tools.value = res.tools;
      error.value = null;
      return res.tools;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      loading.value = false;
    }
  }

  async function loadSources(): Promise<SourceStatus[]> {
    loading.value = true;
    try {
      const res = await rpc.call("plugins/sources.status", {});
      sources.value = res.sources;
      error.value = null;
      return res.sources;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      loading.value = false;
    }
  }

  async function search(q: string, target?: SkillTarget, toolId?: string): Promise<SkillProfile[]> {
    loading.value = true;
    try {
      const res = await rpc.call("plugins/skills.search", {
        q,
        ...(target === undefined ? {} : { target }),
        ...(toolId === undefined ? {} : { toolId }),
      });
      skills.value = res.skills;
      error.value = null;
      return res.skills;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      loading.value = false;
    }
  }

  async function profile(id: string): Promise<SkillProfile | null> {
    try {
      const res = await rpc.call("plugins/skills.profile", { id });
      error.value = null;
      return res.skill;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    }
  }

  async function download(id: string, roomId: string): Promise<SkillDownload> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/skills.download", { id, roomId });
      error.value = null;
      return res.download;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function flag(id: string, level: WarningLevel, reason: string): Promise<WarningLevel> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/skills.flag", { id, level, reason });
      error.value = null;
      return res.warningLevel;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function run(
    id: string,
    roomId: string,
    args?: Record<string, unknown>,
  ): Promise<{ run: SkillRunResult | null; status: SkillRunStatus }> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/skills.run", {
        id,
        roomId,
        ...(args === undefined ? {} : { args }),
      });
      error.value = null;
      return { run: res.run, status: res.status };
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function consent(id: string, granted: boolean): Promise<boolean> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/skills.consent", { id, granted });
      error.value = null;
      return res.consented;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function install(spec: ToolInstallSpec): Promise<ToolRecord> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/tools.install", { spec });
      error.value = null;
      return res.tool;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function uninstall(toolId: string): Promise<boolean> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/tools.uninstall", { toolId });
      error.value = null;
      return res.removed;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function setEnabled(toolId: string, enabled: boolean): Promise<ToolRecord> {
    busy.value = true;
    try {
      const res = await rpc.call("plugins/tools.enable", { toolId, enabled });
      error.value = null;
      return res.tool;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function status(toolId: string): Promise<SourceStatus | null> {
    try {
      const res = await rpc.call("plugins/tools.status", { toolId });
      error.value = null;
      return res.status;
    } catch (caught) {
      error.value = describeError(caught);
      throw caught;
    }
  }

  return {
    tools,
    sources,
    skills,
    loading,
    busy,
    error,
    loadTools,
    loadSources,
    search,
    profile,
    download,
    flag,
    run,
    consent,
    install,
    uninstall,
    setEnabled,
    status,
  };
}
