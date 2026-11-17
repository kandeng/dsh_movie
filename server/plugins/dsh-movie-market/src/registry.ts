/**
 * The server-global tool registry (Phase-7 D2/D4/D10).
 *
 * A *tool* is one sandboxed MCP skill source. The registry is the single source
 * of truth for every tool's {@link ToolRecord} (what the Tools page renders),
 * its {@link ToolSpec} (what the SPR supervisor spawns), and its
 * {@link TrustTier} (how much ranking trust its skills earn). Built-ins are
 * seeded from {@link builtinToolDefs}; third-party/user tools are added via
 * {@link ToolRegistry.install} (a host-only action, D2).
 *
 * It is deliberately Cordis-free and takes the supervisor's status through an
 * injected lookup, so `verify-plugins-search.ts` can drive it with a fake
 * status source and never boot a DSH host.
 *
 * @module dsh-movie-market/registry
 */

import type { ToolInstallSpec, ToolRecord, ToolStatus } from '@dsh-movie/protocol'
import type { BuiltinToolDef } from './builtinTools.ts'
import type { ToolRuntimeStatus, ToolSpec, TrustTier } from './types.ts'

/** Ranking trust weight per provenance tier (Phase-7 D10). */
const TIER_WEIGHT: Readonly<Record<TrustTier, number>> = {
  curated: 1.0,
  registry: 0.7,
  installed: 0.45,
}

/** One registry entry: record + spawn spec + provenance tier. */
interface RegistryEntry {
  record: ToolRecord
  spec: ToolSpec
  tier: TrustTier
}

/**
 * The registry of every known tool. Records are returned with the supervisor's
 * live lifecycle status merged in, so the Tools page never shows a stale state.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly statusOf: (id: string) => ToolRuntimeStatus | null

  /**
   * @param statusOf - resolves a tool's live runtime status (or `null` when the
   *   supervisor has no opinion yet). Injected to keep this class testable.
   * @param defs - the built-in tools to seed.
   */
  constructor(statusOf: (id: string) => ToolRuntimeStatus | null, defs: readonly BuiltinToolDef[] = []) {
    this.statusOf = statusOf
    for (const def of defs) this.seed(def)
  }

  /** Add/replace one built-in definition. */
  private seed(def: BuiltinToolDef): void {
    this.entries.set(def.record.id, { record: def.record, spec: def.spec, tier: def.tier })
  }

  /** Every spawn spec, for registering with the supervisor. */
  specs(): ToolSpec[] {
    return [...this.entries.values()].map((entry): ToolSpec => entry.spec)
  }

  /** All records (built-in + installed), with live status merged. */
  records(): ToolRecord[] {
    return [...this.entries.values()].map((entry): ToolRecord => this.withStatus(entry))
  }

  /** One record by id (status merged), or `null`. */
  get(id: string): ToolRecord | null {
    const entry = this.entries.get(id)
    return entry === undefined ? null : this.withStatus(entry)
  }

  /** One spawn spec by id, or `null`. */
  spec(id: string): ToolSpec | null {
    return this.entries.get(id)?.spec ?? null
  }

  /** The provenance tier of a tool (`installed` when unknown). */
  tier(id: string): TrustTier {
    return this.entries.get(id)?.tier ?? 'installed'
  }

  /** The ranking trust weight of a tool (D10). */
  trustWeight(id: string): number {
    return TIER_WEIGHT[this.tier(id)]
  }

  /** Every tool id whose skills the index should fan out to. */
  enabledSearchIds(): string[] {
    return [...this.entries.values()]
      .filter((entry): boolean => entry.record.installed && entry.record.enabled)
      .map((entry): string => entry.record.id)
  }

  /**
   * Enable/disable a tool. Disabling also marks its live status `disabled` so
   * the supervisor refuses to spawn it (see `supervisor.ensureRunning`).
   * @param id - the tool id.
   * @param enabled - the new state.
   * @returns the updated record, or `null` when unknown.
   */
  setEnabled(id: string, enabled: boolean): ToolRecord | null {
    const entry = this.entries.get(id)
    if (entry === undefined) return null
    entry.record = { ...entry.record, enabled }
    return this.withStatus(entry)
  }

  /**
   * Install a third-party/user tool from an install spec (host-only, D2). The
   * server assigns an id when the spec omits one.
   * @param install - the install spec.
   * @param cwd - working directory for the spawned child.
   * @param tier - provenance tier (defaults to `installed`).
   * @returns the created record.
   */
  install(install: ToolInstallSpec, cwd: string, tier: TrustTier = 'installed'): ToolRecord {
    const id = install.id !== undefined && install.id !== '' ? install.id : `user-${Date.now().toString(36)}`
    const record: ToolRecord = {
      id,
      name: install.name,
      provider: 'third-party',
      kind: 'user',
      transport: 'mcp-stdio',
      manifest: install.manifest,
      installed: true,
      enabled: true,
      requiresCredentials: (install.manifest.credentialsEnv?.length ?? 0) > 0,
      status: 'stopped',
      warningLevel: 'clean',
    }
    const spec: ToolSpec = {
      id,
      command: install.command,
      args: install.args ?? [],
      env: install.env ?? {},
      cwd,
      manifest: install.manifest,
    }
    this.entries.set(id, { record, spec, tier })
    return this.withStatus(this.entries.get(id) as RegistryEntry)
  }

  /**
   * Uninstall a tool. Built-ins cannot be removed (only disabled); user tools
   * are dropped entirely.
   * @param id - the tool id.
   * @returns true when an entry was removed.
   */
  uninstall(id: string): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.record.kind === 'builtin') return false
    this.entries.delete(id)
    return true
  }

  /** Merge the supervisor's live status onto a record. */
  private withStatus(entry: RegistryEntry): ToolRecord {
    let status: ToolStatus = entry.record.status
    if (!entry.record.enabled) {
      status = 'disabled'
    } else {
      const live = this.statusOf(entry.record.id)
      if (live !== null) status = live.status
    }
    return { ...entry.record, status }
  }
}
