/**
 * Cross-route model-pick stash (Phase-1 model selector, D7-mode-1 mirror).
 *
 * The Studio editor's model selector row leaves `/studio`, browses the Plugins
 * page Models view in pick-mode (`/plugins?category=models&mode=pick`), and
 * returns with the chosen model id. Navigating away unmounts the Studio
 * component, so the pending-pick context (which node) and the completed choice
 * must survive the round-trip outside any component — exactly like the skill
 * import hand-off in {@link file://./import.ts}.
 *
 * Persisted to `sessionStorage` so an accidental refresh mid-flow does not
 * silently drop the pending pick; the Studio consumes {@link takeCompleted}
 * exactly once.
 */

import { defineStore } from "pinia";
import { ref } from "vue";

/** Where the Studio wants a model id written when the user returns from pick-mode. */
export interface PendingModelPick {
  /** The room owning the node (context only; the model widget is node-local). */
  roomId: string;
  /** The Studio node id (`String(WorkflowNode.id)`). */
  nodeId: string;
  /** The node class type being picked for (drives the compatibility filter). */
  classType: string;
}

/** A finished pick waiting for the Studio to write it into its node's widget. */
export interface CompletedModelPick {
  /** The Studio node id the choice belongs to. */
  nodeId: string;
  /** The chosen model id ("" would mean default; the pick flow never emits it). */
  modelId: string;
  /** The chosen model's display name (selector-row label). */
  modelName: string;
}

/**
 * The model-pick hand-off store.
 * @returns the pending/completed refs + the begin/complete/take/clear actions.
 */
export const useModelPickStore = defineStore(
  "modelPick",
  () => {
    const pending = ref<PendingModelPick | null>(null);
    const completed = ref<CompletedModelPick | null>(null);

    /** Stash the pick-mode context before routing to `/plugins`. */
    function begin(next: PendingModelPick): void {
      pending.value = next;
      completed.value = null;
    }

    /** Record the chosen model before routing back to `/studio`. */
    function complete(next: CompletedModelPick): void {
      completed.value = next;
    }

    /** Consume the completed pick exactly once (selector row + dirty draft). */
    function takeCompleted(): CompletedModelPick | null {
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
      key: "dsh-movie.modelPick",
      pick: ["pending", "completed"],
      storage: sessionStorage,
    },
  },
);
