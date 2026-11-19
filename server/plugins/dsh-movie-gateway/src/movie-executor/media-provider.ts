/**
 * Leg B executor media-provider seam (Phase-3 P3-M4, Phase-5 D15).
 *
 * The seam where a node that produces *media* (image/video/clip/movie) calls a
 * real inference backend. dsh_movie is Bailian-only (D15): text rides the LLM,
 * video rides the Bailian "Happyhorse" synthesis model (`video-provider.ts`)
 * when its endpoint is configured, and image/audio have no model — those are
 * rejected by the D15 availability gate before reaching a provider, never
 * silently canned.
 *
 * Two implementations ship here: {@link cannedMediaProvider}, the honest
 * offline/dev placeholder (used by the verifier and the legacy six-step path),
 * and {@link createRoutingMediaProvider}, which routes the functional
 * `VideoGenerator` to the real provider when configured and everything else to
 * the canned fallback so legacy behavior is unchanged.
 *
 * @module dsh-movie-gateway/movie-executor/media-provider
 */

/** The result of one media generation. */
export interface MediaGeneration {
  /** A short, honest description of the produced (placeholder) artifact. */
  artifact?: string | undefined
  /** The media kind/tag produced (`canned` for the placeholder provider). */
  media?: string | undefined
  /** Raw output bytes (Phase 8: real GPU backends return the file itself). */
  bytes?: Uint8Array | undefined
  /** Suggested file name for the produced bytes (e.g. `dsh-movie_00001_.png`). */
  filename?: string | undefined
  /** MIME type of the produced bytes (e.g. `image/png`, `video/mp4`). */
  mime?: string | undefined
}

/**
 * Optional run hooks (Phase 8 P8-M4): progress reporting and cancellation.
 * Providers that cannot report progress simply ignore `onProgress`; providers
 * that support cancellation must honor `signal` (abort the remote job).
 */
export interface MediaHooks {
  /** Called with 0..100 as the backend reports sampling progress. */
  onProgress?: ((percent: number) => void) | undefined
  /** Aborts when the user interrupts the run or the job is cancelled. */
  signal?: AbortSignal | undefined
}

/** A backend that can produce a media artifact for one pipeline step. */
export interface MediaProvider {
  /**
   * Generate the media artifact for one step.
   * @param step - the node `class_type` being executed.
   * @param inputs - the node's resolved prompt inputs.
   * @param hooks - optional progress/cancellation hooks (Phase 8).
   * @returns the artifact description and media tag.
   */
  generate(step: string, inputs: Record<string, unknown>, hooks?: MediaHooks): Promise<MediaGeneration>
}

/**
 * The shipped placeholder provider: no GPU/model inference runs on the DSH host,
 * so media steps emit an honest canned artifact and paint `success` truthfully
 * as a placeholder rather than pretending to render real media.
 */
export const cannedMediaProvider: MediaProvider = {
  async generate(step: string, _inputs: Record<string, unknown>): Promise<MediaGeneration> {
    return {
      artifact: `[canned ${step}] placeholder media artifact — offline/dev fallback (no model configured for this modality)`,
      media: 'canned',
    }
  },
}

/**
 * Route media generation by class type (D15 + Phase 8 D2): the functional
 * `ImageGenerator` goes to the local ComfyUI provider when configured, the
 * functional `VideoGenerator` goes to ComfyUI when configured else the Bailian
 * "Happyhorse" provider; every other class type (the legacy six-step media,
 * and any modality the availability gate would already have rejected) falls
 * back to the canned provider so the legacy pipeline stays green.
 * @param routes - the real image/video providers (when configured) + the canned fallback.
 * @returns the routing provider injected as the executor's media seam.
 */
export function createRoutingMediaProvider(routes: { image?: MediaProvider | undefined; video?: MediaProvider | undefined; fallback: MediaProvider }): MediaProvider {
  return {
    async generate(step: string, inputs: Record<string, unknown>, hooks?: MediaHooks): Promise<MediaGeneration> {
      if (step === 'ImageGenerator' && routes.image !== undefined) return routes.image.generate(step, inputs, hooks)
      if (step === 'VideoGenerator' && routes.video !== undefined) return routes.video.generate(step, inputs, hooks)
      return routes.fallback.generate(step, inputs, hooks)
    },
  }
}
