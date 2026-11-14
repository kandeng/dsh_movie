/**
 * Leg B executor job runner (Phase-3 P3-M4 §6, Phase-5 D4).
 *
 * Turns a validated, topologically-ordered prompt graph into ONE background job
 * on `ctx.jobs` (kind `movie-exec`). The job walks the nodes in topo order and
 * broadcasts the ComfyUI execution lifecycle over the existing exec WebSocket:
 * `status` -> `queued` -> `execution_start` -> per-node (`executing` ->
 * `progress` -> `executed`) -> `executing(null)` -> `execution_success`. A node
 * failure emits `execution_error` and settles the job `failed`; a cancel emits
 * `execution_interrupted` and settles `killed`.
 *
 * Artifact production dispatches through the D1 handler registry: functional
 * class types resolve to their registered family adapter (D4, `adapters/`),
 * which reads upstream artifacts from the per-run output table keyed by
 * `(nodeId, slotIndex)`. Legacy step class types have no registered handler and
 * keep the Phase-3 path: the two *text* steps (`MovieScript`, `MovieShotPlan`)
 * call the optional {@link StepTextGenerator} when supplied; everything else
 * goes through the {@link MediaProvider} seam (canned placeholder — Bailian is
 * chat-only, so no GPU inference runs on the DSH host).
 *
 * @module dsh-movie-gateway/movie-executor/runner
 */

import type { ExecMessage, PromptGraph } from '@dsh-movie/protocol'
import type { JobHooks, JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { MediaProvider } from './media-provider.ts'
import { handlerFor, modalityOf, type NodeHandler, type NodeHandlerContext } from './registry.ts'

/** Register the `movie-exec` producer kind with the jobs subsystem. */
declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap {
    'movie-exec': 'movie-exec'
  }
}

/** Minimal diagnostics sink (matches the gateway logger's `warn`). */
export interface RunnerLogger {
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/**
 * Produces the real text artifact for a *text* pipeline step. Supplied by the
 * Task-4 director (a lightweight agent turn); when absent, text steps fall back
 * to the canned {@link MediaProvider} so the runner still completes.
 * @param classType - the text step's node class (`MovieScript`/`MovieShotPlan`).
 * @param inputs - the node's resolved prompt inputs.
 * @returns the generated text artifact.
 */
export interface StepTextGenerator {
  (classType: string, inputs: Record<string, unknown>): Promise<string>
}

/** Everything the runner needs to schedule and drive one prompt job. */
export interface RunPromptDeps {
  /** The background-job registry (`ctx.jobs`), controller already attached. */
  jobs: JobRegistry
  /** Broadcasts lifecycle messages to the connected `/ws` exec clients. */
  broadcast: (messages: ExecMessage[]) => void
  /** The media-artifact seam for non-text steps. */
  mediaProvider: MediaProvider
  /** Real text generator for the text steps; canned fallback when absent. */
  stepText?: StepTextGenerator | undefined
  /** Diagnostics sink. */
  logger: RunnerLogger
  /** The assigned execution id. */
  promptId: string
  /** The queue position reported in the `queued`/`status` messages. */
  number: number
  /** One-line job label (room / intent). */
  label: string
}

/** The two pipeline steps that produce real text rather than canned media. */
const TEXT_STEPS: ReadonlySet<string> = new Set(['MovieScript', 'MovieShotPlan'])

/**
 * Whether a node class is a real-text step (and a generator is available).
 * @param classType - the node class.
 * @param stepText - the optional text generator.
 * @returns true when the step should call {@link StepTextGenerator}.
 */
function isTextStep(classType: string, stepText: StepTextGenerator | undefined): boolean {
  return stepText !== undefined && TEXT_STEPS.has(classType)
}

/**
 * Schedule one prompt graph as a `movie-exec` background job and drive its
 * execution lifecycle over the broadcast sink. The graph MUST already be
 * validated and topologically ordered by the caller.
 * @param deps - job registry, broadcast sink, provider seam, and ids.
 * @param graph - the validated prompt graph.
 * @param order - the node ids in topological (sources-first) order.
 * @returns the registry-issued job id.
 */
export function startPromptJob(deps: RunPromptDeps, graph: PromptGraph, order: readonly string[]): JobId {
  const { promptId, number, logger } = deps
  return deps.jobs.start({
    kind: 'movie-exec',
    label: deps.label,
    run(job): JobHooks {
      const controller = new AbortController()
      let cancelReason: string | undefined

      // Emit the pre-loop lifecycle synchronously so a client already on `/ws`
      // observes the full envelope for this prompt id.
      deps.broadcast([
        { type: 'status', data: { status: { exec_info: { queue_remaining: number } } } },
        { type: 'queued', data: { prompt_id: promptId, number } },
        { type: 'execution_start', data: { prompt_id: promptId } },
      ])

      const done = (async (): Promise<JobOutcome> => {
        const executed: string[] = []
        /** Per-run output table: `nodeId -> slotIndex -> artifact` (D4). */
        const outputsByNode = new Map<string, unknown[]>()
        let currentId = ''
        let currentType = ''
        let currentInputs: Record<string, unknown> = {}
        try {
          for (const id of order) {
            if (controller.signal.aborted) {
              deps.broadcast([{ type: 'execution_interrupted', data: { prompt_id: promptId, node_id: id, node_type: graph[id]?.class_type ?? '' } }])
              return { status: 'killed', detail: cancelReason ?? 'cancelled' }
            }
            currentId = id
            const node = graph[id]
            currentType = node?.class_type ?? ''
            currentInputs = (node?.inputs ?? {}) as Record<string, unknown>

            deps.broadcast([
              { type: 'executing', data: { prompt_id: promptId, node: id } },
              { type: 'progress', data: { prompt_id: promptId, node: id, value: 1, max: 1 } },
            ])
            job.updateProgress(`${executed.length + 1}/${order.length} ${currentType}`)

            let output: Record<string, unknown>
            const handler: NodeHandler | undefined = handlerFor(currentType)
            if (handler !== undefined) {
              // D4 family dispatch: the registered adapter resolves upstream
              // artifacts from the run's output table (topo order guarantees
              // producers already ran).
              const ctx: NodeHandlerContext = {
                inputs: currentInputs,
                resolve: (sourceId: string, slotIndex: number): unknown => outputsByNode.get(sourceId)?.[slotIndex],
                ...(deps.stepText === undefined ? {} : { text: deps.stepText }),
                media: deps.mediaProvider,
              }
              const result = await handler.run(ctx)
              outputsByNode.set(id, result.outputs)
              const modality = modalityOf(currentType)
              output = {
                artifact: result.artifact ?? '',
                media: result.media ?? 'canned',
                outputs: result.outputs,
                ...(modality === undefined ? {} : { modality }),
              }
            } else if (isTextStep(currentType, deps.stepText)) {
              const text = await deps.stepText?.(currentType, currentInputs)
              output = { artifact: text ?? '', media: false }
            } else {
              const generation = await deps.mediaProvider.generate(currentType, currentInputs)
              output = { artifact: generation.artifact ?? '', media: generation.media ?? 'canned' }
            }

            deps.broadcast([{ type: 'executed', data: { prompt_id: promptId, node: id, output } }])
            job.append(`[${currentType}] ${String(output['artifact'] ?? '')}\n`, { channel: 'log' })
            executed.push(id)
          }
          deps.broadcast([
            { type: 'executing', data: { prompt_id: promptId, node: null } },
            { type: 'execution_success', data: { prompt_id: promptId } },
          ])
          return { status: 'completed', result: `${executed.length} node(s) executed in topo order` }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('[movie-executor] prompt %s failed at node %s: %s', promptId, currentId, message)
          deps.broadcast([{
            type: 'execution_error',
            data: {
              prompt_id: promptId,
              node_id: currentId,
              node_type: currentType,
              exception_type: 'MovieExecutorError',
              exception_message: message,
              executed,
              current_inputs: currentInputs,
              current_outputs: {},
            },
          }])
          return { status: 'failed', detail: message }
        }
      })()

      return {
        cancel(reason?: string): void {
          cancelReason = reason
          controller.abort()
        },
        done,
      }
    },
  })
}
