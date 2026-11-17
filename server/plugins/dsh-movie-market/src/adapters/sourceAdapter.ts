/**
 * The skill-source adapter MCP library (Phase-7 P7-M3).
 *
 * Every built-in tool is an MCP stdio server exposing the three source tools
 * (`skills/search`, `skills/profile`, `skills/download`). Rather than repeat the
 * JSON-RPC framing in each adapter, this module implements the transport once
 * and lets an adapter supply only its {@link SourceHandlers}.
 *
 * It is **dependency-free** — only `node:*` plus the sibling `contract.ts` — so
 * the adapter scripts stay hermetic inside the OS sandbox (see `sandbox.ts`).
 * The framing mirrors `test/fixture-mcp-server.ts` (proven under the supervisor
 * in P7-M2): newline-delimited JSON on stdin/stdout, logs to stderr.
 *
 * @module dsh-movie-market/adapters/sourceAdapter
 */

import type {
  SourceDownloadResult, SourceProfileResult, SourceRunResult, SourceSearchResult,
} from './contract.ts'
import { SOURCE_TOOL_NAMES } from './contract.ts'

/** The per-adapter business logic this library drives. */
export interface SourceHandlers {
  /** Answer a `skills/search`. */
  search(q: string, target?: string | undefined): Promise<SourceSearchResult>
  /** Answer a `skills/profile`. */
  profile(slug: string): Promise<SourceProfileResult>
  /** Answer a `skills/download`. */
  download(slug: string): Promise<SourceDownloadResult>
  /**
   * Answer a `skills/run` (Phase-7 D9). OPTIONAL: a source that does not declare
   * it simply does not advertise the executable entrypoint, and the host treats
   * its skills as non-executable. It runs inside the tool's already-sandboxed
   * process, so the manifest allow-list + caps bound it (D3).
   */
  run?(slug: string, args: Readonly<Record<string, unknown>>): Promise<SourceRunResult>
}

/** Identity advertised in the MCP `initialize` result. */
export interface SourceServerInfo {
  /** Server name. */
  name: string
  /** Server version. */
  version: string
  /** Optional human instructions. */
  instructions?: string | undefined
}

/** One inbound JSON-RPC request. */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

/** The static tool catalog every skill-source adapter advertises. */
const BASE_TOOLS: readonly unknown[] = [
  {
    name: SOURCE_TOOL_NAMES.search,
    description: 'Search this source for skills matching a query (JSON result).',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' }, target: { type: 'string' } },
      required: ['q'],
    },
  },
  {
    name: SOURCE_TOOL_NAMES.profile,
    description: 'Fetch one skill profile by source-local slug (JSON result).',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    name: SOURCE_TOOL_NAMES.download,
    description: 'Download the full SKILL.md body for one slug (JSON result).',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
]

/** The executable-entrypoint tool (Phase-7 D9), advertised only when implemented. */
const RUN_TOOL: unknown = {
  name: SOURCE_TOOL_NAMES.run,
  description: 'Execute one skill\'s entrypoint in this sandbox and return its output (JSON result).',
  inputSchema: {
    type: 'object',
    properties: { slug: { type: 'string' }, args: { type: 'object' } },
    required: ['slug'],
  },
}

/** Write one newline-delimited JSON message to stdout. */
function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Log to stderr (never stdout, which carries the MCP framing). */
function log(name: string, ...parts: unknown[]): void {
  process.stderr.write(`[${name}] ${parts.map((p): string => String(p)).join(' ')}\n`)
}

/** Reply with a result. */
function replyResult(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

/** Reply with an error. */
function replyError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/** Encode a handler payload into a single MCP text content block. */
function encode(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/**
 * Run the MCP stdio server for one adapter.
 * @param info - server identity.
 * @param handlers - the adapter's search/profile/download logic.
 */
export function runSourceServer(info: SourceServerInfo, handlers: SourceHandlers): void {
  const tag = info.name
  // Advertise the executable entrypoint only when this source implements it, so
  // a non-executable source never offers a `skills/run` that would just error.
  const tools: readonly unknown[] = handlers.run === undefined ? BASE_TOOLS : [...BASE_TOOLS, RUN_TOOL]

  /** Route one `tools/call` to a handler, encoding the JSON result. */
  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === SOURCE_TOOL_NAMES.search) {
      const q = String(args['q'] ?? '')
      const target = args['target'] === undefined ? undefined : String(args['target'])
      return encode(await handlers.search(q, target))
    }
    if (name === SOURCE_TOOL_NAMES.profile) {
      return encode(await handlers.profile(String(args['slug'] ?? '')))
    }
    if (name === SOURCE_TOOL_NAMES.download) {
      return encode(await handlers.download(String(args['slug'] ?? '')))
    }
    if (name === SOURCE_TOOL_NAMES.run) {
      if (handlers.run === undefined) throw new Error('this source does not support execution')
      const runArgs = (args['args'] as Record<string, unknown> | undefined) ?? {}
      return encode(await handlers.run(String(args['slug'] ?? ''), runArgs))
    }
    return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${name}` }) }], isError: true }
  }

  /** Dispatch one inbound JSON-RPC message. */
  async function dispatch(message: JsonRpcRequest): Promise<void> {
    const { method, params } = message
    const id = message.id
    switch (method) {
      case 'initialize': {
        const requested = (params?.['protocolVersion'] as string | undefined) ?? '2024-11-05'
        if (id !== undefined) {
          const result: Record<string, unknown> = {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
          }
          if (info.instructions !== undefined) result['instructions'] = info.instructions
          replyResult(id, result)
        }
        return
      }
      case 'notifications/initialized':
      case 'initialized':
        return
      case 'ping':
        if (id !== undefined) replyResult(id, {})
        return
      case 'tools/list':
        if (id !== undefined) replyResult(id, { tools })
        return
      case 'tools/call': {
        if (id === undefined) return
        const name = String(params?.['name'] ?? '')
        const args = (params?.['arguments'] as Record<string, unknown> | undefined) ?? {}
        try {
          replyResult(id, await callTool(name, args))
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error)
          // Surface as an MCP tool error (isError) so the host can cache-serve.
          replyResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: message2 }) }], isError: true })
        }
        return
      }
      default:
        if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
    }
  }

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
        log(tag, 'bad json line:', error)
        continue
      }
      void dispatch(parsed).catch((error: unknown): void => log(tag, 'dispatch failed:', error))
    }
  })
  process.stdin.on('end', () => {
    log(tag, 'stdin ended; exiting')
    process.exit(0)
  })
  log(tag, 'ready (pid', process.pid, ')')
}
