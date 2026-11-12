/**
 * Real-LLM intent-to-op-script generator (Phase-3 P3-M3, design doc §5).
 *
 * Turns a natural-language canvas intent into a validated {@link CanvasScript}
 * using the DSH agent runtime (Bailian `qwen3.8-max` via `ctx.agents` +
 * `ctx.agentDefaultModel`), mirroring the per-room serialized driver in
 * `dsh-matrix-chat/src/agent-inbox.ts`. The model is prompted to emit ONLY a
 * strict JSON array over the constrained op catalog (never arbitrary JS); the
 * reply is parsed, validated by `op-script-validator.ts`, and wrapped in a fresh
 * `txnId`.
 *
 * This is the minimal "intent -> ops" slice of P3-M4 pulled into M3 to satisfy
 * the real-LLM fidelity choice. The intelligent observe/re-plan supervision loop
 * and the six director/step pipeline teams remain deferred to P3-M4.
 *
 * @module dsh-movie-gateway/canvas-agent
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
// Empty type-only imports pull the Context service-key merges used below.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import {
  CANVAS_OP_TYPES,
  MOVIE_NODES,
  type CanvasScript,
  type MatrixRoomId,
  type WorkflowGraph,
} from '@dsh-movie/protocol'
import { validateOps } from './op-script-validator.ts'

/** Minimal logger (matches `ctx.logger`). */
export interface CanvasAgentLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The host services the generator drives; injected once at plugin activation. */
export interface CanvasScriptAgentDeps {
  /** Core Agent registry (`ctx.agents`). */
  agents: Context['agents']
  /** Default model selection (`ctx.agentDefaultModel`). */
  agentDefaultModel: Context['agentDefaultModel']
  /** Session store, used to flush a turn's durable log (`ctx.sessions`). */
  sessions: Context['sessions']
  /** Optional subagent tree settlement (`ctx.subagents`). */
  subagents?: Context['subagents'] | undefined
  /** Working directory the per-room agents run in. */
  cwd: string
  /** Diagnostics sink. */
  logger: CanvasAgentLogger
}

/** Why a generation attempt failed (surfaced to the client for a clear message). */
export type CanvasGenerateCode = 'llm-unavailable' | 'bad-json' | 'bad-ops'

/** The result of one intent-to-script generation. */
export type CanvasGenerateResult =
  | { ok: true; script: CanvasScript }
  | { ok: false; code: CanvasGenerateCode; message: string }

/** Derive a stable, filesystem-safe session id for a room's canvas planner. */
function sessionForRoom(roomId: MatrixRoomId): SessionId {
  const digest = createHash('sha1').update(`canvas-${roomId}`).digest('hex').slice(0, 32)
  return brandString<SessionId>(`canvas-script-${digest}`)
}

/** A compact, bounded text description of the op catalog for the prompt. */
function opCatalogText(): string {
  return [
    'Emit a JSON array. Each element is exactly {"op": <name>, "payload": {...}}.',
    `Allowed op names: ${CANVAS_OP_TYPES.join(', ')}.`,
    '- node.add    payload {"nodeType": string, "pos": [x, y], "id"?: number, "props"?: {widgetName: value}}',
    '- node.remove payload {"id": number}',
    '- node.move   payload {"id": number, "x": number, "y": number}',
    '- node.setWidget payload {"id": number, "key": string, "value": any}',
    '- node.setStatus payload {"id": number, "status": "idle"|"queued"|"running"|"progress"|"success"|"error"}',
    '- edge.add    payload {"fromId": number, "fromSlot": number, "toId": number, "toSlot": number} (slots are 0-based indices)',
    '- edge.remove payload {"id": number}',
    '- group.collapse payload {"title": string, "collapsed": boolean}',
    '- view.fit    payload {"ids"?: number[]}',
  ].join('\n')
}

/** A compact description of the movie node types + their slots/widgets. */
function nodeCatalogText(): string {
  return MOVIE_NODES.map((node) => {
    const inputs = node.inputs.map((slot): string => `${slot.name}:${slot.type}`).join(', ') || 'none'
    const outputs = node.outputs.map((slot): string => `${slot.name}:${slot.type}`).join(', ') || 'none'
    const widgets = node.widgets.map((widget): string => `${widget.name}:${widget.type}`).join(', ') || 'none'
    return `- ${node.classType} (step ${node.step}) inputs[${inputs}] outputs[${outputs}] widgets[${widgets}]`
  }).join('\n')
}

/** Project a workflow graph to a small, bounded context blob for the prompt. */
function graphContextText(graph: WorkflowGraph | null | undefined): string {
  if (graph === null || graph === undefined) return 'The canvas is empty.'
  const nodes = (graph.nodes ?? []).map((node): string => {
    const widgets = Array.isArray(node.widgets_values) ? JSON.stringify(node.widgets_values) : '[]'
    return `  {id:${node.id}, type:"${node.type}"${node.title !== undefined ? `, title:"${node.title}"` : ''}, widgets:${widgets}}`
  })
  const links = (graph.links ?? []).map((link): string => `  [${link.join(', ')}]`)
  return [
    'Current graph nodes:',
    nodes.length > 0 ? nodes.join('\n') : '  (none)',
    'Current graph links [linkId, fromNode, fromSlot, toNode, toSlot]:',
    links.length > 0 ? links.join('\n') : '  (none)',
  ].join('\n')
}

/** Compose the single-shot planner prompt for one intent. */
function buildPrompt(intent: string, graph: WorkflowGraph | null | undefined): string {
  return [
    'You are the dsh_movie canvas planner. Convert the user intent into a minimal,',
    'ordered array of canvas operations that edit the workflow graph.',
    '',
    'MOVIE NODE TYPES:',
    nodeCatalogText(),
    '',
    'OP CATALOG:',
    opCatalogText(),
    '',
    'CURRENT GRAPH:',
    graphContextText(graph),
    '',
    'RULES:',
    '1. Reuse existing node ids from the current graph; do not recreate nodes that already exist.',
    '2. Connect an upstream node output slot to a downstream node input slot with edge.add, matching artifact types (e.g. SCRIPT -> SCRIPT). Slot indices are 0-based.',
    '3. For node.add, omit "id" to let the client allocate one; set "pos" to lay nodes left-to-right by step (x ~ step*260, y ~ 80).',
    '4. Emit only the ops the intent actually requires. Prefer the fewest ops.',
    '5. Reply with ONLY the raw JSON array. No prose, no markdown fences, no tool calls, no explanations.',
    '',
    `USER INTENT: ${intent}`,
  ].join('\n')
}

/**
 * Extract the first JSON array from a model reply, tolerating code fences and
 * surrounding prose.
 * @param text - the raw assistant text.
 * @returns the parsed array value.
 * @throws when no bracketed array is present or it is not valid JSON.
 */
function extractOpsArray(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON array found in model output')
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown
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
    // oxlint-disable-next-line typescript/no-deprecated -- mirrors the headless driver's durable-log read.
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

/** Per-room serialized canvas-op-script generator. */
export class CanvasScriptAgent {
  private readonly agentsByRoom = new Map<MatrixRoomId, Agent>()
  private readonly queues = new Map<MatrixRoomId, Promise<void>>()
  private readonly deps: CanvasScriptAgentDeps
  private closed = false

  /**
   * @param deps - the injected agent runtime services.
   */
  constructor(deps: CanvasScriptAgentDeps) {
    this.deps = deps
  }

  /** Number of rooms with a live canvas-planner agent. */
  get roomCount(): number {
    return this.agentsByRoom.size
  }

  /**
   * Generate a validated op-script for one intent, serialized behind the room's
   * prior turn so concurrent requests for a room never interleave.
   * @param roomId - the room whose canvas is being edited.
   * @param intent - the natural-language canvas instruction.
   * @param graph - the room's current persisted graph (context for the model).
   * @returns the generated script, or a typed failure.
   */
  generate(roomId: MatrixRoomId, intent: string, graph: WorkflowGraph | null): Promise<CanvasGenerateResult> {
    const previous = this.queues.get(roomId) ?? Promise.resolve()
    const turn = previous.then(() => this.runTurn(roomId, intent, graph), () => this.runTurn(roomId, intent, graph))
    // The queue tracks completion only; the caller receives the turn's result.
    this.queues.set(roomId, turn.then(() => undefined, () => undefined))
    return turn
  }

  /** Get the room's live planner agent, creating its session on first use. */
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
    this.deps.logger.info('[movie-gateway] canvas planner opened for room %s', roomId)
    return agent
  }

  /** Drive one planner turn to quiescence and parse/validate its JSON output. */
  private async runTurn(roomId: MatrixRoomId, intent: string, graph: WorkflowGraph | null): Promise<CanvasGenerateResult> {
    if (this.closed) return { ok: false, code: 'llm-unavailable', message: 'canvas planner disposed' }
    let text: string
    try {
      const agent = await this.ensureAgent(roomId)
      const firstSeq = Number(agent.session.seq)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildPrompt(intent, graph) }],
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
      text = finalAssistantText(agent.session, firstSeq)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn('[movie-gateway] canvas planner turn failed in %s: %s', roomId, message)
      return { ok: false, code: 'llm-unavailable', message }
    }

    let raw: unknown
    try {
      raw = extractOpsArray(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'bad-json', message: `${message}; raw: ${text.slice(0, 200)}` }
    }

    const validation = validateOps(raw)
    if (!validation.ok) return { ok: false, code: 'bad-ops', message: validation.message }
    return { ok: true, script: { txnId: randomUUID(), ops: validation.ops } }
  }

  /** Drop all live agents and reject further work (plugin disposal). */
  dispose(): void {
    this.closed = true
    this.agentsByRoom.clear()
    this.queues.clear()
  }
}
