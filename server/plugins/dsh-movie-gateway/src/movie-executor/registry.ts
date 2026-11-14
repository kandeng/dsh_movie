/**
 * Leg B executor node registry (Phase-3 P3-M4 §6, Phase-5 D1/D4).
 *
 * Builds the ComfyUI `/object_info` catalog the executor validates and schedules
 * prompts against: the six deprecated movie step nodes plus the fifteen
 * functional nodes from the shared protocol registry (via {@link buildObjectInfo}),
 * merged over the small canned demo nodes from `fixtures.ts`
 * (`MovieTextToImage`, `MovieImageToVideo`, `MovieSaveOutput`) so the existing
 * bridge demo graph and `verify-comfy-bridge` stay green. Protocol entries win
 * on any class_type collision.
 *
 * Also exposes the D1 **handler-registry service contract**: adapters register
 * `classType → handler` at activation, so a future plugin (a GPU-backed media
 * provider, a community node pack) can contribute execution handlers without
 * modifying the gateway.
 *
 * @module dsh-movie-gateway/movie-executor/registry
 */

import {
  FUNCTIONAL_NODES,
  MOVIE_NODES,
  buildObjectInfo,
  type MovieNodeSchema,
  type NodeFamily,
  type NodeModality,
  type NodeSlotSchema,
  type ObjectInfoEntry,
} from '@dsh-movie/protocol'
import { CANNED_OBJECT_INFO } from '../fixtures.ts'

/** One `/object_info` entry, loosely typed for the merged canned + movie map. */
type ObjectInfoMap = Record<string, unknown>

/**
 * Build the merged `/object_info` map: the six legacy step nodes + the fifteen
 * functional nodes plus the canned bridge demo nodes. Protocol nodes win on any
 * class_type collision.
 * @returns a `class_type -> object_info entry` record.
 */
export function objectInfoFromMovieNodes(): ObjectInfoMap {
  const movieInfo: ObjectInfoMap = buildObjectInfo([...MOVIE_NODES, ...FUNCTIONAL_NODES]) as ObjectInfoMap
  return { ...CANNED_OBJECT_INFO, ...movieInfo }
}

/** The merged catalog, computed once (it is static for the process lifetime). */
const OBJECT_INFO: ObjectInfoMap = objectInfoFromMovieNodes()

/** The merged protocol schema catalog, keyed by class_type. */
const SCHEMA_BY_TYPE: ReadonlyMap<string, MovieNodeSchema> = new Map(
  [...MOVIE_NODES, ...FUNCTIONAL_NODES].map((node): [string, MovieNodeSchema] => [node.classType, node]),
)

/**
 * Whether a `class_type` is known to the executor catalog.
 * @param classType - the node class to check.
 * @returns true when the catalog advertises it.
 */
export function isKnownClassType(classType: string): boolean {
  return Object.prototype.hasOwnProperty.call(OBJECT_INFO, classType)
}

/**
 * The output slot type names a `class_type` produces, used to validate that a
 * link's source slot index is in range.
 * @param classType - the node class to look up.
 * @returns the ordered output slot types, or `undefined` for an unknown class.
 */
export function classTypeOutputs(classType: string): readonly string[] | undefined {
  const entry = OBJECT_INFO[classType] as ObjectInfoEntry | undefined
  if (entry === undefined) return undefined
  return Array.isArray(entry.output) ? entry.output : undefined
}

/**
 * The required input key names a `class_type` declares (widgets + link inputs,
 * required AND optional), used to reject unknown input keys on a prompt node.
 * @param classType - the node class to look up.
 * @returns the declared input keys, or `undefined` for an unknown class.
 */
export function classTypeRequiredInputs(classType: string): readonly string[] | undefined {
  const entry = OBJECT_INFO[classType] as ObjectInfoEntry | undefined
  if (entry === undefined) return undefined
  return [...Object.keys(entry.input?.required ?? {}), ...Object.keys(entry.input?.optional ?? {})]
}

/** The functional family (role) a `class_type` plays, when it is a protocol node. */
export function familyOf(classType: string): NodeFamily | undefined {
  return SCHEMA_BY_TYPE.get(classType)?.family
}

/** The modality a `class_type` consumes/produces, when it is a protocol node. */
export function modalityOf(classType: string): NodeModality | undefined {
  return SCHEMA_BY_TYPE.get(classType)?.modality
}

/**
 * The declared input slot schema for one input key of a protocol node.
 * @param classType - the consumer node class.
 * @param inputKey - the input slot name (e.g. `image`).
 * @returns the slot schema, or `undefined` when the class or key is unknown.
 */
export function inputSlotSchema(classType: string, inputKey: string): NodeSlotSchema | undefined {
  return SCHEMA_BY_TYPE.get(classType)?.inputs.find((slot): boolean => slot.name === inputKey)
}

/**
 * The declared output slot schema for one slot index of a protocol node.
 * @param classType - the producer node class.
 * @param slotIndex - the 0-based output slot index.
 * @returns the slot schema, or `undefined` when the class or index is unknown.
 */
export function outputSlotSchema(classType: string, slotIndex: number): NodeSlotSchema | undefined {
  return SCHEMA_BY_TYPE.get(classType)?.outputs[slotIndex]
}

/* -------------------------------------------------------------------------- */
/* Handler-registry service contract (Phase-5 D1/D4).                          */
/* -------------------------------------------------------------------------- */

/** Resolves an upstream link `[sourceId, slotIndex]` to its produced artifact. */
export interface UpstreamResolver {
  /**
   * @param sourceId - the producer node id.
   * @param slotIndex - the producer's 0-based output slot index.
   * @returns the artifact the upstream node produced, or `undefined`.
   */
  (sourceId: string, slotIndex: number): unknown
}

/** The execution context handed to a node handler. */
export interface NodeHandlerContext {
  /** The node's raw prompt inputs (literal widget values + link tuples). */
  inputs: Record<string, unknown>
  /** Resolves link tuples to upstream artifacts (topo order guarantees presence). */
  resolve: UpstreamResolver
  /** Real LLM text seam (generalizes the legacy `StepTextGenerator`). */
  text?: ((classType: string, inputs: Record<string, unknown>) => Promise<string>) | undefined
  /** Real reviewer seam: judges one artifact against criteria. */
  review?: ((classType: string, artifact: unknown, criteria: string) => Promise<string>) | undefined
  /** Media-artifact seam for generator/reviewer modality adapters. */
  media?: { generate(classType: string, inputs: Record<string, unknown>): Promise<{ artifact?: string | undefined; media?: string | undefined }> } | undefined
}

/** One node execution result: the ordered output slot artifacts. */
export interface NodeHandlerOutput {
  /** Artifact per output slot index (must match the schema's outputs). */
  outputs: unknown[]
  /** A short display artifact for the lifecycle log / `executed` payload. */
  artifact?: string | undefined
  /** The media kind/tag produced (`canned` for placeholder paths). */
  media?: string | undefined
}

/** Executes one node class (D4: one adapter per family/modality). */
export interface NodeHandler {
  /**
   * Run one node.
   * @param ctx - raw inputs plus the upstream/model seams.
   * @returns the per-slot outputs and display artifact.
   */
  run(ctx: NodeHandlerContext): Promise<NodeHandlerOutput>
}

/** The process-wide `classType → handler` map (D1 extension point). */
const NODE_HANDLERS = new Map<string, NodeHandler>()

/**
 * Register execution handlers for class types (additive; last writer wins).
 * Called by the built-in adapters at activation and open to future plugins.
 * @param handlers - `classType → handler` entries to merge into the registry.
 */
export function registerNodeHandlers(handlers: Readonly<Record<string, NodeHandler>>): void {
  for (const [classType, handler] of Object.entries(handlers)) NODE_HANDLERS.set(classType, handler)
}

/**
 * Look up the registered handler for a class type.
 * @param classType - the node class to execute.
 * @returns the handler, or `undefined` when none is registered (the runner
 * then falls back to the legacy step path).
 */
export function handlerFor(classType: string): NodeHandler | undefined {
  return NODE_HANDLERS.get(classType)
}
