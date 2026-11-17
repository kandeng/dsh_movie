/**
 * The server-global skill flag store (Phase-7 D8, R10).
 *
 * Flags are community-trust reports against a skill id (`<toolId>:<slug>`) and
 * are **server-global**: every user sees them, any user may raise one, and only
 * the host may clear one (the same governance split as canvas publish). Writes
 * are last-write-wins and every mutation appends to an audit log. The store is
 * a small JSON document under the market data dir so it survives a host reload.
 *
 * This class is Cordis-free and filesystem-only, so `verify-plugins-search.ts`
 * can exercise it against a temp file without booting a DSH host.
 *
 * @module dsh-movie-market/flagStore
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WarningLevel } from '@dsh-movie/protocol'
import type { FlagAuditEntry, FlagRecord, MarketLogger } from './types.ts'

/** The persisted document shape. */
interface FlagFile {
  version: 1
  flags: Record<string, FlagRecord>
  audit: FlagAuditEntry[]
}

/** Cap on the audit log so the file cannot grow without bound. */
const AUDIT_CAP = 500

/**
 * A persistent, server-global store of skill warning flags.
 */
export class FlagStore {
  private readonly file: string
  private readonly logger: MarketLogger | null
  private flags: Record<string, FlagRecord> = {}
  private audit: FlagAuditEntry[] = []

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
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as FlagFile
      this.flags = parsed.flags ?? {}
      this.audit = Array.isArray(parsed.audit) ? parsed.audit : []
    } catch (error) {
      this.logger?.warn('[market:flags] could not parse %s, starting empty: %s', this.file, String(error))
      this.flags = {}
      this.audit = []
    }
  }

  /** Atomically persist the document (write-temp + rename). */
  private persist(): void {
    try {
      const dir = dirname(this.file)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const doc: FlagFile = { version: 1, flags: this.flags, audit: this.audit.slice(-AUDIT_CAP) }
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.logger?.error('[market:flags] persist failed: %s', String(error))
    }
  }

  /**
   * The flag for a skill, or `null` when unflagged.
   * @param id - the global skill id.
   */
  get(id: string): FlagRecord | null {
    return this.flags[id] ?? null
  }

  /**
   * Raise/update a flag (last-write-wins) and audit it.
   * @param id - the global skill id.
   * @param level - the level to set.
   * @param reason - free-text reason.
   * @param actor - who raised it.
   * @returns the stored record.
   */
  set(id: string, level: WarningLevel, reason: string, actor: string): FlagRecord {
    const record: FlagRecord = { id, level, reason, actor, flaggedAt: Date.now() }
    this.flags[id] = record
    this.audit.push({ id, action: 'set', level, actor, at: record.flaggedAt })
    this.persist()
    return record
  }

  /**
   * Clear a flag (host-only at the gateway; the store itself is policy-free) and
   * audit it.
   * @param id - the global skill id.
   * @param actor - who cleared it.
   * @returns true when a flag was removed.
   */
  clear(id: string, actor: string): boolean {
    const prior = this.flags[id]
    if (prior === undefined) return false
    delete this.flags[id]
    this.audit.push({ id, action: 'clear', level: prior.level, actor, at: Date.now() })
    this.persist()
    return true
  }

  /** Every stored flag. */
  all(): FlagRecord[] {
    return Object.values(this.flags)
  }

  /** The audit trail (newest last). */
  auditLog(): FlagAuditEntry[] {
    return [...this.audit]
  }
}
