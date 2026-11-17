/**
 * The built-in skill-source tools (Phase-7 D4).
 *
 * Each built-in is a sandboxed MCP stdio child (an adapter under `src/adapters/`)
 * plus its server-global {@link ToolRecord} and a {@link TrustTier} used for
 * ranking. They are installed-and-enabled by default; the open registries
 * (ClawHub, GitHub, directories) carry the D8 default-on warning banner, while
 * the curated vendored suite is the offline, zero-config floor.
 *
 * Adapter script paths and the vendored `skills/` dir are resolved from this
 * module's own location, so they survive being spawned inside the bwrap
 * `--ro-bind / /` sandbox (absolute host paths remain valid there).
 *
 * @module dsh-movie-market/builtinTools
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolManifest, ToolRecord } from '@dsh-movie/protocol'
import type { ToolSpec, TrustTier } from './types.ts'

/** This module's directory (`.../dsh-movie-market/src`). */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The plugin root (`.../dsh-movie-market`). */
const PLUGIN_ROOT = dirname(HERE)
/** Absolute path of an adapter script under `src/adapters/`. */
function adapter(script: string): string {
  return join(HERE, 'adapters', script)
}
/** Absolute path of the vendored curated suite dir. */
export const CURATED_SKILLS_DIR = join(PLUGIN_ROOT, 'skills')

/** A built-in tool: its record, its spawn spec, and its ranking tier. */
export interface BuiltinToolDef {
  /** The server-global record shown on the Tools page. */
  record: ToolRecord
  /** The sandboxed spawn spec registered with the SPR supervisor. */
  spec: ToolSpec
  /** Provenance tier for ranking trust (D10). */
  tier: TrustTier
}

/** Build a record + spec pair for a built-in adapter. */
function builtin(
  id: string,
  name: string,
  provider: string,
  script: string,
  manifest: ToolManifest,
  tier: TrustTier,
  env: Readonly<Record<string, string>> = {},
): BuiltinToolDef {
  const record: ToolRecord = {
    id,
    name,
    provider,
    kind: 'builtin',
    transport: 'mcp-stdio',
    manifest,
    installed: true,
    enabled: true,
    requiresCredentials: (manifest.credentialsEnv?.length ?? 0) > 0,
    status: 'stopped',
    warningLevel: 'clean',
  }
  const spec: ToolSpec = {
    id,
    command: process.execPath,
    args: [adapter(script)],
    env,
    cwd: PLUGIN_ROOT,
    manifest,
  }
  return { record, spec, tier }
}

/** Optional GitHub token, injected only when the operator set it (never required). */
function githubEnv(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
  return token !== undefined && token !== '' ? { GITHUB_TOKEN: token } : {}
}

/**
 * The default built-in tools (D4). Order is the Tools-page display order: the
 * curated offline suite first (the zero-config floor), then the open registries.
 * @returns the built-in definitions.
 */
export function builtinToolDefs(): BuiltinToolDef[] {
  return [
    builtin(
      'curated',
      'Curated Craft Suite',
      'dsh_movie',
      'curated-mcp.ts',
      // Offline: empty allow-list → private netns (hard egress deny).
      { networkAllowlist: [], memoryMaxMb: 192, cpuQuotaPct: 100 },
      'curated',
      { DSH_CURATED_SKILLS_DIR: CURATED_SKILLS_DIR },
    ),
    builtin(
      'clawhub',
      'ClawHub Registry',
      'clawhub.ai',
      'clawhub-mcp.ts',
      {
        networkAllowlist: ['clawhub.ai'],
        memoryMaxMb: 256,
        cpuQuotaPct: 100,
      },
      'registry',
    ),
    builtin(
      'github',
      'GitHub Skill Search',
      'github.com',
      'github-mcp.ts',
      {
        networkAllowlist: ['api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com'],
        memoryMaxMb: 256,
        cpuQuotaPct: 100,
        // The operator token is OPTIONAL (it only lifts the 10 req/min
        // unauthenticated cap), so it is injected via spec.env, not declared as
        // a required credential — GitHub stays usable unauthenticated.
      },
      'registry',
      githubEnv(),
    ),
    builtin(
      'directory',
      'Skills Directories',
      'skills.sh / lobehub.com',
      'directory-mcp.ts',
      {
        networkAllowlist: ['skills.sh', 'lobehub.com', 'api.github.com', 'raw.githubusercontent.com'],
        memoryMaxMb: 256,
        cpuQuotaPct: 100,
      },
      'registry',
    ),
    builtin(
      'gitrepo',
      'Git SKILL.md Suite',
      'github.com',
      'gitrepo-mcp.ts',
      {
        networkAllowlist: ['raw.githubusercontent.com', 'codeload.github.com', 'github.com'],
        memoryMaxMb: 256,
        cpuQuotaPct: 100,
      },
      'registry',
    ),
  ]
}
