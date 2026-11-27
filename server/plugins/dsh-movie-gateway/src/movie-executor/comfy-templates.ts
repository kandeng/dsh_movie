/**
 * Phase 8 (D10): server-held ComfyUI workflow templates.
 *
 * Templates are plain JSON graphs shipped with the gateway plugin; the DSH
 * process never loads model code. At run time we instantiate a template with
 * the step's prompt/seed/size parameters and POST the resulting graph to
 * ComfyUI's /prompt endpoint.
 *
 * JSON is loaded via readFileSync (the server tsconfig does not enable
 * resolveJsonModule).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ComfyTemplateMeta {
  modality: 'image' | 'video' | 'audio';
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  samplerNode: string;
  saveNode: string;
  seedNode: string;
  stepsNode: string;
  ckptNode: string;
  /**
   * The VAE that decodes this template's latents - the model/VAE pairing record.
   *
   * `'bundled'` means the checkpoint file carries its own VAE, so decode reads
   * it from the checkpoint loader's third output (`[ckptNode, 2]`) and the graph
   * holds no `VAELoader` at all. Any other value is the filename of a standalone
   * VAE that MUST belong to the same family as the diffusion model
   * (Qwen-Image -> `qwen_image_vae`, Wan 2.1/2.2 -> `wan_2.1_vae`).
   *
   * This exists because a mismatched VAE is invisible to every other check: the
   * old SDXL graphs decoded SDXL latents through the SD1.5 `sd-vae-ft-mse`, which
   * produced a structurally perfect PNG of chroma noise. Declaring the pairing
   * here makes it reviewable in one line and verifiable against the backend's
   * own inventory ({@link missingModelFiles}).
   */
  vae: string;
  /** Optional standalone VAELoader node; img2img encodes through it when present. */
  vaeNode?: string;
  /** Optional LoadImage node fed with the uploaded reference (i2v / face lock). */
  imageNode?: string;
}

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export interface ComfyTemplate {
  meta: ComfyTemplateMeta;
  prompt: Record<string, ComfyNode>;
}

export interface ComfyTemplates {
  /** SDXL 1.0 text-to-image (1024x1024, mse VAE). */
  image: ComfyTemplate;
  /** Wan 2.2 two-stage text-to-video (832x480, 16 fps). */
  video: ComfyTemplate;
  /** Qwen-Image 20B t2i (typography/posters, 1328x1328). */
  imageQwen?: ComfyTemplate;
  /** Wan 2.1 VACE first-frame image-to-video. */
  videoI2v?: ComfyTemplate;
  /** Stable Audio Open 1.0 (SFX / BGM beds). */
  audio?: ComfyTemplate;
  /** SDXL + InstantID face-identity lock. */
  instantid?: ComfyTemplate;
}

export interface TemplateParams {
  prompt: string;
  negative?: string;
  seed?: number;
  width?: number;
  height?: number;
  /** Video frame count (Wan length, 4n+1 at 16 fps). */
  length?: number;
  steps?: number;
  /** Audio duration in seconds (EmptyLatentAudio). */
  seconds?: number;
  /**
   * Model overrides keyed by the id of the weight node being replaced. A bare
   * filename is fine for a leaf weight (VAE/CLIP/InstantID/ControlNet) or for a
   * checkpoint that bundles its VAE; replacing a *split* model's ckpt/unet
   * requires a {@link ModelBundle} so the paired VAE travels with it.
   */
  models?: ModelOverrides;
}

let cached: ComfyTemplates | undefined;

function loadTemplate(file: string): ComfyTemplate {
  const raw = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  const parsed = JSON.parse(raw) as ComfyTemplate;
  if (!parsed.meta || !parsed.prompt) {
    throw new Error(`comfy template malformed: ${file}`);
  }
  if (typeof parsed.meta.vae !== 'string' || parsed.meta.vae === '') {
    throw new Error(`comfy template ${file} does not declare meta.vae (its model/VAE pairing)`);
  }
  return parsed;
}

/** Load (and cache) the bundled workflow templates (H20 inventory). */
export function loadComfyTemplates(): ComfyTemplates {
  if (!cached) {
    cached = {
      image: loadTemplate('./comfy-templates/image.json'),
      video: loadTemplate('./comfy-templates/video_t2v.json'),
      imageQwen: loadTemplate('./comfy-templates/image_qwen.json'),
      videoI2v: loadTemplate('./comfy-templates/video_i2v.json'),
      audio: loadTemplate('./comfy-templates/audio.json'),
      instantid: loadTemplate('./comfy-templates/instantid.json'),
    };
  }
  return cached;
}

/**
 * Map a movie-executor generator class type to its template.
 * @param hint - optional variant: `qwen` / `instantid` for images, `i2v` for
 * video (default video is the Wan 2.2 t2v two-stage graph).
 */
export function templateFor(
  classType: string,
  templates: ComfyTemplates,
  hint?: string,
): ComfyTemplate | undefined {
  if (classType === 'ImageGenerator') {
    if (hint === 'instantid' && templates.instantid !== undefined) return templates.instantid;
    if (hint === 'qwen' && templates.imageQwen !== undefined) return templates.imageQwen;
    return templates.image;
  }
  if (classType === 'VideoGenerator') {
    if (hint === 'i2v' && templates.videoI2v !== undefined) return templates.videoI2v;
    return templates.video;
  }
  if (classType === 'AudioGenerator') return templates.audio;
  return undefined;
}

/** Primary weight fields: a pinned model id identifies a template by THESE (the
 *  checkpoint / UNET that carries the diffusion model), never by its paired VAE
 *  or text encoder, which several families share. */
const PRIMARY_WEIGHT_FIELDS = ['ckpt_name', 'unet_name'] as const;

/**
 * Resolve a pinned model id (a Plugins-catalog checkpoint filename, written by
 * the Studio's model selector into the `model` widget) to the bundled template
 * whose PRIMARY weight it is, so the whole validated bundle (weights + paired
 * VAE, `meta.vae`) runs instead of a raw filename swap.
 *
 * Only templates of the requested modality are candidates (the image selector
 * serves the Image Generator, the video one the Video Generator, the audio one
 * the Audio Generator); basename comparison keeps subfolder-prefixed
 * inventories matching bare template values, exactly like {@link missingModelFiles}.
 *
 * @param modality - which family of bundled templates may capture the pin.
 * @returns the matching template, or `undefined` when no bundled template owns
 *   that weight (the caller then falls back to the derived bundle).
 */
export function templateByModelFile(
  templates: ComfyTemplates,
  file: string,
  modality: 'image' | 'video' | 'audio' = 'image',
): ComfyTemplate | undefined {
  const target = baseName(file.trim());
  if (target === '') return undefined;
  for (const key of TEMPLATE_KEYS) {
    const template = templates[key];
    if (template === undefined || template.meta.modality !== modality) continue;
    for (const node of Object.values(template.prompt)) {
      for (const field of PRIMARY_WEIGHT_FIELDS) {
        const value = node.inputs[field];
        if (typeof value === 'string' && baseName(value) === target) return template;
      }
    }
  }
  return undefined;
}

/**
 * Node types a template needs that the target ComfyUI instance does not
 * expose (from GET /object_info). Empty array = template is runnable.
 */
export function missingNodeTypes(
  template: ComfyTemplate,
  objectInfo: Record<string, unknown>,
): string[] {
  const missing = new Set<string>();
  for (const node of Object.values(template.prompt)) {
    if (!(node.class_type in objectInfo)) missing.add(node.class_type);
  }
  return [...missing];
}

/** Input fields whose value is a model filename drawn from the backend's inventory. */
export const MODEL_FILE_FIELDS = [
  'ckpt_name', 'unet_name', 'vae_name', 'clip_name', 'instantid_file', 'control_net_name',
] as const;

/** One model file a template asks for that the target backend does not have. */
export interface MissingModelFile {
  /** Graph node id holding the reference. */
  node: string;
  /** ComfyUI node class, e.g. `VAELoader`. */
  classType: string;
  /** The field naming the file, e.g. `vae_name`. */
  field: string;
  /** The filename the template asks for. */
  value: string;
}

function baseName(path: string): string {
  const tail = path.split('/').pop();
  return tail === undefined || tail === '' ? path : tail;
}

/**
 * The filename inventory a real ComfyUI publishes for one node class + field,
 * or `undefined` when it publishes none (mock fixtures, older builds, numeric
 * option lists). Comparing basenames keeps subfolder-prefixed listings
 * (`vae/qwen_image_vae.safetensors`) matching bare template values.
 */
function publishedFiles(
  objectInfo: Record<string, unknown>,
  classType: string,
  field: string,
): Set<string> | undefined {
  const entry = objectInfo[classType] as
    | { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
    | undefined;
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined;
  const spec = entry.input?.required?.[field] ?? entry.input?.optional?.[field];
  if (!Array.isArray(spec)) return undefined;
  const options = spec[0];
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const names = options.filter((option): option is string => typeof option === 'string');
  return names.length === options.length ? new Set(names.map(baseName)) : undefined;
}

/**
 * Model files a template references that the target ComfyUI instance does not
 * list in its `/object_info` inventory. Empty array = every weight is present.
 *
 * Fails OPEN when the backend publishes no inventory for a field (an
 * unverifiable pairing is not a proven-broken one, and the mock fixture used by
 * `verify-comfy` advertises node types only), and CLOSED when it does publish
 * one and our file is missing from it - which is how a renamed or uninstalled
 * checkpoint/VAE is caught at pre-flight instead of surfacing as a ComfyUI
 * exception mid-run.
 */
export function missingModelFiles(
  template: ComfyTemplate,
  objectInfo: Record<string, unknown>,
): MissingModelFile[] {
  const missing: MissingModelFile[] = [];
  for (const [node, entry] of Object.entries(template.prompt)) {
    for (const field of MODEL_FILE_FIELDS) {
      const value = entry.inputs[field];
      if (typeof value !== 'string' || value === '') continue;
      const published = publishedFiles(objectInfo, entry.class_type, field);
      if (published === undefined) continue;
      if (!published.has(baseName(value))) {
        missing.push({ node, classType: entry.class_type, field, value });
      }
    }
  }
  return missing;
}

/** Catalog keys of the bundled templates, i.e. the addressable model variants. */
export const TEMPLATE_KEYS = ['image', 'imageQwen', 'instantid', 'video', 'videoI2v', 'audio'] as const;

/** One addressable model variant (a template plus its validated pairing). */
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** The catalog key of an already-selected template (identity lookup). */
export function keyOf(
  templates: ComfyTemplates,
  template: ComfyTemplate,
): TemplateKey | undefined {
  for (const key of TEMPLATE_KEYS) {
    if (templates[key] === template) return key;
  }
  return undefined;
}

/** Human-readable form of {@link missingModelFiles} for logs and errors. */
export function describeMissingFiles(missing: MissingModelFile[]): string {
  return missing.map((entry): string => `${entry.classType}.${entry.field}=${entry.value}`).join(', ');
}

function setIfPresent(
  node: ComfyNode | undefined,
  key: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (node && key in node.inputs) node.inputs[key] = value;
}

/**
 * Instantiate a template with run parameters. Only keys already present in
 * the template are overwritten (guarded sets), so a template edit cannot be
 * silently defeated by a stray parameter. Seed defaults to a random value.
 */
export function instantiate(
  template: ComfyTemplate,
  params: TemplateParams,
): Record<string, ComfyNode> {
  const graph = structuredClone(template.prompt);
  const m = template.meta;
  const seed =
    params.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  const promptNode = graph[m.promptNode];
  if (promptNode) promptNode.inputs.text = params.prompt;
  if (params.negative !== undefined) {
    setIfPresent(graph[m.negativeNode], 'text', params.negative);
  }

  // Seed lives on different nodes per template (KSampler.seed vs
  // RandomNoise.noise_seed); set whichever key the template actually has.
  const seedNode = graph[m.seedNode];
  if (seedNode) {
    if ('seed' in seedNode.inputs) seedNode.inputs.seed = seed;
    else if ('noise_seed' in seedNode.inputs) seedNode.inputs.noise_seed = seed;
  }

  setIfPresent(graph[m.stepsNode], 'steps', params.steps);
  const latent = graph[m.latentNode];
  if (latent) {
    setIfPresent(latent, 'width', params.width);
    setIfPresent(latent, 'height', params.height);
    setIfPresent(latent, 'length', params.length);
    setIfPresent(latent, 'seconds', params.seconds);
  }

  // Model overrides. A weight swap is a BUNDLE swap: the paired VAE and text
  // encoder must travel with the checkpoint/UNET, because a graph that decodes
  // latents through a mismatched VAE still produces a valid PNG - of chroma
  // noise. See applyModelOverride for the pairing rules.
  if (params.models !== undefined) {
    for (const [nodeId, override] of Object.entries(params.models)) {
      applyModelOverride(graph, template, nodeId, override);
    }
  }

  // Keep VACE conditioning batches/scales in sync with the sampled geometry.
  // The i2v graph carries TWO RepeatImageBatch nodes: the control-video
  // repeater (source = ImageScale) matches `length`; the first-frame mask
  // repeater (source = MaskToImage) fills the `length - 1` generated frames
  // (frame 0 is the kept reference). This ComfyUI build's SolidMask has no
  // batch_size input, so the mask batch is assembled from images instead.
  if (params.length !== undefined || params.width !== undefined || params.height !== undefined) {
    for (const node of Object.values(graph)) {
      if (params.length !== undefined && node.class_type === 'RepeatImageBatch') {
        const srcRef = node.inputs.image;
        const srcId = Array.isArray(srcRef) ? String(srcRef[0]) : '';
        const src = graph[srcId];
        node.inputs.amount = src?.class_type === 'MaskToImage' ? params.length - 1 : params.length;
      }
      if (node.class_type === 'ImageScale') {
        setIfPresent(node, 'width', params.width);
        setIfPresent(node, 'height', params.height);
      }
    }
  }
  return graph;
}

/**
 * A model bundle: the weight files that must travel together.
 *
 * Overriding one without the others is precisely how a mismatched VAE ships, so
 * a replacement is expressed as one value instead of a set of unrelated
 * per-node filenames. `vae: 'bundled'` means the new checkpoint carries its own
 * VAE (SD-family); a filename means a standalone `VAELoader` file that matches
 * the new model's family.
 */
export interface ModelBundle {
  /** `CheckpointLoaderSimple.ckpt_name` - a checkpoint bundles its own VAE. */
  ckpt?: string;
  /** `UNETLoader.unet_name` - a split diffusion model carries no VAE. */
  unet?: string;
  /** The paired VAE: `'bundled'` or a standalone `VAELoader` filename. */
  vae?: string;
  /** The paired text encoder (`CLIPLoader.clip_name`). */
  clip?: string;
  /** Identity-lock weights (`InstantIDModelLoader.instantid_file`). */
  instantid?: string;
  /** Identity-lock ControlNet (`ControlNetLoader.control_net_name`). */
  controlNet?: string;
}

/**
 * Model overrides keyed by the id of the weight node being replaced: either a
 * bare filename (leaf weights, or a VAE-bundling checkpoint) or a full
 * {@link ModelBundle}.
 */
export type ModelOverrides = Record<string, string | ModelBundle>;

function findNodeByClass(graph: Record<string, ComfyNode>, classType: string): string | undefined {
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === classType) return id;
  }
  return undefined;
}

function setFieldEverywhere(graph: Record<string, ComfyNode>, field: string, value: string): void {
  for (const node of Object.values(graph)) {
    if (field in node.inputs) node.inputs[field] = value;
  }
}

/**
 * Point every VAE consumer at the right source for a chosen pairing.
 *
 * `'bundled'` rewires each `vae` input that read the standalone loader to the
 * checkpoint's own VAE output and drops the now-unused loader - the graph shape
 * the SDXL and audio templates ship with. A filename rewrites that loader
 * instead; without one there is nowhere to attach it, so that is an error
 * rather than a silently ignored override.
 */
function applyVaeChoice(graph: Record<string, ComfyNode>, template: ComfyTemplate, vae: string): void {
  const loaderId = template.meta.vaeNode ?? findNodeByClass(graph, 'VAELoader');
  if (vae === 'bundled') {
    if (loaderId !== undefined) {
      for (const node of Object.values(graph)) {
        const ref = node.inputs.vae;
        if (Array.isArray(ref) && String(ref[0]) === loaderId) {
          node.inputs.vae = [template.meta.ckptNode, 2];
        }
      }
      delete graph[loaderId];
    }
    return;
  }
  const loader = loaderId === undefined ? undefined : graph[loaderId];
  if (loader === undefined) {
    throw new Error(
      `model override: cannot attach standalone VAE '${vae}' - this template pairs its VAE ` +
      `inline ('${template.meta.vae}') and has no VAELoader node to retarget`,
    );
  }
  loader.inputs.vae_name = vae;
}

/**
 * Apply one model override while keeping the model/VAE pairing intact.
 *
 * A bare filename may replace a leaf weight (VAE, CLIP, InstantID, ControlNet)
 * or a checkpoint that bundles its VAE - in both cases no pairing can break.
 * Replacing a *split* model's checkpoint/UNET with a bare filename is refused,
 * because the VAE that goes with the new weights is then unknowable and the
 * latents would decode through the old model's VAE (chroma noise, valid PNG).
 */
function applyModelOverride(
  graph: Record<string, ComfyNode>,
  template: ComfyTemplate,
  nodeId: string,
  override: string | ModelBundle,
): void {
  const target = graph[nodeId];
  if (target === undefined) return;

  if (typeof override === 'string') {
    const field = MODEL_FILE_FIELDS.find((key): boolean => key in target.inputs);
    if (field === undefined) return;
    const isWeightSwap = field === 'ckpt_name' || field === 'unet_name';
    if (isWeightSwap && template.meta.vae !== 'bundled') {
      throw new Error(
        `model override for node ${nodeId} (${target.class_type}.${field}) replaces a split-model weight ` +
        `while this template pairs it with VAE '${template.meta.vae}'; pass a bundle ` +
        `{ ${field === 'unet_name' ? 'unet' : 'ckpt'}, vae, clip } so the pairing travels with the weights`,
      );
    }
    target.inputs[field] = override;
    return;
  }

  if (override.ckpt !== undefined && 'ckpt_name' in target.inputs) target.inputs.ckpt_name = override.ckpt;
  if (override.unet !== undefined && 'unet_name' in target.inputs) target.inputs.unet_name = override.unet;
  if (override.instantid !== undefined) setFieldEverywhere(graph, 'instantid_file', override.instantid);
  if (override.controlNet !== undefined) setFieldEverywhere(graph, 'control_net_name', override.controlNet);
  if (override.clip !== undefined) setFieldEverywhere(graph, 'clip_name', override.clip);
  // VAE last: it may delete the loader node the other fields were found on.
  if (override.vae !== undefined) applyVaeChoice(graph, template, override.vae);
}