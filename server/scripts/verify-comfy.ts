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
import { comfyConfigFromEnv, createComfyProvider, type ComfyProvider } from '../plugins/dsh-movie-gateway/src/movie-executor/comfy-provider.ts'
import { instantiate, loadComfyTemplates, missingNodeTypes, templateFor } from '../plugins/dsh-movie-gateway/src/movie-executor/comfy-templates.ts'
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
  const graph = instantiate(templates.image, { prompt: 'hello world', seed: 42, width: 640, height: 384, steps: 12 })
  check('templates: guarded instantiation (prompt/seed/size/steps)', graph['6']?.inputs.text === 'hello world' && graph['3']?.inputs.seed === 42 && graph['5']?.inputs.width === 640 && graph['3']?.inputs.steps === 12)
  const vgraph = instantiate(templates.video, { prompt: 'a clip', seed: 7, length: 49 })
  check('templates: video seed lands on RandomNoise.noise_seed', vgraph['10']?.inputs.noise_seed === 7 && vgraph['6']?.inputs.length === 49)
  check('templates: missingNodeTypes detects withheld nodes', missingNodeTypes(templates.video, { CheckpointLoaderSimple: {} }).includes('LTXVScheduler'))

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
  check('probe: healthy fixture → image+video ready', healthy.image && healthy.video)
  fx.controls.missingNodes = ['LTXVScheduler']
  const partial = await provider.probe(true)
  check('probe: withheld template node → video not ready, image ready', partial.image && !partial.video)
  fx.controls.missingNodes = []
  fx.controls.healthy = false
  const sick = await provider.probe(true)
  check('probe: unhealthy /system_stats fails closed', !sick.image && !sick.video)
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