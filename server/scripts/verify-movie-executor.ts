/**
 * Leg B movie-executor verifier (Phase-3 P3-M4 §6, Phase-5 P5-M1/M2/M4).
 *
 * Two layers:
 *
 *  1. OFFLINE / deterministic (no network, no LLM): the executor registry,
 *     prompt validator, and topological sort that back the rewired
 *     `POST /prompt`:
 *     - `registry` advertises all six {@link MOVIE_NODES} class types plus the
 *       eleven functional class types (Phase-5 D3);
 *     - `validatePromptGraph` accepts the demo graph, rejects an unknown
 *       `class_type`, a link to a missing node, an out-of-range slot, and —
 *       new in Phase-5 D2 — a link whose source/target slot types are
 *       incompatible, while a subtype link (SCRIPT → TEXT) stays valid;
 *     - a functional join graph (image input + text input → image generator)
 *       and a fork graph (one source feeding two consumers) validate and
 *       topo-sort sources-first;
 *     - the D1 handler registry resolves functional class types to their
 *       family adapter, and leaves legacy step types on the fallback path;
 *     - the D15 availability gate fails an unbacked-modality generator with a
 *       `ModelUnavailableError`, the room notifier posts the customer_service
 *       notice (and degrades log-only without a poster/room), and the text
 *       seam runs through injected fakes;
 *     - `topoSort` orders a linked chain 1->6 regardless of insertion order and
 *       detects a cycle.
 *
 *  2. LIVE gateway (movie-profile host up: gateway 8788): `POST /prompt`
 *     validates first (400 + `node_errors` on a bad class_type / bad link /
 *     type mismatch) and, when accepted, is scheduled as a `movie-exec` job
 *     that drives the `/ws` execution lifecycle across all node ids in
 *     topological order (executing -> progress -> executed ->
 *     execution_success) — for both the legacy six-step chain and the
 *     functional join/fork graphs.
 *
 * Run from the `server/` directory:
 *   node scripts/verify-movie-executor.ts
 */

import {
  FUNCTIONAL_NODES,
  MOVIE_NODES,
  isExecMessage,
  type CacheCard,
  type CachePiece,
  type ExecMessage,
  type PromptGraph,
} from '../../protocol/src/index.ts'
import { classTypeOutputs, handlerFor, isKnownClassType, objectInfoFromMovieNodes, type NodeHandlerContext } from '../plugins/dsh-movie-gateway/src/movie-executor/registry.ts'
// Activation: registers the built-in family adapters (Phase-5 D4).
import '../plugins/dsh-movie-gateway/src/movie-executor/adapters/index.ts'
import { validatePromptGraph } from '../plugins/dsh-movie-gateway/src/movie-executor/validate.ts'
import { topoSort } from '../plugins/dsh-movie-gateway/src/movie-executor/topo.ts'
// Phase-5 P5-M2: the D15 availability gate, its typed error, and the room
// notifier (customer_service notice + D8 echo).
import { ModelUnavailableError, isModelUnavailable } from '../plugins/dsh-movie-gateway/src/movie-executor/errors.ts'
import {
  MODEL_UNAVAILABLE_NOTICE,
  PERMISSIVE_AVAILABILITY,
  availabilityFromInventory,
  staticAvailability,
  type ModelAvailability,
} from '../plugins/dsh-movie-gateway/src/movie-executor/model-catalog.ts'
import { createRoomNotifier, type RoomPoster } from '../plugins/dsh-movie-gateway/src/movie-executor/room-notifier.ts'
import {
  loadComfyTemplates,
  templateByModelFile,
  type ComfyTemplate,
} from '../plugins/dsh-movie-gateway/src/movie-executor/comfy-templates.ts'

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8788'
const wsBase = gatewayUrl.replace(/^http/, 'ws')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

/** The six movie class types in pipeline (step) order. */
const ORDERED_CLASS_TYPES: string[] = [...MOVIE_NODES]
  .sort((a, b): number => (a.step ?? 0) - (b.step ?? 0))
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
 * The Phase-5 join graph: image input + text request → image generator
 * (`image_to_image`), inserted generator-first so topo sort must reorder.
 */
function joinPrompt(): PromptGraph {
  return {
    '3': { class_type: 'ImageGenerator', inputs: { prompt: ['2', 0], image: ['1', 0], mode: 'image_to_image' } },
    '1': { class_type: 'ImageInput', inputs: { image: 'asset-ref.png' } },
    '2': { class_type: 'TextInput', inputs: { text: 'make the sky teal' } },
  }
}

/** The Phase-5 fork graph: one text source feeding two consumers. */
function forkPrompt(): PromptGraph {
  return {
    '1': { class_type: 'TextInput', inputs: { text: 'a logline' } },
    '2': { class_type: 'TextGenerator', inputs: { context: ['1', 0], prompt: 'write the script' } },
    '3': { class_type: 'TextGenerator', inputs: { context: ['1', 0], prompt: 'write the shot list' } },
  }
}

/** A type-mismatched link: AUDIO output into an IMAGE input (D2 rejects). */
function mismatchPrompt(): PromptGraph {
  return {
    '1': { class_type: 'AudioInput', inputs: { audio: 'bgm.mp3' } },
    '2': { class_type: 'ImageGenerator', inputs: { image: ['1', 0] } },
  }
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

  // Phase-5: the merged catalog also advertises the functional classes.
  const missingFunctional = FUNCTIONAL_NODES
    .map((node): string => node.classType)
    .filter((classType): boolean => !(classType in catalog))
  check('registry advertises all twelve functional class types', missingFunctional.length === 0, missingFunctional.length === 0 ? '12 classes' : `missing: ${missingFunctional.join(', ')}`)

  // Phase-5 D1: handler registry resolves functional classes; legacy steps stay
  // on the fallback path (no registered handler).
  check('every functional class type resolves to a registered handler', FUNCTIONAL_NODES.every((node): boolean => handlerFor(node.classType) !== undefined))
  check('legacy step class types keep the fallback path (no handler)', ORDERED_CLASS_TYPES.every((classType): boolean => handlerFor(classType) === undefined))

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

  // Phase-5 D2: link type compatibility.
  check('validate accepts the functional join graph', validatePromptGraph(joinPrompt()).ok)
  check('validate accepts the functional fork graph', validatePromptGraph(forkPrompt()).ok)
  const mismatch = validatePromptGraph(mismatchPrompt())
  check(
    'validate rejects an AUDIO → IMAGE type mismatch (D2)',
    !mismatch.ok && mismatch.nodeErrors['2']?.errors.some((e): boolean => e.includes('type mismatch')) === true,
    mismatch.ok ? 'accepted' : JSON.stringify(mismatch.nodeErrors['2']?.errors ?? []),
  )
  const subtypeLink = validatePromptGraph({
    '1': { class_type: 'MovieScript', inputs: {} },
    '2': { class_type: 'TextGenerator', inputs: { context: ['1', 0] } },
  })
  check('validate accepts a legacy SCRIPT → TEXT subtype link (R2)', subtypeLink.ok)

  // Phase-5: functional join/fork graphs topo-sort sources-first.
  const joinSorted = topoSort(joinPrompt())
  check(
    'topoSort orders the join graph sources-first',
    joinSorted.ok && joinSorted.order.indexOf('3') === 2 && joinSorted.order.slice(0, 2).sort().join(',') === '1,2',
    joinSorted.ok ? joinSorted.order.join(' -> ') : `cycle: ${joinSorted.cycle.join(', ')}`,
  )
  const forkSorted = topoSort(forkPrompt())
  check(
    'topoSort orders the fork graph source-first',
    forkSorted.ok && forkSorted.order[0] === '1',
    forkSorted.ok ? forkSorted.order.join(' -> ') : `cycle: ${forkSorted.cycle.join(', ')}`,
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

/** Build a minimal handler context for an offline adapter check. */
function handlerCtx(availability: ModelAvailability, overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return { inputs: {}, resolve: (): unknown => undefined, availability, ...overrides }
}

/** A media seam fake that tags the artifact with the producing class. */
const fakeMedia = {
  async generate(classType: string): Promise<{ artifact?: string; media?: string }> {
    return { artifact: `rendered:${classType}`, media: 'video' }
  },
}

/**
 * Phase-5 P5-M2 offline checks: the D15 model-availability gate, its typed
 * error, the room notifier (customer_service notice + D8 echo), and the
 * generator/text adapter seams — all deterministic, no host/LLM.
 */
async function availabilityChecks(): Promise<void> {
  process.stdout.write('\n— offline: D15 availability gate + room notifier + adapter seams —\n')

  // The gate: a Bailian-only inventory (text yes; image/video/audio no).
  const bailianOnly = availabilityFromInventory({ text: true, video: false, image: false, audio: false })
  check(
    'D15 gate: text available, image/video/audio unavailable on the Bailian-only inventory',
    bailianOnly.for('text') === 'available' && bailianOnly.for('image') === 'unavailable'
      && bailianOnly.for('video') === 'unavailable' && bailianOnly.for('audio') === 'unavailable',
  )
  const partial = staticAvailability({ video: 'available' })
  check(
    'D15 gate: unlisted modalities fail closed; an undefined modality is never gated',
    partial.for('video') === 'available' && partial.for('image') === 'unavailable' && partial.for(undefined) === 'available',
  )
  check(
    'D15 gate: PERMISSIVE_AVAILABILITY opens every modality (dev affordance)',
    PERMISSIVE_AVAILABILITY.for('image') === 'available' && PERMISSIVE_AVAILABILITY.for('audio') === 'available',
  )

  // The typed error the gate throws.
  const err = new ModelUnavailableError('image', 'ImageGenerator')
  check(
    'ModelUnavailableError carries the D15 reason/modality/class + notice message',
    isModelUnavailable(err) && err.reason === 'model-unavailable' && err.modality === 'image'
      && err.classType === 'ImageGenerator' && err.message === MODEL_UNAVAILABLE_NOTICE,
  )

  // The room notifier with a fake poster (customer_service voice).
  const posted: Array<{ roomId: string; body: string }> = []
  const fakePoster: RoomPoster = {
    async postText(roomId: string, body: string): Promise<boolean> {
      posted.push({ roomId, body })
      return true
    },
  }
  const quietLogger = { info(): void { /* swallow */ }, warn(): void { /* swallow */ } }
  const notifier = createRoomNotifier(fakePoster, quietLogger)
  await notifier.notifyModelUnavailable('!room:x', 'ImageGenerator', 'image')
  check(
    'room notifier posts the D15 customer_service notice (text + node + modality)',
    posted.length === 1 && posted[0]!.roomId === '!room:x'
      && posted[0]!.body.includes(MODEL_UNAVAILABLE_NOTICE)
      && posted[0]!.body.includes('ImageGenerator') && posted[0]!.body.includes('image'),
    posted[0]?.body ?? 'none',
  )
  posted.length = 0
  await notifier.echoArtifact('!room:x', 'VideoGenerator', 'https://v/clip.mp4', 'media')
  await notifier.echoArtifact('!room:x', 'TextGenerator', 'hello world', 'text')
  await notifier.echoArtifact('!room:x', 'TextGenerator', '', 'text')
  check(
    'room notifier frames a media echo, passes text through, and skips empty artifacts',
    posted.length === 2 && posted[0]!.body === '[VideoGenerator] https://v/clip.mp4' && posted[1]!.body === 'hello world',
    posted.map((entry): string => entry.body).join(' | '),
  )
  posted.length = 0
  await notifier.notifyModelUnavailable('', 'ImageGenerator', 'image')
  check('room notifier skips posting when the run carries no room', posted.length === 0)
  let degraded = true
  try {
    await createRoomNotifier(undefined, quietLogger).notifyModelUnavailable('!room:x', 'ImageGenerator', 'image')
  } catch { degraded = false }
  check('room notifier degrades to log-only without a poster (isolated verifier)', degraded)

  // The generator adapter gate: an unbacked image generator throws.
  const imageHandler = handlerFor('ImageGenerator')
  let threw: unknown
  try {
    await imageHandler?.run(handlerCtx(bailianOnly, { inputs: { prompt: 'a teal sky' } }))
  } catch (error) { threw = error }
  check(
    'D15 adapter gate: an image generator throws ModelUnavailableError when unbacked',
    isModelUnavailable(threw) && (threw as ModelUnavailableError).modality === 'image',
    threw instanceof Error ? threw.message : String(threw),
  )

  // An available video generator calls the media seam.
  const withVideo = availabilityFromInventory({ text: true, video: true, image: false, audio: false })
  const videoOut = await handlerFor('VideoGenerator')?.run(handlerCtx(withVideo, { inputs: { prompt: 'a robot paints' }, media: fakeMedia }))
  check(
    'D15 adapter gate: an available video generator calls the media seam',
    videoOut?.artifact === 'rendered:VideoGenerator' && videoOut?.media === 'video',
    videoOut?.artifact ?? 'none',
  )

  // The unified REF slot: ONE variadic `in` port carries mixed-modality links;
  // the adapter's internal split routes each link by its SOURCE output type —
  // TEXT-family elements join into `prompt`, IMAGE-family elements collect
  // into the ordered `image` array (the keys promptOf/imageRefs consume).
  let capturedInputs: Record<string, unknown> = {}
  const captureMedia = {
    async generate(_classType: string, inputs: Record<string, unknown>): Promise<{ artifact?: string; media?: string }> {
      capturedInputs = inputs
      return { artifact: 'rendered:VideoGenerator', media: 'video' }
    },
  }
  const refOut = await handlerFor('VideoGenerator')?.run(handlerCtx(withVideo, {
    inputs: { in: [['1', 0], ['2', 0], ['3', 0]], mode: 'image_to_video', duration: 6 },
    resolve: (id: string): unknown =>
      id === '1' ? 'shot text' : id === '2' ? 'https://img/frame-a.png' : 'https://img/frame-b.png',
    linkSourceType: (id: string): string | undefined =>
      id === '1' ? 'SHOT_PLAN' : id === '2' || id === '3' ? 'STORYBOARD' : undefined,
    media: captureMedia,
  }))
  check(
    'REF adapter: text links join into `prompt`, image links collect into `image` in link order',
    capturedInputs['prompt'] === 'shot text'
      && Array.isArray(capturedInputs['image'])
      && (capturedInputs['image'] as unknown[]).join(',') === 'https://img/frame-a.png,https://img/frame-b.png'
      && capturedInputs['in'] === undefined
      && refOut?.artifact === 'rendered:VideoGenerator',
    JSON.stringify({ prompt: capturedInputs['prompt'], image: capturedInputs['image'], in: capturedInputs['in'] }),
  )

  // The text generator seam (real LLM) and its honest canned fallback.
  const textHandler = handlerFor('TextGenerator')
  const textLlm = await textHandler?.run(handlerCtx(bailianOnly, { inputs: { prompt: 'write a logline' }, text: async (classType: string): Promise<string> => `llm:${classType}` }))
  check('text generator routes through the injected LLM seam', textLlm?.artifact === 'llm:TextGenerator' && textLlm?.media === 'llm', textLlm?.artifact ?? 'none')
  const textCanned = await textHandler?.run(handlerCtx(bailianOnly, { inputs: { prompt: 'write a logline' } }))
  check(
    'text generator falls back to honest canned text without a seam',
    textCanned?.media === 'canned' && typeof textCanned?.artifact === 'string' && textCanned.artifact.includes('canned'),
    textCanned?.artifact ?? 'none',
  )

  // Phase-2 vision: a linked IMAGE slot reaches the text seam as an ordered
  // array of resolved refs under its own key, and never leaks into the
  // composed prompt sections (`resolved`).
  let visionInputs: Record<string, unknown> = {}
  const visionOut = await textHandler?.run(handlerCtx(bailianOnly, {
    inputs: { prompt: 'describe the picture', image: [['imgNode', 0]] },
    resolve: (): unknown => 'https://example.invalid/x.png',
    text: async (_classType: string, inputs: Record<string, unknown>): Promise<string> => {
      visionInputs = inputs
      return 'vision-ok'
    },
  }))
  const visionImage = visionInputs['image']
  check(
    'vision: the image slot reaches the text seam as an ordered array of resolved refs',
    Array.isArray(visionImage) && visionImage[0] === 'https://example.invalid/x.png',
    JSON.stringify(visionImage ?? null),
  )
  const visionResolved = visionInputs['resolved']
  check(
    'vision: image urls never leak into the resolved prompt sections',
    Array.isArray(visionResolved) && !visionResolved.some((entry): boolean => String(entry).includes('example.invalid')),
    JSON.stringify(visionResolved ?? null),
  )
  check('vision: the text generator returns the seam artifact with images linked', visionOut?.artifact === 'vision-ok', visionOut?.artifact ?? 'none')

  // Phase-3 image model selector: a pinned Plugins-catalog checkpoint filename
  // resolves to the bundled template whose PRIMARY weight it is (so the paired
  // VAE travels with it); an unknown pin resolves to nothing, and the provider
  // then keeps the variant widget's bundle.
  const pinnedTemplates = loadComfyTemplates()
  const primaryWeight = (template: ComfyTemplate | undefined): string => {
    if (template === undefined) return ''
    const node = template.prompt[template.meta.ckptNode]
    for (const field of ['ckpt_name', 'unet_name']) {
      const value = node?.inputs[field]
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  }
  const qwenWeight = primaryWeight(pinnedTemplates.imageQwen)
  const sdxlWeight = primaryWeight(pinnedTemplates.image)
  const videoWeight = primaryWeight(pinnedTemplates.video)
  check(
    'image model pin: the qwen bundle primary weight maps back to the qwen template',
    qwenWeight !== '' && templateByModelFile(pinnedTemplates, qwenWeight) === pinnedTemplates.imageQwen,
    qwenWeight,
  )
  check(
    'image model pin: the sdxl bundle primary weight maps back to the sdxl template',
    sdxlWeight !== '' && templateByModelFile(pinnedTemplates, sdxlWeight) === pinnedTemplates.image,
    sdxlWeight,
  )
  check(
    'image model pin: a subfolder-prefixed inventory listing still matches (basename compare)',
    sdxlWeight !== '' && templateByModelFile(pinnedTemplates, `checkpoints/${sdxlWeight}`) === pinnedTemplates.image,
  )
  check(
    'image model pin: an unknown checkpoint matches no bundled template (variant fallback)',
    templateByModelFile(pinnedTemplates, 'not_a_model.safetensors') === undefined,
  )
  check(
    'image model pin: a video weight never captures the image selector',
    videoWeight === '' || templateByModelFile(pinnedTemplates, videoWeight) === undefined,
    videoWeight,
  )

  // ── Cache node (Utilities): arrival cards, monotonic seq across runs, a
  //    multi-piece card from an upstream Cache replay, delete/reorder reflected
  //    in the replayed output order, and variadic array-splicing into MediaConcat
  //    — all offline against a fake card store (no room, no host). ──
  process.stdout.write('\n— offline: Cache node card semantics —\n')
  const cacheHandler = handlerFor('Cache')
  const cacheStore: CacheCard[] = []
  let cacheSeq = 0
  const cacheSeam = {
    read: (): CacheCard[] => cacheStore,
    append: (arrivals: { sourceName: string; pieces: CachePiece[] }[]): CacheCard[] => {
      for (const arrival of arrivals) {
        cacheSeq += 1
        cacheStore.push({ seq: cacheSeq, sourceName: arrival.sourceName, arrivedAt: 0, pieces: arrival.pieces })
      }
      return cacheStore
    },
  }
  const titleOf = (id: string): string => id
  const replayOf = (out: { outputs?: unknown[] } | undefined): string =>
    Array.isArray(out?.outputs?.[0]) ? (out?.outputs?.[0] as string[]).join(',') : ''

  // Run 1: node "A" arrives once → card seq 1, replayed as its single piece.
  const run1 = await cacheHandler?.run(handlerCtx(PERMISSIVE_AVAILABILITY, {
    inputs: { in: ['A', 0] },
    resolve: (): unknown => 'hello',
    linkSourceType: (): string | undefined => 'TEXT',
    nodeTitle: titleOf,
    cache: cacheSeam,
  }))
  check(
    'Cache run 1 appends one card (seq 1, source A) and replays its single piece',
    cacheStore.length === 1 && cacheStore[0]!.seq === 1 && cacheStore[0]!.sourceName === 'A' && replayOf(run1) === 'hello',
    JSON.stringify({ seqs: cacheStore.map((c): number => c.seq), out: run1?.outputs?.[0] }),
  )

  // Run 2: node "B" arrives → seq 2 (monotonic across runs); replay holds both.
  const run2 = await cacheHandler?.run(handlerCtx(PERMISSIVE_AVAILABILITY, {
    inputs: { in: ['B', 0] },
    resolve: (): unknown => 'world',
    nodeTitle: titleOf,
    cache: cacheSeam,
  }))
  check(
    'Cache run 2 appends seq 2 (monotonic across runs) and replays both cards in order',
    cacheStore.length === 2 && cacheStore[1]!.seq === 2 && replayOf(run2) === 'hello,world',
    JSON.stringify(run2?.outputs?.[0]),
  )

  // Multi-piece card: an upstream Cache replay arrives as an ARRAY → ONE card, N pieces.
  await cacheHandler?.run(handlerCtx(PERMISSIVE_AVAILABILITY, {
    inputs: { in: ['C', 0] },
    resolve: (): unknown => ['p1', 'p2', 'p3'],
    nodeTitle: titleOf,
    cache: cacheSeam,
  }))
  const multi = cacheStore[cacheStore.length - 1]!
  check(
    'Cache folds an upstream list arrival into ONE multi-piece card (seq keeps incrementing)',
    multi.seq === 3 && multi.pieces.length === 3 && multi.pieces.map((piece): string => piece.artifact).join(',') === 'p1,p2,p3',
    JSON.stringify({ seq: multi.seq, pieces: multi.pieces.length }),
  )

  // Delete card seq 2 (a host editor action); the next no-arrival run replays
  // only the surviving cards, in order, and the seq counter is never reused.
  const deleteIdx = cacheStore.findIndex((card): boolean => card.seq === 2)
  if (deleteIdx >= 0) cacheStore.splice(deleteIdx, 1)
  const runAfterDelete = await cacheHandler?.run(handlerCtx(PERMISSIVE_AVAILABILITY, { inputs: {}, cache: cacheSeam }))
  check(
    'Cache delete removes the card from the replayed output',
    cacheStore.length === 2 && replayOf(runAfterDelete) === 'hello,p1,p2,p3',
    JSON.stringify(runAfterDelete?.outputs?.[0]),
  )

  // Reorder (editor shuffle-drag): reverse the CARD order; the replay follows
  // the new card order (a multi-piece card keeps its internal piece order).
  cacheStore.reverse()
  const runAfterReorder = await cacheHandler?.run(handlerCtx(PERMISSIVE_AVAILABILITY, { inputs: {}, cache: cacheSeam }))
  check(
    'Cache reorder is reflected in the replayed output order',
    replayOf(runAfterReorder) === 'p1,p2,p3,hello',
    JSON.stringify(runAfterReorder?.outputs?.[0]),
  )

  // Variadic-output splicing: an array-valued Cache replay fed into MediaConcat
  // (Effect) splices element-wise into the concat parts list, ahead of slot b.
  const concatOut = await handlerFor('MediaConcat')?.run(handlerCtx(PERMISSIVE_AVAILABILITY, {
    inputs: { a: ['cacheNode', 0], b: ['tailNode', 0] },
    resolve: (id: string): unknown => (id === 'cacheNode' ? ['x', 'y'] : 'z'),
  }))
  check(
    'MediaConcat splices an array-valued Cache replay into its ordered parts',
    concatOut?.artifact === '[concat 3 media part(s)] x + y + z',
    concatOut?.artifact ?? 'none',
  )
}

/** Read a lifecycle frame's `prompt_id` (absent on the global `status` frame). */
function promptIdOf(message: ExecMessage): string | undefined {
  return (message.data as { prompt_id?: string | undefined }).prompt_id
}

/**
 * Collect the Leg B lifecycle over `/ws` for one submitted `/prompt`.
 *
 * The `/ws` broadcast is global (every connected client sees every job), so the
 * collector submits first, learns its own `prompt_id` from the POST response,
 * and keeps only frames for that run — frames from any other concurrent job are
 * dropped. Frames that arrive before the id is known are held in a pending
 * buffer and filtered once it is.
 */
function collectLifecycle(prompt: PromptGraph, timeoutMs = 90_000): Promise<ExecMessage[]> {
  return new Promise((resolveCollect, rejectCollect) => {
    const socket = new WebSocket(`${wsBase}/ws`)
    const messages: ExecMessage[] = []
    const pending: ExecMessage[] = []
    let targetPromptId: string | undefined
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      rejectCollect(new Error('Leg B lifecycle timed out'))
    }, timeoutMs)

    /** Admit one frame if it belongs to this run; resolve on its terminal frame. */
    function admit(message: ExecMessage): void {
      const pid = promptIdOf(message)
      if (targetPromptId !== undefined && pid !== undefined && pid !== targetPromptId) return
      messages.push(message)
      const terminal = message.type === 'execution_success' || message.type === 'execution_error'
      if (terminal && targetPromptId !== undefined && pid === targetPromptId) {
        clearTimeout(timer)
        socket.close()
        resolveCollect(messages)
      }
    }

    socket.addEventListener('open', () => {
      void (async () => {
        const resp = await fetch(`${gatewayUrl}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        const body = (await resp.json()) as { prompt_id?: string | undefined }
        targetPromptId = body.prompt_id
        // Flush any frames that arrived before the id was known.
        for (const message of pending.splice(0)) admit(message)
      })().catch((error: unknown): void => rejectCollect(error instanceof Error ? error : new Error(String(error))))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (!isExecMessage(parsed)) return
      if (targetPromptId === undefined) pending.push(parsed)
      else admit(parsed)
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

  // Phase-5 D2: a type-mismatched link is rejected 400 with node_errors.
  const badType = await postPrompt(mismatchPrompt())
  check(
    'POST /prompt rejects a type-mismatched link with 400 node_errors',
    badType.status === 400 && badType.body.error === 'invalid_prompt' && badType.body.node_errors !== undefined,
    `status ${badType.status} ${badType.body.error ?? ''}`,
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

  // Phase-5: the functional fork graph (all text nodes) runs in topo
  // order through the family adapters (D4) and fans out from one source. Text
  // nodes are never gated by D15 — they ride the LLM seam when a key is present
  // and fall back to honest canned text otherwise — so this stays green offline.
  for (const [label, prompt, expectedCount] of [
    ['fork', forkPrompt(), 3],
  ] as [string, PromptGraph, number][]) {
    try {
      const messages = await collectLifecycle(prompt)
      const executingOrder = messages
        .filter((message): boolean => message.type === 'executing')
        .map((message): string | null => (message.type === 'executing' ? message.data.node : null))
        .filter((node): node is string => typeof node === 'string')
      const executedCount = messages.filter((message): boolean => message.type === 'executed').length
      check(
        `POST /prompt drives the ${label} graph lifecycle (${String(expectedCount)} nodes)`,
        executingOrder.length === expectedCount
          && executedCount === expectedCount
          && executingOrder[executingOrder.length - 1] !== '1'
          && messages.some((message): boolean => message.type === 'execution_success'),
        `executing: ${executingOrder.join(' -> ') || 'none'}`,
      )
    } catch (error) {
      check(`Leg B ${label}-graph lifecycle completed`, false, String(error))
    }
  }

  // Phase-5 D15: an image generator has no backing model on the Bailian-only
  // inventory, so the join graph's ImageGenerator fails `model-unavailable`
  // end-to-end (customer_service would post the notice when a room is threaded).
  // Both sources still execute before the gated node fails.
  try {
    const messages = await collectLifecycle(joinPrompt())
    const failure = messages.find(
      (message): message is Extract<ExecMessage, { type: 'execution_error' }> => message.type === 'execution_error',
    )
    check(
      'POST /prompt fails an image generator with model-unavailable (D15)',
      failure !== undefined
        && failure.data.exception_type === 'ModelUnavailableError'
        && failure.data.node_type === 'ImageGenerator'
        && failure.data.exception_message.includes('model-unavailable')
        && !messages.some((message): boolean => message.type === 'execution_success'),
      failure === undefined ? 'no execution_error' : `${failure.data.node_type}: ${failure.data.exception_type}`,
    )
    check(
      'the gated run executed both sources before failing',
      failure !== undefined && failure.data.executed.includes('1') && failure.data.executed.includes('2'),
      failure === undefined ? 'none' : failure.data.executed.join(',') || 'none',
    )
  } catch (error) {
    check('Leg B D15 image-unavailable lifecycle completed', false, String(error))
  }
}

async function main(): Promise<void> {
  offlineChecks()
  await availabilityChecks()
  await liveChecks()
  process.stdout.write(failures === 0 ? '\nALL MOVIE-EXECUTOR CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
