/**
 * `dsh-movie-gateway`: the Phase-2 Leg B/C browser gateway, exposed as the
 * Cordis service `ctx.movieGateway`.
 *
 * It generalizes the Phase-1 `/auth` listener into one loopback HTTP + WS server
 * (see `gateway-server.ts`): Leg C is a `POST /api/<ns>/<method>` JSON-RPC
 * dispatcher (auth/registry/assets in M1), and Leg B is a ComfyUI-subset surface
 * (`/object_info`, `/system_stats`, `/prompt`, `/queue`, `/history`) plus the
 * `/ws` execution-lifecycle socket. The gateway owns no identity logic — it maps
 * a caller's Matrix access token to a principal through the injected
 * `ctx.matrixIdentity`, so a single trust anchor covers both legs, and gates the
 * host-only `assets/list` op on `matrixIdentity.roomRole`.
 *
 * The server runs as a reversible effect: a host reload tears the socket down
 * and releases the port. The identity plugin's own `8787` `/auth` listener stays
 * intact, so the Phase-1 verification scripts remain green.
 *
 * @module dsh-movie-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startGatewayServer, type GatewayHandle } from './gateway-server.ts'
import { CanvasScriptAgent } from './canvas-agent.ts'
import { MovieDirector } from './movie-team/director.ts'
import { cannedMediaProvider, createRoutingMediaProvider } from './movie-executor/media-provider.ts'
import { LlmTextAgent } from './movie-executor/llm-text.ts'
import { createVideoProvider, videoConfigFromEnv } from './movie-executor/video-provider.ts'
import { comfyConfigFromEnv, createComfyProvider } from './movie-executor/comfy-provider.ts'
import { loadComfyTemplates } from './movie-executor/comfy-templates.ts'
import type { ModelAvailability } from './movie-executor/model-catalog.ts'
import type { MovieGateway, MovieGatewayInfo } from './types.ts'
// Pulls the optional `ctx.matrixChat` service-key merge used for the D15 room
// notice + D8 artifact echo (type-only; the poster is fetched with `ctx.get`).
import type {} from 'dsh-matrix-chat/types'
// Pulls the optional `ctx.movieMarket` service-key merge used for the Phase-7
// `plugins/*` namespace + D7 skill import (type-only; fetched with `ctx.get`).
import type {} from 'dsh-movie-market/types'

export type { MovieGateway, MovieGatewayInfo } from './types.ts'

/**
 * Resolve the Bailian API key so the real-LLM gate matches the rest of the
 * runtime. The credentials seam (and `llm-pi-ai`'s `apiKeyEnv: BAILIAN_API_KEY`)
 * sources the key from `server/.env`, but DSH does NOT inject that file into
 * `process.env`, so a host launched without the variable exported would read an
 * empty key and silently disable the text/review seams, the D15 text
 * availability and the D7 intent miner. Prefer the live environment, then fall
 * back to parsing `server/.env`.
 *
 * @param serverRoot - absolute path of the `server/` directory.
 * @returns the trimmed key, or `''` when none is configured (key-free degrade).
 */
function resolveBailianKey(serverRoot: string): string {
  const fromEnv = (process.env['BAILIAN_API_KEY'] ?? '').trim()
  if (fromEnv !== '') return fromEnv
  try {
    for (const line of readFileSync(resolve(serverRoot, '.env'), 'utf8').split('\n')) {
      const match = /^BAILIAN_API_KEY=(.*)$/.exec(line.trim())
      if (match !== null) return (match[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {
    // No readable server/.env: stay key-free (canned seams, D7 off).
  }
  return ''
}

/** Stable Loader identity. */
export const name = 'movie-gateway'

/**
 * The gateway resolves callers through the identity provider, drives canvas
 * op-script generation through the DSH agent runtime (Phase-3 P3-M3), and (in
 * P3-M4) orchestrates the director/step pipeline through the in-process
 * subagent runtime and the background-job registry.
 *
 * NOTE (P3-M4 Task 0 finding): `ctx.subagents` and `ctx.jobs` ship in the
 * `@deepseek-ai/dsh-base` bundle, so they resolve here. The shared task-DAG
 * board (`ctx.agentTeams`) does NOT: in `0.2.2-rc.1` it lives in the experimental
 * `@deepseek-ai/dsh-experimental-agent-team-profile` bundle, which also disables
 * the standard subagent tools and injects experimental team tools/UI globally.
 * We deliberately keep the host composition stable and run the director on
 * `subagents` + `jobs`, holding the step DAG in gateway-owned state instead.
 */
export const inject = ['matrixIdentity', 'agents', 'agentDefaultModel', 'sessions', 'subagents', 'jobs']

/** Plugin configuration: the loopback port to bind. */
export interface Config {
  /** Loopback port for the Leg B/C gateway; `0` disables it. */
  port: number
  /**
   * Directory holding the pinned ComfyUI frontend build served at `/comfy/`.
   * Empty (default) resolves to `<server>/static/comfy` when that directory
   * exists (populated by `scripts/fetch-comfy-frontend.ts`).
   */
  comfyStaticDir: string
  /**
   * Directory holding the file-backed per-room workspaces (P3-M5): committed
   * graph history + the host's uncommitted draft. Empty (default) resolves to
   * `<server>/.dsh/workspaces`.
   */
  workspaceRoot: string
}

/** Schemastery validation + defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  port: z.number().min(0).default(8788),
  comfyStaticDir: z.string().default(''),
  workspaceRoot: z.string().default(''),
})

/** Build the gateway's loopback coordinates for a port. */
function coordinatesFor(port: number): MovieGatewayInfo {
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    execWsUrl: `ws://127.0.0.1:${port}/ws`,
    muxWsUrl: `ws://127.0.0.1:${port}/api/ws`,
  }
}

/**
 * Activate the gateway: provide `ctx.movieGateway` and, when a port is set, run
 * the HTTP/WS server as a reversible effect.
 * @param ctx - host context with the `matrixIdentity` service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let handle: GatewayHandle | null = null
  const fallback = coordinatesFor(config.port)

  const service: MovieGateway = {
    isListening(): boolean {
      return handle?.isListening() ?? false
    },
    info(): MovieGatewayInfo {
      return handle?.info() ?? fallback
    },
  }

  ctx.provide('movieGateway', service)

  if (config.port > 0) {
    // Resolve the ComfyUI frontend build dir and our bridge extension relative to
    // this plugin file (CWD-independent): `<server>/static/comfy` and the
    // `comfy-bridge/bridge-extension.js` we ship alongside the plugin source.
    const pluginDir = dirname(fileURLToPath(import.meta.url))
    const serverRoot = resolve(pluginDir, '..', '..', '..')
    const defaultStatic = resolve(serverRoot, 'static', 'comfy')
    const configuredStatic = config.comfyStaticDir !== ''
      ? resolve(config.comfyStaticDir)
      : defaultStatic
    const staticDir = existsSync(configuredStatic) ? configuredStatic : undefined
    const bridgeExtensionFile = resolve(pluginDir, 'comfy-bridge', 'bridge-extension.js')
    // The file-backed per-room workspace root (P3-M5). Mirrors the ComfyUI
    // static-dir resolution: an explicit config wins, else `<server>/.dsh/workspaces`.
    const defaultWorkspaceRoot = resolve(serverRoot, '.dsh', 'workspaces')
    const workspaceRoot = config.workspaceRoot !== '' ? resolve(config.workspaceRoot) : defaultWorkspaceRoot
    if (staticDir === undefined) {
      ctx.logger.warn('[movie-gateway] ComfyUI frontend build not found at %s; /comfy/ will 503 (run scripts/fetch-comfy-frontend.ts)', configuredStatic)
    }
    // The real-LLM canvas op-script generator (P3-M3). It mirrors the matrix-chat
    // agent wiring: per-room sessions, optional subagent settlement, and the
    // host CWD as the agent working directory.
    const canvasAgent = new CanvasScriptAgent({
      agents: ctx.agents,
      agentDefaultModel: ctx.agentDefaultModel,
      sessions: ctx.sessions,
      ...ctx.get('subagents') === undefined ? {} : { subagents: ctx.get('subagents') },
      cwd: process.cwd(),
      logger: ctx.logger,
    })
    // The six-step movie pipeline director (P3-M4). It runs the two text steps
    // as real spawned subagents (Bailian) and the media steps through the canned
    // provider seam, holding the step DAG in gateway-owned pipeline state.
    const director = new MovieDirector({
      agents: ctx.agents,
      agentDefaultModel: ctx.agentDefaultModel,
      sessions: ctx.sessions,
      ...ctx.get('subagents') === undefined ? {} : { subagents: ctx.get('subagents') },
      cwd: process.cwd(),
      logger: ctx.logger,
      mediaProvider: cannedMediaProvider,
    })
    // P5-M2: the real modality adapters + the D15 availability gate.
    //  - text  -> a shared Bailian LLM turn (LlmTextAgent), gated on subagents.
    //  - video -> the Bailian "Happyhorse" DashScope seam, gated on env config.
    //  - image/audio -> the ComfyUI GPU backend (Phase 8); without it the gate
    //    fails the node and `customer_service` posts the "no such model" notice.
    const subagents = ctx.get('subagents')
    const bailianKey = resolveBailianKey(serverRoot)
    // D7 is otherwise invisible when degraded (the listener simply never
    // registers and ctx.logger.info is filtered at the default level), so state
    // the arm decision once at boot on stdout for operability.
    console.log(
      '[movie-gateway] D7 intent miner %s (key=%s, subagents=%s)',
      subagents === undefined || bailianKey === '' ? 'OFF' : 'armed',
      bailianKey === '' ? 'missing' : 'set',
      subagents === undefined ? 'missing' : 'present',
    )
    // The real text/review seams activate only with BOTH the subagent runtime and
    // a Bailian key; without either the adapters fall back to their honest canned
    // text (mirroring the director's key-free degrade), so the key-free verifier
    // stays deterministic and D15 text availability reflects reality.
    const llmText = subagents === undefined || bailianKey === ''
      ? undefined
      : new LlmTextAgent({
        agents: ctx.agents,
        agentDefaultModel: ctx.agentDefaultModel,
        sessions: ctx.sessions,
        subagents,
        cwd: process.cwd(),
        logger: ctx.logger,
      })
    const videoConfig = videoConfigFromEnv({ ...process.env, BAILIAN_API_KEY: bailianKey })
    const videoProvider = videoConfig === undefined ? undefined : createVideoProvider(videoConfig, ctx.logger)
    // Phase 8 (D2/D13): the local-first ComfyUI backend, config-gated on
    // DSH_COMFY_BASE_URL (loopback by default). Without it, image stays unbacked
    // and video keeps the Happyhorse-only behavior — a settings/env change, not
    // a code change. Templates are server-held (D10); the DSH process stays
    // model-code-free.
    const comfyConfig = comfyConfigFromEnv()
    const comfyProvider = comfyConfig === undefined
      ? undefined
      : createComfyProvider(comfyConfig, ctx.logger, loadComfyTemplates())
    // Route functional generators (D15 + P8 D2): ImageGenerator → ComfyUI when
    // configured; VideoGenerator → ComfyUI when configured else Happyhorse;
    // AudioGenerator → ComfyUI (Stable Audio Open) when configured; everything
    // else stays on the canned offline fallback so the legacy six-step
    // pipeline + verify bridges are unchanged.
    const routingMediaProvider = createRoutingMediaProvider({
      ...(comfyProvider === undefined ? {} : { image: comfyProvider }),
      ...((comfyProvider ?? videoProvider) === undefined ? {} : { video: comfyProvider ?? videoProvider }),
      ...(comfyProvider === undefined ? {} : { audio: comfyProvider }),
      fallback: cannedMediaProvider,
    })
    // The D15 availability gate, now dynamic for the GPU modalities (P8-M5):
    // text needs a live LLM; image needs a configured ComfyUI whose last health
    // probe passed (fail-closed before the first probe); video needs a ready
    // ComfyUI OR a configured Happyhorse endpoint; audio needs a ready ComfyUI
    // whose inventory covers the Stable Audio template.
    const availability: ModelAvailability = {
      for(modality) {
        if (modality === undefined) return 'available'
        if (modality === 'text') return llmText !== undefined ? 'available' : 'unavailable'
        if (modality === 'image') return comfyProvider !== undefined && comfyProvider.readiness().image ? 'available' : 'unavailable'
        if (modality === 'video') {
          const comfyReady = comfyProvider !== undefined && comfyProvider.readiness().video
          return comfyReady || videoProvider !== undefined ? 'available' : 'unavailable'
        }
        if (modality === 'audio') return comfyProvider !== undefined && comfyProvider.readiness().audio ? 'available' : 'unavailable'
        return 'unavailable'
      },
    }
    // Optional `customer_service` room poster (D15 notice + D8 echo). Absent in
    // the isolated verifier (matrix-chat disabled) -> the notifier degrades to
    // log-only.
    const matrixChat = ctx.get('matrixChat')
    // Optional plugins marketplace (Phase-7 D5/D7). Absent without the
    // dsh-movie-market plugin -> the `plugins/*` namespace answers
    // `unimplemented` and runs proceed skill-less.
    const movieMarket = ctx.get('movieMarket')
    ctx.effect(() => {
      // P8-M5: probe the ComfyUI backend once at activation so the availability
      // gate reflects reality from the first run (fail-closed until it passes).
      if (comfyProvider !== undefined) {
        void comfyProvider.probe(true).then((readiness): void => {
          ctx.logger.info('[movie-gateway] P8 comfy readiness at activation: image=%s video=%s audio=%s', readiness.image, readiness.video, readiness.audio)
        })
      }
      // The Leg B executor schedules prompts as `movie-exec` background jobs.
      // `ctx.jobs.start` refuses work unless an attached controller serves the
      // (here, unowned) job, so attach one for the gateway's lifetime and detach
      // it on teardown (P3-M4 Task 0 finding).
      const detachController = ctx.jobs === undefined ? undefined : ctx.jobs.attachController('movie-gateway')
      handle = startGatewayServer({
        port: config.port,
        identity: ctx.matrixIdentity,
        logger: ctx.logger,
        staticDir,
        bridgeExtensionFile: existsSync(bridgeExtensionFile) ? bridgeExtensionFile : undefined,
        canvasAgent,
        director,
        workspaceRoot,
        mediaProvider: routingMediaProvider,
        availability,
        ...(llmText === undefined ? {} : { stepText: (classType: string, inputs: Record<string, unknown>): Promise<string> => llmText.text(classType, inputs) }),
        ...(llmText === undefined ? {} : { review: (classType: string, artifact: unknown, criteria: string): Promise<string> => llmText.review(classType, artifact, criteria) }),
        ...(matrixChat === undefined ? {} : { matrixChat }),
        ...(movieMarket === undefined ? {} : { movieMarket }),
        // P8-M5: fail-closed pre-run health gate. When ComfyUI is configured but
        // unreachable/lacking template nodes, /prompt answers 503 instead of
        // queueing work onto an unready backend.
        ...(comfyProvider === undefined ? {} : {
          beforeRun: async (): Promise<void> => {
            const readiness = await comfyProvider.probe(true)
            if (!readiness.image && !readiness.video) {
              throw new Error('ComfyUI backend is not ready (health probe failed closed)')
            }
          },
        }),
        // P5-M4 D7: conversation → graph. The Bailian-backed text seam doubles as
        // the cheap intent router (`mineIntent`); without it (no subagents/key) D7
        // stays off and the chat relay is unaffected. `onRoomMessage` subscribes to
        // the global `matrix/room-message` event matrix-chat emits for every inbound
        // HUMAN utterance (the bot's own narration/echo/notice is filtered upstream,
        // so a commit can never re-trigger itself).
        ...(llmText === undefined ? {} : { intentMiner: llmText }),
        onRoomMessage: (handler): (() => void) =>
          ctx.on('matrix/room-message', (message): void => { handler(message) }),
        ...(ctx.jobs === undefined ? {} : { jobs: ctx.jobs }),
      })
      ctx.logger.info('[movie-gateway] Leg B/C gateway active on port %d', config.port)
      return async () => {
        const current = handle
        handle = null
        if (current !== null) await current.stop()
        detachController?.()
        llmText?.dispose()
        director.dispose()
        canvasAgent.dispose()
      }
    })
  } else {
    ctx.logger.warn('[movie-gateway] port is 0; gateway disabled')
  }
}
