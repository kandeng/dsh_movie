/**
 * The server-global skill-execution consent store (Phase-7 D9, R10).
 *
 * An **orange** skill may only execute after the user has recorded explicit
 * consent (D8/D9). Consent is keyed by skill id (`<toolId>:<slug>`) and is
 * **server-global** — mirroring {@link FlagStore} — so a host who consents once
 * on a card does not have to re-consent for every run, and the director-agent
 * trigger (D9b) can honour that prior decision without an interactive prompt.
 * Writes are last-write-wins and every mutation appends to an audit log. The
 * store is a small JSON document under the market data dir so it survives a host
 * reload.
 *
 * This class is Cordis-free and filesystem-only, so `verify-plugins-execute.ts`
 * can exercise it against a temp file without booting a DSH host.
 *
 * @module dsh-movie-market/consentStore
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MarketLogger } from './types.ts'

/** One persisted consent decision against a skill (server-global). */
export interface ConsentRecord {
  /** The skill id (`<toolId>:<slug>`). */
  id: string
  /** Whether execution consent is granted. */
  granted: boolean
  /** Who decided (Matrix user id, or `host`). */
  actor: string
  /** When it was recorded (epoch ms). */
  recordedAt: number
}

/** One append-only audit entry (last-write-wins + audit, R10). */
export interface ConsentAuditEntry {
  /** The affected skill id. */
  id: string
  /** The decision recorded. */
  granted: boolean
  /** Who acted. */
  actor: string
  /** When (epoch ms). */
  at: number
}

/** The persisted document shape. */
interface ConsentFile {
  version: 1
  consent: Record<string, ConsentRecord>
  audit: ConsentAuditEntry[]
}

/** Cap on the audit log so the file cannot grow without bound. */
const AUDIT_CAP = 500

/**
 * A persistent, server-global store of skill-execution consent decisions.
 */
export class ConsentStore {
  private readonly file: string
  private readonly logger: MarketLogger | null
  private consent: Record<string, ConsentRecord> = {}
  private audit: ConsentAuditEntry[] = []

  /**
   * @param file - absolute path of the JSON document (created on first write).
   * @param logger - optional diagnostics sink.
   */
  constructor(file: string, logger: MarketLogger | null = null) {
    this.file = file
    this.logger = logger
    this.load()
  }

  /** Load the document from disk (tolerant of a missing/corrupt file). */
  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ConsentFile
      this.consent = parsed.consent ?? {}
      this.audit = Array.isArray(parsed.audit) ? parsed.audit : []
    } catch (error) {
      this.logger?.warn('[market:consent] could not parse %s, starting empty: %s', this.file, String(error))
      this.consent = {}
      this.audit = []
    }
  }

  /** Atomically persist the document (write-temp + rename). */
  private persist(): void {
    try {
      const dir = dirname(this.file)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const doc: ConsentFile = { version: 1, consent: this.consent, audit: this.audit.slice(-AUDIT_CAP) }
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.logger?.error('[market:consent] persist failed: %s', String(error))
    }
  }

  /**
   * Whether execution consent is currently granted for a skill.
   * @param id - the global skill id.
   */
  granted(id: string): boolean {
    return this.consent[id]?.granted === true
  }

  /**
   * The stored decision for a skill, or `null` when none was recorded.
   * @param id - the global skill id.
   */
  get(id: string): ConsentRecord | null {
    return this.consent[id] ?? null
  }

  /**
   * Record a consent decision (last-write-wins) and audit it.
   * @param id - the global skill id.
   * @param granted - whether execution is consented to.
   * @param actor - who decided.
   * @returns the stored record.
   */
  set(id: string, granted: boolean, actor: string): ConsentRecord {
    const record: ConsentRecord = { id, granted, actor, recordedAt: Date.now() }
    this.consent[id] = record
    this.audit.push({ id, granted, actor, at: record.recordedAt })
    this.persist()
    return record
  }

  /** Every stored decision. */
  all(): ConsentRecord[] {
    return Object.values(this.consent)
  }

  /** The audit trail (newest last). */
  auditLog(): ConsentAuditEntry[] {
    return [...this.audit]
  }
}
