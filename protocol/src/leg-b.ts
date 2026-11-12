/**
 * Leg B contract: the ComfyUI-compatible graph interchange and execution
 * lifecycle envelope.
 *
 * Leg B carries two things a live workflow canvas needs:
 *  1. Graph interchange - a ComfyUI-style "workflow" JSON (nodes/links/widget
 *     values) for the editor, plus the flattened "prompt" graph (node id ->
 *     class_type + inputs) submitted for execution.
 *  2. Execution lifecycle - the WebSocket message envelope ComfyUI emits while
 *     a prompt runs (`status`, `executing`, `progress`, `executed`, `preview`,
 *     and the queued/error/interrupted variants).
 *
 * The DSH host implements this protocol subset itself (frontend-only ComfyUI;
 * no Python server). The shapes below are the single source of truth shared by
 * the host's Leg B executor and the browser SDK's Leg B client.
 *
 * @module @dsh-movie/protocol/leg-b
 */

/* -------------------------------------------------------------------------- */
/* Graph interchange: editor "workflow" format                                 */
/* -------------------------------------------------------------------------- */

/** A node input/output slot in the editor workflow graph. */
export interface WorkflowSlot {
  /** Slot name. */
  name?: string
  /** Slot value type, e.g. `IMAGE`, `STRING`, `*`. */
  type?: string
  /**
   * Id of the link connected to this slot, or `null` when unconnected. Input
   * slots carry a single `link`; output slots additionally carry `links`.
   */
  link: number | null
  /**
   * Output slots only: the list of link ids connected to this output (a node
   * output may fan out to several inputs), or `null`/empty when unconnected.
   * Matches the serialized LiteGraph shape the pinned frontend expects.
   */
  links?: number[] | null
  /** Output slots only: the slot index hint LiteGraph stores when serializing. */
  slot_index?: number
}

/** A single node in the editor workflow graph. */
export interface WorkflowNode {
  /** Node id (unique within the graph). */
  id: number
  /** Registered node type / class name. */
  type: string
  /** Canvas position `[x, y]`. */
  pos: [number, number]
  /** Canvas size `[width, height]`. */
  size: [number, number]
  /** LiteGraph node flags bitmask. */
  flags: number
  /** Execution order hint. */
  order: number
  /** LiteGraph mode (0 = normal, 2 = muted, 4 = bypassed). */
  mode: number
  /** Input slots. */
  inputs?: WorkflowSlot[]
  /** Output slots. */
  outputs?: WorkflowSlot[]
  /** Node title shown on the canvas. */
  title?: string
  /** Arbitrary node properties. */
  properties?: Record<string, unknown>
  /** Serialized widget values, positionally matched to the node's widgets. */
  widgets_values?: unknown[]
}

/**
 * A ComfyUI link tuple as stored in `WorkflowGraph.links`:
 * `[linkId, fromNodeId, fromSlot, toNodeId, toSlot]` (older builds append a
 * type string). Kept as a loose tuple to tolerate both shapes.
 */
export type WorkflowLinkTuple = [number, number, number | string, number, number | string, ...unknown[]]

/** A visual grouping box on the canvas (e.g. one of the six movie steps). */
export interface WorkflowGroup {
  /** Group title. */
  title: string
  /** Bounding box `[x, y, width, height]`. */
  bounding: [number, number, number, number]
  /** Group color key. */
  color?: string
  /** Whether the group is collapsed. */
  collapsed?: boolean
}

/** The full editor workflow graph (what `loadWorkflow` / `graphEdited` carry). */
export interface WorkflowGraph {
  /** Highest node id allocated so far. */
  last_node_id?: number
  /** Highest link id allocated so far. */
  last_link_id?: number
  /** All nodes. */
  nodes: WorkflowNode[]
  /** All links as ComfyUI tuples. */
  links?: WorkflowLinkTuple[]
  /** Canvas grouping boxes. */
  groups?: WorkflowGroup[]
  /** Graph-level config. */
  config?: Record<string, unknown>
  /** Extra metadata (frontier version, ds scale, etc.). */
  extra?: Record<string, unknown>
  /** Workflow schema version. */
  version?: number
}

/* -------------------------------------------------------------------------- */
/* Graph interchange: execution "prompt" format                                */
/* -------------------------------------------------------------------------- */

/** A single node in the flattened execution graph. */
export interface PromptGraphNode {
  /** The registered node class to execute. */
  class_type: string
  /** Input values; a link input is `[sourceNodeId, sourceSlotIndex]`. */
  inputs: Record<string, unknown>
  /** Optional display metadata. */
  _meta?: { title?: string }
}

/** The flattened execution graph: node id (string) -> node spec. */
export type PromptGraph = Record<string, PromptGraphNode>

/** Body submitted to `POST /prompt` to enqueue a workflow execution. */
export interface PromptPayload {
  /** The flattened execution graph. */
  prompt: PromptGraph
  /** Client id used to route lifecycle events back over the WS. */
  client_id?: string
  /** Optional front/insert options mirroring ComfyUI. */
  front?: boolean
}

/** Response from `POST /prompt` once a workflow is accepted/queued. */
export interface PromptResponse {
  /** The assigned prompt (execution) id. */
  prompt_id: string
  /** Position in the queue. */
  number: number
  /** Node id -> list of node ids that were already cached, if any. */
  node_errors?: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/* Execution lifecycle: WebSocket envelope                                     */
/* -------------------------------------------------------------------------- */

/** Queue status payload nested inside a `status` message. */
export interface ExecStatusInfo {
  /** How many prompts remain queued. */
  queue_remaining: number
}

/** `status`: server/queue health, sent on connect and on queue changes. */
export interface StatusMessage {
  type: 'status'
  data: { status: { exec_info: ExecStatusInfo } }
}

/** `queued`: a prompt was accepted and enqueued. */
export interface QueuedMessage {
  type: 'queued'
  data: { prompt_id: string; number: number }
}

/** `execution_start`: a prompt began executing. */
export interface ExecutionStartMessage {
  type: 'execution_start'
  data: { prompt_id: string }
}

/** `execution_cached`: nodes whose outputs were reused from cache. */
export interface ExecutionCachedMessage {
  type: 'execution_cached'
  data: { prompt_id: string; nodes: string[] }
}

/** `executing`: the node currently running (`null` node when finished). */
export interface ExecutingMessage {
  type: 'executing'
  data: { prompt_id: string; node: string | null }
}

/** `progress`: incremental progress for the running node. */
export interface ProgressMessage {
  type: 'progress'
  data: { prompt_id: string; node: string; value: number; max: number }
}

/** `executed`: a node finished and produced output. */
export interface ExecutedMessage {
  type: 'executed'
  data: { prompt_id: string; node: string; output: Record<string, unknown> }
}

/** `preview`: a binary/image preview frame for the running node. */
export interface PreviewMessage {
  type: 'preview'
  data: { prompt_id: string; node: string; format: string; bytes: string }
}

/** `execution_success`: the whole prompt completed. */
export interface ExecutionSuccessMessage {
  type: 'execution_success'
  data: { prompt_id: string }
}

/** `execution_error`: a node failed. */
export interface ExecutionErrorMessage {
  type: 'execution_error'
  data: {
    prompt_id: string
    node_id: string
    node_type: string
    exception_type: string
    exception_message: string
    executed: string[]
    current_inputs: Record<string, unknown>
    current_outputs: Record<string, unknown>
  }
}

/** `execution_interrupted`: execution was stopped before completion. */
export interface ExecutionInterruptedMessage {
  type: 'execution_interrupted'
  data: { prompt_id: string; node_id: string; node_type: string }
}

/** The discriminated union of every Leg B lifecycle message. */
export type ExecMessage =
  | StatusMessage
  | QueuedMessage
  | ExecutionStartMessage
  | ExecutionCachedMessage
  | ExecutingMessage
  | ProgressMessage
  | ExecutedMessage
  | PreviewMessage
  | ExecutionSuccessMessage
  | ExecutionErrorMessage
  | ExecutionInterruptedMessage

/** Every Leg B lifecycle message `type` discriminator. */
export type ExecMessageType = ExecMessage['type']

/**
 * Narrow an unknown WS payload to an {@link ExecMessage} by its `type` field.
 * @param value - the parsed WS payload.
 * @returns true when the payload looks like a Leg B lifecycle message.
 */
export function isExecMessage(value: unknown): value is ExecMessage {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && EXEC_MESSAGE_TYPES.includes(type as ExecMessageType)
}

/** The set of valid {@link ExecMessageType} discriminators. */
export const EXEC_MESSAGE_TYPES: readonly ExecMessageType[] = [
  'status',
  'queued',
  'execution_start',
  'execution_cached',
  'executing',
  'progress',
  'executed',
  'preview',
  'execution_success',
  'execution_error',
  'execution_interrupted',
] as const
