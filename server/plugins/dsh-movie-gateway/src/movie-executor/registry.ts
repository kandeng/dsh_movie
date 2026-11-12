/**
 * Leg B executor node registry (Phase-3 P3-M4, design doc §6).
 *
 * Builds the ComfyUI `/object_info` catalog the executor validates and schedules
 * prompts against. The six movie step nodes come from the shared
 * {@link MOVIE_NODES} registry (via {@link buildObjectInfo}); the small canned
 * demo nodes from `fixtures.ts` (`MovieTextToImage`, `MovieImageToVideo`,
 * `MovieSaveOutput`) are merged in so the existing bridge demo graph and
 * `verify-comfy-bridge` stay green.
 *
 * @module dsh-movie-gateway/movie-executor/registry
 */

import { buildObjectInfo, type ObjectInfoEntry } from '@dsh-movie/protocol'
import { CANNED_OBJECT_INFO } from '../fixtures.ts'

/** One `/object_info` entry, loosely typed for the merged canned + movie map. */
type ObjectInfoMap = Record<string, unknown>

/**
 * Build the merged `/object_info` map: the six movie step nodes plus the canned
 * bridge demo nodes. Movie nodes win on any class_type collision.
 * @returns a `class_type -> object_info entry` record.
 */
export function objectInfoFromMovieNodes(): ObjectInfoMap {
  const movieInfo: ObjectInfoMap = buildObjectInfo() as ObjectInfoMap
  return { ...CANNED_OBJECT_INFO, ...movieInfo }
}

/** The merged catalog, computed once (it is static for the process lifetime). */
const OBJECT_INFO: ObjectInfoMap = objectInfoFromMovieNodes()

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
 * The required input key names a `class_type` declares (widgets + link inputs),
 * used to reject unknown input keys on a prompt node.
 * @param classType - the node class to look up.
 * @returns the required input keys, or `undefined` for an unknown class.
 */
export function classTypeRequiredInputs(classType: string): readonly string[] | undefined {
  const entry = OBJECT_INFO[classType] as ObjectInfoEntry | undefined
  if (entry === undefined) return undefined
  return Object.keys(entry.input?.required ?? {})
}
