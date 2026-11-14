/**
 * Phase-5 D4/M2 real Bailian text + reviewer seams for the Leg B executor.
 *
 * Generalizes the director's six-step text path (`movie-team/director.ts`) and
 * the canvas planner's turn loop (`canvas-agent.ts`) into the two model seams the
 * functional adapters consume:
 *  - {@link LlmTextAgent.text} — the `generator/text` seam: one Bailian LLM turn
 *    (`qwen3.8-max` via `ctx.agents` + `ctx.agentDefaultModel`) that writes the
 *    text a `TextGenerator` node describes, folding its resolved upstream
 *    sections + prompt widget into the instruction.
 *  - {@link LlmTextAgent.review} — the `reviewer` seam (D5): one LLM turn that
 *    judges an artifact against the node's criteria and returns a PASS/FAIL
 *    verdict with brief notes.
 *
 * The Leg B `/prompt` surface is room-agnostic, so a single shared executor agent
 * is lazily created and every turn is serialized behind one queue — concurrent
 * runs never interleave a turn. When the agent runtime is unavailable the gateway
 * simply does not inject these seams and the adapters fall back to their canned
 * paths (unchanged behavior).
 *
 * @module dsh-movie-gateway/movie-executor/llm-text
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
// Empty type-only imports pull the Context service-key merges used below.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'

/** Minimal logger (matches `ctx.logger`). */
export interface LlmTextLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The host services the text/review seams drive; injected once at activation. */
export interface LlmTextDeps {
  /** Core Agent registry (`ctx.agents`). */
  agents: Context['agents']
  /** Default model selection (`ctx.agentDefaultModel`). */
  agentDefaultModel: Context['agentDefaultModel']
  /** Session store, used to flush a turn's durable log (`ctx.sessions`). */
  sessions: Context['sessions']
  /** Optional subagent tree settlement (`ctx.subagents`). */
  subagents?: Context['subagents'] | undefined
  /** Working directory the executor agent runs in. */
  cwd: string
  /** Diagnostics sink. */
  logger: LlmTextLogger
}

/** The reviewer seam signature (D5): judge one artifact against criteria. */
export type ReviewFn = (classType: string, artifact: unknown, criteria: string) => Promise<string>

/** The stable session id for the single shared executor text agent. */
function executorSession(): SessionId {
  return brandString<SessionId>('movie-executor-text')
}

/** Coerce one value to a display string. */
function display(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/** The resolved upstream text sections the adapter folded into `inputs.resolved`. */
function resolvedSections(inputs: Record<string, unknown>): string[] {
  const resolved = inputs['resolved']
  if (!Array.isArray(resolved)) return []
  return resolved.map((entry): string => display(entry)).filter((entry): boolean => entry !== '')
}

/** Compose the instruction prompt for one text-generator node. */
function buildTextPrompt(classType: string, inputs: Record<string, unknown>): string {
  const instruction = display(inputs['prompt'])
  const sections = resolvedSections(inputs)
  const lines: string[] = [
    `You are the dsh_movie "${classType}" text generator.`,
    'Write the text described below. Reply with ONLY the text — no prose, no markdown fences, no tool calls.',
    '',
  ]
  if (instruction !== '') lines.push(`INSTRUCTION: ${instruction}`, '')
  if (sections.length > 0) lines.push('CONTEXT (linked upstream sections, in order):', ...sections, '')
  if (instruction === '' && sections.length === 0) lines.push('No instruction or context was supplied; produce a short, sensible default for this node.', '')
  return lines.join('\n').trim()
}

/** Compose the judge prompt for one reviewer node (D5). */
function buildReviewPrompt(classType: string, artifact: unknown, criteria: string): string {
  const body = display(artifact)
  return [
    `You are the dsh_movie "${classType}" reviewer. Judge the artifact against the criteria.`,
    'Reply with ONLY the verdict: begin with PASS or FAIL, then one or two brief sentences of notes.',
    '',
    `CRITERIA: ${criteria === '' ? '(none specified — judge general quality)' : criteria}`,
    '',
    'ARTIFACT:',
    body === '' ? '(empty)' : body,
  ].join('\n')
}

/**
 * Read the final assistant text produced since `firstSeq` on a session log.
 * Only the last `assistant/message` after the most recent `turn/start` counts.
 * @param session - the agent's durable session.
 * @param firstSeq - the log offset captured before the turn was submitted.
 * @returns the aggregated final assistant text (possibly empty).
 */
function finalAssistantText(session: Session, firstSeq: number): string {
  let started = false
  let text = ''
  const length = Number(session.seq)
  for (let seq = firstSeq; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- mirrors the canvas planner's durable-log read.
    const event = session.eventAt(SessionSeq(seq)) as
      | { type: string; data?: { message?: { content?: Array<{ type: string; text?: string }> } } }
      | undefined
    if (event === undefined) break
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (Array.isArray(content)) {
        const joined = content.filter((block): boolean => block.type === 'text').map((block): string => block.text ?? '').join('')
        if (joined !== '') text = joined
      }
    }
  }
  return text
}

/**
 * The shared executor LLM agent: one lazily-created Bailian agent driving
 * serialized text-generation and reviewer turns for the Leg B `/prompt` path.
 */
export class LlmTextAgent {
  private agent: Agent | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly deps: LlmTextDeps
  private closed = false

  /**
   * @param deps - the injected agent runtime services.
   */
  constructor(deps: LlmTextDeps) {
    this.deps = deps
  }

  /**
   * Generate the text artifact for one `generator/text` node.
   * @param classType - the node class (e.g. `TextGenerator`).
   * @param inputs - the node's resolved inputs (`prompt` widget + `resolved` sections).
   * @returns the generated text.
   */
  text(classType: string, inputs: Record<string, unknown>): Promise<string> {
    return this.enqueue((): Promise<string> => this.runTurn(buildTextPrompt(classType, inputs), `text:${classType}`))
  }

  /**
   * Judge one artifact against criteria for a `reviewer` node (D5).
   * @param classType - the reviewer class.
   * @param artifact - the artifact under review.
   * @param criteria - the review-criteria widget text.
   * @returns the verdict (PASS/FAIL + notes).
   */
  review(classType: string, artifact: unknown, criteria: string): Promise<string> {
    return this.enqueue((): Promise<string> => this.runTurn(buildReviewPrompt(classType, artifact, criteria), `review:${classType}`))
  }

  /** Serialize one turn behind the prior turn so concurrent runs never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue
    const run = previous.then(task, task)
    this.queue = run.then((): void => undefined, (): void => undefined)
    return run
  }

  /** Get the shared executor agent, creating its session on first use. */
  private async ensureAgent(): Promise<Agent> {
    if (this.agent !== undefined) return this.agent
    const selection = this.deps.agentDefaultModel.currentSelection()
    const agentOptions: AgentOptions = { ...selection }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx)
    }
    const { agent } = await this.deps.agents.create({
      sessionId: executorSession(),
      meta: { cwd: this.deps.cwd },
      agentOptions,
      setup,
    })
    await agent.whenIdle()
    this.agent = agent
    this.deps.logger.info('[movie-executor] shared text agent opened')
    return agent
  }

  /** Drive one turn to quiescence and return its final assistant text. */
  private async runTurn(prompt: string, label: string): Promise<string> {
    if (this.closed) throw new Error('executor text agent disposed')
    const agent = await this.ensureAgent()
    const firstSeq = Number(agent.session.seq)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    const subagents = this.deps.subagents
    for (;;) {
      await agent.whenIdle()
      const idleSeq = Number(agent.session.seq)
      const treeBusy = subagents === undefined ? false : await subagents.waitForChildren(agent)
      if (!treeBusy && agent.status === 'idle' && Number(agent.session.seq) === idleSeq) break
    }
    await this.deps.sessions.flush(agent.session)
    const text = finalAssistantText(agent.session, firstSeq).trim()
    if (text === '') {
      this.deps.logger.warn('[movie-executor] %s produced no text', label)
      throw new Error(`${label} produced no text`)
    }
    return text
  }

  /** Drop the live agent and reject further work (plugin disposal). */
  dispose(): void {
    this.closed = true
    this.agent = undefined
    this.queue = Promise.resolve()
  }
}
