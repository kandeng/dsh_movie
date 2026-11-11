/**
 * Canned M1 fixtures for the Leg B/C gateway stub.
 *
 * The Phase-2 M1 gateway proves the *transport and trust wiring*, not a real
 * ComfyUI execution engine (the DSH host runs no Python/model code). So the
 * registry, asset repository, node catalog, and execution lifecycle are small
 * deterministic fixtures shaped exactly like the `@dsh-movie/protocol` wire
 * types. Later milestones swap these for real host-side producers without
 * changing the gateway's HTTP/WS surface.
 *
 * @module dsh-movie-gateway/fixtures
 */

import type {
  AssetRecord,
  ExecMessage,
  PromptGraph,
  RegistryEntry,
} from '@dsh-movie/protocol'

/** The movie-making node catalog the stub registry/object_info advertises. */
export const CANNED_REGISTRY: readonly RegistryEntry[] = [
  {
    id: 'movie.text_to_image',
    name: 'Text to Image',
    kind: 'node',
    version: '1',
    data: {
      class_type: 'MovieTextToImage',
      category: 'movie/conditioning',
      input: { required: { prompt: ['STRING', { multiline: true }] } },
      output: ['IMAGE'],
    },
  },
  {
    id: 'movie.image_to_video',
    name: 'Image to Video',
    kind: 'node',
    version: '1',
    data: {
      class_type: 'MovieImageToVideo',
      category: 'movie/animation',
      input: { required: { image: ['IMAGE'], frames: ['INT', { default: 24 }] } },
      output: ['VIDEO'],
    },
  },
  {
    id: 'movie.save_output',
    name: 'Save Output',
    kind: 'node',
    version: '1',
    data: {
      class_type: 'MovieSaveOutput',
      category: 'movie/output',
      input: { required: { media: ['*'] } },
      output: [],
      output_node: true,
    },
  },
]

/** A single canned asset record returned by the (host-gated) `assets/list` stub. */
export const CANNED_ASSETS: readonly AssetRecord[] = [
  {
    id: 'asset.demo-still.1',
    roomId: null,
    kind: 'image',
    uri: 'mxc://localhost/demoStill0001',
    name: 'demo-still.png',
    createdBy: null,
    createdAt: 0,
    meta: { fixture: true, note: 'M1 stub asset; replaced by the real repository at M3+' },
  },
]

/** The ComfyUI `/object_info` catalog subset the stub advertises. */
export const CANNED_OBJECT_INFO: Record<string, unknown> = Object.fromEntries(
  CANNED_REGISTRY.map((entry): [string, unknown] => {
    const data = entry.data as { class_type?: unknown }
    const classType = typeof data.class_type === 'string' ? data.class_type : entry.id
    return [classType, { ...data, name: entry.name }]
  }),
)

/** The ComfyUI `/system_stats` payload subset the stub reports. */
export const CANNED_SYSTEM_STATS: Record<string, unknown> = {
  system: {
    os: 'posix',
    argv: ['dsh-movie-gateway'],
    comfyui_version: '0.0.0-dsh-movie-m1',
    python_version: 'frontend-only (no python runtime on the DSH host)',
    embedded_python: false,
  },
  devices: [],
}

/**
 * Count the executable nodes in a submitted prompt graph so the canned
 * lifecycle can emit one `executing`/`progress`/`executed` triple per node.
 * @param graph - the flattened execution graph from `POST /prompt`.
 * @returns the ordered node ids to walk through the lifecycle.
 */
export function nodeIdsOf(graph: PromptGraph): string[] {
  return Object.keys(graph)
}

/**
 * Build the deterministic execution-lifecycle sequence the stub emits over the
 * Leg B WebSocket for a submitted prompt. Mirrors the ComfyUI envelope order:
 * `status` -> `queued` -> `execution_start` -> per-node
 * (`executing` -> `progress` -> `executed`) -> `executing(null)` ->
 * `execution_success`.
 * @param promptId - the assigned execution id.
 * @param number - the queue position reported in the `queued` message.
 * @param nodeIds - the node ids to walk, from {@link nodeIdsOf}.
 * @returns the ordered lifecycle messages.
 */
export function cannedLifecycle(promptId: string, number: number, nodeIds: readonly string[]): ExecMessage[] {
  const messages: ExecMessage[] = [
    { type: 'status', data: { status: { exec_info: { queue_remaining: number } } } },
    { type: 'queued', data: { prompt_id: promptId, number } },
    { type: 'execution_start', data: { prompt_id: promptId } },
  ]
  for (const node of nodeIds) {
    messages.push({ type: 'executing', data: { prompt_id: promptId, node } })
    messages.push({ type: 'progress', data: { prompt_id: promptId, node, value: 1, max: 1 } })
    messages.push({ type: 'executed', data: { prompt_id: promptId, node, output: { fixture: true } } })
  }
  messages.push({ type: 'executing', data: { prompt_id: promptId, node: null } })
  messages.push({ type: 'execution_success', data: { prompt_id: promptId } })
  return messages
}
