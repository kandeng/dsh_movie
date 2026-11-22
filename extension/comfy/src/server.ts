/**
 * comfy-remote: MCP server bridging dsh_movie to the remote H20 ComfyUI
 * service (host `yw01`, reached over the ZeroTier overlay — see
 * ../../zerotier/zt_install.sh and ../comfy_README.md "Remote access").
 *
 * This is NOT the Phase-2 canvas `comfy-bridge` inside dsh-movie-gateway, and
 * NOT the Phase-8 media seam (`comfy-provider.ts`). It is an operator/agent
 * surface: it exposes the H20 stack's own HTTP API (including the custom
 * `model_catalog` endpoints that back the Plugin → Models page) as MCP tools,
 * so any MCP client (DSH marketplace tooling, qodercli, Claude-style hosts)
 * can inspect and drive the remote GPU box.
 *
 * Governance note: application-level model calls must still go through the
 * DSH gateway (「模型调用一律经 DSH」). For the movie pipeline itself, the gateway
 * reaches the H20 over the ZeroTier overlay — `DSH_COMFY_ZEROTIER` dynamic
 * managed-IP resolution, or a static `DSH_COMFY_BASE_URL=http://10.188.8.105:8188`
 * — comfy-provider.ts supports both as env-only switches. This server is for
 * catalog/health/ops introspection.
 *
 * Env:
 *   COMFY_REMOTE_BASE_URL   default http://10.188.8.105:8188 (ZeroTier managed IP)
 *   COMFY_REMOTE_TOKEN      optional bearer token (never logged)
 *   COMFY_REMOTE_TIMEOUT_MS default 900000 (per-job wait cap)
 *
 * @module extension/comfy/src/server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (process.env['COMFY_REMOTE_BASE_URL'] ?? 'http://10.188.8.105:8188').replace(/\/+$/, '')
const TOKEN = (process.env['COMFY_REMOTE_TOKEN'] ?? '').trim()
const TIMEOUT_MS = Number(process.env['COMFY_REMOTE_TIMEOUT_MS'] ?? '900000')

function headers(): Record<string, string> {
  return TOKEN === '' ? {} : { 'Authorization': `Bearer ${TOKEN}` }
}

/** MCP tool result envelope (always text content). */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** fetch wrapper: auth headers + bounded timeout + uniform error text. */
async function get(path: string, timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`)
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text }
}

async function post(path: string, body?: unknown, timeoutMs = 30_000): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (!response.ok) throw new Error(`POST ${path} → HTTP ${response.status}: ${text.slice(0, 400)}`)
  return parsed
}

/** Wrap an async tool body into a uniform result/error envelope. */
function tool(run: () => Promise<unknown>): Promise<ToolResult> {
  return run().then(json, (error: unknown): ToolResult =>
    fail(error instanceof Error ? error.message : String(error)))
}

// ---------------------------------------------------------------------------
// Job polling (submit → history → bytes), mirrors comfy-provider.ts semantics
// ---------------------------------------------------------------------------

interface HistoryFile { filename?: string; subfolder?: string; type?: string }
interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
  outputs?: Record<string, Record<string, unknown>>
}

function savedFilesOf(entry: HistoryEntry): HistoryFile[] {
  const files: HistoryFile[] = []
  for (const outputs of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'gifs', 'video', 'audio']) {
      const list = outputs[key]
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'object' && item !== null && typeof (item as HistoryFile).filename === 'string') {
            files.push(item as HistoryFile)
          }
        }
      }
    }
  }
  return files
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve): void => { setTimeout(resolve, ms) })
}

/** Poll /history/{id} until success/error/timeout; return status + file list. */
async function waitForJob(promptId: string, pollMs: number, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, TIMEOUT_MS)
  for (;;) {
    await sleep(pollMs)
    const history = (await get(`/history/${promptId}`)) as Record<string, HistoryEntry>
    const entry = history[promptId]
    if (entry === undefined) {
      if (Date.now() > deadline) return { promptId, state: 'timeout', hint: 'still queued/executing; re-check with comfy_job_status' }
      continue
    }
    if (entry.status?.status_str === 'error') {
      return { promptId, state: 'error', messages: entry.status.messages ?? [] }
    }
    const files = savedFilesOf(entry)
    if (files.length > 0) {
      return {
        promptId,
        state: 'success',
        files: files.map((file): unknown => ({
          filename: file.filename,
          subfolder: file.subfolder ?? '',
          type: file.type ?? 'output',
          viewPath: `/view?${new URLSearchParams({ filename: file.filename ?? '', subfolder: file.subfolder ?? '', type: file.type ?? 'output' }).toString()}`,
        })),
      }
    }
    if (Date.now() > deadline) return { promptId, state: 'timeout', hint: 'no saved outputs yet; re-check with comfy_job_status' }
  }
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'comfy-remote', version: '0.1.0' })

server.registerTool('comfy_health', {
  title: 'ComfyUI health',
  description: `Fail-closed reachability check of the remote ComfyUI (${BASE_URL}). Returns ok:true only when /system_stats answers.`,
  inputSchema: {},
}, (): Promise<ToolResult> => tool(async () => {
  try {
    const stats = await get('/system_stats', 8_000) as Record<string, unknown>
    return { ok: true, baseUrl: BASE_URL, systemStats: stats }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false, baseUrl: BASE_URL, error: message,
      hint: message.includes('fetch failed') || message.includes('timeout')
        ? 'Is the ZeroTier overlay up? Run: zerotier-cli listnetworks (local) — see extension/zerotier/zt_install.sh'
        : undefined,
    }
  }
}))

server.registerTool('comfy_system_stats', {
  title: 'ComfyUI system stats',
  description: 'Raw GET /system_stats: ComfyUI version, torch/CUDA versions, GPU list, VRAM, queue state.',
  inputSchema: {},
}, (): Promise<ToolResult> => tool(async () => get('/system_stats')))

server.registerTool('comfy_model_catalog', {
  title: 'Model catalog',
  description: 'The H20 model catalog (custom endpoint). Lists every installed weight with id/category/size/lazy_loaded/purpose/loader/est_vram_gb/description (~100 words). This is the data source for the Plugin → Models page.',
  inputSchema: {
    category: z.string().optional().describe('Optional category filter (e.g. checkpoints, diffusion_models, text_encoders, vae, loras, clip_vision, instantid, upscale_models, frame_interpolation, audio). Omit for the full catalog.'),
  },
}, (args): Promise<ToolResult> => tool(async () => {
  const path = args.category === undefined ? '/model_catalog' : `/model_catalog/${encodeURIComponent(args.category)}`
  return get(path)
}))

server.registerTool('comfy_model_categories', {
  title: 'Model catalog categories',
  description: 'GET /model_catalog/categories — the category list for tab/filter construction.',
  inputSchema: {},
}, (): Promise<ToolResult> => tool(async () => get('/model_catalog/categories')))

server.registerTool('comfy_object_info', {
  title: 'Node capability info',
  description: 'GET /object_info (all node types) or /object_info/{nodeClass} for one. Use to verify a workflow template\'s node coverage before submitting.',
  inputSchema: {
    nodeClass: z.string().optional().describe('Optional node class name, e.g. CheckpointLoaderSimple.'),
  },
}, (args): Promise<ToolResult> => tool(async () =>
  get(args.nodeClass === undefined ? '/object_info' : `/object_info/${encodeURIComponent(args.nodeClass)}`, 30_000)))

server.registerTool('comfy_queue', {
  title: 'Queue state',
  description: 'GET /queue — running and pending prompt jobs on the remote box.',
  inputSchema: {},
}, (): Promise<ToolResult> => tool(async () => get('/queue')))

server.registerTool('comfy_submit_prompt', {
  title: 'Submit workflow (API format)',
  description: 'POST /prompt with an API-format graph ({"nodeId": {class_type, inputs}}). Returns prompt_id and any node_errors. Use comfy_wait_for_job / comfy_job_status to track, comfy_fetch_output to download results.',
  inputSchema: {
    workflow: z.record(z.string(), z.record(z.string(), z.unknown())).describe('The API-format prompt graph.'),
    waitSeconds: z.number().int().min(0).max(3600).optional().describe('If > 0, block up to this many seconds polling /history and return the terminal state inline (default 0 = fire-and-forget).'),
  },
}, (args): Promise<ToolResult> => tool(async () => {
  const envelope = await post('/prompt', { prompt: args.workflow }) as Record<string, unknown>
  const promptId = envelope['prompt_id']
  const nodeErrors = envelope['node_errors'] ?? {}
  if (typeof promptId !== 'string' || Object.keys(nodeErrors as object).length > 0) {
    return { ok: false, response: envelope }
  }
  const waitSeconds = args.waitSeconds ?? 0
  if (waitSeconds > 0) {
    const result = await waitForJob(promptId, 1_500, waitSeconds * 1_000)
    return { ok: true, promptId, ...result as object }
  }
  return { ok: true, promptId, queued: true }
}))

server.registerTool('comfy_job_status', {
  title: 'Job status',
  description: 'One-shot GET /history/{prompt_id}: status plus saved-output file list (empty while still executing).',
  inputSchema: {
    promptId: z.string().describe('The prompt_id returned by comfy_submit_prompt.'),
  },
}, (args): Promise<ToolResult> => tool(async () => {
  const history = (await get(`/history/${encodeURIComponent(args.promptId)}`)) as Record<string, HistoryEntry>
  const entry = history[args.promptId]
  if (entry === undefined) return { promptId: args.promptId, state: 'unknown-or-queued' }
  const files = savedFilesOf(entry)
  return {
    promptId: args.promptId,
    state: entry.status?.status_str ?? 'running',
    completed: entry.status?.completed ?? false,
    files,
  }
}))

server.registerTool('comfy_wait_for_job', {
  title: 'Wait for job',
  description: 'Poll /history/{prompt_id} until success/error/timeout. Returns terminal state with per-file /view paths.',
  inputSchema: {
    promptId: z.string().describe('The prompt_id returned by comfy_submit_prompt.'),
    pollMs: z.number().int().min(500).max(30_000).optional().describe('Poll interval (default 1500 ms).'),
    timeoutSeconds: z.number().int().min(5).max(3600).optional().describe('Wait cap (default 900 s; Wan 2.2 smoke runs ~240 s).'),
  },
}, (args): Promise<ToolResult> => tool(async () =>
  waitForJob(args.promptId, args.pollMs ?? 1_500, (args.timeoutSeconds ?? 900) * 1_000)))

server.registerTool('comfy_fetch_output', {
  title: 'Fetch output bytes',
  description: 'GET /view for one saved file; returns base64 bytes with mime type. Use a file entry from comfy_wait_for_job / comfy_job_status.',
  inputSchema: {
    filename: z.string(),
    subfolder: z.string().optional(),
    type: z.string().optional().describe('output | input | temp (default output).'),
    saveTo: z.string().optional().describe('Optional absolute local path to write the bytes to (instead of returning base64).'),
  },
}, (args): Promise<ToolResult> => tool(async () => {
  const query = new URLSearchParams({
    filename: args.filename,
    subfolder: args.subfolder ?? '',
    type: args.type ?? 'output',
  })
  const response = await fetch(`${BASE_URL}/view?${query.toString()}`, {
    headers: headers(),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`GET /view → HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const mime = response.headers.get('content-type') ?? 'application/octet-stream'
  if (args.saveTo !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(args.saveTo, bytes)
    return { savedTo: args.saveTo, bytes: bytes.byteLength, mime }
  }
  return { filename: args.filename, bytes: bytes.byteLength, mime, base64: bytes.toString('base64') }
}))

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[comfy-remote] MCP server listening on stdio; upstream ${BASE_URL}`)
