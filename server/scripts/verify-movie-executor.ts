/**
 * Leg B movie-executor verifier (Phase-3 P3-M4, design doc §6).
 *
 * Two layers:
 *
 *  1. OFFLINE / deterministic (no network, no LLM): the executor registry,
 *     prompt validator, and topological sort that back the rewired
 *     `POST /prompt`:
 *     - `registry` advertises all six {@link MOVIE_NODES} class types;
 *     - `validatePromptGraph` accepts the demo graph, rejects an unknown
 *       `class_type`, a link to a missing node, and an out-of-range slot;
 *     - `topoSort` orders a linked chain 1->6 regardless of insertion order and
 *       detects a cycle.
 *
 *  2. LIVE gateway (movie-profile host up: gateway 8788): `POST /prompt`
 *     validates first (400 + `node_errors` on a bad class_type / bad link) and,
 *     when accepted, is scheduled as a `movie-exec` job that drives the `/ws`
 *     execution lifecycle across all six node ids in topological order
 *     (executing -> progress -> executed -> execution_success).
 *
 * Run from the `server/` directory:
 *   node scripts/verify-movie-executor.ts
 */

import {
  MOVIE_NODES,
  isExecMessage,
  type ExecMessage,
  type PromptGraph,
} from '../../protocol/src/index.ts'
import { classTypeOutputs, isKnownClassType, objectInfoFromMovieNodes } from '../plugins/dsh-movie-gateway/src/movie-executor/registry.ts'
import { validatePromptGraph } from '../plugins/dsh-movie-gateway/src/movie-executor/validate.ts'
import { topoSort } from '../plugins/dsh-movie-gateway/src/movie-executor/topo.ts'

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
const wsBase = gatewayUrl.replace(/^http/, 'ws')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** The six movie class types in pipeline (step) order. */
const ORDERED_CLASS_TYPES: string[] = [...MOVIE_NODES]
  .sort((a, b): number => a.step - b.step)
  .map((node): string => node.classType)

/** The flattened six-node demo prompt (keys "1".."6", no links). */
function demoPrompt(): PromptGraph {
  const graph: PromptGraph = {}
  ORDERED_CLASS_TYPES.forEach((classType, index) => {
    graph[String(index + 1)] = { class_type: classType, inputs: {} }
  })
  return graph
}

/**
 * A linked chain "1"->"2"->...->"6" inserted in REVERSE order, so a correct
 * topological sort must still yield 1..6 (proving it sorts, not just iterates).
 */
function chainPrompt(): PromptGraph {
  const graph: PromptGraph = {}
  for (let index = ORDERED_CLASS_TYPES.length - 1; index >= 0; index--) {
    const id = String(index + 1)
    const classType = ORDERED_CLASS_TYPES[index] as string
    graph[id] = index === 0
      ? { class_type: classType, inputs: {} }
      : { class_type: classType, inputs: { upstream: [String(index), 0] } }
  }
  return graph
}

/** Run the offline registry / validate / topo checks. */
function offlineChecks(): void {
  process.stdout.write('\n— offline: executor registry + validation + topo-sort —\n')

  const catalog = objectInfoFromMovieNodes()
  const missing = ORDERED_CLASS_TYPES.filter((classType): boolean => !(classType in catalog))
  check('registry advertises all six movie class types', missing.length === 0, missing.length === 0 ? ORDERED_CLASS_TYPES.join(', ') : `missing: ${missing.join(', ')}`)
  check('registry knows every movie class type', ORDERED_CLASS_TYPES.every((classType): boolean => isKnownClassType(classType)))
  check('registry rejects an unknown class type', !isKnownClassType('MovieBogus'))
  const scriptOutputs = classTypeOutputs('MovieScript')
  check('registry exposes MovieScript output slots', scriptOutputs !== undefined && scriptOutputs.length > 0, `${scriptOutputs?.length ?? 0} outputs`)

  // Validation: the demo graph is accepted verbatim.
  check('validate accepts the six-node demo graph', validatePromptGraph(demoPrompt()).ok)

  // Validation: an unknown class_type is rejected with a node error.
  const unknownClass = validatePromptGraph({ '1': { class_type: 'MovieBogus', inputs: {} } })
  check(
    'validate rejects an unknown class_type',
    !unknownClass.ok && unknownClass.nodeErrors['1']?.errors.some((e): boolean => e.includes('unknown class_type')) === true,
    unknownClass.ok ? 'accepted' : JSON.stringify(unknownClass.nodeErrors['1']?.errors ?? []),
  )

  // Validation: a link to a missing node is rejected.
  const missingNode = validatePromptGraph({
    '1': { class_type: 'MovieScript', inputs: {} },
    '2': { class_type: 'MovieShotPlan', inputs: { upstream: ['999', 0] } },
  })
  check(
    'validate rejects a link to a missing node',
    !missingNode.ok && missingNode.nodeErrors['2']?.errors.some((e): boolean => e.includes('missing node')) === true,
    missingNode.ok ? 'accepted' : JSON.stringify(missingNode.nodeErrors['2']?.errors ?? []),
  )

  // Validation: an out-of-range source slot is rejected.
  const badSlot = validatePromptGraph({
    '1': { class_type: 'MovieScript', inputs: {} },
    '2': { class_type: 'MovieShotPlan', inputs: { upstream: ['1', 99] } },
  })
  check(
    'validate rejects an out-of-range link slot',
    !badSlot.ok && badSlot.nodeErrors['2']?.errors.some((e): boolean => e.includes('out-of-range slot')) === true,
    badSlot.ok ? 'accepted' : JSON.stringify(badSlot.nodeErrors['2']?.errors ?? []),
  )

  // Topo: the reverse-inserted chain still sorts to 1..6.
  const chain = topoSort(chainPrompt())
  const expectedOrder = ['1', '2', '3', '4', '5', '6']
  check(
    'topoSort orders a linked chain 1->6 regardless of insertion order',
    chain.ok && chain.order.join(',') === expectedOrder.join(','),
    chain.ok ? chain.order.join(' -> ') : `cycle: ${chain.cycle.join(', ')}`,
  )

  // Topo: a two-node cycle is detected.
  const cyclic = topoSort({
    '1': { class_type: 'MovieScript', inputs: { a: ['2', 0] } },
    '2': { class_type: 'MovieShotPlan', inputs: { b: ['1', 0] } },
  })
  check('topoSort detects a cycle', !cyclic.ok && cyclic.cycle.length === 2, cyclic.ok ? 'ordered' : `cycle: ${cyclic.cycle.join(', ')}`)
}

/** Collect the Leg B lifecycle over `/ws` for one submitted `/prompt`. */
function collectLifecycle(prompt: PromptGraph): Promise<ExecMessage[]> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/ws`)
    const messages: ExecMessage[] = []
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('Leg B lifecycle timed out'))
    }, 15_000)
    socket.addEventListener('open', () => {
      void (async () => {
        await fetch(`${gatewayUrl}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
      })().catch((error: unknown): void => rejectCollect(error instanceof Error ? error : new Error(String(error))))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (!isExecMessage(parsed)) return
      messages.push(parsed)
      if (parsed.type === 'execution_success') {
        clearTimeout(timer)
        socket.close()
        resolveCollect(messages)
      }
    })
    socket.addEventListener('error', () => { /* the timeout guards a hard failure */ })
  })
}

/** A Leg B `POST /prompt` response: status + parsed body. */
interface PromptPost {
  status: number
  body: { error?: string; node_errors?: unknown; prompt_id?: string; number?: number }
}

/** Submit a prompt graph to `POST /prompt` and return the status + body. */
async function postPrompt(prompt: PromptGraph): Promise<PromptPost> {
  const resp = await fetch(`${gatewayUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  return { status: resp.status, body: (await resp.json()) as PromptPost['body'] }
}

async function liveChecks(): Promise<void> {
  process.stdout.write('\n— live: POST /prompt validation + job lifecycle over /ws —\n')

  const health = await fetch(`${gatewayUrl}/health`)
  check('gateway /health answers ok', health.ok && ((await health.json()) as { ok?: boolean }).ok === true)

  // A bad class_type is rejected 400 with node_errors before scheduling.
  const badClass = await postPrompt({ '1': { class_type: 'MovieBogus', inputs: {} } })
  check(
    'POST /prompt rejects an unknown class_type with 400 node_errors',
    badClass.status === 400 && badClass.body.error === 'invalid_prompt' && badClass.body.node_errors !== undefined,
    `status ${badClass.status} ${badClass.body.error ?? ''}`,
  )

  // A bad link slot is rejected 400 with node_errors.
  const badLink = await postPrompt({
    '1': { class_type: 'MovieScript', inputs: {} },
    '2': { class_type: 'MovieShotPlan', inputs: { upstream: ['1', 99] } },
  })
  check(
    'POST /prompt rejects an out-of-range link with 400 node_errors',
    badLink.status === 400 && badLink.body.error === 'invalid_prompt' && badLink.body.node_errors !== undefined,
    `status ${badLink.status} ${badLink.body.error ?? ''}`,
  )

  // A cyclic graph is rejected 400 (cycle detected in topo-sort).
  const cyclic = await postPrompt({
    '1': { class_type: 'MovieScript', inputs: { a: ['2', 0] } },
    '2': { class_type: 'MovieShotPlan', inputs: { b: ['1', 0] } },
  })
  check(
    'POST /prompt rejects a cyclic graph with 400',
    cyclic.status === 400 && cyclic.body.error === 'invalid_prompt',
    `status ${cyclic.status} ${cyclic.body.error ?? ''}`,
  )

  // The accepted demo prompt drives the lifecycle across all six nodes in order.
  try {
    const messages = await collectLifecycle(demoPrompt())
    const executingOrder = messages
      .filter((message): boolean => message.type === 'executing')
      .map((message): string | null => (message.type === 'executing' ? message.data.node : null))
      .filter((node): node is string => typeof node === 'string')
    const covered = ['1', '2', '3', '4', '5', '6'].every((id): boolean => executingOrder.includes(id))
    const inOrder = executingOrder.join(',') === '1,2,3,4,5,6'
    check(
      'POST /prompt drives the /ws lifecycle across all six nodes',
      covered && messages.some((message): boolean => message.type === 'execution_success'),
      `executing: ${executingOrder.join(' -> ') || 'none'}`,
    )
    check('the lifecycle executes the six nodes in topological order', inOrder, executingOrder.join(' -> '))
    const executedCount = messages.filter((message): boolean => message.type === 'executed').length
    check('every node emits an executed result', executedCount === 6, `${executedCount}/6`)
  } catch (error) {
    check('Leg B /ws lifecycle completed', false, String(error))
  }
}

async function main(): Promise<void> {
  offlineChecks()
  await liveChecks()
  process.stdout.write(failures === 0 ? '\nALL MOVIE-EXECUTOR CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
