/**
 * Leg B executor media-provider seam (Phase-3 P3-M4, design doc §6).
 *
 * The single seam where a step that produces *media* (image/video/clip/movie)
 * would call a real inference backend. The only model provider configured for
 * dsh_movie is Bailian, which is chat-only — it has no text2image/video route —
 * so the only implementation that ships is {@link cannedMediaProvider}: it
 * returns an honest placeholder artifact and marks the step as canned media. A
 * future GPU/provider-backed implementation slots in here without touching the
 * runner or the Leg B surface.
 *
 * @module dsh-movie-gateway/movie-executor/media-provider
 */

/** The result of one media generation. */
export interface MediaGeneration {
  /** A short, honest description of the produced (placeholder) artifact. */
  artifact?: string | undefined
  /** The media kind/tag produced (`canned` for the placeholder provider). */
  media?: string | undefined
}

/** A backend that can produce a media artifact for one pipeline step. */
export interface MediaProvider {
  /**
   * Generate the media artifact for one step.
   * @param step - the node `class_type` being executed.
   * @param inputs - the node's resolved prompt inputs.
   * @returns the artifact description and media tag.
   */
  generate(step: string, inputs: Record<string, unknown>): Promise<MediaGeneration>
}

/**
 * The shipped placeholder provider: no GPU/model inference runs on the DSH host,
 * so media steps emit an honest canned artifact and paint `success` truthfully
 * as a placeholder rather than pretending to render real media.
 */
export const cannedMediaProvider: MediaProvider = {
  async generate(step: string, _inputs: Record<string, unknown>): Promise<MediaGeneration> {
    return {
      artifact: `[canned ${step}] placeholder media artifact — no GPU inference on the DSH host (Bailian is chat-only)`,
      media: 'canned',
    }
  },
}
