/**
 * Movie pipeline runner (Phase-3 P3-M4, design doc §2/§5).
 *
 * The browser half of the `movie.*` channel. A natural-language intent is
 * submitted to the host (Leg C `movie/run` POST), which starts the director
 * agent and acknowledges with a `runId`. This composable then opens the
 * `movie/run` mux channel (correlated by `runId`) and folds the streamed
 * `{stage:'step'}` / `{stage:'done'}` frames into reactive pipeline state:
 *
 *  1. `POST movie/run {roomId, intent}` -> `{runId, accepted}`;
 *  2. open mux `movie/run {roomId, runId, token}`;
 *  3. each `{stage:'step', step}` upserts one {@link MovieStepResult} (the host
 *     replays progress-so-far on attach, then fans out live stages);
 *  4. `{stage:'done', pipeline}` settles the run with the full
 *     {@link MoviePipelineStatus};
 *  5. every step is echoed to `onStep` so the Studio can paint the matching
 *     canvas node badge (Leg B style) via the bridge.
 *
 * The text steps (`MovieScript`, `MovieShotPlan`) carry real Bailian artifacts;
 * the media steps carry canned placeholders (`media: true`) since the only
 * provider is chat-only. Both are surfaced verbatim for the inspector.
 */

import { onScopeDispose, ref, type Ref } from "vue";
import { LegCError, MuxSocket, RpcClient, type MuxStream } from "@dsh-movie/sdk";
import type { MoviePipelineStatus, MovieStepResult } from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";

/** The coarse progress phase of one movie run, surfaced to the Studio UI. */
export type MovieRunStage = "idle" | "submitting" | "running" | "done" | "error";

/** Options for {@link useMovieRun}. */
export interface UseMovieRunOptions {
  /** Override the access-token getter (defaults to the auth store). */
  getToken?: () => string | null;
  /** Called for every streamed step so the Studio can paint node badges. */
  onStep?: (step: MovieStepResult) => void;
  /** Called once when the pipeline settles (`done`) or errors. */
  onSettled?: (pipeline: MoviePipelineStatus | null) => void;
}

/** The handle returned by {@link useMovieRun}. */
export interface MovieRunHandle {
  /** True while a run is in flight. */
  busy: Ref<boolean>;
  /** The current {@link MovieRunStage}. */
  stage: Ref<MovieRunStage>;
  /** The run id of the most recent run, or `null`. */
  runId: Ref<string | null>;
  /** Per-step outcomes streamed so far, in pipeline order. */
  steps: Ref<MovieStepResult[]>;
  /** The settled pipeline status, or `null` until `done`. */
  pipeline: Ref<MoviePipelineStatus | null>;
  /** The last surfaced error message, or `null`. */
  error: Ref<string | null>;
  /**
   * Submit an intent and stream the six-step pipeline to completion.
   * @param roomId - the room whose pipeline runs.
   * @param intent - the natural-language movie description.
   * @returns the settled pipeline, or `null` when the run failed/was rejected.
   */
  runIntent(roomId: string, intent: string): Promise<MoviePipelineStatus | null>;
  /** Clear every tracked step/pipeline (e.g. before a fresh run). */
  reset(): void;
}

/**
 * Whole-run guard. Six sequential Bailian text steps plus canned media can be
 * slow; mirror the host's 300s run TTL so the UI gives up at the same horizon.
 */
const RUN_TIMEOUT_MS = 300_000;

/** Turn an unknown throw into a short human-readable message. */
function describeError(error: unknown): string {
  if (error instanceof LegCError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Narrow an unknown mux frame to the `{stage:'step', step}` payload. */
function isStepFrame(value: unknown): value is { stage: "step"; step: MovieStepResult } {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { stage?: unknown; step?: unknown };
  return frame.stage === "step" && typeof frame.step === "object" && frame.step !== null;
}

/** Narrow an unknown mux frame to the `{stage:'done', pipeline}` payload. */
function isDoneFrame(value: unknown): value is { stage: "done"; pipeline: MoviePipelineStatus } {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { stage?: unknown; pipeline?: unknown };
  return frame.stage === "done" && typeof frame.pipeline === "object" && frame.pipeline !== null;
}

/**
 * Create a movie pipeline runner bound to the Leg C RPC + mux transports.
 * @param options - optional token getter and step/settled callbacks.
 * @returns the {@link MovieRunHandle}; the mux socket closes on scope dispose.
 */
export function useMovieRun(options: UseMovieRunOptions = {}): MovieRunHandle {
  const auth = useAuthStore();
  const getToken = options.getToken ?? ((): string | null => auth.session?.accessToken ?? null);

  const rpc = new RpcClient(sdkConfig, { getToken });
  const mux = new MuxSocket(sdkConfig, { reconnect: true });

  const busy = ref(false);
  const stage = ref<MovieRunStage>("idle");
  const runId = ref<string | null>(null);
  const steps = ref<MovieStepResult[]>([]);
  const pipeline = ref<MoviePipelineStatus | null>(null);
  const error = ref<string | null>(null);

  /** The in-flight stream's rejector, so dispose can unblock a pending run. */
  let pendingReject: ((reason: Error) => void) | null = null;

  /** Merge one streamed step into the ordered step list (idempotent by step). */
  function upsertStep(step: MovieStepResult): void {
    const next = steps.value.slice();
    const index = next.findIndex((entry) => entry.step === step.step);
    if (index >= 0) next[index] = step;
    else next.push(step);
    next.sort((a, b) => a.step - b.step);
    steps.value = next;
  }

  function reset(): void {
    steps.value = [];
    pipeline.value = null;
    runId.value = null;
    error.value = null;
  }

  async function runIntent(roomId: string, intent: string): Promise<MoviePipelineStatus | null> {
    if (busy.value) return null;
    busy.value = true;
    reset();
    stage.value = "submitting";
    try {
      const ack = await rpc.call("movie/run", { roomId, intent });
      if (!ack.accepted) throw new Error("movie/run was not accepted by the host");
      runId.value = ack.runId;
      stage.value = "running";
      const token = getToken() ?? "";
      const settled = await new Promise<MoviePipelineStatus>((resolve, reject) => {
        let done = false;
        let stream: MuxStream;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          pendingReject = null;
          stream.close();
          reject(new Error("movie pipeline timed out"));
        }, RUN_TIMEOUT_MS);
        const finish = (fn: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          pendingReject = null;
          fn();
        };
        pendingReject = (reason: Error): void => {
          finish(() => { stream.close(); reject(reason); });
        };
        stream = mux.open("movie/run", { roomId, runId: ack.runId, token }, {
          onData(payload: unknown): void {
            if (isStepFrame(payload)) {
              upsertStep(payload.step);
              options.onStep?.(payload.step);
              return;
            }
            if (isDoneFrame(payload)) {
              pipeline.value = payload.pipeline;
              steps.value = [...payload.pipeline.steps];
              finish(() => { stream.close(); resolve(payload.pipeline); });
            }
          },
          onError(payload: unknown): void {
            const message =
              (payload as { message?: string } | null)?.message ?? "movie pipeline stream error";
            finish(() => { stream.close(); reject(new Error(message)); });
          },
          onEnd(): void {
            finish(() => {
              if (pipeline.value !== null) resolve(pipeline.value);
              else reject(new Error("movie pipeline stream ended without completion"));
            });
          },
        });
      });
      stage.value = "done";
      options.onSettled?.(settled);
      return settled;
    } catch (caught) {
      error.value = describeError(caught);
      stage.value = "error";
      options.onSettled?.(null);
      return null;
    } finally {
      busy.value = false;
    }
  }

  onScopeDispose(() => {
    pendingReject?.(new Error("movie pipeline runner disposed"));
    pendingReject = null;
    mux.close();
  });

  return { busy, stage, runId, steps, pipeline, error, runIntent, reset };
}
