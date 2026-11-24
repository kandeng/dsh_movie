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
  /** Model filename overrides keyed by node id (sourced from /model_catalog). */
  models?: Record<string, string>;
}

let cached: ComfyTemplates | undefined;

function loadTemplate(file: string): ComfyTemplate {
  const raw = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  const parsed = JSON.parse(raw) as ComfyTemplate;
  if (!parsed.meta || !parsed.prompt) {
    throw new Error(`comfy template malformed: ${file}`);
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

  // Model filename overrides (the driver sources exact names from /model_catalog).
  if (params.models !== undefined) {
    for (const [nodeId, filename] of Object.entries(params.models)) {
      const target = graph[nodeId];
      if (target === undefined) continue;
      for (const key of ['ckpt_name', 'unet_name', 'vae_name', 'clip_name', 'instantid_file', 'control_net_name']) {
        if (key in target.inputs) {
          target.inputs[key] = filename;
          break;
        }
      }
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