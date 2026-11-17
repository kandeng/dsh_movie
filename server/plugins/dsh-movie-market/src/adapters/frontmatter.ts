/**
 * A minimal SKILL.md front-matter parser (Phase-7 D1).
 *
 * The ecosystem convention (agentskills.io / `npx skills` / ClawHub / LobeHub /
 * skills.sh) is a YAML front-matter block between leading `---` fences carrying
 * at least `name` and `description`. dsh_movie adds its own routing fields
 * (`target`, `version`, `license`, `provider`). We parse the flat `key: value`
 * subset those files actually use — no anchors, no nesting — so the adapters
 * stay dependency-free inside the sandbox.
 *
 * @module dsh-movie-market/adapters/frontmatter
 */

import type { SourceSkillRecord } from './contract.ts'

/** A parsed front-matter block: flat fields plus the remaining body. */
export interface ParsedSkill {
  /** Flat `key: value` fields (keys lower-cased, values trimmed, quotes stripped). */
  fields: Record<string, string>
  /** The markdown body after the closing fence. */
  body: string
}

/** Strip one layer of matching single/double quotes from a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Parse a SKILL.md document into its front-matter fields and body. Tolerant of a
 * missing/blank front-matter block (returns empty fields + the whole body).
 * @param raw - the full document text.
 * @returns the parsed fields and body.
 */
export function parseSkill(raw: string): ParsedSkill {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { fields: {}, body: text }
  const afterFirst = text.indexOf('\n')
  if (afterFirst < 0) return { fields: {}, body: text }
  const closing = text.indexOf('\n---', afterFirst)
  if (closing < 0) return { fields: {}, body: text }
  const block = text.slice(afterFirst + 1, closing)
  const bodyStart = text.indexOf('\n', closing + 1)
  const body = bodyStart < 0 ? '' : text.slice(bodyStart + 1)

  const fields: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const key = trimmed.slice(0, colon).trim().toLowerCase()
    fields[key] = unquote(trimmed.slice(colon + 1))
  }
  return { fields, body }
}

/**
 * Build a {@link SourceSkillRecord} from a parsed SKILL.md.
 * @param slug - the source-local skill id.
 * @param parsed - the parsed front-matter + body.
 * @param fallbackProvider - provider used when the front-matter omits one.
 * @returns the source record (never assigns a warning level or global id).
 */
export function recordFromSkill(
  slug: string,
  parsed: ParsedSkill,
  fallbackProvider: string,
): SourceSkillRecord {
  const f = parsed.fields
  const record: SourceSkillRecord = {
    slug,
    title: f['name'] ?? slug,
    description: f['description'] ?? '',
    target: f['target'] ?? 'any',
    version: f['version'] ?? '0.0.0',
    license: f['license'] !== undefined && f['license'] !== '' ? f['license'] : null,
    provider: f['provider'] !== undefined && f['provider'] !== '' ? f['provider'] : fallbackProvider,
  }
  if (f['executable'] === 'true') record.executable = true
  return record
}
