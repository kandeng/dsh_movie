/**
 * Movie pipeline director (Phase-3 P3-M4, design doc §2/§5).
 *
 * Runs the six-step movie-making pipeline for one room intent: script ->
 * shot-plan -> asset -> storyboard -> clip -> assemble. It mirrors the
 * per-room serialized {@link CanvasScriptAgent} lifecycle (one resident director
 * agent per room, turns queued so concurrent runs never interleave) and drives
 * each step in pipeline order.
 *
 * Orchestration model (P3-M4 Task 0 finding): the shared task-DAG board
 * (`ctx.agentTeams`) is NOT available in the stable `0.2.2-rc.1` bundle — it
 * lives in an experimental profile that also disables the standard subagent
 * tools. So the director holds the step DAG in gateway-owned state (the
 * {@link MoviePipelineStatus}) and runs each *text* step
 * (`MovieScript`/`MovieShotPlan`) as a real spawned subagent via
 * `ctx.subagents.startActivation` (Bailian `qwen3.8-max`), feeding each artifact
 * into the next step's prompt. The *media* steps go through the
 * {@link MediaProvider} seam, whose only shipped impl is canned (Bailian is
 * chat-only — no GPU inference on the DSH host). A step failure marks it
 * `error` and short-circuits its dependents to `skipped`.
 *
 * @module dsh-movie-gateway/movie-team/director
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Empty type-only imports pull the Context service-key merges used below.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import {
  initialPipelineStatus,
  type MatrixRoomId,
  type MoviePipelineStatus,
  type MovieStepId,
  type MovieStepResult,
} from '@dsh-movie/protocol'
import type { MediaProvider } from '../movie-executor/media-provider.ts'

/** Minimal logger (matches `ctx.logger`). */
export interface MovieDirectorLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The host services the director drives; injected once at plugin activation. */
export interface MovieDirectorDeps {
  /** Core Agent registry (`ctx.agents`). */
  agents: Context['agents']
  /** Default model selection (`ctx.agentDefaultModel`). */
  agentDefaultModel: Context['agentDefaultModel']
  /** Session store (`ctx.sessions`). */
  sessions: Context['sessions']
  /** Subagent runtime used to spawn each text step (`ctx.subagents`). */
  subagents?: Context['subagents'] | undefined
  /** Working directory the per-room director agents run in. */
  cwd: string
  /** Diagnostics sink. */
  logger: MovieDirectorLogger
  /** Media-artifact seam for the non-text steps. */
  mediaProvider: MediaProvider
}

/** One incremental progress emission from a pipeline run. */
export type MovieRunStage =
  | { stage: 'step'; step: MovieStepResult }
  | { stage: 'done'; pipeline: MoviePipelineStatus }

/** Receives each incremental stage of a run (the gateway mux fans these out). */
export type MovieRunListener = (stage: MovieRunStage) => void

/** The two pipeline steps that produce real model text rather than canned media. */
const TEXT_STEPS: ReadonlySet<string> = new Set(['MovieScript', 'MovieShotPlan'])

/** Derive a stable, filesystem-safe session id for a room's director agent. */
function sessionForRoom(roomId: MatrixRoomId): SessionId {
  const digest = createHash('sha1').update(`movie-${roomId}`).digest('hex').slice(0, 32)
  return brandString<SessionId>(`movie-director-${digest}`)
}

/**
 * Build the subagent prompt for one text step, feeding the prior artifacts so
 * each step builds on the last.
 * @param classType - the text step being run.
 * @param intent - the user's movie intent.
 * @param artifacts - prior step artifacts keyed by step id.
 * @returns the bounded prompt text.
 */
function buildStepPrompt(classType: MovieStepId, intent: string, artifacts: ReadonlyMap<MovieStepId, string>): string {
  const script = artifacts.get('MovieScript') ?? ''
  if (classType === 'MovieShotPlan') {
    return [
      'You are the dsh_movie shot planner. From the script below, produce a concise',
      'numbered shot plan: for each shot give the framing, the action, and a duration',
      'in seconds. Reply with ONLY the shot plan text — no prose, no markdown fences.',
      '',
      `MOVIE INTENT: ${intent}`,
      '',
      'SCRIPT:',
      script === '' ? '(none)' : script,
    ].join('\n')
  }
  return [
    'You are the dsh_movie script writer. Write a short, self-contained movie script',
    '(scenes with brief action and dialogue) for the intent below. Keep it under ~300',
    'words. Reply with ONLY the script text — no prose, no markdown fences.',
    '',
    `MOVIE INTENT: ${intent}`,
  ].join('\n')
}

/** Flatten prior artifacts into a bounded input blob for a media step. */
function artifactInputs(intent: string, artifacts: ReadonlyMap<MovieStepId, string>): Record<string, unknown> {
  const inputs: Record<string, unknown> = { intent }
  for (const [key, value] of artifacts) inputs[key] = value
  return inputs
}

/** Per-room serialized six-step movie pipeline director. */
export class MovieDirector {
  private readonly agentsByRoom = new Map<MatrixRoomId, Agent>()
  private readonly queues = new Map<MatrixRoomId, Promise<void>>()
  private readonly deps: MovieDirectorDeps
  private closed = false

  /**
   * @param deps - the injected agent runtime services.
   */
  constructor(deps: MovieDirectorDeps) {
    this.deps = deps
  }

  /** Number of rooms with a live director agent. */
  get roomCount(): number {
    return this.agentsByRoom.size
  }

  /**
   * Run the six-step pipeline for one intent, serialized behind the room's prior
   * run so concurrent requests for a room never interleave. Emits incremental
   * {@link MovieRunStage} progress to `onStage`.
   * @param roomId - the room whose pipeline runs.
   * @param runId - the stable run identity (correlates `movie/run` + `movie/status`).
   * @param intent - the natural-language movie intent.
   * @param onStage - incremental progress listener.
   * @returns the final pipeline status.
   */
  run(roomId: MatrixRoomId, runId: string, intent: string, onStage: MovieRunListener): Promise<MoviePipelineStatus> {
    const previous = this.queues.get(roomId) ?? Promise.resolve()
    const task = previous.then(
      () => this.runPipeline(roomId, runId, intent, onStage),
      () => this.runPipeline(roomId, runId, intent, onStage),
    )
    this.queues.set(roomId, task.then(() => undefined, () => undefined))
    return task
  }

  /** Get the room's live director agent, creating its session on first use. */
  private async ensureAgent(roomId: MatrixRoomId): Promise<Agent> {
    const existing = this.agentsByRoom.get(roomId)
    if (existing !== undefined) return existing
    const selection = this.deps.agentDefaultModel.currentSelection()
    const agentOptions: AgentOptions = { ...selection }
    const sessionId = sessionForRoom(roomId)
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx)
    }
    const { agent } = await this.deps.agents.create({
      sessionId,
      meta: { cwd: this.deps.cwd },
      agentOptions,
      setup,
    })
    await agent.whenIdle()
    this.agentsByRoom.set(roomId, agent)
    this.deps.logger.info('[movie-gateway] director opened for room %s', roomId)
    return agent
  }

  /** Walk the six steps in order, emitting progress and folding artifacts forward. */
  private async runPipeline(roomId: MatrixRoomId, runId: string, intent: string, onStage: MovieRunListener): Promise<MoviePipelineStatus> {
    const pipeline = initialPipelineStatus(runId, roomId)
    const artifacts = new Map<MovieStepId, string>()

    // A director agent is only needed for the real-text steps. When the agent
    // runtime is unavailable, media steps still run (canned) and text steps fall
    // back to the canned provider so the pipeline always completes honestly.
    let director: Agent | undefined
    if (!this.closed && this.deps.subagents !== undefined) {
      try {
        director = await this.ensureAgent(roomId)
      } catch (error) {
        this.deps.logger.warn('[movie-gateway] director agent unavailable in %s: %s', roomId, error instanceof Error ? error.message : String(error))
      }
    }

    let failed = false
    for (const step of pipeline.steps) {
      if (failed) {
        step.status = 'skipped'
        onStage({ stage: 'step', step: { ...step } })
        continue
      }
      step.status = 'running'
      onStage({ stage: 'step', step: { ...step } })
      try {
        if (TEXT_STEPS.has(step.classType) && director !== undefined && this.deps.subagents !== undefined) {
          const text = await this.runTextStep(director, step.classType, intent, artifacts)
          step.status = 'success'
          step.artifact = text
          step.media = false
          artifacts.set(step.classType, text)
        } else {
          const generation = await this.deps.mediaProvider.generate(step.classType, artifactInputs(intent, artifacts))
          step.status = 'success'
          step.artifact = generation.artifact ?? ''
          step.media = true
          if (generation.artifact !== undefined) artifacts.set(step.classType, generation.artifact)
        }
      } catch (error) {
        step.status = 'error'
        step.error = error instanceof Error ? error.message : String(error)
        failed = true
        this.deps.logger.warn('[movie-gateway] run %s step %s failed: %s', runId, step.classType, step.error)
      }
      onStage({ stage: 'step', step: { ...step } })
    }

    pipeline.done = true
    onStage({ stage: 'done', pipeline })
    return pipeline
  }

  /** Spawn one text step as a subagent and return its final assistant text. */
  private async runTextStep(director: Agent, classType: MovieStepId, intent: string, artifacts: ReadonlyMap<MovieStepId, string>): Promise<string> {
    const subagents = this.deps.subagents
    if (subagents === undefined) throw new Error('subagent runtime unavailable')
    const controller = new AbortController()
    const prompt: ContentBlock[] = [{ type: 'text', text: buildStepPrompt(classType, intent, artifacts) }]
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: `movie-${classType}`,
      request: { prompt, parent: director },
      signal: controller.signal,
      delivery: 'caller',
    })
    try {
      const result = await activation.result
      if (result.stopReason !== 'completed') {
        const detail = result.diagnostic ?? ''
        throw new Error(`step ${classType} ended "${result.stopReason}"${detail === '' ? '' : `: ${detail}`}`)
      }
      const text = result.output
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block): string => block.text)
        .join('')
        .trim()
      if (text === '') throw new Error(`step ${classType} produced no text`)
      return text
    } finally {
      await activation.dispose().catch((): void => {})
    }
  }

  /** Drop all live agents and reject further work (plugin disposal). */
  dispose(): void {
    this.closed = true
    this.agentsByRoom.clear()
    this.queues.clear()
  }
}
