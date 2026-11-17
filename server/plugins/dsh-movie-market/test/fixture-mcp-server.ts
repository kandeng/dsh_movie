/**
 * A minimal, dependency-free MCP stdio server used by `verify-sandbox.ts` to
 * exercise the SPR supervisor's sandbox guarantees (Phase-7 P7-M2).
 *
 * It speaks the legacy MCP JSON-RPC handshake over newline-delimited JSON on
 * stdin/stdout (logs go to stderr so they never corrupt the framing) and
 * exposes three tools designed to trip each sandbox control:
 *
 * - `echo {text}` → returns `text` (proves the request/response round-trip and
 *   that recovery re-spawn works).
 * - `net-probe {host, port}` → attempts a TCP connect and returns
 *   `EGRESS_ALLOWED` or `EGRESS_BLOCKED:<code>` (proves the network sandbox:
 *   an empty allow-list runs the child in a private netns, so this is blocked).
 * - `alloc {mb}` → allocates **and touches** `mb` megabytes; under the cgroup
 *   `MemoryMax` the child is OOM-killed before it can answer (proves the memory
 *   cap). If it somehow survives it returns `ALLOC_OK:<mb>`.
 *
 * Run directly by node (v24 native TS stripping — erasable syntax only).
 *
 * @module dsh-movie-market/fixture-mcp-server
 */

import * as net from 'node:net'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

/** Write one newline-delimited JSON message to stdout. */
function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Log to stderr (never stdout, which carries the MCP framing). */
function log(...parts: unknown[]): void {
  process.stderr.write(`[fixture] ${parts.map((p) => String(p)).join(' ')}\n`)
}

/** Reply to a request with a result. */
function replyResult(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

/** Reply to a request with an error. */
function replyError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/** The static tool catalog advertised by `tools/list`. */
const TOOLS: readonly unknown[] = [
  {
    name: 'echo',
    description: 'Echo the given text back (round-trip + recovery probe).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'net-probe',
    description: 'Attempt a TCP connect to prove the network sandbox.',
    inputSchema: {
      type: 'object',
      properties: { host: { type: 'string' }, port: { type: 'number' } },
      required: ['host', 'port'],
    },
  },
  {
    name: 'alloc',
    description: 'Allocate and touch N megabytes to prove the memory cap.',
    inputSchema: {
      type: 'object',
      properties: { mb: { type: 'number' } },
      required: ['mb'],
    },
  },
]

/** Attempt a TCP connect; resolve to `EGRESS_ALLOWED` or `EGRESS_BLOCKED:<code>`. */
function netProbe(host: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish('EGRESS_ALLOWED'))
    socket.once('timeout', () => finish('EGRESS_BLOCKED:ETIMEDOUT'))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(`EGRESS_BLOCKED:${error.code ?? 'ERR'}`))
  })
}

/** Allocate and touch `mb` megabytes; returns only if the memory cap did not kill us. */
function alloc(mb: number): string {
  const chunkBytes = 16 * 1024 * 1024
  const chunks = Math.max(1, Math.ceil((mb * 1024 * 1024) / chunkBytes))
  const held: Buffer[] = []
  for (let i = 0; i < chunks; i += 1) {
    const buffer = Buffer.alloc(chunkBytes)
    buffer.fill(1) // touch every page so RSS grows and the cgroup cap applies
    held.push(buffer)
  }
  // Reference `held` so the optimizer cannot drop the allocations.
  return `ALLOC_OK:${mb}:${held.length}`
}

/** Handle one `tools/call`, producing an MCP result object. */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
  }
  if (name === 'net-probe') {
    const host = String(args['host'] ?? 'example.com')
    const port = Number(args['port'] ?? 443)
    const verdict = await netProbe(host, port, 4000)
    const blocked = verdict.startsWith('EGRESS_BLOCKED')
    return { content: [{ type: 'text', text: verdict }], isError: blocked }
  }
  if (name === 'alloc') {
    const mb = Number(args['mb'] ?? 64)
    return { content: [{ type: 'text', text: alloc(mb) }] }
  }
  return { content: [{ type: 'text', text: `UNKNOWN_TOOL:${name}` }], isError: true }
}

/** Dispatch one inbound JSON-RPC message. */
async function dispatch(message: JsonRpcRequest): Promise<void> {
  const { method, params } = message
  const id = message.id
  switch (method) {
    case 'initialize': {
      const requested = (params?.['protocolVersion'] as string | undefined) ?? '2024-11-05'
      if (id !== undefined) {
        replyResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-market-fixture', version: '0.1.0' },
          instructions: 'fixture MCP server for P7-M2 sandbox verification',
        })
      }
      return
    }
    case 'notifications/initialized':
    case 'initialized':
      return // notification — no reply
    case 'ping':
      if (id !== undefined) replyResult(id, {})
      return
    case 'tools/list':
      if (id !== undefined) replyResult(id, { tools: TOOLS })
      return
    case 'tools/call': {
      if (id === undefined) return
      const name = String(params?.['name'] ?? '')
      const args = (params?.['arguments'] as Record<string, unknown> | undefined) ?? {}
      try {
        replyResult(id, await callTool(name, args))
      } catch (error) {
        replyError(id, -32603, error instanceof Error ? error.message : String(error))
      }
      return
    }
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
  }
}

/** Accumulate stdin bytes and split them into newline-delimited JSON messages. */
let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string): void => {
  pending += chunk
  let newline = pending.indexOf('\n')
  while (newline >= 0) {
    const line = pending.slice(0, newline).trim()
    pending = pending.slice(newline + 1)
    newline = pending.indexOf('\n')
    if (line === '') continue
    let parsed: JsonRpcRequest
    try {
      parsed = JSON.parse(line) as JsonRpcRequest
    } catch (error) {
      log('bad json line:', error)
      continue
    }
    void dispatch(parsed).catch((error: unknown) => log('dispatch failed:', error))
  }
})
process.stdin.on('end', () => {
  log('stdin ended; exiting')
  process.exit(0)
})
log('fixture MCP server ready (pid', process.pid, ')')
