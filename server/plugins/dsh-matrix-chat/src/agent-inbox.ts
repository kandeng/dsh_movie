/**
 * Per-room serialized DSH agent inbox.
 *
 * Each Matrix room maps to one long-lived DSH Agent (a stable `SessionId`
 * derived from the room id), so a room's conversation keeps its history across
 * messages. Turns within a room are serialized through a promise chain — a
 * second human message never interleaves with an in-flight agent turn — while
 * distinct rooms run concurrently.
 *
 * The run loop mirrors the canonical one-shot driver in
 * `@deepseek-ai/dsh-headless`: submit a user message with `agent.followup`,
 * await quiescence (`whenIdle` plus subagent tree settlement), flush the
 * session, then read the final assistant text off the durable session log.
 *
 * @module dsh-matrix-chat/agent-inbox
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
// Empty type-only imports pull the Context service-key merges used below.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import type { MatrixRoomId } from './types.ts'

/** Minimal logger the inbox writes diagnostics to (matches `ctx.logger`). */
export interface InboxLogger {
  /** Log an informational line. */
  info(message: string, ...args: unknown[]): void
  /** Log a warning line. */
  warn(message: string, ...args: unknown[]): void
}

/** The host services the inbox drives; injected once at plugin activation. */
export interface AgentInboxDeps {
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
  logger: InboxLogger
}

/** Derive a stable, filesystem-safe session id from a room id. */
function sessionForRoom(roomId: MatrixRoomId): SessionId {
  const digest = createHash('sha1').update(roomId).digest('hex').slice(0, 32)
  return brandString<SessionId>(`matrix-room-${digest}`)
}

/**
 * Read the final assistant text produced since `firstSeq` on a session log.
 * Only the last `assistant/message` after the most recent `turn/start` counts,
 * so an intermediate turn's text never shadows the final answer.
 * @param session - the agent's durable session.
 * @param firstSeq - the log offset captured before the turn was submitted.
 * @returns the aggregated final assistant text (possibly empty).
 */
function summarize(session: Session, firstSeq: number): string {
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
        const joined = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
        if (joined !== '') text = joined
      }
    }
  }
  return text
}

/** Serialized per-room agent runner. */
export class AgentInbox {
  private readonly agentsByRoom = new Map<MatrixRoomId, Agent>()
  private readonly queues = new Map<MatrixRoomId, Promise<void>>()
  private readonly deps: AgentInboxDeps
  private closed = false

  constructor(deps: AgentInboxDeps) {
    this.deps = deps
  }

  /** Number of rooms with a live agent. */
  get roomCount(): number {
    return this.agentsByRoom.size
  }

  /**
   * Submit one human message to a room's agent, serialized behind that room's
   * prior turn. Distinct rooms are independent; the same room never overlaps.
   * @param roomId - the room the message arrived in.
   * @param text - the human message body.
   * @returns the agent's final assistant text (empty when it produced none).
   */
  run(roomId: MatrixRoomId, text: string): Promise<string> {
    const previous = this.queues.get(roomId) ?? Promise.resolve()
    // Chain regardless of the prior outcome so one failed turn never wedges the room.
    const turn = previous.then(() => this.runTurn(roomId, text), () => this.runTurn(roomId, text))
    this.queues.set(roomId, turn.then(() => undefined, () => undefined))
    return turn
  }

  /** Get the room's live agent, creating its session on first use. */
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
    // Settle any creation-time work before the first user turn is submitted.
    await agent.whenIdle()
    this.agentsByRoom.set(roomId, agent)
    this.deps.logger.info('[matrix-chat] agent inbox opened for room %s', roomId)
    return agent
  }

  /** Drive one turn to quiescence and return the final assistant text. */
  private async runTurn(roomId: MatrixRoomId, text: string): Promise<string> {
    if (this.closed) return ''
    const agent = await this.ensureAgent(roomId)
    const firstSeq = Number(agent.session.seq)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    const subagents = this.deps.subagents
    for (;;) {
      await agent.whenIdle()
      const idleSeq = Number(agent.session.seq)
      // Child settlement can wake the parent before the child wait observes it,
      // so require both an idle status and an unchanged log offset to stop.
      const treeBusy = subagents === undefined ? false : await subagents.waitForChildren(agent)
      if (!treeBusy && agent.status === 'idle' && Number(agent.session.seq) === idleSeq) break
    }
    await this.deps.sessions.flush(agent.session)
    return summarize(agent.session, firstSeq)
  }

  /** Drop all live agents and reject further work (plugin disposal). */
  dispose(): void {
    this.closed = true
    this.agentsByRoom.clear()
    this.queues.clear()
  }
}
