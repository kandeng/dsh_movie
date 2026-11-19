/**
 * The host-authoritative, file-backed per-room workspace (Phase-3 P3-M5).
 *
 * Replaces the volatile in-memory `workflow-store` with a durable directory per
 * room under a configurable workspace root (default `<server>/.dsh/workspaces`).
 * Each room directory holds:
 *
 *  - `head.json`            - the latest committed {@link WorkflowRecord} (HEAD).
 *  - `commits.json`         - the append-only {@link CommitMeta} index.
 *  - `history/<rev>.json`   - one FULL graph snapshot per committed revision.
 *  - `draft.json`           - the host's uncommitted working copy (when present).
 *  - `draft-state.json`     - `{ undo: string[], redo: string[] }` snapshot names.
 *  - `snapshots/<name>.json`- draft undo/redo snapshots (capped).
 *
 * The model is host-exclusive: only the room `host` writes (the gateway gates
 * every mutating call on `roomRole === 'host'`). A commit appends an immutable
 * full snapshot; `revert` is a FORWARD commit restoring an old snapshot, so the
 * history is never rewritten (GitHub-style). Draft undo/redo is server-side
 * view-state (per room), surviving a page reload but not synced to viewers.
 *
 * Writes are crash-tolerant (write-temp-then-rename). Every read degrades to a
 * safe default rather than throwing, so a filesystem hiccup never takes the
 * gateway down.
 *
 * @module dsh-movie-gateway/workspace-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { MatrixUserId, WorkflowGraph, WorkflowRecord } from '@dsh-movie/protocol'
import type { CommitMeta, DraftState } from '@dsh-movie/protocol'

/** The outcome of a direct graph write (`workflow/put`). */
export type WorkspacePutResult =
  | { ok: true; record: WorkflowRecord }
  | { ok: false; reason: 'conflict'; current: WorkflowRecord }

/** Maximum draft undo/redo snapshots retained per room (bounds disk use). */
const MAX_SNAPSHOTS = 50

/** An empty editor graph, used when a room has no head and no draft. */
function emptyGraph(): WorkflowGraph {
  return { last_node_id: 0, last_link_id: 0, nodes: [], links: [], groups: [], version: 0.4 }
}

/** The persistent draft undo/redo index. */
interface DraftIndex {
  undo: string[]
  redo: string[]
}

/** The host-owned, file-backed workspace store. */
export interface WorkspaceStore {
  /** Read the committed HEAD record for a room, or `null` when none exists. */
  getHead(roomId: string): WorkflowRecord | null
  /**
   * Directly commit a graph (`workflow/put`, host-only). Appends a full
   * snapshot, bumps the revision, updates HEAD, and clears the draft.
   * @returns the new record, or a `conflict` carrying HEAD when `baseRev` is stale.
   */
  putGraph(roomId: string, graph: WorkflowGraph, author: MatrixUserId | null, baseRev: number | undefined, message?: string): WorkspacePutResult
  /** Commit the current draft (`workspace/commit`, host-only). */
  commitDraft(roomId: string, author: MatrixUserId | null, message: string): WorkflowRecord | null
  /** Forward-commit restoring the snapshot at `rev` (`workspace/revert`, host-only). */
  revert(roomId: string, rev: number, author: MatrixUserId | null, message: string): WorkflowRecord | null
  /** List the committed history index (newest last). */
  listCommits(roomId: string): CommitMeta[]
  /** Read one committed revision's metadata + full graph snapshot. */
  getCommit(roomId: string, rev: number): { commit: CommitMeta; graph: WorkflowGraph } | null
  /** Read the draft working copy + undo/redo depths. */
  readDraft(roomId: string): DraftState
  /** Autosave the draft working copy, pushing the prior state onto the undo stack. */
  putDraft(roomId: string, graph: WorkflowGraph): DraftState
  /** Undo one draft step (server-side); returns the resulting draft state. */
  undo(roomId: string): DraftState
  /** Redo one draft step (server-side); returns the resulting draft state. */
  redo(roomId: string): DraftState

  /* --- Phase-7 D7: per-room imported-skill files + import commits --- */

  /**
   * Write a skill body to a room-relative path (`skills/<file>.md`). Refuses
   * (returns `false`) any path that escapes the room dir (zip-slip guard).
   */
  writeSkill(roomId: string, relPath: string, body: string): boolean
  /** Read a skill body by room-relative path, or `null` when absent/escaping. */
  readSkill(roomId: string, relPath: string): string | null
  /** True when a skill file exists at the room-relative path. */
  hasSkill(roomId: string, relPath: string): boolean
  /**
   * Record one skill-import commit (`skill import <id>`) against the room's
   * history. Unlike a graph commit this NEVER deletes the working draft, so
   * importing a skill cannot wipe the host's uncommitted WIP.
   */
  recordSkillImport(roomId: string, author: MatrixUserId | null, skillId: string): CommitMeta

  /* --- Phase 8 P8-M3: generated-media artifact files --- */

  /**
   * Write generated media bytes to a room-relative path (`artifacts/<file>`).
   * Refuses (returns `false`) any path that escapes the room dir (zip-slip
   * guard, same as {@link writeSkill}). Crash-tolerant temp-then-rename write.
   */
  writeArtifact(roomId: string, relPath: string, bytes: Uint8Array): boolean
}

/** Turn a room id into a stable, filesystem-safe directory name. */
function sanitizeRoom(roomId: string): string {
  const safe = roomId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `room-${safe}`
}

/**
 * Create a file-backed workspace store rooted at `root`.
 * @param root - absolute directory holding one sub-directory per room.
 * @returns the {@link WorkspaceStore}.
 */
export function createWorkspaceStore(root: string): WorkspaceStore {
  /** Resolve (and lazily create) a room's directory. */
  function roomDir(roomId: string): string {
    const dir = join(root, sanitizeRoom(roomId))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function historyDir(roomId: string): string {
    const dir = join(roomDir(roomId), 'history')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function snapshotDir(roomId: string): string {
    const dir = join(roomDir(roomId), 'snapshots')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Crash-tolerant JSON write: temp file then atomic rename. */
  function writeJson(file: string, value: unknown): void {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, file)
  }

  /** Read + parse a JSON file, degrading to `null` on any failure. */
  function readJson<T>(file: string): T | null {
    try {
      if (!existsSync(file)) return null
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }

  function readHead(roomId: string): WorkflowRecord | null {
    return readJson<WorkflowRecord>(join(roomDir(roomId), 'head.json'))
  }

  function readCommits(roomId: string): CommitMeta[] {
    return readJson<CommitMeta[]>(join(roomDir(roomId), 'commits.json')) ?? []
  }

  function readDraftIndex(roomId: string): DraftIndex {
    return readJson<DraftIndex>(join(roomDir(roomId), 'draft-state.json')) ?? { undo: [], redo: [] }
  }

  function readDraftGraph(roomId: string): WorkflowGraph | null {
    return readJson<WorkflowGraph>(join(roomDir(roomId), 'draft.json'))
  }

  /** Append one full snapshot to history + the commits index; update HEAD. */
  function appendCommit(roomId: string, graph: WorkflowGraph, author: MatrixUserId | null, message: string): WorkflowRecord {
    const head = readHead(roomId)
    const rev = (head?.rev ?? 0) + 1
    const file = `history/${rev}.json`
    writeJson(join(historyDir(roomId), `${rev}.json`), graph)
    const commits = readCommits(roomId)
    const meta: CommitMeta = { rev, author, timestamp: Date.now(), message, file }
    commits.push(meta)
    writeJson(join(roomDir(roomId), 'commits.json'), commits)
    const record: WorkflowRecord = { id: roomId, roomId, graph, rev, updatedAt: meta.timestamp, updatedBy: author }
    writeJson(join(roomDir(roomId), 'head.json'), record)
    // The committed graph becomes the new baseline: drop the working draft.
    const draftFile = join(roomDir(roomId), 'draft.json')
    if (existsSync(draftFile)) rmSync(draftFile)
    return record
  }

  /** Resolve (and lazily create) a room's `skills/` directory. */
  function skillDir(roomId: string): string {
    const dir = join(roomDir(roomId), 'skills')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * Resolve a room-relative skill path against the room dir, refusing any escape
   * (zip-slip guard). Returns `null` when the resolved path leaves the room dir.
   */
  function safeSkillPath(roomId: string, relPath: string): string | null {
    const base = roomDir(roomId)
    const target = resolve(base, relPath)
    if (target !== base && !target.startsWith(base + sep)) return null
    return target
  }

  /**
   * Append a skill-import commit: snapshot the CURRENT HEAD graph at the next
   * revision and index it in `commits.json`, but — unlike {@link appendCommit} —
   * NEVER delete `draft.json`. Importing a skill must not wipe the host's WIP,
   * yet HEAD's revision still advances so the history stays monotonic.
   */
  function appendSkillCommit(roomId: string, author: MatrixUserId | null, skillId: string): CommitMeta {
    const head = readHead(roomId)
    const graph = head?.graph ?? emptyGraph()
    const rev = (head?.rev ?? 0) + 1
    const file = `history/${rev}.json`
    writeJson(join(historyDir(roomId), `${rev}.json`), graph)
    const commits = readCommits(roomId)
    const meta: CommitMeta = { rev, author, timestamp: Date.now(), message: `skill import ${skillId}`, file }
    commits.push(meta)
    writeJson(join(roomDir(roomId), 'commits.json'), commits)
    const record: WorkflowRecord = { id: roomId, roomId, graph, rev, updatedAt: meta.timestamp, updatedBy: author }
    writeJson(join(roomDir(roomId), 'head.json'), record)
    // NOTE: draft.json is deliberately preserved here (see the interface docs).
    return meta
  }

  /** Write a draft snapshot file and return its stored name. */
  function pushSnapshot(roomId: string, graph: WorkflowGraph): string {
    const name = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    writeJson(join(snapshotDir(roomId), name), graph)
    return name
  }

  function readSnapshot(roomId: string, name: string): WorkflowGraph | null {
    return readJson<WorkflowGraph>(join(snapshotDir(roomId), name))
  }

  function dropSnapshot(roomId: string, name: string): void {
    const file = join(snapshotDir(roomId), name)
    if (existsSync(file)) rmSync(file)
  }

  function persistDraftIndex(roomId: string, index: DraftIndex): void {
    writeJson(join(roomDir(roomId), 'draft-state.json'), index)
  }

  function buildDraftState(roomId: string): DraftState {
    const head = readHead(roomId)
    const draft = readDraftGraph(roomId)
    const index = readDraftIndex(roomId)
    return {
      graph: draft ?? head?.graph ?? emptyGraph(),
      hasDraft: draft !== null,
      undoDepth: index.undo.length,
      redoDepth: index.redo.length,
    }
  }

  return {
    getHead(roomId: string): WorkflowRecord | null {
      return readHead(roomId)
    },

    putGraph(roomId: string, graph: WorkflowGraph, author: MatrixUserId | null, baseRev: number | undefined, message = ''): WorkspacePutResult {
      const head = readHead(roomId)
      if (baseRev !== undefined && head !== null && baseRev !== head.rev) {
        return { ok: false, reason: 'conflict', current: head }
      }
      const record = appendCommit(roomId, graph, author, message)
      return { ok: true, record }
    },

    commitDraft(roomId: string, author: MatrixUserId | null, message: string): WorkflowRecord | null {
      const draft = readDraftGraph(roomId)
      const head = readHead(roomId)
      const graph = draft ?? head?.graph ?? null
      if (graph === null) return null
      return appendCommit(roomId, graph, author, message)
    },

    revert(roomId: string, rev: number, author: MatrixUserId | null, message: string): WorkflowRecord | null {
      const snapshot = readJson<WorkflowGraph>(join(historyDir(roomId), `${rev}.json`))
      if (snapshot === null) return null
      const text = message !== '' ? message : `Revert to r${rev}`
      return appendCommit(roomId, snapshot, author, text)
    },

    listCommits(roomId: string): CommitMeta[] {
      return readCommits(roomId)
    },

    getCommit(roomId: string, rev: number): { commit: CommitMeta; graph: WorkflowGraph } | null {
      const commit = readCommits(roomId).find((entry): boolean => entry.rev === rev)
      if (commit === undefined) return null
      const graph = readJson<WorkflowGraph>(join(historyDir(roomId), `${rev}.json`))
      if (graph === null) return null
      return { commit, graph }
    },

    readDraft(roomId: string): DraftState {
      return buildDraftState(roomId)
    },

    putDraft(roomId: string, graph: WorkflowGraph): DraftState {
      // Push the prior working state (draft, else HEAD, else empty) onto undo.
      const prior = readDraftGraph(roomId) ?? readHead(roomId)?.graph ?? emptyGraph()
      const index = readDraftIndex(roomId)
      index.undo.push(pushSnapshot(roomId, prior))
      if (index.undo.length > MAX_SNAPSHOTS) {
        const dropped = index.undo.shift()
        if (dropped !== undefined) dropSnapshot(roomId, dropped)
      }
      // A fresh edit invalidates the redo branch.
      for (const name of index.redo) dropSnapshot(roomId, name)
      index.redo = []
      persistDraftIndex(roomId, index)
      writeJson(join(roomDir(roomId), 'draft.json'), graph)
      return buildDraftState(roomId)
    },

    undo(roomId: string): DraftState {
      const index = readDraftIndex(roomId)
      const prevName = index.undo.pop()
      if (prevName === undefined) return buildDraftState(roomId)
      const prev = readSnapshot(roomId, prevName)
      dropSnapshot(roomId, prevName)
      const current = readDraftGraph(roomId) ?? readHead(roomId)?.graph ?? emptyGraph()
      index.redo.push(pushSnapshot(roomId, current))
      persistDraftIndex(roomId, index)
      if (prev !== null) writeJson(join(roomDir(roomId), 'draft.json'), prev)
      return buildDraftState(roomId)
    },

    redo(roomId: string): DraftState {
      const index = readDraftIndex(roomId)
      const nextName = index.redo.pop()
      if (nextName === undefined) return buildDraftState(roomId)
      const next = readSnapshot(roomId, nextName)
      dropSnapshot(roomId, nextName)
      const current = readDraftGraph(roomId) ?? readHead(roomId)?.graph ?? emptyGraph()
      index.undo.push(pushSnapshot(roomId, current))
      persistDraftIndex(roomId, index)
      if (next !== null) writeJson(join(roomDir(roomId), 'draft.json'), next)
      return buildDraftState(roomId)
    },

    writeSkill(roomId: string, relPath: string, body: string): boolean {
      const target = safeSkillPath(roomId, relPath)
      if (target === null) return false
      const dir = dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Crash-tolerant write: temp file then atomic rename (mirrors writeJson).
      const tmp = `${target}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, target)
      return true
    },

    readSkill(roomId: string, relPath: string): string | null {
      const target = safeSkillPath(roomId, relPath)
      if (target === null) return null
      try {
        if (!existsSync(target)) return null
        return readFileSync(target, 'utf8')
      } catch {
        return null
      }
    },

    hasSkill(roomId: string, relPath: string): boolean {
      const target = safeSkillPath(roomId, relPath)
      return target !== null && existsSync(target)
    },

    recordSkillImport(roomId: string, author: MatrixUserId | null, skillId: string): CommitMeta {
      // Ensure the skills dir exists even before the first body is written.
      skillDir(roomId)
      return appendSkillCommit(roomId, author, skillId)
    },

    writeArtifact(roomId: string, relPath: string, bytes: Uint8Array): boolean {
      const target = safeSkillPath(roomId, relPath)
      if (target === null) return false
      const dir = dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Crash-tolerant write: temp file then atomic rename (mirrors writeSkill).
      const tmp = `${target}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, target)
      return true
    },
  }
}
