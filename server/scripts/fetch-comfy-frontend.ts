/**
 * Fetch the pinned ComfyUI frontend build (Phase-2 M5, Option 1 canvas track).
 *
 * The Studio canvas embeds the *unmodified* ComfyUI frontend served same-origin
 * at `/comfy/` (see `doc/design/phase2-client-and-protocol.md` §3 and
 * `doc/design/phase3-comfyui-canvas-agent-scripting.md` §2). The frontend is
 * GPL-3.0; we serve the official compiled `dist.zip` as static assets and never
 * vendor/copy its source into our own bundle, so there is no license
 * contamination. The downloaded build lives in a gitignored directory
 * (`server/static/comfy/`) — only this script and the version pin are committed.
 *
 * Source of truth for the build: the GitHub release asset `dist.zip` published
 * by `Comfy-Org/ComfyUI_frontend` (the same compiled bundle shipped as the PyPI
 * `comfyui-frontend-package`). We download over HTTPS and extract with the
 * system `unzip`.
 *
 * Run from the `server/` directory:
 *   node --experimental-strip-types scripts/fetch-comfy-frontend.ts
 *
 * Override the pin ad-hoc with: COMFY_FRONTEND_VERSION=v1.60.0 node ... (the
 * committed pin below stays the default).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')

/**
 * The pinned ComfyUI frontend release. Bumping this is a deliberate act: the
 * bridge extension and the boot-protocol subset are conformance-tested against
 * this exact version (design doc §3 "pin the frontend build").
 */
const PINNED_VERSION = 'v1.60.0'

/** GitHub release asset holding the compiled static frontend. */
const RELEASE_REPO = 'Comfy-Org/ComfyUI_frontend'

/** Where the extracted build is served from (gitignored). */
const STATIC_DIR = resolve(serverRoot, 'static', 'comfy')

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

/** Download a URL to a local file path, following redirects. */
async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} for ${url}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  writeFileSync(dest, bytes)
  log(`downloaded ${(bytes.byteLength / 1_048_576).toFixed(1)} MiB -> ${dest}`)
}

async function main(): Promise<void> {
  const version = process.env.COMFY_FRONTEND_VERSION ?? PINNED_VERSION
  const url = `https://github.com/${RELEASE_REPO}/releases/download/${version}/dist.zip`
  const zipPath = resolve(tmpdir(), `comfyui-frontend-${version}.zip`)

  log(`ComfyUI frontend pin: ${version}`)
  log(`release asset: ${url}`)

  await download(url, zipPath)

  // Fresh extract: drop any stale build, then unzip the release into place.
  rmSync(STATIC_DIR, { recursive: true, force: true })
  mkdirSync(STATIC_DIR, { recursive: true })
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', STATIC_DIR], { stdio: 'inherit' })
  rmSync(zipPath, { force: true })

  // Sanity-check the extracted build shape.
  const indexHtml = resolve(STATIC_DIR, 'index.html')
  const assets = resolve(STATIC_DIR, 'assets')
  let indexOk = false
  let assetsOk = false
  try {
    indexOk = statSync(indexHtml).isFile()
  } catch {
    indexOk = false
  }
  try {
    assetsOk = statSync(assets).isDirectory()
  } catch {
    assetsOk = false
  }
  if (!indexOk) {
    process.stdout.write(`ERROR: expected ${indexHtml} after extract\n`)
    process.exit(1)
  }
  log(`extracted -> ${STATIC_DIR}`)
  log(`index.html: ${indexOk ? 'ok' : 'MISSING'}; assets/: ${assetsOk ? 'ok' : 'MISSING (non-fatal)'}`)
  log(`\nServe this directory at /comfy/ (gateway static route) and embed it in the Studio canvas iframe.`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`fetch-comfy-frontend failed: ${String(error)}\n`)
  process.exit(1)
})
