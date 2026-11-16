/**
 * Node visual skin (Phase-6 D11): the family accent hue + icon that a node card
 * and its docked editor header share. Extracted from `MovieNode.vue` so the
 * editor renders the SAME identity row (icon + localized type in the family hue)
 * instead of duplicating the color tables.
 *
 * The six deprecated movie steps keep their per-`class_type` skin; functional
 * nodes resolve by family (accent) + modality (icon).
 *
 * @module @/canvas/nodeSkin
 */
import {
  IconFileText,
  IconLayoutGrid,
  IconListDetails,
  IconMovie,
  IconPhoto,
  IconVideo,
  IconVolume2,
} from "@tabler/icons-vue";
import { schemaFor } from "@/canvas/graphMapper";

/** A tabler icon component, usable with `<component :is>`. */
export type SkinIcon = typeof IconFileText;

/** The resolved identity skin for one node. */
export interface NodeSkin {
  /** The icon rendered before the node type name. */
  icon: SkinIcon;
  /** The accent hue: the family color for functional nodes. */
  accent: string;
}

/** Per-class_type icon + accent hue for the six deprecated movie steps. */
const TYPE_SKIN: Readonly<Record<string, NodeSkin>> = {
  MovieScript: { icon: IconFileText, accent: "#409eff" },
  MovieShotPlan: { icon: IconListDetails, accent: "#36cfc9" },
  MovieAsset: { icon: IconPhoto, accent: "#52c41a" },
  MovieStoryboard: { icon: IconLayoutGrid, accent: "#faad14" },
  MovieClip: { icon: IconVideo, accent: "#9254de" },
  MovieAssemble: { icon: IconMovie, accent: "#f759ab" },
};

/** Functional-node icon by modality (Phase-5 D3). */
const MODALITY_ICON: Readonly<Record<string, SkinIcon>> = {
  text: IconFileText,
  image: IconPhoto,
  video: IconVideo,
  audio: IconVolume2,
};

/** Functional-node accent hue by family (role). */
const FAMILY_ACCENT: Readonly<Record<string, string>> = {
  source: "#13c2c2",
  generator: "#409eff",
  reviewer: "#fa8c16",
  combiner: "#722ed1",
};

/** Unknown class type: neutral text icon + primary blue. */
const FALLBACK_SKIN: NodeSkin = { icon: IconFileText, accent: "#409eff" };

/**
 * Resolve a node's identity skin from its `class_type`.
 * @param classType - the ComfyUI class type (a movie/functional node key).
 * @returns the icon + accent hue to render for that node.
 */
export function nodeSkin(classType: string): NodeSkin {
  const legacy = TYPE_SKIN[classType];
  if (legacy !== undefined) return legacy;
  const schema = schemaFor(classType);
  if (schema === undefined) return FALLBACK_SKIN;
  return {
    icon: MODALITY_ICON[schema.modality ?? "text"] ?? IconFileText,
    accent: FAMILY_ACCENT[schema.family ?? ""] ?? "#409eff",
  };
}
