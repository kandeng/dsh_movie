/**
 * Trust primitives for the plugins marketplace (Phase-7 D8): a heuristic
 * content scanner and a seed blocklist.
 *
 * The scanner inspects the text dsh_movie actually has at *index* time — a
 * skill's `title` + `description` (profiles never carry the body, D1) — and, at
 * download time, the full SKILL.md body. It only ever raises **yellow** (info:
 * external URLs, install/setup steps, service-coupled recipes) or **orange**
 * (consent-gated: credential requests, `curl | sh` pipes, bundled-binary/exec
 * patterns). **Red** is never a heuristic verdict: it comes from the seed
 * blocklist (a known-bad hash/id) or a confirmed user/operator report, both of
 * which the skill index layers on top (see `skillIndex.ts`).
 *
 * Detection is best-effort and shared with users by product decision (R4): the
 * ladder is advisory, the sandbox (D3) is the hard boundary for *execution*.
 *
 * @module dsh-movie-market/trust
 */

import { createHash } from 'node:crypto'
import type { WarningLevel } from '@dsh-movie/protocol'
import type { ScanResult, ScanSignal } from './types.ts'

/** Ordering of the warning ladder, for `maxLevel`. */
const LEVEL_RANK: Readonly<Record<WarningLevel, number>> = {
  clean: 0,
  yellow: 1,
  orange: 2,
  red: 3,
}

/**
 * Return the higher of two warning levels.
 * @param a - first level.
 * @param b - second level.
 * @returns whichever ranks higher on the ladder.
 */
export function maxLevel(a: WarningLevel, b: WarningLevel): WarningLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
}

/**
 * SHA-256 of a string, hex-encoded (the blocklist key for skill bodies).
 * @param text - the content to hash.
 * @returns the lowercase hex digest.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A heuristic rule: a pattern plus the level and reason it implies. */
interface ScanRule {
  level: 'yellow' | 'orange'
  reason: string
  pattern: RegExp
}

/**
 * Orange rules — consent-gated signals (D8): credential harvesting, remote-code
 * execution pipes, and bundled-binary/exec patterns.
 */
const ORANGE_RULES: readonly ScanRule[] = [
  { level: 'orange', reason: 'requests a secret/api key', pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)\b\s*[:=]/i },
  { level: 'orange', reason: 'asks the user to paste credentials', pattern: /(paste|enter|provide|supply|set)\s+(your\s+)?(api[_-]?key|token|secret|password|credentials)/i },
  { level: 'orange', reason: 'contains an AWS-style access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { level: 'orange', reason: 'contains an OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { level: 'orange', reason: 'embeds a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { level: 'orange', reason: 'pipes a remote script into a shell', pattern: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b/i },
  { level: 'orange', reason: 'evals dynamically decoded content', pattern: /\beval\s*\(|base64\s+(-d|--decode)\s*\|/i },
  { level: 'orange', reason: 'escalates privileges with sudo', pattern: /\bsudo\s+(rm|chmod|chown|mv|cp|install|curl|wget|bash|sh)\b/i },
  { level: 'orange', reason: 'runs a bundled binary/executable', pattern: /\b(chmod\s+\+x|\.\/[A-Za-z0-9_.-]+\.(sh|bin|exe)|run the bundled (binary|executable))\b/i },
]

/**
 * Yellow rules — informational signals (D8): external URLs, install/setup steps,
 * and service-coupled recipes.
 */
const YELLOW_RULES: readonly ScanRule[] = [
  { level: 'yellow', reason: 'references an external URL', pattern: /\bhttps?:\/\/[^\s)>'"]+/i },
  { level: 'yellow', reason: 'contains install/setup instructions', pattern: /\b(npm\s+(i|install)|npx\s|pip3?\s+install|pnpm\s+add|yarn\s+add|brew\s+install|apt(-get)?\s+install|git\s+clone)\b/i },
  { level: 'yellow', reason: 'is coupled to an external service/account', pattern: /(requires?|needs?)\s+(an?\s+)?(account|api key|subscription)|(sign\s+up|register)\s+(at|on|for)\s+https?:\/\//i },
]

/**
 * Scan arbitrary skill text and return the highest heuristic level plus every
 * signal found (highest-first). Never returns `red` — see the module docs.
 * @param text - the skill text to inspect (profile or body).
 * @returns the scan verdict.
 */
export function scanText(text: string): ScanResult {
  const signals: ScanSignal[] = []
  for (const rule of ORANGE_RULES) {
    if (rule.pattern.test(text)) signals.push({ level: 'orange', reason: rule.reason })
  }
  for (const rule of YELLOW_RULES) {
    if (rule.pattern.test(text)) signals.push({ level: 'yellow', reason: rule.reason })
  }
  // Highest-first, de-duplicated by reason for a tidy tooltip.
  const seen = new Set<string>()
  const unique = signals.filter((signal): boolean => {
    if (seen.has(signal.reason)) return false
    seen.add(signal.reason)
    return true
  })
  unique.sort((a, b): number => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])
  const level = unique.reduce<WarningLevel>((acc, signal): WarningLevel => maxLevel(acc, signal.level), 'clean')
  return { level, signals: unique }
}

/**
 * Scan a skill profile (title + description) — the text available at index time.
 * @param title - the front-matter name.
 * @param description - the front-matter description.
 * @returns the scan verdict.
 */
export function scanProfile(title: string, description: string): ScanResult {
  return scanText(`${title}\n${description}`)
}

/** One seed-blocklist entry: match by content hash and/or by skill id. */
export interface BlocklistEntry {
  /** SHA-256 of a known-bad skill body, when matched by content. */
  hash?: string | undefined
  /** A known-bad global skill id (`<toolId>:<slug>`) or bare slug. */
  id?: string | undefined
  /** Why it is blocked (shown in the red banner). */
  reason: string
}

/**
 * The bundled seed blocklist (D8 source c). Ships with release-updateable
 * known-bad entries; the constructor accepts extra entries so tests (and a
 * future operator-supplied file) can augment it. Matching is by exact content
 * hash or by id (global id or bare slug).
 */
export class Blocklist {
  private readonly entries: readonly BlocklistEntry[]
  private readonly hashes: Set<string>
  private readonly ids: Set<string>

  /**
   * @param seed - the built-in entries.
   * @param extra - additional entries (operator file / tests).
   */
  constructor(seed: readonly BlocklistEntry[] = SEED_BLOCKLIST, extra: readonly BlocklistEntry[] = []) {
    this.entries = [...seed, ...extra]
    this.hashes = new Set(this.entries.flatMap((entry): string[] => (entry.hash !== undefined ? [entry.hash.toLowerCase()] : [])))
    this.ids = new Set(this.entries.flatMap((entry): string[] => (entry.id !== undefined ? [entry.id] : [])))
  }

  /**
   * Test a skill against the blocklist.
   * @param id - the global skill id (`<toolId>:<slug>`).
   * @param slug - the source-local slug.
   * @param body - the full body, when available (hashed for the check).
   * @returns the matching entry's reason, or `null` when not blocked.
   */
  match(id: string, slug: string, body?: string | undefined): string | null {
    if (this.ids.has(id) || this.ids.has(slug)) {
      const entry = this.entries.find((e): boolean => e.id === id || e.id === slug)
      return entry?.reason ?? 'known-bad skill (id)'
    }
    if (body !== undefined) {
      const hash = sha256Hex(body).toLowerCase()
      if (this.hashes.has(hash)) {
        const entry = this.entries.find((e): boolean => e.hash?.toLowerCase() === hash)
        return entry?.reason ?? 'known-bad skill (content hash)'
      }
    }
    return null
  }

  /** Every entry, for diagnostics. */
  all(): readonly BlocklistEntry[] {
    return this.entries
  }
}

/**
 * The bundled seed entries. Empty of real hashes at M3 (none published yet);
 * the structure is exercised by tests and updated with releases (D8/R4). Keep
 * reasons user-facing — they render in the red banner.
 */
export const SEED_BLOCKLIST: readonly BlocklistEntry[] = []
