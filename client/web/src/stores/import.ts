/**
 * Cross-route skill-import stash (Phase-7 P7-M5, D7 mode 1).
 *
 * The editor **Import** flow leaves the Studio (route `/studio`), browses the
 * Plugins page in pick-mode (`/plugins?mode=pick`), then returns to Studio to
 * paste the downloaded body. Navigating away unmounts the Studio component, so
 * the pending-import context (which node/widget, the insertion point, the
 * intent-prefilled query) and the completed download must survive the round-trip
 * outside any component. This store is that hand-off.
 *
 * It is persisted to `sessionStorage` so an accidental refresh mid-flow does not
 * silently drop the pending import (the paste is idempotent-safe: the Studio
 * consumes {@link takeCompleted} exactly once).
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { ImportedSkillRef, SkillTarget } from "@dsh-movie/protocol";

/** Where the Studio wants a skill pasted when the user returns from pick-mode. */
export interface PendingImport {
  /** The room owning the node (the download target for `plugins/skills.download`). */
  roomId: string;
  /** The Studio node id (`String(WorkflowNode.id)`). */
  nodeId: string;
  /** The text widget name to paste into (the node's primary STRING widget). */
  widgetName: string;
  /** Character offset to splice the body at; `-1` appends to the end. */
  insertionPoint: number;
  /** The intent-prefilled search query (D10). */
  query: string;
  /** The node's skill target, used to pre-rank the Skills view. */
  target?: SkillTarget | undefined;
}

/** A finished download waiting for the Studio to paste it into its node. */
export interface CompletedImport {
  /** The Studio node id the body belongs to. */
  nodeId: string;
  /** The text widget to paste into. */
  widgetName: string;
  /** Character offset to splice the body at; `-1` appends. */
  insertionPoint: number;
  /** The sanitized SKILL.md body to paste. */
  body: string;
  /** The additive reference to record under `properties.importedSkills`. */
  ref: ImportedSkillRef;
}

/**
 * The import-handoff store.
 * @returns the pending/completed refs + the begin/complete/take/clear actions.
 */
export const useImportStore = defineStore(
  "import",
  () => {
    const pending = ref<PendingImport | null>(null);
    const completed = ref<CompletedImport | null>(null);

    /** Stash the pick-mode context before routing to `/plugins`. */
    function begin(next: PendingImport): void {
      pending.value = next;
      completed.value = null;
    }

    /** Record a finished download before routing back to `/studio`. */
    function complete(next: CompletedImport): void {
      completed.value = next;
    }

    /** Consume the completed download exactly once (paste + chip). */
    function takeCompleted(): CompletedImport | null {
      const value = completed.value;
      completed.value = null;
      return value;
    }

    /** Drop the pending context (cancelled pick-mode / stale return). */
    function clearPending(): void {
      pending.value = null;
    }

    /** Forget everything (e.g. room switch). */
    function reset(): void {
      pending.value = null;
      completed.value = null;
    }

    return { pending, completed, begin, complete, takeCompleted, clearPending, reset };
  },
  {
    persist: {
      key: "dsh-movie.import",
      pick: ["pending", "completed"],
      storage: sessionStorage,
    },
  },
);
