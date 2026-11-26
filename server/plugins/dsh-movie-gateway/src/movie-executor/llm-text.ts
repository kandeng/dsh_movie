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
import { admitEncodedImages, type AttachmentStore, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
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
  /**
   * Phase-2 vision: the attachment store linked image bytes are admitted into
   * (durable ImageBlocks for the user message). Omitted = linked images degrade
   * to an honest prompt note instead of failing the turn.
   */
  attachments?: AttachmentStore | undefined
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

/**
 * The stable session id for a per-model executor text agent (Phase-1 model
 * selector). A node that pins a specific model id gets its OWN durable session
 * so its turns never share a log with the default-model agent, and the session
 * still outlives a plugin reload / host restart (reused/resumed by that id).
 * @param model - the pinned model id (non-empty).
 * @returns the branded session id for that model.
 */
function executorModelSession(model: string): SessionId {
  return brandString<SessionId>(`movie-executor-text:${model}`)
}

/** Coerce one value to a display string. */
function display(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/** Ordered http(s) image URLs linked into a text generator's `image` slot. */
function imageURLs(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((entry): string => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((url): boolean => url.startsWith('http://') || url.startsWith('https://'))
}

/** Hard cap of image blocks per turn (well inside the SDK per-message budget). */
const MAX_TURN_IMAGES = 4

/** The raster media types the version-one attachment path admits. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Phase-2 vision: fetch each linked image and admit its bytes into the
 * attachment store, yielding durable ImageBlocks for the user message. A
 * failed fetch/admit is logged and skipped so the turn still runs text-only.
 * @param attachments - the store owning batch admission policy.
 * @param urls - resolved upstream image URLs, in link order.
 * @param logger - diagnostics sink.
 * @returns the admitted image blocks, in url order.
 */
async function admitImageBlocks(attachments: AttachmentStore, urls: string[], logger: LlmTextLogger): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = []
  for (const url of urls.slice(0, MAX_TURN_IMAGES)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        logger.warn('[movie-executor] image fetch %s -> %s', url, String(response.status))
        continue
      }
      // The attachment path admits exactly four raster types; anything else
      // (svg, html error page, ...) is skipped honestly rather than coerced.
      const headerType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
      const mediaType = IMAGE_MEDIA_TYPES.find((entry): boolean => entry === headerType)
      if (mediaType === undefined) {
        logger.warn('[movie-executor] image %s has unsupported media type %s', url, headerType === '' ? '(none)' : headerType)
        continue
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      const ref = (await admitEncodedImages(attachments, [{ data: bytes.toString('base64'), mediaType }]))[0]
      if (ref !== undefined) blocks.push({ type: 'image', attachment: ref })
    } catch (error) {
      logger.warn('[movie-executor] image admit failed for %s: %s', url, error instanceof Error ? error.message : String(error))
    }
  }
  return blocks
}

/** The resolved upstream text sections the adapter folded into `inputs.resolved`. */
function resolvedSections(inputs: Record<string, unknown>): string[] {
  const resolved = inputs['resolved']
  if (!Array.isArray(resolved)) return []
  return resolved.map((entry): string => display(entry)).filter((entry): boolean => entry !== '')
}

/**
 * Compose the instruction prompt for one text-generator node.
 *
 * This is the SINGLE seam both the legacy `MovieScript`/`MovieShotPlan` steps
 * (via `deps.stepText`) and the functional `TextGenerator` adapter (via
 * `ctx.text`) route through, so folding the Phase-7 D12 `inputs.skills` section
 * here makes the two consume an imported skill identically. Exported so the
 * download verifier can assert that identity deterministically (key-free).
 * @param classType - the node class (named in the header).
 * @param inputs - the node's resolved inputs (`prompt`, `resolved`, `skills`).
 * @returns the composed prompt.
 */
export function buildTextPrompt(classType: string, inputs: Record<string, unknown>): string {
  const instruction = display(inputs['prompt'])
  const sections = resolvedSections(inputs)
  // The composed, framed `## Craft skills` section (already bounded and wrapped
  // as quoted untrusted material by `skill-import.composeSkillSection`); appended
  // verbatim so the frame the model is given is exactly the one the bridge built.
  const skills = display(inputs['skills'])
  const lines: string[] = [
    `You are the dsh_movie "${classType}" text generator.`,
    'Write the text described below. Reply with ONLY the text — no prose, no markdown fences, no tool calls.',
    '',
  ]
  if (instruction !== '') lines.push(`INSTRUCTION: ${instruction}`, '')
  if (sections.length > 0) lines.push('CONTEXT (linked upstream sections, in order):', ...sections, '')
  if (skills !== '') lines.push(skills, '')
  if (instruction === '' && sections.length === 0 && skills === '') lines.push('No instruction or context was supplied; produce a short, sensible default for this node.', '')
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
 * Compose the D7 intent-router prompt: a CHEAP classification turn that decides
 * whether one room utterance asks to edit the canvas graph, and if so distills it
 * into a single imperative intent the canvas planner can act on. Ordinary content
 * discussion (story talk, feedback, questions) must classify as `NONE` so it never
 * triggers ops (design doc D7/R5).
 * @param utterance - the inbound human message body.
 * @returns the router instruction prompt.
 */
function buildIntentRouterPrompt(utterance: string): string {
  return [
    'You are the dsh_movie canvas intent router.',
    'Decide whether the user message asks to EDIT the movie canvas GRAPH.',
    '',
    'A graph edit means: add/remove a node, connect or reconnect nodes (edges),',
    'change a node widget/parameter value, rename a node title, move a node,',
    'or create/collapse a group box.',
    'Ordinary content discussion (the story, creative feedback, questions, chat) is NOT a graph edit.',
    '',
    'Reply with EXACTLY one line and nothing else:',
    '- if it is NOT a graph-edit request, reply: NONE',
    '- if it IS a graph-edit request, reply with one concise imperative instruction',
    '  describing the edit, e.g. "Add an ImageGenerator and connect the script node output to it".',
    '',
    'MESSAGE:',
    utterance,
  ].join('\n')
}

/**
 * Parse the intent-router reply into a distilled intent, or `null` when the
 * utterance was classified as ordinary content (`NONE`/empty).
 * @param reply - the raw router model output.
 * @returns the one-line intent, or `null` when no graph edit was requested.
 */
function parseIntentRouterReply(reply: string): string | null {
  const firstLine = reply.split('\n').map((line): string => line.trim()).find((line): boolean => line !== '') ?? ''
  if (firstLine === '') return null
  if (firstLine.toUpperCase().startsWith('NONE')) return null
  return firstLine
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
  /** Per-model agent cache keyed by model id ('' = the default-model agent). */
  private readonly agents = new Map<string, Agent>()
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
    // Phase-1 model selector: a node's `model` widget (forwarded through the
    // adapter's resolved inputs) pins the LLM route for THIS turn. Empty = the
    // executor's default-model agent (unchanged behavior).
    const model = display(inputs['model']).trim()
    // Phase-2 vision: linked IMAGE refs (ordered array from the adapter) become
    // image blocks beside the prompt; a vision model route (e.g. qwen-vl-max,
    // pinned via the Phase-1 selector) then reads them.
    const urls = imageURLs(inputs['image'])
    return this.enqueue(async (): Promise<string> => {
      let prompt = buildTextPrompt(classType, inputs)
      let images: ImageBlock[] = []
      if (urls.length > 0) {
        const attachments = this.deps.attachments
        if (attachments === undefined) {
          prompt += `\n\n(NOTE: ${urls.length} linked image(s) are NOT attached — no attachment store is mounted; answer from the text alone.)`
        } else {
          images = await admitImageBlocks(attachments, urls, this.deps.logger)
          prompt += images.length > 0
            ? `\n\n(The ${images.length} attached image(s) accompany this message; use their content as the task requires.)`
            : `\n\n(NOTE: ${urls.length} linked image(s) failed to load; answer from the text alone.)`
        }
      }
      return this.runTurn(prompt, `text:${classType}`, model, images)
    })
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

  /**
   * D7 intent router: decide whether one room utterance asks to edit the canvas
   * graph, and if so distill it into a single imperative intent for the planner.
   * Ordinary content discussion resolves to `null` (no ops). A model failure or
   * an empty turn also resolves to `null` so mining never throws into the chat
   * relay path.
   * @param utterance - the inbound human message body.
   * @returns the distilled graph-edit intent, or `null` when none was requested.
   */
  mineIntent(utterance: string): Promise<string | null> {
    return this.enqueue(async (): Promise<string | null> => {
      try {
        const reply = await this.runTurn(buildIntentRouterPrompt(utterance), 'intent-router')
        return parseIntentRouterReply(reply)
      } catch {
        return null
      }
    })
  }

  /** Serialize one turn behind the prior turn so concurrent runs never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue
    const run = previous.then(task, task)
    this.queue = run.then((): void => undefined, (): void => undefined)
    return run
  }

  /** Get the executor agent for one model id, reusing/resuming/creating its stable
   *  session. `model === ''` selects the shared default-model agent. */
  private async ensureAgent(model = ''): Promise<Agent> {
    const cached = this.agents.get(model)
    if (cached !== undefined) return cached
    const sessionId = model === '' ? executorSession() : executorModelSession(model)
    const selection = this.deps.agentDefaultModel.currentSelection()
    // A pinned model overrides just the route's model id; the provider + any
    // reasoning effort come from the default selection (same Bailian provider).
    const agentOptions: AgentOptions = model === '' ? { ...selection } : { ...selection, model }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx)
    }
    // The executor session id is a STABLE constant, so the session outlives a
    // plugin reload / host restart. Reuse a live agent when one is already
    // registered under the id; otherwise create it; and when creation reports
    // the session already exists (a persisted log survived), resume it. Without
    // this the second and later lifecycles throw `session "…" already exists`
    // and every text/review/intent turn fails.
    const live = this.deps.agents.get(sessionId)
    if (live !== undefined) {
      this.agents.set(model, live)
      return live
    }
    let agent: Agent
    try {
      agent = (await this.deps.agents.create({
        sessionId,
        meta: { cwd: this.deps.cwd },
        agentOptions,
        setup,
      })).agent
    } catch (error) {
      this.deps.logger.warn(
        '[movie-executor] create on %s failed (%s); resuming the persisted session',
        sessionId,
        error instanceof Error ? error.message : String(error),
      )
      agent = (await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })).agent
    }
    await agent.whenIdle()
    this.agents.set(model, agent)
    this.deps.logger.info('[movie-executor] text agent opened (model: %s)', model === '' ? 'default' : model)
    return agent
  }

  /** Drive one turn to quiescence and return its final assistant text. */
  private async runTurn(prompt: string, label: string, model = '', images: readonly ImageBlock[] = []): Promise<string> {
    if (this.closed) throw new Error('executor text agent disposed')
    const agent = await this.ensureAgent(model)
    const firstSeq = Number(agent.session.seq)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }, ...images],
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

  /** Drop the live agents and reject further work (plugin disposal). */
  dispose(): void {
    this.closed = true
    this.agents.clear()
    this.queue = Promise.resolve()
  }
}
