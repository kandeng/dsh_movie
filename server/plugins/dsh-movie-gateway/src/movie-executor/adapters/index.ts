/**
 * Built-in node handlers for the functional catalog (Phase-5 D4, P5-M1).
 *
 * One adapter per family (source / generator / reviewer / combiner), registered
 * for every functional `class_type` through the D1 handler-registry contract at
 * module activation. Each adapter is a thin composition of the existing seams:
 *
 *  - `source`    → pass-through: the widget payload (or a resolved upstream
 *                  link) becomes the node's single output artifact.
 *  - `generator/text` → the LLM seam (`ctx.text`, the generalized
 *                  `StepTextGenerator`); canned text fallback when absent.
 *  - `generator/image|video|audio` → the media seam (`ctx.media`, the existing
 *                  `MediaProvider`); canned fallback when absent.
 *  - `reviewer`  → the review seam (`ctx.review`); canned PASS verdict when
 *                  absent. Output 0 is the VERDICT, output 1 forwards the
 *                  reviewed artifact unchanged (D5 — no loops, fail never
 *                  retries automatically).
 *  - `combiner`  → pure functions, no model call: `TextMerge` concatenates in
 *                  slot order, `MediaConcat` forwards slot-ordered references,
 *                  `SaveOutput` passes the media through as the run output.
 *
 * Real Bailian-backed implementations arrive in P5-M2 behind the same seams;
 * nothing here changes the per-node lifecycle broadcast.
 *
 * @module dsh-movie-gateway/movie-executor/adapters
 */

import { FUNCTIONAL_NODES, type MovieNodeSchema } from '@dsh-movie/protocol'
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

/** Assemble display strings for every resolved input, in declared slot order. */
function resolvedInputsBySlot(schema: MovieNodeSchema, ctx: NodeHandlerContext): string[] {
  return schema.inputs.map((slot): string => display(resolveValue(ctx, ctx.inputs[slot.name]))).filter((text): boolean => text !== '')
}

/** Build the handler for one source class (payload widget → typed output). */
function sourceHandler(schema: MovieNodeSchema): NodeHandler {
  const widget = schema.widgets[0]?.name ?? 'text'
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      const raw = ctx.inputs[widget]
      const artifact = asLink(raw) === undefined ? raw : resolveValue(ctx, raw)
      return { outputs: [artifact ?? ''], artifact: display(artifact) }
    },
  }
}

/** Build the handler for one generator class (text → LLM seam, media → media seam). */
function generatorHandler(schema: MovieNodeSchema): NodeHandler {
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      const sections = resolvedInputsBySlot(schema, ctx)
      const promptWidget = schema.widgets.find((entry): boolean => entry.name === 'prompt' || entry.name === 'text')
      const prompt = promptWidget === undefined ? '' : display(ctx.inputs[promptWidget.name])
      const inputs: Record<string, unknown> = { ...ctx.inputs, resolved: sections, prompt }
      if (schema.modality === 'text') {
        const artifact = ctx.text === undefined
          ? cannedText(schema.classType, `generated text from ${sections.length} linked section(s)`)
          : await ctx.text(schema.classType, inputs)
        return { outputs: [artifact], artifact, media: ctx.text === undefined ? 'canned' : 'llm' }
      }
      if (ctx.media === undefined) {
        const artifact = cannedText(schema.classType, `placeholder ${schema.modality ?? 'media'} artifact`)
        return { outputs: [artifact], artifact, media: 'canned' }
      }
      const generation = await ctx.media.generate(schema.classType, inputs)
      const artifact = generation.artifact ?? ''
      return { outputs: [artifact], artifact, media: generation.media ?? 'canned' }
    },
  }
}

/** Build the handler for one reviewer class (verdict + passthrough, D5). */
function reviewerHandler(schema: MovieNodeSchema): NodeHandler {
  const inputSlot = schema.inputs[0]!
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      const reviewed = resolveValue(ctx, ctx.inputs[inputSlot.name])
      const criteria = display(ctx.inputs['criteria'])
      const verdict = ctx.review === undefined
        ? `[canned verdict] PASS — reviewer seam not configured; criteria: ${criteria === '' ? '(none)' : criteria}`
        : await ctx.review(schema.classType, reviewed, criteria)
      return { outputs: [verdict, reviewed], artifact: display(verdict), media: ctx.review === undefined ? 'canned' : 'llm' }
    },
  }
}

/** Build the handler for one combiner class (pure function, no model call). */
function combinerHandler(schema: MovieNodeSchema): NodeHandler {
  return {
    async run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput> {
      const parts = schema.inputs.map((slot): unknown => resolveValue(ctx, ctx.inputs[slot.name]))
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

/** Build the handler for one functional class by family dispatch (D4). */
function handlerForSchema(schema: MovieNodeSchema): NodeHandler {
  switch (schema.family) {
    case 'source': return sourceHandler(schema)
    case 'generator': return generatorHandler(schema)
    case 'reviewer': return reviewerHandler(schema)
    case 'combiner': return combinerHandler(schema)
    default: throw new Error(`functional node ${schema.classType} has no family`)
  }
}

/** The built-in handlers for all fifteen functional class types. */
export const BUILTIN_NODE_HANDLERS: Readonly<Record<string, NodeHandler>> = Object.fromEntries(
  FUNCTIONAL_NODES.map((schema): [string, NodeHandler] => [schema.classType, handlerForSchema(schema)]),
)

// Activation: contribute the built-in handlers to the executor handler registry
// (D1). Importing this module is the gateway's activation step; future plugins
// call registerNodeHandlers() the same way.
registerNodeHandlers(BUILTIN_NODE_HANDLERS)
