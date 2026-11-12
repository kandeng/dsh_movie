/**
 * ComfyUI canvas-bridge conformance verifier (Phase-2 P2-M5).
 *
 * Headless guard for the Option-1 canvas prototype: it exercises the running
 * gateway's `/comfy/*` surface and the versioned postMessage bridge contract,
 * so a pinned frontend build + our bridge extension stay conformant across
 * changes. Live UI behaviour (graph rendering, badge painting, node clicks) is
 * checked separately by the Task-8 browser E2E; this script covers the wire.
 *
 * Asserts:
 *  - static: `GET /comfy/index.html` 200 (frontend fetched), bridge JS served;
 *  - boot subset: `/comfy/api/object_info` carries the six movie step nodes,
 *    `/comfy/api/extensions` lists our bridge, `/comfy/api/system_stats` answers;
 *  - Leg B: `POST /comfy/api/prompt` drives the `/comfy/ws` lifecycle across all
 *    six node ids (executing -> progress -> executed -> execution_success);
 *  - bridge contract: every command/event envelope round-trips through
 *    `isBridgeMessage`, and a bogus payload is rejected.
 *
 * Run from the `server/` directory (movie-profile host up with the gateway on
 * port 8788 and the frontend fetched into `server/static/comfy/`):
 *   node scripts/verify-comfy-bridge.ts
 */

import {
  BRIDGE_MESSAGE_TYPES,
  BRIDGE_VERSION,
  MOVIE_NODES,
  bridgeCommand,
  bridgeEvent,
  buildObjectInfo,
  isBridgeMessage,
  isExecMessage,
  type BridgeEventType,
  type ExecMessage,
  type PromptGraph,
} from '../../protocol/src/index.ts'

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
const wsBase = gatewayUrl.replace(/^http/, 'ws')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** Build the flattened six-node demo prompt (keys "1".."6" by step order). */
function demoPrompt(): PromptGraph {
  const graph: PromptGraph = {}
  const ordered = [...MOVIE_NODES].sort((a, b) => a.step - b.step)
  ordered.forEach((node, index) => {
    graph[String(index + 1)] = { class_type: node.classType, inputs: {} }
  })
  return graph
}

/** Collect the Leg B lifecycle over `/comfy/ws` for one submitted prompt. */
async function collectComfyLifecycle(): Promise<ExecMessage[]> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/comfy/ws`)
    const messages: ExecMessage[] = []
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('ComfyUI lifecycle timed out'))
    }, 10_000)
    socket.addEventListener('open', () => {
      void (async () => {
        await fetch(`${gatewayUrl}/comfy/api/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: demoPrompt() }),
        })
      })().catch((error: unknown) => rejectCollect(error instanceof Error ? error : new Error(String(error))))
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

/** Round-trip a value through JSON to mimic a postMessage structured clone. */
function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

async function main(): Promise<void> {
  const sixClassTypes = MOVIE_NODES.map((node): string => node.classType)

  // 1. Static serving: the pinned frontend entrypoint.
  const index = await fetch(`${gatewayUrl}/comfy/index.html`)
  const indexText = index.ok ? await index.text() : ''
  check('GET /comfy/index.html serves the frontend', index.ok && indexText.includes('<html'), `status ${index.status}`)

  // 2. Static serving: our bridge extension JS (not the frontend's).
  const bridgeJs = await fetch(`${gatewayUrl}/comfy/extensions/dsh-movie-bridge.js`)
  const bridgeText = bridgeJs.ok ? await bridgeJs.text() : ''
  const bridgeMime = bridgeJs.headers.get('content-type') ?? ''
  check(
    'GET /comfy/extensions/dsh-movie-bridge.js serves our bridge',
    bridgeJs.ok && bridgeMime.includes('javascript') && bridgeText.includes('registerExtension'),
    `status ${bridgeJs.status} ${bridgeMime}`,
  )

  // 3. Boot subset: object_info carries the six movie step nodes.
  const objectInfo = await fetch(`${gatewayUrl}/comfy/api/object_info`)
  const objectInfoBody = objectInfo.ok ? ((await objectInfo.json()) as Record<string, unknown>) : {}
  const missingNodes = sixClassTypes.filter((classType): boolean => !(classType in objectInfoBody))
  check(
    '/comfy/api/object_info advertises the six movie step nodes',
    objectInfo.ok && missingNodes.length === 0,
    missingNodes.length === 0 ? sixClassTypes.join(', ') : `missing: ${missingNodes.join(', ')}`,
  )

  // Cross-check the served catalog against the locally generated registry.
  const expected = buildObjectInfo()
  const shapesMatch = sixClassTypes.every((classType): boolean => {
    const served = objectInfoBody[classType] as { display_name?: unknown } | undefined
    return served?.display_name === expected[classType]?.display_name
  })
  check('/comfy/api/object_info matches the protocol node registry', objectInfo.ok && shapesMatch)

  // The frontend constructs each node def and calls `python_module.split('.')`
  // with no fallback; a missing python_module (or input.optional) throws inside
  // registerNodesFromDefs, aborting app.setup() before the bridge's setup hook
  // runs (no `ready` event, empty canvas). Guard that regression here.
  const defFieldsOk = sixClassTypes.every((classType): boolean => {
    const entry = objectInfoBody[classType] as { python_module?: unknown; input?: { optional?: unknown } } | undefined
    return typeof entry?.python_module === 'string' && entry.python_module.length > 0
      && typeof entry?.input?.optional === 'object' && entry.input.optional !== null
  })
  check('/comfy/api/object_info entries carry python_module + input.optional', objectInfo.ok && defFieldsOk)

  // 4. Boot subset: extensions lists the bridge URL (api_base-relative).
  const extensions = await fetch(`${gatewayUrl}/comfy/api/extensions`)
  const extensionsBody = extensions.ok ? ((await extensions.json()) as unknown) : []
  const bridgeEntry = Array.isArray(extensionsBody)
    ? extensionsBody.find((entry): entry is string => typeof entry === 'string' && entry.includes('dsh-movie-bridge.js'))
    : undefined
  // The frontend resolves each entry as `api_base + entry` (api_base === '/comfy'),
  // so the advertised URL MUST be api_base-relative (leading slash, no '/comfy'
  // prefix); otherwise it doubles to '/comfy/comfy/...' and 404s, aborting setup().
  const relativeOk = bridgeEntry !== undefined && bridgeEntry.startsWith('/extensions/') && !bridgeEntry.startsWith('/comfy')
  check('/comfy/api/extensions lists the bridge as an api_base-relative URL', extensions.ok && relativeOk, JSON.stringify(extensionsBody))
  if (bridgeEntry !== undefined) {
    const resolved = await fetch(`${gatewayUrl}/comfy${bridgeEntry}`)
    check('api_base + extension URL resolves to the served bridge (no doubled prefix)', resolved.ok, `GET /comfy${bridgeEntry} -> ${resolved.status}`)
  }

  // 5. Boot subset: system_stats answers with a system block.
  const stats = await fetch(`${gatewayUrl}/comfy/api/system_stats`)
  const statsBody = stats.ok ? ((await stats.json()) as { system?: unknown }) : {}
  check('/comfy/api/system_stats answers with a system block', stats.ok && statsBody.system !== undefined)

  // 6. Leg B lifecycle over /comfy/ws drives all six node ids.
  try {
    const messages = await collectComfyLifecycle()
    const executedNodes = new Set(
      messages
        .filter((message): boolean => message.type === 'executing')
        .map((message): string | null => (message.type === 'executing' ? message.data.node : null))
        .filter((node): node is string => typeof node === 'string'),
    )
    const expectedIds = new Set(Object.keys(demoPrompt()))
    const covered = [...expectedIds].every((id): boolean => executedNodes.has(id))
    check(
      'POST /comfy/api/prompt drives the /comfy/ws lifecycle across all six nodes',
      covered && messages.some((message): boolean => message.type === 'execution_success'),
      `executing nodes: ${[...executedNodes].join(', ') || 'none'}`,
    )
  } catch (error) {
    check('ComfyUI /comfy/ws lifecycle completed', false, String(error))
  }

  // 7. Bridge contract: command envelopes round-trip.
  const commandSamples = [
    bridgeCommand('hello/version', { version: BRIDGE_VERSION }),
    bridgeCommand('graph.load', { graph: { nodes: [] } }),
    bridgeCommand('node.setStatus', { id: 1, status: 'running' }),
    bridgeCommand('setReadonly', { readonly: true }, 'txn-1'),
    bridgeCommand('view.fit', {}),
  ]
  const commandsOk = commandSamples.every((command): boolean => {
    const parsed = roundTrip(command)
    return isBridgeMessage(parsed) && parsed.v === BRIDGE_VERSION
  })
  check('parent->iframe command envelopes round-trip through isBridgeMessage', commandsOk)

  // 8. Bridge contract: every event type builds + round-trips.
  const eventPayloads: Record<BridgeEventType, unknown> = {
    ready: { version: BRIDGE_VERSION },
    graphChanged: { graph: { nodes: [] }, rev: 1 },
    nodeSelected: { id: null },
    execPainted: { id: 1, status: 'success' },
    commandResult: { txn: 'txn-1', ok: true, data: null },
    bridgeError: { code: 'x', message: 'y' },
  }
  const eventsOk = (Object.keys(eventPayloads) as BridgeEventType[]).every((type) => {
    const event = bridgeEvent(type, eventPayloads[type] as never, 'txn-1')
    const parsed = roundTrip(event)
    return isBridgeMessage(parsed) && parsed.type === type
  })
  check('iframe->parent event envelopes round-trip through isBridgeMessage', eventsOk)

  // 9. Bridge contract: the type list is complete and rejects bogus payloads.
  check('BRIDGE_MESSAGE_TYPES covers commands + events', BRIDGE_MESSAGE_TYPES.length === 19, `${BRIDGE_MESSAGE_TYPES.length} types`)
  check('isBridgeMessage rejects a non-bridge payload', !isBridgeMessage({ hello: 'world' }) && !isBridgeMessage(null))
  check('isBridgeMessage rejects a wrong-version envelope', !isBridgeMessage({ v: 999, type: 'ready', payload: {} }))

  process.stdout.write(failures === 0 ? '\nALL COMFY-BRIDGE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
