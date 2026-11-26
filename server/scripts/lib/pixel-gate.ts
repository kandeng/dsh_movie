/**
 * Pixel-quality gate (P1) — chroma-noise detector for generated stills/clips.
 *
 * WHY THIS EXISTS
 * The SDXL-VAE fault (a `sd-vae-ft-mse` SD1.5 VAE decoding SDXL latents) produced
 * pictures that were *structurally perfect*: correct dimensions, a valid PNG
 * header, intact luma, and a file size in the normal range. Only the colour was
 * noise. Every cheap existence/size check passed, so 24 corrupted frames were
 * certified and then animated into clips. "Does the file exist?" cannot see a
 * picture; this can.
 *
 * THE METRIC — `chroma_hf`
 * Mean absolute difference of the two chromatic opponent planes (R-G and B-G)
 * against each pixel's neighbours. Colour noise is high-frequency by nature, so
 * a clean render scores low and a chroma-corrupt one scores many times higher,
 * while luma detail (which is legitimately high-frequency in sharp artwork) does
 * not move it. Decoding is delegated to ffmpeg (rawvideo/rgb24); the metric is
 * computed here so it needs no extra dependency.
 *
 * CALIBRATION TABLE (measured on this project's real H20 outputs)
 *   clean Qwen-Image stills ......... ~1.2
 *   clean SDXL renders .............. 1.65 - 1.77
 *   chroma-corrupt SDXL/InstantID ... 5.57 - 10.40
 *   chroma-corrupt face-lock frames . 11 - 21
 * The default threshold is the geometric midpoint of the clean/corrupt bands, so
 * it sits as far as possible from both: sqrt(1.77 * 5.57) ~= 3.14 -> 3.2.
 *
 * FAIL DIRECTION
 * A file that cannot be decoded is reported `ok: false`. Callers treat that as
 * "missing" (unlink + throw) so the resume path regenerates it instead of
 * leaving a poisoned record that every later phase would trust. Failing closed
 * is right here because regeneration is cheap relative to propagating a bad
 * asset into clips.
 *
 * @module server/scripts/lib/pixel-gate
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** chroma_hf at or above which an asset is rejected; <= 0 disables the gate. */
export const DEFAULT_PIXEL_THRESHOLD = 3.2

/** Per-call timeout for one ffmpeg decode of a single sampled frame. */
const DECODE_TIMEOUT_MS = 60_000

export interface PixelQuality {
  /** False when the worst sampled frame reaches the threshold (or is undecodable). */
  ok: boolean
  /** Worst (maximum) chroma_hf across the sampled frames — the gate decides on this. */
  worst: number
  /** Mean chroma_hf across the sampled frames. */
  mean: number
  /** chroma_hf per sampled frame, in timeline order. Empty when nothing decoded. */
  samples: number[]
  /** How many frames were actually sampled (<= requested). */
  frames: number
  /** Threshold this call was judged against. */
  threshold: number
  /** Human-readable one-liner for logs and rejection messages. */
  detail: string
}

/** ffprobe view of the first video stream (fields optional: stills lack some). */
interface StreamInfo {
  width: number
  height: number
  frames: number
  duration: number
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Probe geometry/length. `frames` and `duration` fall back to 0 when unknown. */
function probe(file: string): StreamInfo | undefined {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames,duration', '-show_entries', 'format=duration', '-of', 'json', file],
    { encoding: 'utf8', timeout: DECODE_TIMEOUT_MS },
  )
  if (res.status !== 0 || res.stdout === '') return undefined
  try {
    const parsed = JSON.parse(res.stdout) as { streams?: { width?: unknown; height?: unknown; nb_frames?: unknown; duration?: unknown }[]; format?: { duration?: unknown } }
    const stream = parsed.streams?.[0]
    if (stream === undefined) return undefined
    const width = num(stream.width)
    const height = num(stream.height)
    if (width <= 0 || height <= 0) return undefined
    const duration = num(stream.duration) > 0 ? num(stream.duration) : num(parsed.format?.duration)
    return { width, height, frames: num(stream.nb_frames), duration }
  } catch {
    return undefined
  }
}

/**
 * Sample timestamps spread across the timeline, worst-one-wins style: frame 0,
 * then evenly spaced points ending on the last frame. Stills always yield one.
 */
function sampleTimes(info: StreamInfo, requested: number): number[] {
  const available = info.frames > 0 ? info.frames : info.duration > 0 ? Math.max(1, Math.round(info.duration * 16)) : 1
  const count = Math.max(1, Math.min(requested, available))
  if (count === 1 || info.duration <= 0) return Array.from({ length: count }, (): number => 0)
  return Array.from({ length: count }, (_unused, i): number => (info.duration * (i + 0.5)) / count)
}

/**
 * chroma_hf of one rgb24 frame: mean |Δ| of the R-G and B-G opponent planes
 * against all four in-frame neighbours. Border pixels are skipped (they have no
 * full neighbourhood), which is negligible at these resolutions.
 */
function chromaHf(buf: Buffer, width: number, height: number): number {
  let sum = 0
  let count = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 3
      const r = buf[i] as number
      const g = buf[i + 1] as number
      const b = buf[i + 2] as number
      const c1 = r - g
      const c2 = b - g
      const left = i - 3
      const right = i + 3
      const up = i - width * 3
      const down = i + width * 3
      const l1 = (buf[left] as number) - (buf[left + 1] as number)
      const r1 = (buf[right] as number) - (buf[right + 1] as number)
      const u1 = (buf[up] as number) - (buf[up + 1] as number)
      const d1 = (buf[down] as number) - (buf[down + 1] as number)
      const l2 = (buf[left + 2] as number) - (buf[left + 1] as number)
      const r2 = (buf[right + 2] as number) - (buf[right + 1] as number)
      const u2 = (buf[up + 2] as number) - (buf[up + 1] as number)
      const d2 = (buf[down + 2] as number) - (buf[down + 1] as number)
      const hf1 = (Math.abs(c1 - l1) + Math.abs(c1 - r1) + Math.abs(c1 - u1) + Math.abs(c1 - d1)) / 4
      const hf2 = (Math.abs(c2 - l2) + Math.abs(c2 - r2) + Math.abs(c2 - u2) + Math.abs(c2 - d2)) / 4
      sum += (hf1 + hf2) / 2
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

/** Decode one frame at `t` seconds as raw rgb24, or undefined on failure. */
function decodeFrame(file: string, t: number): Buffer | undefined {
  const args = ['-v', 'error', '-an']
  if (t > 0) args.push('-ss', t.toFixed(3))
  args.push('-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1')
  const res = spawnSync('ffmpeg', args, { encoding: 'buffer', timeout: DECODE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 })
  if (res.status !== 0) return undefined
  const out = res.stdout
  return out !== undefined && out.length > 0 ? out : undefined
}

/**
 * Measure chroma noise in an image or video file.
 *
 * @param file - absolute path to a still (png/jpg) or a clip (mp4/...).
 * @param frames - how many frames to sample from a clip (spread across its
 *   timeline; the worst one decides). Stills always sample exactly one.
 * @param threshold - chroma_hf at or above which the asset is rejected. A value
 *   <= 0 makes every measurement pass, which is how callers disable the gate.
 */
export function pixelQuality(file: string, frames = 1, threshold = DEFAULT_PIXEL_THRESHOLD): PixelQuality {
  const want = Math.max(1, Math.floor(frames))
  const base = { frames: 0, threshold, samples: [] as number[] }

  if (!existsSync(file)) {
    return { ...base, ok: false, worst: Number.POSITIVE_INFINITY, mean: Number.POSITIVE_INFINITY, detail: 'asset file not found' }
  }
  const info = probe(file)
  if (info === undefined) {
    return { ...base, ok: false, worst: Number.POSITIVE_INFINITY, mean: Number.POSITIVE_INFINITY, detail: 'ffprobe could not read a video stream' }
  }

  const times = sampleTimes(info, want)
  const samples: number[] = []
  for (const t of times) {
    const buf = decodeFrame(file, t)
    if (buf === undefined) {
      return { ...base, ok: false, worst: Number.POSITIVE_INFINITY, mean: Number.POSITIVE_INFINITY, detail: `ffmpeg could not decode a frame at ${t.toFixed(2)}s` }
    }
    // Derive the row count from the decoded buffer rather than trusting the
    // probe: a mismatch would silently skew the neighbour stride.
    const height = Math.floor(buf.length / (info.width * 3))
    if (height < 3) {
      return { ...base, ok: false, worst: Number.POSITIVE_INFINITY, mean: Number.POSITIVE_INFINITY, detail: `decoded frame too small (${buf.length} bytes)` }
    }
    samples.push(chromaHf(buf, info.width, height))
  }

  const worst = Math.max(...samples)
  const mean = samples.reduce((a, b): number => a + b, 0) / samples.length
  const ok = threshold <= 0 || worst < threshold
  const first = (samples[0] ?? 0).toFixed(2)
  const detail = `chroma_hf worst ${worst.toFixed(2)} (first ${first}, mean ${mean.toFixed(2)}) over ${samples.length} sampled frame(s), threshold ${threshold.toFixed(2)}`
  return { ok, worst, mean, samples, frames: samples.length, threshold, detail }
}
