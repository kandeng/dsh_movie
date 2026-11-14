/**
 * Typed executor errors (Phase-5 D15).
 *
 * {@link ModelUnavailableError} is thrown by a generator adapter when its
 * modality has no configured backing model. The runner catches it specifically
 * so it can (a) post the D15 `customer_service` notice into the room and (b)
 * settle the node/job with the honest `model-unavailable` reason rather than a
 * generic failure — never a silent canned placeholder.
 *
 * @module dsh-movie-gateway/movie-executor/errors
 */

import type { NodeModality } from '@dsh-movie/protocol'
import { MODEL_UNAVAILABLE_NOTICE, MODEL_UNAVAILABLE_REASON } from './model-catalog.ts'

/** Thrown when a generator's modality has no configured model (D15). */
export class ModelUnavailableError extends Error {
  /** The stable reason tag surfaced on the execution error (`model-unavailable`). */
  readonly reason: string = MODEL_UNAVAILABLE_REASON
  /** The modality that has no backing model. */
  readonly modality: string
  /** The generator class type that was executed. */
  readonly classType: string

  /**
   * @param modality - the unbacked modality.
   * @param classType - the generator class type being executed.
   * @param message - the room-facing notice (defaults to the D15 text).
   */
  constructor(modality: NodeModality | string, classType: string, message: string = MODEL_UNAVAILABLE_NOTICE) {
    super(message)
    this.name = 'ModelUnavailableError'
    this.modality = String(modality)
    this.classType = classType
  }
}

/**
 * Narrow an unknown thrown value to {@link ModelUnavailableError}.
 * @param error - the caught value.
 * @returns true when the error is the D15 model-unavailable signal.
 */
export function isModelUnavailable(error: unknown): error is ModelUnavailableError {
  return error instanceof ModelUnavailableError
}
