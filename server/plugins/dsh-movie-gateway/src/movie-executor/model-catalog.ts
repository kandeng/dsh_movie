/**
 * Phase-5 D15 model-availability gate.
 *
 * The single source of truth for *which modalities have a configured backing
 * model*. dsh_movie runs Bailian-only (design doc D15): text rides the Bailian
 * LLM (`ctx.subagents`), video rides the Bailian "Happyhorse" synthesis model
 * when its endpoint is configured, and image/audio have no model today. A
 * generator whose modality is `unavailable` must NOT emit a silent canned
 * placeholder — the adapter throws {@link ModelUnavailableError} and the runner
 * surfaces the {@link MODEL_UNAVAILABLE_NOTICE} into the room via
 * `customer_service` (see `room-notifier.ts`).
 *
 * The inventory is read from server settings/env at gateway activation, so
 * adding an image/audio/video endpoint there flips that modality to `available`
 * with no code change (D15 settings-gated activation).
 *
 * @module dsh-movie-gateway/movie-executor/model-catalog
 */

import type { NodeModality } from '@dsh-movie/protocol'

/** Whether a modality has a configured backing model. */
export type ModalityAvailability = 'available' | 'unavailable'

/**
 * The D15 customer-service notice posted into the room when a generator whose
 * modality has no configured model is executed.
 */
export const MODEL_UNAVAILABLE_NOTICE =
  'There is no this type AI model available now, please configure the settings to provide the AI model first.'

/** The reason tag carried on a model-unavailable execution error (D15). */
export const MODEL_UNAVAILABLE_REASON = 'model-unavailable'

/** Per-modality model availability, derived from the configured inventory. */
export interface ModelAvailability {
  /**
   * Resolve a modality to its availability.
   * @param modality - the node modality (`undefined` for non-protocol classes,
   * which are never gated).
   * @returns `available` or `unavailable`.
   */
  for(modality: NodeModality | undefined): ModalityAvailability
}

/**
 * Build a gate from an explicit per-modality map. Unlisted modalities default to
 * `unavailable` (fail closed — an unbacked modality never silently succeeds).
 * @param map - the per-modality availability overrides.
 * @returns the gate.
 */
export function staticAvailability(map: Partial<Record<NodeModality, ModalityAvailability>>): ModelAvailability {
  return {
    for(modality: NodeModality | undefined): ModalityAvailability {
      // Non-protocol classes (canned demo nodes, legacy steps) are never gated.
      if (modality === undefined) return 'available'
      return map[modality] ?? 'unavailable'
    },
  }
}

/** The configured-model inventory the gateway derives from settings/env (D15). */
export interface ModelInventory {
  /** A text/LLM model is configured (Bailian `qwen3.8-max` via `ctx.subagents`). */
  text: boolean
  /** A video model is configured (Bailian "Happyhorse" endpoint present). */
  video: boolean
  /** An image model is configured. */
  image: boolean
  /** An audio model is configured. */
  audio: boolean
}

/**
 * Build the availability gate from the configured inventory.
 * @param inventory - which modalities have a backing model.
 * @returns the gate.
 */
export function availabilityFromInventory(inventory: ModelInventory): ModelAvailability {
  return staticAvailability({
    text: inventory.text ? 'available' : 'unavailable',
    video: inventory.video ? 'available' : 'unavailable',
    image: inventory.image ? 'available' : 'unavailable',
    audio: inventory.audio ? 'available' : 'unavailable',
  })
}

/**
 * The dev/verifier affordance: every modality reports `available`, bypassing the
 * D15 gate so canned paths can be exercised offline. Never used in production —
 * the gateway builds its gate from {@link availabilityFromInventory}.
 */
export const PERMISSIVE_AVAILABILITY: ModelAvailability = staticAvailability({
  text: 'available',
  image: 'available',
  video: 'available',
  audio: 'available',
})
