/**
 * Phase-8 ComfyUI backend verifier (P8-M2..M5) — fully offline.
 *
 * Exercises the local-first ComfyUI seam against mock ComfyUI fixtures
 * (`fixture-comfy-server.ts`): no GPU, no real models, no network beyond
 * loopback. Covers:
 *
 *  - M2: config gate (`comfyConfigFromEnv`), server-held templates (D10),
 *    guarded instantiation, routing (image/video/fallback), and a full
 *    image + video generation returning real bytes;
 *  - M3: runner integration — bytes → room media post + local artifact copy →
 *    `contentRef {origin:'generated'}` on the executed payload, downstream
 *    output rebasing, and no duplicate text echo;
 *  - M4: /ws progress → percent hook, interrupt (killed + /interrupt),
 *    overall timeout, and the in-flight cap;
 *  - M5: fail-closed health probe, template node coverage, round-robin
 *    pooling across two mock endpoints, and submit failover.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-comfy.ts
 */

import type { ExecMessage, PromptGraph } from '../../protocol/src/index.ts'
import { FUNCTIONAL_NODES } from '../../protocol/src/index.ts'
import { comfyConfigFromEnv, createComfyProvider, type ComfyProvider } from '../plugins/dsh-movie-gateway/src/movie-executor/comfy-provider.ts'
import {
  describeMissingFiles,
  instantiate,
  loadComfyTemplates,
  missingModelFiles,
  missingNodeTypes,
  templateFor,
  TEMPLATE_KEYS,
  type ComfyNode,
  type ComfyTemplate,
} from '../plugins/dsh-movie-gateway/src/movie-executor/comfy-templates.ts'
import { cannedMediaProvider, createRoutingMediaProvider, type MediaGeneration } from '../plugins/dsh-movie-gateway/src/movie-executor/media-provider.ts'
import { startPromptJob, type RunPromptDeps } from '../plugins/dsh-movie-gateway/src/movie-executor/runner.ts'
import { PERMISSIVE_AVAILABILITY } from '../plugins/dsh-movie-gateway/src/movie-executor/model-catalog.ts'
import { createRoomNotifier, type RoomPoster } from '../plugins/dsh-movie-gateway/src/movie-executor/room-notifier.ts'
// Activation: registers the built-in family adapters (Phase-5 D4).
import '../plugins/dsh-movie-gateway/src/movie-executor/adapters/index.ts'
import { startFixtureComfy, FIXTURE_PNG, FIXTURE_MP4 } from './fixture-comfy-server.ts'

/** The jobs seam type, derived from the runner deps (plugin-local package). */
type JobsSeam = RunPromptDeps['jobs']
/** The structural job-hooks shape the fake registry captures. */
interface FakeJobHooks {
  cancel(reason?: string): void
  done: Promise<{ status: string; detail?: string; result?: string }>
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

const logger = { info(): void {}, warn(): void {} }
const templates = loadComfyTemplates()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve): void => { setTimeout(resolve, ms) })
}

/** A minimal in-process JobRegistry stand-in capturing the job hooks. */
function fakeJobs(): { jobs: JobsSeam; hooks: FakeJobHooks[] } {
  const hooks: FakeJobHooks[] = []
  const jobs = {
    start(spec: { run(job: { append(): void; updateProgress(): void }): FakeJobHooks }): string {
      hooks.push(spec.run({ append(): void {}, updateProgress(): void {} }))
      return `job-${hooks.length}`
    },
  } as unknown as JobsSeam
  return { jobs, hooks }
}

/** A fake room poster recording text + media posts (M3). */
function fakePoster(): { poster: RoomPoster; texts: string[]; media: Array<{ roomId: string; filename: string; mime: string; size: number }> } {
  const texts: string[] = []
  const media: Array<{ roomId: string; filename: string; mime: string; size: number }> = []
  const poster: RoomPoster = {
    async postText(_roomId: string, body: string): Promise<boolean> {
      texts.push(body)
      return true
    },
    async postMedia(roomId: string, bytes: Uint8Array, filename: string, mime: string): Promise<string | undefined> {
      media.push({ roomId, filename, mime, size: bytes.byteLength })
      return 'mxc://fixture/generated-001'
    },
  }
  return { poster, texts, media }
}

/** The functional two-node prompt: TextInput → ImageGenerator. */
function imagePrompt(): PromptGraph {
  return {
    '1': { class_type: 'TextInput', inputs: { text: 'a teal sky over the sea' } },
    '2': { class_type: 'ImageGenerator', inputs: { prompt: ['1', 0], image: '' } },
  }
}

/* --- model/VAE pairing helpers (D2) ---------------------------------------- */

/** A graph link `[nodeId, slot]`, or `undefined` when the input is not one. */
function linkOf(value: unknown): [string, number] | undefined {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'number'
    ? [String(value[0]), value[1]]
    : undefined
}

/** Instantiate a template with a throwaway prompt for wiring assertions. */
function wired(template: ComfyTemplate): Record<string, ComfyNode> {
  return instantiate(template, { prompt: 'pairing probe', seed: 1 })
}

/**
 * True when a template decodes through its checkpoint's OWN VAE: the graph holds
 * no `VAELoader` and every `vae` input reads `[ckptNode, 2]`. This is the shape
 * the SDXL, InstantID and audio templates must keep - the shipped bug was an
 * SDXL graph decoding through SD1.5's `sd-vae-ft-mse`, which produced a valid
 * PNG of chroma noise.
 */
function bundledPairingHolds(template: ComfyTemplate | undefined): boolean {
  if (template === undefined || template.meta.vae !== 'bundled') return false
  const graph = wired(template)
  const loaders = Object.values(graph).filter((node): boolean => node.class_type === 'VAELoader')
  if (loaders.length > 0) return false
  return Object.values(graph).every((node): boolean => {
    const link = linkOf(node.inputs.vae)
    return link === undefined || (link[0] === template.meta.ckptNode && link[1] === 2)
  })
}

/**
 * True when a split-model template decodes through its family VAE: a
 * `VAELoader` names exactly `meta.vae` and every `vae` input reads it.
 */
function splitPairingHolds(template: ComfyTemplate | undefined): boolean {
  if (template === undefined || template.meta.vae === 'bundled') return false
  const graph = wired(template)
  const loaderId = template.meta.vaeNode
    ?? Object.entries(graph).find(([, node]): boolean => node.class_type === 'VAELoader')?.[0]
  if (loaderId === undefined) return false
  if (graph[loaderId]?.inputs.vae_name !== template.meta.vae) return false
  return Object.values(graph).every((node): boolean => {
    const link = linkOf(node.inputs.vae)
    return link === undefined || link[0] === loaderId
  })
}

/**
 * The pre-fix SDXL graph shape (standalone `sd-vae-ft-mse` beside a checkpoint
 * that already bundles a VAE), kept here only to prove the override path can
 * convert it to the bundled pairing in one move.
 */
const FOREIGN_VAE_TEMPLATE: ComfyTemplate = {
  meta: {
    modality: 'image', promptNode: '2', negativeNode: '2', latentNode: '3', samplerNode: '4',
    saveNode: '5', seedNode: '4', stepsNode: '4', ckptNode: '1',
    vae: 'sd-vae-ft-mse.safetensors', vaeNode: '9',
  },
  prompt: {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '3': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 64, batch_size: 1 } },
    '4': { class_type: 'KSampler', inputs: { seed: 0, steps: 4, model: ['1', 0], positive: ['2', 0], latent_image: ['3', 0] } },
    '5': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['8', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['9', 0] } },
    '9': { class_type: 'VAELoader', inputs: { vae_name: 'sd-vae-ft-mse.safetensors' } },
  },
}

async function main(): Promise<void> {
  /* --- M2: config gate ---------------------------------------------------- */
  check('config gate: unset DSH_COMFY_BASE_URL → undefined', comfyConfigFromEnv({}) === undefined)
  const cfg = comfyConfigFromEnv({
    DSH_COMFY_BASE_URL: 'http://127.0.0.1:8188/',
    DSH_COMFY_POOL: 'http://127.0.0.1:8189, http://127.0.0.1:8188 ,',
  })
  check('config gate: trailing slash stripped + pool dedup', cfg !== undefined && cfg.endpoints.length === 2 && cfg.endpoints[0] === 'http://127.0.0.1:8188')
  check('config gate: 8GB-envelope defaults (900s timeout, inflight 1)', cfg !== undefined && cfg.timeoutMs === 900_000 && cfg.inflightMax === 1)

  /* --- M2: templates (D10) ------------------------------------------------ */
  check('templates: image + video load', templates.image.meta.modality === 'image' && templates.video.meta.modality === 'video')
  check('templates: templateFor routing map', templateFor('ImageGenerator', templates) === templates.image && templateFor('VideoGenerator', templates) === templates.video && templateFor('TextGenerator', templates) === undefined)

  /* --- Task 3: the model selector ------------------------------------------ */
  check('selector: variant hint routes to the matching template',
    templateFor('ImageGenerator', templates, 'qwen') === templates.imageQwen
    && templateFor('ImageGenerator', templates, 'instantid') === templates.instantid
    && templateFor('ImageGenerator', templates, 'sdxl') === templates.image
    && templateFor('VideoGenerator', templates, 'i2v') === templates.videoI2v)
  const imageSchema = FUNCTIONAL_NODES.find((entry): boolean => entry.classType === 'ImageGenerator')
  const variantWidget = imageSchema?.widgets.find((entry): boolean => entry.name === 'variant')
  check('selector: ImageGenerator publishes a variant COMBO defaulting to qwen',
    variantWidget?.type === 'COMBO' && variantWidget.default === 'qwen'
    && JSON.stringify(variantWidget.options ?? []) === JSON.stringify(['sdxl', 'qwen', 'instantid']))
  check('selector: the skill input is APPENDED at slot 2 (prompt/image slots unchanged)',
    imageSchema?.inputs.map((slot): string => slot.name).join(',') === 'prompt,image,skill')
  const graph = instantiate(templates.image, { prompt: 'hello world', seed: 42, width: 640, height: 384, steps: 12 })
  check('templates: guarded instantiation (prompt/seed/size/steps)', graph['6']?.inputs.text === 'hello world' && graph['3']?.inputs.seed === 42 && graph['5']?.inputs.width === 640 && graph['3']?.inputs.steps === 12)
  const vgraph = instantiate(templates.video, { prompt: 'a clip', seed: 7, length: 49 })
  // Only the FIRST Wan stage takes the seed: stage 2 runs with
  // `add_noise: disable`, so its noise_seed is never consumed.
  check('templates: video seed lands on the noise-adding Wan stage',
    vgraph['7']?.inputs.noise_seed === 7 && vgraph['8']?.inputs.add_noise === 'disable' && vgraph['6']?.inputs.length === 49)
  check('templates: missingNodeTypes detects withheld nodes', missingNodeTypes(templates.video, { CheckpointLoaderSimple: {} }).includes('UNETLoader'))

  /* --- M2: model/VAE pairing (D2) ------------------------------------------ */
  check('pairing: every bundled template declares meta.vae',
    TEMPLATE_KEYS.every((key): boolean => {
      const declared = templates[key]?.meta.vae
      return typeof declared === 'string' && declared !== ''
    }))
  check('pairing: SDXL decodes through its checkpoint’s own VAE (no VAELoader)', bundledPairingHolds(templates.image))
  check('pairing: InstantID decodes through its checkpoint’s own VAE (no VAELoader)', bundledPairingHolds(templates.instantid))
  check('pairing: Stable Audio decodes through its checkpoint’s own VAE (no VAELoader)', bundledPairingHolds(templates.audio))
  check('pairing: Qwen-Image decodes through qwen_image_vae', splitPairingHolds(templates.imageQwen) && templates.imageQwen?.meta.vae === 'qwen_image_vae.safetensors')
  check('pairing: Wan t2v decodes through wan_2.1_vae', splitPairingHolds(templates.video) && templates.video.meta.vae === 'wan_2.1_vae.safetensors')
  check('pairing: Wan VACE i2v decodes through wan_2.1_vae', splitPairingHolds(templates.videoI2v) && templates.videoI2v?.meta.vae === 'wan_2.1_vae.safetensors')

  // missingModelFiles: fail OPEN when the backend publishes no inventory (an
  // unverifiable pairing is not a proven-broken one), CLOSED when it publishes
  // one and our weight is absent.
  check('pairing: missingModelFiles fails OPEN with no published inventory',
    missingModelFiles(templates.video, { UNETLoader: {}, CLIPLoader: {}, VAELoader: {} }).length === 0)
  const renamedUnet = {
    UNETLoader: { input: { required: { unet_name: [['wan2.2_t2v_high_noise_14B.safetensors']] } } },
  }
  check('pairing: missingModelFiles fails CLOSED on a renamed/absent weight',
    describeMissingFiles(missingModelFiles(templates.video, renamedUnet)).includes('UNETLoader.unet_name=wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors'))
  const prefixedUnets = {
    UNETLoader: {
      input: {
        required: {
          unet_name: [[
            'diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
            'diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors',
          ]],
        },
      },
    },
  }
  check('pairing: subfolder-prefixed inventory entries match by basename',
    missingModelFiles(templates.video, prefixedUnets).length === 0)

  // Model overrides must keep the pairing intact.
  let refusedSwap = ''
  try {
    instantiate(templates.video, { prompt: 'x', models: { '1': 'some_other_unet.safetensors' } })
  } catch (error) {
    refusedSwap = error instanceof Error ? error.message : String(error)
  }
  check('overrides: a bare weight swap on a split model is refused (its VAE would be orphaned)', refusedSwap.includes('bundle'))
  let refusedAttach = ''
  try {
    instantiate(templates.image, { prompt: 'x', models: { '1': { vae: 'sd-vae-ft-mse.safetensors' } } })
  } catch (error) {
    refusedAttach = error instanceof Error ? error.message : String(error)
  }
  check('overrides: a foreign VAE cannot be attached to an inline-paired template', refusedAttach.includes('no VAELoader node'))
  const bundleSwap = instantiate(templates.video, {
    prompt: 'x',
    models: { '1': { unet: 'wan2.2_t2v_high_noise_14B.safetensors', vae: 'wan_2.2_vae.safetensors', clip: 'umt5_xxl.safetensors' } },
  })
  check('overrides: a bundle retargets the weights and the paired VAE together',
    bundleSwap['1']?.inputs.unet_name === 'wan2.2_t2v_high_noise_14B.safetensors'
    && bundleSwap['9']?.inputs.vae_name === 'wan_2.2_vae.safetensors'
    && bundleSwap['3']?.inputs.clip_name === 'umt5_xxl.safetensors')
  const bareCkptSwap = instantiate(templates.image, { prompt: 'x', models: { '1': 'sd_xl_refiner_1.0.safetensors' } })
  check('overrides: a bare checkpoint swap is allowed where the VAE is bundled', bareCkptSwap['1']?.inputs.ckpt_name === 'sd_xl_refiner_1.0.safetensors')
  const converted = instantiate(FOREIGN_VAE_TEMPLATE, { prompt: 'x', models: { '1': { ckpt: 'sd_xl_base_1.0.safetensors', vae: 'bundled' } } })
  check('overrides: vae "bundled" rewires decode to [ckptNode,2] and drops the VAELoader',
    converted['9'] === undefined && linkOf(converted['8']?.inputs.vae)?.[0] === '1' && linkOf(converted['8']?.inputs.vae)?.[1] === 2)

  /* --- M2: routing seam ---------------------------------------------------- */
  const tag = (name: string) => ({ async generate(): Promise<MediaGeneration> { return { media: name } } })
  const routing = createRoutingMediaProvider({ image: tag('img'), video: tag('vid'), fallback: cannedMediaProvider })
  check('routing: ImageGenerator → image route', (await routing.generate('ImageGenerator', {})).media === 'img')
  check('routing: VideoGenerator → video route', (await routing.generate('VideoGenerator', {})).media === 'vid')
  check('routing: legacy step → canned fallback', (await routing.generate('MovieTextToImage', {})).media === 'canned')

  /* --- M5: fail-closed probe ---------------------------------------------- */
  const dead = createComfyProvider({ endpoints: ['http://127.0.0.1:1'], pollIntervalMs: 50, timeoutMs: 2000, inflightMax: 1 }, logger, templates)
  check('probe: readiness before any probe fails closed', !dead.readiness().image && !dead.readiness().video)
  const deadResult = await dead.probe(true)
  check('probe: unreachable endpoint fails closed', !deadResult.image && !deadResult.video)

  const fx = await startFixtureComfy({ jobDelayMs: 150 })
  const provider: ComfyProvider = createComfyProvider({ endpoints: [fx.url], pollIntervalMs: 40, timeoutMs: 5000, inflightMax: 1 }, logger, templates)
  const healthy = await provider.probe(true)
  check('probe: healthy fixture → image+video+audio ready', healthy.image && healthy.video && healthy.audio)
  // Withhold a node EVERY video variant needs (both Wan graphs load their
  // diffusion model through UNETLoader). Image stays ready because SDXL does not
  // use it - readiness is per modality, and one covered variant is enough.
  fx.controls.missingNodes = ['UNETLoader']
  const partial = await provider.probe(true)
  check('probe: a node all video variants need → video not ready, image+audio still ready',
    partial.image && !partial.video && partial.audio)
  fx.controls.missingNodes = []

  // Fail-closed needs a provider with NO last-good probe to fall back on: P8-M7
  // deliberately holds the previous readiness for a live provider that hiccups
  // inside the grace window, so a warmed provider cannot demonstrate it.
  fx.controls.healthy = false
  const cold = createComfyProvider({ endpoints: [fx.url], pollIntervalMs: 40, timeoutMs: 5000, inflightMax: 1 }, logger, templates)
  const sick = await cold.probe(true)
  check('probe: unhealthy /system_stats fails closed with no prior good probe', !sick.image && !sick.video && !sick.audio)
  const gracious = await provider.probe(true)
  check('P8-M7: a liveness hiccup inside the grace window holds last-good readiness', gracious.image && !gracious.video)
  fx.controls.healthy = true
  await provider.probe(true)

  /* --- M2: real generation (image + video bytes) --------------------------- */
  const percents: number[] = []
  const image = await provider.generate('ImageGenerator', { prompt: 'a teal sky', seed: 42 }, { onProgress: (p): void => { percents.push(p) } })
  check('generate(image): bytes + mime + filename + view artifact', image.bytes !== undefined && image.bytes.byteLength === FIXTURE_PNG.byteLength && image.mime === 'image/png' && image.filename === 'dsh-movie_00001_.png' && (image.artifact ?? '').startsWith(`${fx.url}/view?`))
  check('generate(image): media tag', image.media === 'image')
  const submitted = fx.prompts[0]?.graph
  check('generate(image): template instantiated server-side (prompt + seed)', submitted?.['6']?.inputs.text === 'a teal sky' && submitted?.['3']?.inputs.seed === 42)
  check('M4: /ws progress mapped to 0..100 hook', percents.length > 0 && percents[percents.length - 1] === 100)

  const video = await provider.generate('VideoGenerator', { prompt: 'a clip' })
  check('generate(video): mp4 bytes + mime', video.bytes !== undefined && video.bytes.byteLength === FIXTURE_MP4.byteLength && video.mime === 'video/mp4' && video.media === 'video')

  /* --- M2: img2img upload path --------------------------------------------- */
  const pngDataUrl = `data:image/png;base64,${FIXTURE_PNG.toString('base64')}`
  const uploadsBefore = fx.uploads
  await provider.generate('ImageGenerator', { prompt: 'restyle', image: pngDataUrl })
  const img2imgGraph = fx.prompts[fx.prompts.length - 1]?.graph
  check('img2img: input uploaded + LoadImage/VAEEncode wired + denoise 0.75', fx.uploads === uploadsBefore + 1 && img2imgGraph?.['90']?.class_type === 'LoadImage' && img2imgGraph?.['91']?.class_type === 'VAEEncode' && img2imgGraph?.['3']?.inputs.denoise === 0.75)
  check('img2img: the encode reads the checkpoint’s bundled VAE (no orphaned VAELoader)',
    linkOf(img2imgGraph?.['91']?.inputs.vae)?.[0] === '1' && linkOf(img2imgGraph?.['91']?.inputs.vae)?.[1] === 2)

  /* --- Task 4: a skill actually reaches the image prompt ------------------- */
  const promptText = (index: number): string => String(fx.prompts[index]?.graph['6']?.inputs.text ?? '')
  await provider.generate('ImageGenerator', {
    prompt: 'a poster for the festival',
    skill: 'hand-lettered title, three-colour palette',
    skills: '## Craft skills\n- keep the horizon low',
  })
  const composed = promptText(fx.prompts.length - 1)
  check('skill: prompt + wired skill + imported skill section all reach the encoder, in that order',
    composed.indexOf('a poster for the festival') === 0
    && composed.indexOf('hand-lettered title') > composed.indexOf('a poster for the festival')
    && composed.indexOf('keep the horizon low') > composed.indexOf('hand-lettered title'))
  await provider.generate('ImageGenerator', { resolved: ['a teal sky over the sea'] })
  check('skill: `resolved` stays the fallback when there is no prompt or skill', promptText(fx.prompts.length - 1) === 'a teal sky over the sea')
  await provider.generate('ImageGenerator', {})
  check('skill: an empty generator still gets the default prompt', promptText(fx.prompts.length - 1) === 'a cinematic scene')

  /* --- M3: runner → room media + artifact + contentRef --------------------- */
  const { poster, texts, media } = fakePoster()
  const writes: Array<{ roomId: string; relPath: string; size: number }> = []
  const artifactWriter = {
    writeArtifact(roomId: string, relPath: string, bytes: Uint8Array): boolean {
      writes.push({ roomId, relPath, size: bytes.byteLength })
      return true
    },
  }
  const notifier = createRoomNotifier(poster, logger, artifactWriter)
  const broadcasted: ExecMessage[] = []
  const { jobs, hooks } = fakeJobs()
  startPromptJob({
    jobs,
    broadcast: (messages): void => { broadcasted.push(...messages) },
    mediaProvider: createRoutingMediaProvider({ image: provider, fallback: cannedMediaProvider }),
    availability: PERMISSIVE_AVAILABILITY,
    roomId: '!room:fixture',
    notifier,
    logger,
    promptId: 'p8-m3',
    number: 1,
    label: 'verify-comfy M3',
  }, imagePrompt(), ['1', '2'])
  const outcome = await hooks[0]?.done
  check('M3: run completes', outcome?.status === 'completed')
  const executedImage = broadcasted.find((m): boolean => m.type === 'executed' && (m.data as { node?: string }).node === '2') as { data: { output: Record<string, unknown> } } | undefined
  const contentRef = executedImage?.data.output.contentRef as { origin?: string; uri?: string; mime?: string } | undefined
  check('M3: executed payload carries generated contentRef (mxc uri)', contentRef?.origin === 'generated' && contentRef.uri === 'mxc://fixture/generated-001' && contentRef.mime === 'image/png')
  check('M3: media posted into the room once', media.length === 1 && media[0]?.roomId === '!room:fixture' && media[0]?.mime === 'image/png')
  check('M3: local artifact copy under artifacts/', writes.length === 1 && (writes[0]?.relPath ?? '').startsWith('artifacts/2-') && writes[0]?.size === FIXTURE_PNG.byteLength)
  check('M3: no duplicate text echo for the media node', !texts.some((body): boolean => body.includes('[ImageGenerator]')))
  check('M3: node output rebased to the media uri', executedImage?.data.output.artifact === 'mxc://fixture/generated-001')

  /* --- Task 4 end-to-end: a LINKED skill TextInput reaches the image prompt -- */
  // The adapter used to write `prompt: ''` over the resolved link for every media
  // generator (they have no prompt widget), so only `resolved` survived and a
  // skill wired into slot 2 never reached the text encoder.
  const skillRun = fakeJobs()
  const skillBroadcast: ExecMessage[] = []
  const promptsBeforeSkill = fx.prompts.length
  startPromptJob({
    jobs: skillRun.jobs,
    broadcast: (messages): void => { skillBroadcast.push(...messages) },
    mediaProvider: provider,
    availability: PERMISSIVE_AVAILABILITY,
    logger,
    promptId: 'p8-task4-skill',
    number: 3,
    label: 'verify-comfy task4 linked skill',
  }, {
    '1': { class_type: 'TextInput', inputs: { text: 'a lighthouse at dawn' } },
    '2': { class_type: 'TextInput', inputs: { text: 'painterly matte-painting skill' } },
    '3': { class_type: 'ImageGenerator', inputs: { prompt: ['1', 0], skill: ['2', 0] } },
  }, ['1', '2', '3'])
  const skillOutcome = await skillRun.hooks[0]?.done
  const linkedPrompt = String(fx.prompts[promptsBeforeSkill]?.graph['6']?.inputs.text ?? '')
  check('task4: run completes with a skill wired into slot 2', skillOutcome?.status === 'completed')
  check('task4: the generator node executed', skillBroadcast.some((message): boolean =>
    message.type === 'executed' && (message.data as { node?: string }).node === '3'))
  check('task4: BOTH the linked prompt and the linked skill reach the encoder',
    linkedPrompt.includes('a lighthouse at dawn') && linkedPrompt.includes('painterly matte-painting skill'))

  /* --- M4: interrupt -------------------------------------------------------- */
  fx.controls.hang = true
  const interruptBroadcast: ExecMessage[] = []
  const interrupted = fakeJobs()
  startPromptJob({
    jobs: interrupted.jobs,
    broadcast: (messages): void => { interruptBroadcast.push(...messages) },
    mediaProvider: provider,
    availability: PERMISSIVE_AVAILABILITY,
    logger,
    promptId: 'p8-m4-interrupt',
    number: 2,
    label: 'verify-comfy M4 interrupt',
  }, { '2': { class_type: 'ImageGenerator', inputs: { prompt: 'hang please' } } }, ['2'])
  await sleep(120) // let the job submit + start polling
  const interruptsBefore = fx.interrupts
  interrupted.hooks[0]?.cancel('user-stop')
  const killed = await interrupted.hooks[0]?.done
  await sleep(80) // the fire-and-forget /interrupt POST settles asynchronously
  check('M4: interrupt settles killed', killed?.status === 'killed')
  check('M4: execution_interrupted broadcast', interruptBroadcast.some((m): boolean => m.type === 'execution_interrupted'))
  check('M4: remote /interrupt issued', fx.interrupts > interruptsBefore)
  fx.controls.hang = false

  /* --- M4: timeout ---------------------------------------------------------- */
  fx.controls.hang = true
  const impatient = createComfyProvider({ endpoints: [fx.url], pollIntervalMs: 40, timeoutMs: 250, inflightMax: 1 }, logger, templates)
  let timeoutMessage = ''
  try {
    await impatient.generate('ImageGenerator', { prompt: 'too slow' })
  } catch (error) {
    timeoutMessage = error instanceof Error ? error.message : String(error)
  }
  check('M4: overall timeout rejects + interrupts', timeoutMessage.includes('timed out') && fx.interrupts > interruptsBefore)
  fx.controls.hang = false

  /* --- M4: in-flight cap ----------------------------------------------------- */
  // A dedicated fixture: the shared one still carries the never-completing
  // hung interrupt job in its active count, which would pollute the peak.
  const fxcap = await startFixtureComfy({ jobDelayMs: 200 })
  const capped = createComfyProvider({ endpoints: [fxcap.url], pollIntervalMs: 40, timeoutMs: 5000, inflightMax: 1 }, logger, templates)
  const [a, b] = await Promise.all([
    capped.generate('ImageGenerator', { prompt: 'first' }),
    capped.generate('ImageGenerator', { prompt: 'second' }),
  ])
  check('M4: inflight cap serializes (both complete, peak concurrency 1)', a.bytes !== undefined && b.bytes !== undefined && fxcap.maxActive === 1)
  await fxcap.stop()

  /* --- M5: pooling + failover ------------------------------------------------ */
  const fx2 = await startFixtureComfy({ jobDelayMs: 100 })
  const pooled = createComfyProvider({ endpoints: [fx.url, fx2.url], pollIntervalMs: 40, timeoutMs: 5000, inflightMax: 2 }, logger, templates)
  const fxCountBefore = fx.prompts.length
  const fx2CountBefore = fx2.prompts.length
  await pooled.generate('ImageGenerator', { prompt: 'rr-1' })
  await pooled.generate('ImageGenerator', { prompt: 'rr-2' })
  check('M5: round-robin pooling spreads jobs across endpoints', fx.prompts.length === fxCountBefore + 1 && fx2.prompts.length === fx2CountBefore + 1)
  fx.controls.promptStatus = 500
  const failover = await pooled.generate('ImageGenerator', { prompt: 'failover' })
  check('M5: submit failover to the healthy endpoint', failover.bytes !== undefined && fx2.prompts.length === fx2CountBefore + 2)
  fx.controls.promptStatus = 200

  /* --- M5: per-variant coverage gate (D2 pairing pre-flight) ---------------- */
  // A backend that is alive and publishes every node class can still be missing
  // ONE variant's weights. The modality stays ready (another variant covers it),
  // but the requested variant must be refused before any bytes are uploaded,
  // with the offending filename in the message - not as a mid-run exception.
  const fxq = await startFixtureComfy({ jobDelayMs: 100, missingFiles: ['qwen_image_fp8_e4m3fn.safetensors'] })
  const qwenless = createComfyProvider({ endpoints: [fxq.url], pollIntervalMs: 40, timeoutMs: 5000, inflightMax: 1 }, logger, templates)
  const qwenlessReadiness = await qwenless.probe(true)
  check('variant gate: one withheld weight leaves the modality ready via its other variants',
    qwenlessReadiness.image && qwenlessReadiness.video && qwenlessReadiness.audio)
  let variantMessage = ''
  try {
    await qwenless.generate('ImageGenerator', { prompt: 'a poster', variant: 'qwen' })
  } catch (error) {
    variantMessage = error instanceof Error ? error.message : String(error)
  }
  check('variant gate: the uncovered variant is refused at submit, naming the missing file',
    variantMessage.includes('not runnable') && variantMessage.includes('qwen_image_fp8_e4m3fn.safetensors') && fxq.prompts.length === 0)
  const coveredVariant = await qwenless.generate('ImageGenerator', { prompt: 'a poster' })
  check('variant gate: a covered variant still runs on the same backend', coveredVariant.bytes !== undefined && fxq.prompts.length === 1)
  await fxq.stop()

  /* --- M4: execution_error surfaces ------------------------------------------ */
  fx.controls.fail = true
  let errorMessage = ''
  try {
    await provider.generate('ImageGenerator', { prompt: 'fail please' })
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  }
  check('M4: backend execution_error rejects the generation', errorMessage.includes('comfy generation failed'))

  await fx.stop()
  await fx2.stop()

  process.stdout.write(failures === 0 ? '\nverify-comfy: ALL PASS\n' : `\nverify-comfy: ${failures} FAILURE(S)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()