/**
 * Built-in node handlers for the functional catalog (Phase-5 D4, P5-M1).
 *
 * One adapter per family (source / generator / combiner), registered
 * for every functional `class_type` through the D1 handler-registry contract at
 * module activation. Each adapter is a thin composition of the existing seams:
 *
 *  - `source`    → pass-through: the widget payload (or a resolved upstream
 *                  link) becomes the node's single output artifact. Declared
 *                  input slots (exp: TextInput's optional `ref`) resolve and
 *                  append as labeled blocks instead of a bare concatenation;
 *                  a variadic slot with several links appends one numbered
 *                  block per link, in link-creation order.
 *  - `generator/text` → the LLM seam (`ctx.text`, the generalized
 *                  `StepTextGenerator`); canned text fallback when absent.
 *  - `generator/image|video|audio` → first the D15 availability gate
 *                  (`ctx.availability`): an unbacked modality throws
 *                  {@link ModelUnavailableError} so the runner posts the
 *                  `customer_service` notice instead of a silent placeholder. An
 *                  available modality calls the media seam (`ctx.media`) — video
 *                  rides Bailian "Happyhorse" (`video-provider.ts`); the canned
 *                  fallback remains only as an offline/dev affordance.
 *  - `combiner`  → pure functions, no model call: `TextMerge` concatenates in
 *                  slot order, `MediaConcat` forwards slot-ordered references,
 *                  `SaveOutput` passes the media through as the run output, and
 *                  `Cache` records every arrival as a persistent card (via the
 *                  runner-bound `ctx.cache` store) and replays all cards, in
 *                  card order, through its variadic `media` output slot.
 *
 * Real Bailian-backed text/video implementations are wired in P5-M2 behind these
 * same seams; nothing here changes the per-node lifecycle broadcast.
 *
 * @module dsh-movie-gateway/movie-executor/adapters
 */

import { FUNCTIONAL_NODES, MEDIA_SLOT_TYPES, REF_SLOT_TYPE, slotCompatible, type CacheCard, type CachePiece, type MovieNodeSchema } from '@dsh-movie/protocol'
import type { CacheArrival } from '../../workspace-store.ts'
import { ModelUnavailableError } from '../errors.ts'
import {
  registerNodeHandlers,
  type NodeHandler,
  type NodeHandlerContext,
  type NodeHandlerOutput,
} from '../registry.ts'

/** Narrow an input value to a ComfyUI link tuple `[sourceId, slotIndex]`. */
function asLink(value: unknown): [string, number] | undefined {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'number'
    ? [String(value[0]), value[1] as number]
    : undefined
}

/**
 * Resolve one input value: link tuples go through the upstream resolver,
 * literals (widget payloads) pass through unchanged.
 * @param ctx - the handler context carrying the resolver.
 * @param value - the raw prompt input value.
 * @returns the upstream artifact or the literal value.
 */
function resolveValue(ctx: NodeHandlerContext, value: unknown): unknown {
  const link = asLink(value)
  return link === undefined ? value : ctx.resolve(link[0], link[1])
}

/** Honest single-line placeholder for runs without model keys. */
function cannedText(classType: string, note: string): string {
  return `[canned ${classType}] ${note} — no model seam configured (P5-M2 wires the real adapter)`
}

/** Stringify one artifact for display/log payloads. */
function display(artifact: unknown): string {
  return typeof artifact === 'string' ? artifact : String(artifact ?? '')
}

/** Narrow an input value to an ORDERED list of link tuples (a variadic slot). */
function asLinkList(value: unknown): Array<[string, number]> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (!value.every((entry): boolean => asLink(entry) !== undefined)) return undefined
  return (value as Array<[string, number]>).map((entry) => asLink(entry)!)
}

/**
 * Resolve one input slot to its ordered artifact list: a variadic link list
 * resolves element-wise IN LINK ORDER, a single link tuple resolves alone, and
 * a widget literal passes through as the single element. A resolved value that
 * is itself an ARRAY (a variadic OUTPUT slot — the Cache node's card replay)
 * SPLICES into the list, so one edge can deliver many artifacts in card order.
 */
function resolveSlotValues(ctx: NodeHandlerContext, value: unknown): unknown[] {
  const list = asLinkList(value)
  let resolved: unknown[]
  if (list !== undefined) resolved = list.map((link): unknown => ctx.resolve(link[0], link[1]))
  else {
    const link = asLink(value)
    resolved = link === undefined ? [value] : [ctx.resolve(link[0], link[1])]
  }
  return resolved.flatMap((entry): unknown[] => (Array.isArray(entry) ? entry : [entry]))
}

/** Resolve one input slot to a single text: ordered artifacts joined with `\n\n`. */
function resolveSlotText(ctx: NodeHandlerContext, value: unknown): string {
  return resolveSlotValues(ctx, value)
    .map((entry): string => display(entry))
    .filter((text): boolean => text !== '')
    .join('\n\n')
}

/** Assemble display strings for every resolved TEXTUAL input, in declared slot
 *  order. Media slots (IMAGE/VIDEO/AUDIO — e.g. TextGenerator's Phase-2 vision
 *  slot) are excluded: their refs travel to the seam as an ordered array under
 *  their own key and must never be stringified into the prompt body. The
 *  unified REF slot is excluded too: its internal adapter (below) already
 *  splits it into `prompt` / `image`, and stringifying it whole would leak
 *  reference URLs into the composed sections. */
function resolvedInputsBySlot(schema: MovieNodeSchema, ctx: NodeHandlerContext): string[] {
  return schema.inputs
    .filter((slot): boolean => !MEDIA_SLOT_TYPES.includes(slot.type) && slot.type !== REF_SLOT_TYPE)
    .map((slot): string => resolveSlotText(ctx, ctx.inputs[slot.name]))
    .filter((text): boolean => text !== '')
}

/** Build the handler for one source class (payload widget → typed output).
 *
 *  EXP(textinput-toonflow): when the schema declares input slots (TextInput's
 *  optional `ref`), each resolved non-empty input is appended to the widget body
 *  as a labeled block — `【slot】\nvalue`, the semantic-slot cousin of Toonflow's
 *  `参考 N：` and infinite-canvas' `【文本N】` — so a downstream model can tell body
 *  from reference. Sources without input slots keep the exact old passthrough. */
function sourceHandler(schema: MovieNodeSchema): NodeHandler {
  const widget = schema.widgets[0]?.name ?? 'text'
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      const raw = ctx.inputs[widget]
      const artifact = asLink(raw) === undefined ? raw : resolveValue(ctx, raw)
      const blocks = schema.inputs
        .flatMap((slot): string[] => {
          const texts = resolveSlotValues(ctx, ctx.inputs[slot.name])
            .map((entry): string => display(entry))
            .filter((text): boolean => text !== '')
          if (texts.length === 0) return []
          // A variadic slot with several linked references numbers its blocks
          // (【ref 1】, 【ref 2】, …) so the downstream model can tell them
          // apart; a single reference keeps the plain 【ref】 label.
          if (slot.variadic === true && texts.length > 1) {
            return texts.map((text, index): string => `【${slot.name} ${index + 1}】\n${text}`)
          }
          return [`【${slot.name}】\n${texts.join('\n\n')}`]
        })
      if (blocks.length === 0) return { outputs: [artifact ?? ''], artifact: display(artifact) }
      const composed = [display(artifact ?? ''), ...blocks].filter((text): boolean => text !== '').join('\n\n')
      return { outputs: [composed], artifact: composed }
    },
  }
}

/** Build the handler for one generator class (text → LLM seam, media → media seam). */
function generatorHandler(schema: MovieNodeSchema): NodeHandler {
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      const sections = resolvedInputsBySlot(schema, ctx)
      const promptWidget = schema.widgets.find((entry): boolean => entry.name === 'prompt' || entry.name === 'text')
      const prompt = promptWidget === undefined ? '' : display(resolveValue(ctx, ctx.inputs[promptWidget.name]))
      // Resolve ComfyUI link tuples (`[sourceId, slot]`) to their upstream
      // artifact values before handing the inputs to a seam, so a media
      // provider receives the REAL reference (e.g. the t2i image URL feeding an
      // i2v `image` input) rather than the raw link. Widget literals pass
      // through unchanged (resolveValue is identity for non-links).
      const linked: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(ctx.inputs)) {
        const slotType = schema.inputs.find((slot): boolean => slot.name === key)?.type
        // The unified REF slot (the Video Generator's single mixed-modality
        // port) carries an INTERNAL ADAPTER: each link is routed by its
        // SOURCE's declared output type — TEXT-family elements join into the
        // `prompt` key, IMAGE-family elements collect into the ordered
        // `image` array. Those are exactly the two keys promptOf() and
        // imageRefs() consume, so the providers (and the t2v/i2v mode
        // derivation) stay unaware the slots were ever unified. A literal
        // (non-link) value degrades to prompt text.
        if (slotType === REF_SLOT_TYPE) {
          const single = asLink(value)
          const list = asLinkList(value) ?? (single === undefined ? [] : [single])
          const texts: string[] = []
          const refs: unknown[] = []
          for (const link of list) {
            const sourceType = ctx.linkSourceType?.(link[0], link[1])
            const resolved = ctx.resolve(link[0], link[1])
            // A variadic-output source (Cache) delivers an ordered ARRAY through
            // one link; route each element exactly like the whole value would be.
            const elements = Array.isArray(resolved) ? resolved : [resolved]
            for (const element of elements) {
              if (sourceType !== undefined && slotCompatible(sourceType, 'IMAGE')) refs.push(element)
              else texts.push(display(element))
            }
          }
          if (list.length === 0 && value !== undefined && value !== null) {
            const literal = display(value)
            if (literal !== '') texts.push(literal)
          }
          if (texts.length > 0) linked['prompt'] = texts.join('\n\n')
          if (refs.length > 0) linked['image'] = refs
          continue
        }
        const list = asLinkList(value)
        if (list === undefined) {
          // A single link tuple or a widget literal resolves exactly as before.
          linked[key] = resolveValue(ctx, value)
          continue
        }
        // A VARIADIC slot (several links) resolves element-wise in link-creation
        // order. How it composes depends on the slot TYPE:
        //  - TEXT (or a TEXT subtype / wildcard) joins into ONE `\n\n`-separated
        //    string, so promptOf / ctx.text keep seeing plain text;
        //  - a MEDIA slot (IMAGE/VIDEO/AUDIO) stays an ORDERED ARRAY of refs, so
        //    the provider consumes each reference by role and never stringifies a
        //    URL into the prompt (e.g. an Image Generator's several input images).
        const textual = slotType === 'TEXT' || slotType === 'SCRIPT' || slotType === '*' || slotType === undefined
        linked[key] = textual ? resolveSlotText(ctx, value) : resolveSlotValues(ctx, value)
      }
      // An EMPTY prompt widget must not clobber a linked prompt slot. The media
      // generators have no `prompt` widget at all (theirs are `mode`/`variant`),
      // so `prompt` resolved to '' and overwrote the upstream text the link had
      // just carried - the seam then saw only `resolved`, and a skill wired into
      // the Image Generator never reached the image prompt. Omit the key instead
      // of blanking it.
      const inputs: Record<string, unknown> = { ...linked, resolved: sections, ...(prompt === '' ? {} : { prompt }) }
      if (schema.modality === 'text') {
        const artifact = ctx.text === undefined
          ? cannedText(schema.classType, `generated text from ${sections.length} linked section(s)`)
          : await ctx.text(schema.classType, inputs)
        return { outputs: [artifact], artifact, media: ctx.text === undefined ? 'canned' : 'llm' }
      }
      // D15 availability gate: a non-text generator whose modality has no
      // configured model never emits a silent placeholder — throw so the runner
      // posts the customer_service notice and fails the node `model-unavailable`.
      if (ctx.availability.for(schema.modality) === 'unavailable') {
        throw new ModelUnavailableError(schema.modality ?? 'media', schema.classType)
      }
      if (ctx.media === undefined) {
        const artifact = cannedText(schema.classType, `placeholder ${schema.modality ?? 'media'} artifact`)
        return { outputs: [artifact], artifact, media: 'canned' }
      }
      const generation = await ctx.media.generate(schema.classType, inputs, {
        ...(ctx.progress === undefined ? {} : { onProgress: ctx.progress }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
      const artifact = generation.artifact ?? ''
      return {
        outputs: [artifact],
        artifact,
        media: generation.media ?? 'canned',
        ...(generation.bytes === undefined ? {} : { bytes: generation.bytes }),
        ...(generation.filename === undefined ? {} : { filename: generation.filename }),
        ...(generation.mime === undefined ? {} : { mime: generation.mime }),
      }
    },
  }
}

/** Build the handler for one combiner class (pure function, no model call). */
function combinerHandler(schema: MovieNodeSchema): NodeHandler {
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      if (schema.classType === 'Cache') return runCache(ctx)
      // One flat parts list: single-link slots resolve alone, and an array
      // artifact from a variadic-output source (Cache) splices into the list.
      const parts = schema.inputs.flatMap((slot): unknown[] => resolveSlotValues(ctx, ctx.inputs[slot.name]))
      if (schema.classType === 'TextMerge') {
        const merged = parts.map((part): string => display(part)).filter((text): boolean => text !== '').join('\n\n')
        return { outputs: [merged], artifact: merged }
      }
      if (schema.classType === 'MediaConcat') {
        const present = parts.filter((part): boolean => part !== undefined && part !== null && part !== '')
        const artifact = `[concat ${String(present.length)} media part(s)] ${present.map((part): string => display(part)).join(' + ')}`
        return { outputs: [artifact], artifact, media: 'canned' }
      }
      // SaveOutput: terminal passthrough — the linked artifact is the run output.
      const saved = parts[0]
      return { outputs: [], artifact: display(saved), media: 'canned' }
    },
  }
}

/**
 * The Cache node: record every arriving upstream artifact as a persistent
 * card, then replay ALL stored cards downstream through the variadic `media`
 * output slot, in card order (the order the editor's shuffle-drag maintains).
 *
 * One arrival from one upstream node = ONE card; the card holds every piece
 * that arrival delivered (a Cache-to-Cache edge arrives with the upstream's
 * whole replay list as a multi-piece card). Cards accumulate across runs in
 * the runner-bound `ctx.cache` store; without a store (offline verification)
 * this run's arrivals degrade into ephemeral cards numbered from 1.
 */
function runCache(ctx: NodeHandlerContext): NodeHandlerOutput {
  const single = asLink(ctx.inputs['in'])
  const links = asLinkList(ctx.inputs['in']) ?? (single === undefined ? [] : [single])
  const arrivals: CacheArrival[] = []
  for (const link of links) {
    const resolved = ctx.resolve(link[0], link[1])
    const elements = (Array.isArray(resolved) ? resolved : [resolved])
      .map((entry): string => display(entry))
      .filter((text): boolean => text !== '')
    if (elements.length === 0) continue
    const sourceType = ctx.linkSourceType?.(link[0], link[1])
    arrivals.push({
      sourceName: ctx.nodeTitle?.(link[0]) ?? link[0],
      pieces: elements.map((artifact): CachePiece => (sourceType === undefined ? { artifact } : { artifact, sourceType })),
    })
  }
  const cards: CacheCard[] = ctx.cache === undefined
    ? arrivals.map((arrival, index): CacheCard => ({ seq: index + 1, sourceName: arrival.sourceName, arrivedAt: Date.now(), pieces: arrival.pieces }))
    : ctx.cache.append(arrivals)
  // The variadic output slot's artifact IS the ordered replay list; downstream
  // resolveSlotValues splices it into the consumer's ordered value list.
  const replay = cards.flatMap((card): string[] => card.pieces.map((piece): string => piece.artifact))
  const artifact = `[cache ${String(cards.length)} card(s), ${String(replay.length)} item(s)]`
  return { outputs: [replay], artifact, media: 'canned' }
}

/** Build the handler for one functional class by family dispatch (D4). */
function handlerForSchema(schema: MovieNodeSchema): NodeHandler {
  switch (schema.family) {
    case 'source': return sourceHandler(schema)
    case 'generator': return generatorHandler(schema)
    case 'combiner': return combinerHandler(schema)
    default: throw new Error(`functional node ${schema.classType} has no family`)
  }
}

/** The built-in handlers for all twelve functional class types. */
export const BUILTIN_NODE_HANDLERS: Readonly<Record<string, NodeHandler>> = Object.fromEntries(
  FUNCTIONAL_NODES.map((schema): [string, NodeHandler] => [schema.classType, handlerForSchema(schema)]),
)

// Activation: contribute the built-in handlers to the executor handler registry
// (D1). Importing this module is the gateway's activation step; future plugins
// call registerNodeHandlers() the same way.
registerNodeHandlers(BUILTIN_NODE_HANDLERS)
