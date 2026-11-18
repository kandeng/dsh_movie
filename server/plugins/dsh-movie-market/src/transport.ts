/**
 * A minimal MCP stdio transport bound to an **already-spawned** child process.
 *
 * The DSH `@deepseek-ai/dsh-mcp-client` package's own `StdioClientTransport`
 * spawns its child directly (unsandboxed) and registers tools onto `ctx.tools`;
 * the SPR supervisor needs the opposite — it spawns the sandboxed child itself
 * (see `sandbox.ts`) and then attaches an MCP {@link Client} to that child's
 * stdio. This class is the glue: it implements the `Transport` contract from
 * `@modelcontextprotocol/client` over a `ChildProcess`'s pipes using the
 * standard newline-delimited JSON-RPC framing (`ReadBuffer` + `serializeMessage`).
 *
 * Lifetime: `start()` wires the stdout reader and the child's error/close
 * events; `close()` ends stdin and terminates the child. The supervisor owns
 * the actual process lifecycle (spawn, reap, kill) — this transport only
 * reflects it to the MCP client via `onclose`/`onerror`.
 *
 * @module dsh-movie-market/transport
 */

import type { ChildProcess } from 'node:child_process'
import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client'

/** MCP `Transport` over a spawned child's stdin/stdout. */
export class McpChildTransport implements Transport {
  /** Invoked when the child closes / the stream ends. */
  onclose?: () => void
  /** Invoked on a framing or stream error. */
  onerror?: (error: Error) => void
  /** Invoked for each inbound JSON-RPC message. */
  onmessage?: (message: JSONRPCMessage) => void

  private readonly child: ChildProcess
  private readonly buffer: ReadBuffer
  private started = false
  private closed = false

  /**
   * @param child - the spawned sandboxed child (must expose stdin/stdout pipes).
   */
  constructor(child: ChildProcess) {
    this.child = child
    this.buffer = new ReadBuffer()
  }

  /** The child pid, when available. */
  get pid(): number | null {
    return this.child.pid ?? null
  }

  /**
   * Begin reading the child's stdout and watching its lifecycle. The MCP
   * `Client` calls this implicitly during `connect()`.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const stdout = this.child.stdout
    if (stdout === null) {
      this.onerror?.(new Error('sandboxed child has no stdout pipe'))
      return
    }
    stdout.on('data', (chunk: Buffer): void => {
      try {
        this.buffer.append(chunk)
        let message = this.buffer.readMessage()
        while (message !== null) {
          this.onmessage?.(message)
          message = this.buffer.readMessage()
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    })
    // A dead/reaped child makes stdin writes fail with EPIPE. Node raises that
    // as a stream 'error' EVENT; without a listener it becomes an UNCAUGHT
    // exception and kills the whole DSH host. Route pipe errors to onerror so a
    // dead tool degrades the request instead of crashing the server.
    this.child.stdin?.on('error', (error: Error): void => {
      this.onerror?.(error)
    })
    stdout.on('error', (error: Error): void => {
      this.onerror?.(error)
    })
    this.child.on('error', (error: Error): void => {
      this.onerror?.(error)
    })
    this.child.on('close', (): void => {
      if (this.closed) return
      this.closed = true
      this.buffer.clear()
      this.onclose?.()
    })
  }

  /**
   * Write one JSON-RPC message to the child's stdin (newline-delimited).
   * @param message - the outbound message.
   */
  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.child.stdin
    if (this.closed || stdin === null || stdin.destroyed) throw new Error('sandboxed child stdin unavailable')
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error('sandboxed child already exited')
    }
    await new Promise<void>((resolve, reject) => {
      try {
        stdin.write(serializeMessage(message), (error) => {
          if (error !== null && error !== undefined) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * End the transport: close stdin and terminate the child. The supervisor may
   * already have reaped the child; this is idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.buffer.clear()
    try {
      this.child.stdin?.end()
    } catch {
      // stdin already gone — nothing to end.
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM')
    }
    this.onclose?.()
  }
}
