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

import type { CacheCard, ExecMessage, PromptGraph, PromptGraphNode } from '@dsh-movie/protocol'
import type { JobHooks, JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { MediaProvider } from './media-provider.ts'
import type { CacheArrival } from '../workspace-store.ts'
import { displayNameOf, handlerFor, modalityOf, outputSlotSchema, type NodeHandler, type NodeHandlerContext } from './registry.ts'
import { isModelUnavailable } from './errors.ts'
import type { ModelAvailability } from './model-catalog.ts'
import type { EchoKind, RoomNotifier } from './room-notifier.ts'

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

/**
 * Resolves one node's imported skills into a composed prompt section plus
 * lifecycle notes (Phase-7 D7 mode-2). `skill-import.resolveNodeSkills` bound to
 * a room satisfies this; the runner injects `section` into `inputs.skills` (the
 * shared text seam folds it in) and logs each note. It must never throw into the
 * run — a stopped tool yields an empty section + a "skill-less" note (R3).
 * @param node - the prompt node about to execute.
 * @returns the composed section + lifecycle notes.
 */
export interface SkillResolver {
  (node: PromptGraphNode): Promise<{ section: string; notes: string[] }>
}

/**
 * Executes one node's imported skills that declare an executable entrypoint
 * (Phase-7 D9b), returning a composed output section plus lifecycle notes.
 * `skill-import.executeNodeSkills` bound to a room satisfies this; the runner
 * merges `section` into `inputs.skills` (after any {@link SkillResolver} section)
 * and logs each note. The market gates every call by warning level (clean/yellow
 * auto, orange only after recorded consent, red never); it must never throw into
 * the run — a skipped skill yields a note, not a failure (R3).
 * @param node - the prompt node about to execute.
 * @returns the composed run-output section + lifecycle notes.
 */
export interface SkillExecutor {
  (node: PromptGraphNode): Promise<{ section: string; notes: string[] }>
}

/**
 * The Cache node's persistent card-list seam (the {@link WorkspaceStore} cache
 * subset). The runner binds it per node into `NodeHandlerContext.cache` when the
 * run carries both a store and a room; room-less offline runs skip it and the
 * Cache adapter degrades to ephemeral cards.
 */
export interface CacheCardStore {
  /** Read a Cache node's stored cards, in card order. */
  getCacheCards(roomId: string, nodeId: string): CacheCard[]
  /** Append this run's arrivals (seq assigned by the store); returns all cards. */
  appendCacheCards(roomId: string, nodeId: string, arrivals: CacheArrival[]): CacheCard[]
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
  /**
   * Optional Phase-7 D7 mode-2 skill resolver. When present, each node's
   * imported skills are resolved (re-fetching any missing file) before it runs.
   * Absent without a market + room, so runs are unaffected when none applies.
   */
  resolveSkills?: SkillResolver | undefined
  /**
   * Optional Phase-7 D9b skill executor. When present, each node's executable
   * imported skills are run (gated by warning level) before the node executes,
   * and their bounded output section is folded into the inputs. Absent without a
   * market + room, so runs are unaffected when none applies.
   */
  executeSkills?: SkillExecutor | undefined
  /** The D15 model-availability gate consulted before any model call. */
  availability: ModelAvailability
  /** The room this run was triggered from; empty/undefined → no room notices. */
  roomId?: string | undefined
  /** The Cache node's persistent card store; absent → ephemeral cache cards. */
  cache?: CacheCardStore | undefined
  /** The `customer_service` room notifier (D15 notice + D8 artifact echo). */
  notifier?: RoomNotifier | undefined
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
        // Cache card persistence is room-scoped: capture both once so the
        // per-node ctx closures see narrowed consts (no non-null assertions).
        const cacheStore = deps.cache
        const cacheRoom = deps.roomId
        const cacheEnabled = cacheStore !== undefined && cacheRoom !== undefined && cacheRoom !== ''
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

            // Phase-7 D7 mode-2: resolve this node's imported skills (re-fetching
            // any missing file) and fold the composed section into the inputs the
            // shared text seam reads. Lifecycle notes go to the job log; a
            // stopped/failing tool yields an empty section + a note, never a fail.
            if (deps.resolveSkills !== undefined && node !== undefined) {
              const resolvedSkills = await deps.resolveSkills(node)
              for (const note of resolvedSkills.notes) job.append(`[skill] ${note}\n`, { channel: 'log' })
              if (resolvedSkills.section !== '') currentInputs = { ...currentInputs, skills: resolvedSkills.section }
            }

            // Phase-7 D9b: execute this node's imported skills that declare an
            // executable entrypoint (the market gates each call by warning level)
            // and merge their bounded output section into the inputs the shared
            // text seam reads. Notes go to the job log; an orange-without-consent
            // / red / unavailable skill is skipped with a note, never a fail (R3).
            if (deps.executeSkills !== undefined && node !== undefined) {
              const runSkills = await deps.executeSkills(node)
              for (const note of runSkills.notes) job.append(`[skill-run] ${note}\n`, { channel: 'log' })
              if (runSkills.section !== '') {
                const prior = currentInputs['skills']
                const merged = typeof prior === 'string' && prior !== ''
                  ? `${prior}\n\n${runSkills.section}`
                  : runSkills.section
                currentInputs = { ...currentInputs, skills: merged }
              }
            }

            deps.broadcast([
              { type: 'executing', data: { prompt_id: promptId, node: id } },
              { type: 'progress', data: { prompt_id: promptId, node: id, value: 1, max: 1 } },
            ])
            job.updateProgress(`${executed.length + 1}/${order.length} ${currentType}`)

            let output: Record<string, unknown>
            /** Phase 8 P8-M3: true once real media bytes were posted into the room. */
            let mediaPosted = false
            const handler: NodeHandler | undefined = handlerFor(currentType)
            if (handler !== undefined) {
              // D4 family dispatch: the registered adapter resolves upstream
              // artifacts from the run's output table (topo order guarantees
              // producers already ran).
              const ctx: NodeHandlerContext = {
                inputs: currentInputs,
                resolve: (sourceId: string, slotIndex: number): unknown => outputsByNode.get(sourceId)?.[slotIndex],
                // Declared source-slot type for the unified REF slot adapter:
                // the prompt graph carries only ids, so look the producer's
                // class up and ask the registry for its output slot schema.
                linkSourceType: (sourceId: string, slotIndex: number): string | undefined => {
                  const sourceType = graph[sourceId]?.class_type
                  return sourceType === undefined ? undefined : outputSlotSchema(sourceType, slotIndex)?.type
                },
                availability: deps.availability,
                ...(deps.stepText === undefined ? {} : { text: deps.stepText }),
                media: deps.mediaProvider,
                // Cache node seams: the card store bound to this room + node, and
                // the human name resolver for card labels («sourceName» «seq»).
                ...(cacheEnabled ? {
                  cache: {
                    read: (): CacheCard[] => cacheStore.getCacheCards(cacheRoom, id),
                    append: (arrivals: CacheArrival[]): CacheCard[] => cacheStore.appendCacheCards(cacheRoom, id, arrivals),
                  },
                } : {}),
                nodeTitle: (sourceId: string): string => {
                  const sourceNode = graph[sourceId]
                  const title = sourceNode?._meta?.title
                  if (title !== undefined && title !== '') return title
                  const sourceType = sourceNode?.class_type
                  return (sourceType === undefined ? undefined : displayNameOf(sourceType)) ?? sourceId
                },
                // P8-M4: sampling progress rides the existing `progress` lifecycle
                // message; cancellation aborts the provider's remote job.
                progress: (percent: number): void => {
                  deps.broadcast([{ type: 'progress', data: { prompt_id: promptId, node: id, value: percent, max: 100 } }])
                },
                signal: controller.signal,
              }
              const result = await handler.run(ctx)
              outputsByNode.set(id, result.outputs)
              const modality = modalityOf(currentType)
              let artifact = result.artifact ?? ''
              let contentRef: Record<string, unknown> | undefined
              // P8-M3: real GPU output bytes → room media message + local artifact
              // copy; the node's output reference becomes the posted media URI so
              // downstream nodes and the Studio canvas resolve the real file.
              if (result.bytes !== undefined && deps.notifier !== undefined && deps.roomId !== undefined && deps.roomId !== '') {
                const posted = await deps.notifier.echoMediaFile(deps.roomId, currentType, id, result.bytes, result.filename ?? 'artifact.bin', result.mime ?? 'application/octet-stream')
                if (posted !== undefined) {
                  mediaPosted = true
                  const uri = posted.uri ?? posted.path ?? artifact
                  contentRef = {
                    origin: 'generated',
                    uri,
                    ...(result.mime === undefined ? {} : { mime: result.mime }),
                    ...(result.filename === undefined ? {} : { name: result.filename }),
                  }
                  artifact = uri
                  // Downstream media providers re-fetch a backend URL directly
                  // (the ComfyUI provider downloads it, then re-uploads it as
                  // the i2v / face-lock reference). Keep the provider's own
                  // fetchable http(s)/data artifact resolvable downstream; only
                  // fall back to the posted room/workspace uri when the
                  // produced reference isn't something a provider can fetch.
                  const produced = result.outputs[0]
                  const fetchable = typeof produced === 'string' && /^(https?:|data:)/i.test(produced)
                  outputsByNode.set(id, fetchable ? result.outputs : [uri, ...result.outputs.slice(1)])
                }
              }
              output = {
                artifact,
                media: result.media ?? 'canned',
                outputs: outputsByNode.get(id) ?? result.outputs,
                ...(modality === undefined ? {} : { modality }),
                ...(contentRef === undefined ? {} : { contentRef }),
              }
            } else if (isTextStep(currentType, deps.stepText)) {
              const text = await deps.stepText?.(currentType, currentInputs)
              output = { artifact: text ?? '', media: false }
            } else {
              const generation = await deps.mediaProvider.generate(currentType, currentInputs, { signal: controller.signal })
              output = { artifact: generation.artifact ?? '', media: generation.media ?? 'canned' }
            }

            deps.broadcast([{ type: 'executed', data: { prompt_id: promptId, node: id, output } }])
            job.append(`[${currentType}] ${String(output['artifact'] ?? '')}\n`, { channel: 'log' })
            executed.push(id)
            // D8 artifact echo: post the executed representation into the room.
            // A no-op when the run carries no room/poster (the room-agnostic
            // ComfyUI `/prompt` path), so it never breaks offline verification.
            // P8-M3: real media bytes were already posted by echoMediaFile — no
            // duplicate text echo for those nodes.
            if (!mediaPosted && deps.notifier !== undefined && deps.roomId !== undefined && deps.roomId !== '') {
              const echoModality = modalityOf(currentType)
              const kind: EchoKind = echoModality === 'text' || output['media'] === false || output['media'] === 'llm' ? 'text' : 'media'
              await deps.notifier.echoArtifact(deps.roomId, currentType, String(output['artifact'] ?? ''), kind)
            }
          }
          deps.broadcast([
            { type: 'executing', data: { prompt_id: promptId, node: null } },
            { type: 'execution_success', data: { prompt_id: promptId } },
          ])
          return { status: 'completed', result: `${executed.length} node(s) executed in topo order` }
        } catch (error) {
          if (controller.signal.aborted) {
            // P8-M4: the run was interrupted mid-node (the provider aborted its
            // remote job). Settle `killed` with the interrupted lifecycle message.
            deps.broadcast([{ type: 'execution_interrupted', data: { prompt_id: promptId, node_id: currentId, node_type: currentType } }])
            return { status: 'killed', detail: cancelReason ?? 'interrupted' }
          }
          if (isModelUnavailable(error)) {
            // D15: an unbacked modality. `customer_service` posts the notice into
            // the room and the node fails honestly with reason `model-unavailable`
            // (never a silent canned placeholder).
            const modality = error.modality
            logger.warn('[movie-executor] prompt %s node %s: model unavailable (%s)', promptId, currentId, modality)
            if (deps.notifier !== undefined && deps.roomId !== undefined && deps.roomId !== '') {
              await deps.notifier.notifyModelUnavailable(deps.roomId, currentType, modality)
            }
            deps.broadcast([{
              type: 'execution_error',
              data: {
                prompt_id: promptId,
                node_id: currentId,
                node_type: currentType,
                exception_type: 'ModelUnavailableError',
                exception_message: `${error.message} (reason: ${error.reason}, modality: ${modality})`,
                executed,
                current_inputs: currentInputs,
                current_outputs: {},
              },
            }])
            return { status: 'failed', detail: `${error.reason}: no ${modality} model configured` }
          }
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
