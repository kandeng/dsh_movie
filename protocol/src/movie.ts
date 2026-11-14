/**
 * Movie pipeline contract (Phase-3 P3-M4, design doc §2/§5/§6).
 *
 * Types for the six-step movie-making pipeline the director agent runs: each
 * step maps 1:1 onto a {@link MOVIE_NODES} `classType`, produces an artifact
 * (real text for the script/shot-plan steps via Bailian; canned placeholders for
 * the media steps, since the only model provider is chat-only), and reports a
 * lifecycle status the client paints onto the canvas node badges.
 *
 * Contract-as-code: pure types plus tiny pure helpers, no runtime dependencies
 * beyond the sibling protocol modules.
 *
 * @module @dsh-movie/protocol/movie
 */

import type { MatrixRoomId } from './principal.ts'
import { MOVIE_NODES } from './nodes.ts'

/**
 * The six movie-making step identities, keyed to the {@link MOVIE_NODES}
 * `classType` values so a pipeline step always names a real canvas node type.
 */
export type MovieStepId =
  | 'MovieScript'
  | 'MovieShotPlan'
  | 'MovieAsset'
  | 'MovieStoryboard'
  | 'MovieClip'
  | 'MovieAssemble'

/** Every valid {@link MovieStepId}, in pipeline order (for validation / UI). */
export const MOVIE_STEP_IDS: readonly MovieStepId[] = [
  'MovieScript',
  'MovieShotPlan',
  'MovieAsset',
  'MovieStoryboard',
  'MovieClip',
  'MovieAssemble',
] as const

/**
 * Lifecycle of one pipeline step. `pending` before it starts, `running` while
 * the director executes it, then exactly one terminal state: `success`,
 * `error`, or `skipped` (an upstream failure short-circuits its dependents).
 */
export type MovieStepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

/** Every valid {@link MovieStepStatus} (for validation / UI). */
export const MOVIE_STEP_STATUSES: readonly MovieStepStatus[] = [
  'pending',
  'running',
  'success',
  'error',
  'skipped',
] as const

/** The outcome of one pipeline step. */
export interface MovieStepResult {
  /** Pipeline order, 1..6 (mirrors {@link MOVIE_NODES} `step`). */
  step: number
  /** The node `classType` this step produced. */
  classType: MovieStepId
  /** Current lifecycle status. */
  status: MovieStepStatus
  /**
   * The produced artifact: real text for the script/shot-plan steps, or a canned
   * placeholder note for media steps. Absent until the step succeeds.
   */
  artifact?: string | undefined
  /** True when the artifact is a media placeholder rather than real model text. */
  media?: boolean | undefined
  /** Failure reason; present only when `status` is `error`. */
  error?: string | undefined
}

/** The whole-pipeline status for one run, streamed to the client. */
export interface MoviePipelineStatus {
  /** Stable run identity (correlates `movie/run` with `movie/status`). */
  runId: string
  /** The room whose pipeline is running. */
  roomId: MatrixRoomId
  /** Per-step outcomes, in pipeline order. */
  steps: MovieStepResult[]
  /** True once every step reached a terminal status. */
  done: boolean
}

/**
 * Narrow an unknown value to a {@link MovieStepId}.
 * @param value - the candidate value.
 * @returns true when the value is one of the six step identities.
 */
export function isMovieStepId(value: unknown): value is MovieStepId {
  return typeof value === 'string' && (MOVIE_STEP_IDS as readonly string[]).includes(value)
}

/**
 * Build the initial all-`pending` pipeline status for a run, deriving the six
 * steps from {@link MOVIE_NODES} so the step list and the canvas node catalog
 * never drift apart.
 * @param runId - the run identity to stamp on the status.
 * @param roomId - the room the pipeline runs in.
 * @returns a fresh pipeline status with every step `pending`.
 */
export function initialPipelineStatus(runId: string, roomId: MatrixRoomId): MoviePipelineStatus {
  const steps: MovieStepResult[] = [...MOVIE_NODES]
    .filter((node): boolean => node.step !== undefined)
    .sort((a, b): number => (a.step ?? 0) - (b.step ?? 0))
    .map((node): MovieStepResult => ({
      step: node.step ?? 0,
      classType: node.classType as MovieStepId,
      status: 'pending',
    }))
  return { runId, roomId, steps, done: false }
}
