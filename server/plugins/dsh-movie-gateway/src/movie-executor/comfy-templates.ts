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
  modality: 'image' | 'video';
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  samplerNode: string;
  saveNode: string;
  seedNode: string;
  stepsNode: string;
  ckptNode: string;
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
  image: ComfyTemplate;
  video: ComfyTemplate;
}

export interface TemplateParams {
  prompt: string;
  negative?: string;
  seed?: number;
  width?: number;
  height?: number;
  /** Video frame count (LTXV length, step of 8). */
  length?: number;
  steps?: number;
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

/** Load (and cache) the bundled image/video workflow templates. */
export function loadComfyTemplates(): ComfyTemplates {
  if (!cached) {
    cached = {
      image: loadTemplate('./comfy-templates/image.json'),
      video: loadTemplate('./comfy-templates/video.json'),
    };
  }
  return cached;
}

/** Map a movie-executor generator class type to its template. */
export function templateFor(
  classType: string,
  templates: ComfyTemplates,
): ComfyTemplate | undefined {
  if (classType === 'ImageGenerator') return templates.image;
  if (classType === 'VideoGenerator') return templates.video;
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
  }
  return graph;
}