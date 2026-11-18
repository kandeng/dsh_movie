# Phase 8 Plan: ComfyUI GPU Media Backend — Off-Host Image/Video Generation via the MediaProvider Seam

- Status: 📝 PROPOSED (2026-08-09) — design only; nothing is wired yet. The `MediaProvider` seam today ships a canned placeholder + the Bailian "Happyhorse" **video** provider; **image is UNAVAILABLE** (D15). This plan adds an off-host **ComfyUI** server (on the enterprise H100 GPU box, inside the firewall) as the real image/video generation backend behind that seam, plus the output-media plumbing, docs, and verification.
- Depends on: `phase5-functional-node-palette.md` (the functional catalog, the D15 availability gate `movie-executor/model-catalog.ts`, the `MediaProvider` seam `movie-executor/media-provider.ts`, and the config-gated off-host precedent `movie-executor/video-provider.ts`), `phase6-node-card-and-editor.md` (`contentRef` D5, the read-only card media stub), `phase7-external-skills-and-asset-market.md` (the `<roomDir>/artifacts/` convention from P7-M6, the fail-closed sandbox/health discipline, and the Leg B run lifecycle in `movie-executor/runner.ts`), `doc/architecture.md` §4.2–4.3 (why we keep the ComfyUI protocol + its HTTP/WS API) and §6.3 (CPU-only host, inference delegated off-host inside the firewall).
- Scope: **server + docs + client media pipeline**. The server gains one new media provider (`comfy-provider.ts`) + workflow templates + a config gate; the D15 inventory flips `image` (and optionally a second `video` route) to available; the room notifier gains a real media-upload path (`sendFile`) and the canvas card stub resolves the generated artifact. Docs gain a thin README subsection + a full GPU-backend ops doc + an architecture section. **Explicitly NOT** in scope: replacing Leg B/Leg C with a raw ComfyUI passthrough, changing the canvas UI or the protocol graph shape, or exposing ComfyUI's native UI to end users.

## 1. Goal

Let the canvas's **image** and **video** generator nodes produce *real* media by delegating inference to a **ComfyUI server running on the enterprise H100 GPU box inside the firewall** — without putting any Python/model code on the (CPU-only) DSH host and without changing the Toonflow canvas UX.

The four founding questions this plan answers:

1. **Where does generation run?** On a separate, operator-managed **ComfyUI** instance on the H100 server (§6.3's "self-hosted service inside the firewall" — the image/video analogue of the vLLM/Ollama/SGLang text example). dsh_movie only *submits graphs over the wire*; it manages no weights and runs no model code (D7).
2. **How does a generator node reach it?** Through the **existing `MediaProvider` seam** (Mode A). `ImageGenerator`/`VideoGenerator` already dispatch there; we add a `ComfyMediaProvider` that maps each node to a server-held ComfyUI **workflow template**, submits it (`POST /prompt`), tracks it (`/ws` or `/history`), and returns the output (D1/D3/D5).
3. **How does the media get back to the user?** Real bytes are pulled from ComfyUI (`/view`), uploaded into the room through **authenticated media** (`RoomPoster.sendFile`), written under `<roomDir>/artifacts/`, and referenced by the node's `contentRef` so the card stub plays it and downstream nodes consume it (D6). *This closes a real gap: today media artifacts are echoed as **text** only.*
4. **How do we stay safe and honest?** The endpoint is **config-gated** (mirroring `videoConfigFromEnv`), **firewall-internal + token-authed**, accepts **only server-held templates** (never client-authored graphs), probes health before flipping a modality available, and **fails closed** to the D15 `ModelUnavailableError` + `customer_service` notice when unreachable (D2/D9/D10).

Model *routing* still honors the DSH model rule: ComfyUI is reached as a **configured media endpoint** (the sanctioned `MediaProvider` seam, same precedent as the Happyhorse video provider's `fetch`), with the base URL/token held in env — never hardcoded, never a new app-layer model client.

## 2. Current state (what exists today)

- **The media seam.** `movie-executor/media-provider.ts`: `MediaProvider.generate(step, inputs) → { artifact?, media? }`; `cannedMediaProvider` (offline placeholder) and `createRoutingMediaProvider({ video?, fallback })` which routes only `VideoGenerator` to a real provider and everything else to canned (L62–69).
- **The one real off-host provider.** `movie-executor/video-provider.ts`: Bailian "Happyhorse" via DashScope async create→poll over `fetch`; **config-gated** by `videoConfigFromEnv` (`DSH_VIDEO_MODEL` + key → `undefined` when absent, so the provider is never constructed); returns `{ artifact: <url>, media: 'video' }`. This is the exact template Phase 8 mirrors.
- **The D15 availability gate.** `movie-executor/model-catalog.ts`: `ModelInventory { text, video, image, audio }` → `availabilityFromInventory()`; unlisted modalities **fail closed** to `unavailable`. An unbacked generator throws `ModelUnavailableError`; `runner.ts` (L266–285) posts `MODEL_UNAVAILABLE_NOTICE` via `customer_service` and settles the node `error` with reason `model-unavailable`, short-circuiting dependents to `skipped`.
- **The injection block.** `gateway/src/index.ts` L216–233: builds `videoConfig`/`videoProvider`, `routingMediaProvider = createRoutingMediaProvider({ video?, fallback: canned })`, and `availability = availabilityFromInventory({ text: llmText!==undefined, video: videoProvider!==undefined, image: false, audio: false })`. **Image is hard-wired `false`.**
- **The runner dispatch + lifecycle.** `movie-executor/runner.ts`: media steps call `deps.mediaProvider.generate(currentType, currentInputs)` (L244), broadcast `executed`/`executing`/`execution_success` over the Leg B WS (L248–263), and echo each artifact into the room via `deps.notifier.echoArtifact(roomId, classType, artifact, kind)`.
- **The output gap.** `movie-executor/room-notifier.ts`: `echoArtifact` (L106–109) posts media as **text** (`[classType] <artifact>`) via `RoomPoster.sendText`. **There is no `sendFile`/upload path** — so a real generated image/video is not yet delivered as playable room media. This is the largest new surface (D6).
- **The node types.** `protocol/src/nodes.ts`: `NodeModality = 'text'|'image'|'video'|'audio'`; `ImageGenerator` (modality `image`, output `image:IMAGE`, widget `image:STRING`), `VideoGenerator` (modality `video`, output `video:VIDEO`, optional `image:IMAGE` input), `MediaConcat`. `protocol/src/templates.ts` already wires `ImageGenerator`/`VideoGenerator`/`MediaConcat` into starter graphs.
- **The protocol stance.** `doc/architecture.md` §4.2–4.3: we deliberately **keep ComfyUI's protocol and backend** (`POST /prompt`, `/queue`, `/interrupt`, `/free`, `/history`, `/view`, `/object_info`, `/ws`, `/upload/image`, `/system_stats`) and only replaced its *frontend UI*. Leg B is currently a **ComfyUI-subset** served by dsh_movie's own gateway with canned execution (`fixtures.ts` stub advertises `/object_info` + `/system_stats`).

## 3. Decisions D1–D12

### D1 — Integration mode: ComfyUI behind the `MediaProvider` seam (Mode A), not a Leg B replacement
The functional generator nodes dispatch through `MediaProvider`; we add a `ComfyMediaProvider` there. We do **not** point Leg B at the real ComfyUI server wholesale: dsh_movie's graph uses **functional class types** (`ImageGenerator`, `VideoGenerator`, `MediaConcat`, `FamilyDispatch`, `VideoCompositor`) plus Leg C governance (family dispatch, availability gate, ops/narration), not ComfyUI's `KSampler`/`VAE`/latent nodes. A raw passthrough would bypass that governance. Mode A keeps the canvas, protocol, and Leg C untouched; ComfyUI is purely a per-generator execution backend.

### D2 — Off-host, in-firewall, config-gated endpoint (mirror `videoConfigFromEnv`)
A new `comfyConfigFromEnv(env)` returns `undefined` unless a base URL is present, so the provider is never constructed when unconfigured and the D15 gate keeps image/video `unavailable` (fail closed). Env: `DSH_COMFY_BASE_URL` (e.g. `https://comfy.internal:8188`), `DSH_COMFY_TOKEN` (optional bearer, never logged), `DSH_COMFY_POLL_MS` (default 1500), `DSH_COMFY_TIMEOUT_MS` (default 600000 — video renders are long), `DSH_COMFY_INFLIGHT_MAX` (default 1, see D8). **Reconciliation with the "no direct model HTTP" rule:** that rule targets hand-rolled Bailian/DashScope clients + key sprawl; ComfyUI is an *internal workflow engine* reached as a **configured media endpoint** — the exact precedent `video-provider.ts` already sets (a provider doing `fetch` to an env-configured off-host URL). Keys live in env/DSH settings, the host stays CPU-only. Recorded here as an explicit decision.

### D3 — One server-held workflow template per generator modality; `class_type` → template map
ComfyUI consumes a **graph JSON**. dsh_movie holds a small set of versioned **workflow templates** server-side (not client-authored): `image` (e.g. SDXL/Flux txt2img, optional img2img when an `image` input is present) and `video` (e.g. Wan2.x / HunyuanVideo / LTX / CogVideoX). A template is a ComfyUI prompt graph with named injection points; `ComfyMediaProvider.generate(classType, inputs)` maps the node's resolved inputs (`prompt`/`resolved` → positive prompt, `image` → an `/upload/image`-provided input, seed/size/duration → template params) onto the template, then submits. Templates validate against `/object_info` at activation (D9) so a missing custom node degrades instead of failing mid-run.

### D4 — Availability flip via the D15 inventory (settings-gated, per-run re-check)
`index.ts` L228–233 changes `image: false` → `image: comfyImageReady`, and (optionally) routes `VideoGenerator` to ComfyUI instead of/alongside Happyhorse. `comfyImageReady` = a ComfyUI config is present **and** the `image` template validated against `/object_info`. Adding the endpoint in env flips image to available **with no code change**; the gate re-checks per run.

### D5 — Async execution + progress mapping onto the existing Leg B lifecycle
`POST /prompt` → `{ prompt_id }`; track via `/ws` (`executing`/`progress`/`executed`) with a `/history/{prompt_id}` poll fallback. Map ComfyUI progress onto the runner's existing `deps.broadcast([...])` Leg B channel so the canvas shows **real per-node progress** for free. Honor `DSH_COMFY_TIMEOUT_MS`; on cancel/timeout issue `POST /interrupt`. Failures throw (→ node `error`), never silently can.

### D6 — Output media pipeline: bytes → authenticated media → `contentRef` → card stub (closes the text-only gap)
On success, read the output file(s) from ComfyUI (`/history` outputs → `GET /view`), then: (a) upload into the room via a **new `RoomNotifier.sendFile`/media-echo path** (`RoomPoster.sendFile`) so it appears as real playable media; (b) persist under `<roomDir>/artifacts/` (mirroring P7-M6); (c) set the node's `contentRef` with `origin: 'generated'` so the read-only card stub (phase6 D1/D5) resolves and plays it, and downstream `MediaConcat`/`VideoCompositor` consume the artifact — not a bare cross-origin ComfyUI URL. **The browser never talks to ComfyUI directly** (D10/R8): the gateway proxies bytes and re-publishes through authenticated media.

### D7 — Installing/running models is ComfyUI's job, not dsh_movie's
Model install/run (ComfyUI + ComfyUI Manager + custom nodes + checkpoint downloads) happens on the **H100 box**, operator-managed, weights on GPU-box local storage. dsh_movie manages **no** weights and ships **no** Python. The repo documents only the dsh_movie-side contract (env + smoke test) and **links out** to upstream ComfyUI for the install itself (D11).

### D8 — Concurrency & queueing
ComfyUI is **single-queue by default**. Strategy: a per-provider in-flight cap (`DSH_COMFY_INFLIGHT_MAX`); the Leg B executor already schedules prompts as async `movie-exec` jobs, so backpressure simply keeps a run queued. For multiple H100s, run **one ComfyUI per GPU** behind a small router/pool (config lists endpoints; round-robin/least-busy). Autoscaling the pool is out of scope.

### D9 — Health/readiness probe + honest degradation
At gateway activation, probe `GET /system_stats` + `GET /object_info`; a modality flips available **only** when reachable and its template's required node types are present. If ComfyUI is down/unreachable at run time, the gate fails the node → `ModelUnavailableError` → `customer_service` posts the D15 notice → dependents `skipped` (never a canned placeholder). Optionally serve a cached last-good readiness between probes.

### D10 — Security: firewall-internal, token-authed, server-held templates only
An in-firewall ComfyUI is effectively arbitrary-code-execution on the GPU box, so: bind it internal-only; require `DSH_COMFY_TOKEN`; accept **only server-held templates** (D3) — **never** a client-authored graph — so the canvas can't become an RCE vector; enforce a **node-type allow-list** in templates; and proxy all output through the gateway (D6). The canvas remains the only user-facing surface (Toonflow UI, not ComfyUI's).

### D11 — Docs placement (sequenced AFTER implementation)
- **README.md**: a thin **§3.5 "GPU media backend (ComfyUI, optional)"** — what it enables, the `DSH_COMFY_*` env, how to smoke-test, and a **link out** to upstream ComfyUI install docs. No duplicated generic install steps.
- **doc/comfyui-gpu-backend.md** (new): the full H100 ops guide — install/run/test of ComfyUI + Manager + checkpoints, VRAM/fp8/H100 notes, multi-GPU pool, template authoring, troubleshooting.
- **doc/architecture.md**: a new **§10 "GPU media backend (ComfyUI)"** — the seam, the template map, the output-media flow, the security stance (+ a mermaid overview).
Rationale: the README documents only **shipped, wired** dependencies (PostgreSQL, Synapse); a ComfyUI section is added once the integration is real, and heavy ops live in `doc/`.

### D12 — i18n
Any new user-facing strings (e.g. a ComfyUI-specific progress label or a "image backend unreachable" nuance beyond the generic D15 notice) are added as Chinese-keyed entries × 21 catalogs at pinyin-sorted positions, per the established i18n workflow. Reuse the existing `MODEL_UNAVAILABLE_NOTICE` where possible to minimize new keys.

## 4. Server & client changes

- `server/plugins/dsh-movie-gateway/src/movie-executor/comfy-provider.ts` (new): `ComfyModelConfig`, `comfyConfigFromEnv`, `createComfyProvider(config, logger, templates)` → `MediaProvider` (submit `/prompt` → track `/ws`|`/history` → fetch `/view` → return `{ artifact, media, bytes? }`); mirrors `video-provider.ts`.
- `server/plugins/dsh-movie-gateway/src/movie-executor/comfy-templates/` (new): versioned `image.json` / `video.json` ComfyUI prompt graphs + a loader/validator (against `/object_info`) + the `class_type`→template map.
- `movie-executor/media-provider.ts`: extend `createRoutingMediaProvider` to accept an `image?` route (and allow `video?` to be ComfyUI); extend `MediaGeneration` with an optional binary/`contentRef` payload for D6.
- `movie-executor/model-catalog.ts` + `gateway/src/index.ts`: derive `image` (and optional ComfyUI `video`) availability from `comfyConfigFromEnv` + template readiness; inject the ComfyUI route.
- `movie-executor/runner.ts`: on media success with bytes, drive the new room upload + `<roomDir>/artifacts/` write + `contentRef` set; map ComfyUI progress onto `deps.broadcast`; wire `/interrupt` on cancel/timeout.
- `movie-executor/room-notifier.ts`: add a real media path (`echoMediaFile`/`sendFile` via `RoomPoster.sendFile`) alongside the existing text `echoArtifact`.
- `server/.env` / config: `DSH_COMFY_BASE_URL`, `DSH_COMFY_TOKEN`, `DSH_COMFY_POLL_MS`, `DSH_COMFY_TIMEOUT_MS`, `DSH_COMFY_INFLIGHT_MAX`, optional pool list.
- `server/scripts/verify-comfy.ts` (new) + a mock ComfyUI HTTP+WS fixture (`test/fixture-comfy-server.ts`): submit→progress→output round-trip, availability flip, fail-closed, artifact bytes→room+`contentRef`.
- `client/web`: the card media stub already resolves `contentRef`; verify generated image/video plays (likely no code change beyond confirming the `origin: 'generated'` path). Any new label → `client/i18n/src/locales/*.json` × 21 (D12).
- Docs: `README.md` §3.5, `doc/comfyui-gpu-backend.md`, `doc/architecture.md` §10 (D11).

## 5. Milestones

- **P8-M0 — Design + decision sign-off.** This doc. Acceptance: seams verified against source; the D2 "no-direct-model-HTTP" reconciliation and the D10 security stance explicitly approved by the user before any build.
- **P8-M1 — `ComfyMediaProvider` + config gate + routing + availability flip.** `comfy-provider.ts` (submit/ws/poll/view), `comfy-templates/` (image+video) with `/object_info` validation, `createRoutingMediaProvider` image route, `index.ts` inventory flip. Acceptance: repo-wide `pnpm typecheck` green; `verify-comfy.ts` against the **mock** ComfyUI fixture — an `ImageGenerator` run submits a graph, tracks progress, returns an output; image flips `available` when configured and `unavailable` (fail-closed + `customer_service` notice) when not; legacy canned/verify bridges stay green.
- **P8-M2 — Output media pipeline (the gap).** Fetch output bytes → `RoomPoster.sendFile` → `<roomDir>/artifacts/` → node `contentRef` (`origin: 'generated'`) → card stub plays it → downstream `MediaConcat`/`VideoCompositor` consume it. Acceptance: `verify-comfy.ts` asserts a generated image lands as a **room media event** + an artifact file + a resolvable `contentRef`; the browser never receives a raw ComfyUI URL.
- **P8-M3 — Progress, lifecycle, interrupt, timeout, concurrency cap.** Map `/ws` progress onto the Leg B broadcast; cancel → `/interrupt`; `DSH_COMFY_TIMEOUT_MS` fails honestly; `DSH_COMFY_INFLIGHT_MAX` bounds concurrency. Acceptance: the Leg B WS shows real per-node progress; a cancelled run interrupts the ComfyUI job; a timeout settles `error`; concurrent runs respect the cap and queue.
- **P8-M4 — Health probe, degradation, multi-GPU routing.** Activation `/system_stats` + `/object_info` probe; run-time fail-closed; optional pool/round-robin over multiple endpoints. Acceptance: with ComfyUI down the modality is `unavailable` + notice posted; with a 2-endpoint pool, runs distribute; a template whose node types are missing degrades instead of failing mid-run.
- **P8-M5 — Docs + i18n + status flip.** README §3.5, `doc/comfyui-gpu-backend.md`, `doc/architecture.md` §10; any D12 keys × 21; flip this plan's status 📝 → ✅ with per-milestone notes. Acceptance: final gates green (`pnpm typecheck`, `pnpm build:web`, all `verify-*` incl. `verify-comfy`); docs describe only shipped behavior; **live H100 smoke test** (operator-run, documented) produces one real image + one real video end-to-end.

## 6. Verification strategy

- **Static:** `pnpm typecheck` (protocol, server, sdk, web via vue-tsc, i18n) + `pnpm build:web` after every milestone touch.
- **Mock-ComfyUI (CI, no GPU):** `verify-comfy.ts` drives a fixture HTTP+WS server implementing the ComfyUI subset (`/prompt`, `/ws` lifecycle, `/history`, `/view`, `/object_info`, `/system_stats`, `/interrupt`) — asserts routing, availability flip, fail-closed, progress mapping, and the artifact-bytes→room+`contentRef` path deterministically.
- **Live H100 (manual, operator):** documented exact commands in `doc/comfyui-gpu-backend.md` — start ComfyUI, install one image + one video model, run the matching canvas node, confirm real media in the card + room.
- **Browser:** manual pass — `ImageGenerator` → Run → real image appears in the card stub and as room media; a video node likewise.
- **Regression:** existing `verify-*` scripts (sandbox, plugins-search/download/execute, comfy-bridge) stay green; the canned fallback is untouched when ComfyUI is unconfigured.
- **i18n:** JSON parse + per-key coverage across 21 catalogs for any D12 keys.

## 7. Out of scope

- Replacing Leg B/Leg C with a raw ComfyUI graph passthrough (D1) — the functional/governed graph stays.
- Exposing ComfyUI's native UI to end users — the Toonflow canvas remains the only surface.
- Client-authored arbitrary graphs submitted to ComfyUI (D10 security) — server-held templates only.
- Training/fine-tuning models; authoring ComfyUI custom nodes; managing GPU-box weights from dsh_movie.
- The **audio** generator modality (stays unbacked unless a ComfyUI audio template is added later).
- Autoscaling / multi-tenant GPU quota / billing for the pool.
- Loopback-publishing dsh_movie graphs as a ComfyUI-compatible public API.

## 8. Risks

- **R1 — Security: in-firewall ComfyUI ≈ arbitrary code exec on the GPU box.** Mitigated by D10: internal-only bind, token auth, **server-held templates only** (no client graphs), a node-type allow-list, and gateway-proxied output (browser never reaches ComfyUI).
- **R2 — Tension with the "model calls ride DSH, no direct model HTTP" decision.** Mitigated by D2: ComfyUI is a *configured media endpoint* on the sanctioned `MediaProvider` seam (the `video-provider.ts` precedent), env-held URL/token, host stays CPU-only. Explicitly recorded and signed off at P8-M0.
- **R3 — Output-media plumbing is the largest new surface** (`echoArtifact` is text-only today; no `sendFile`). Mitigated by isolating it in P8-M2 with a dedicated verify assertion (room media event + artifact file + resolvable `contentRef`).
- **R4 — Long video renders vs job/WS timeouts.** Mitigated by the existing async `movie-exec` job model, a generous configurable `DSH_COMFY_TIMEOUT_MS` (default 600 s, mirroring Happyhorse's 300 s but larger), and `/ws` progress heartbeats keeping the Leg B channel alive.
- **R5 — ComfyUI single-queue throughput.** Mitigated by D8: in-flight cap + queue backpressure; one instance per GPU behind a router for parallelism.
- **R6 — Weight/VRAM availability on H100.** Big video models need 80 GB + fp8/bf16; mitigated by operator-managed checkpoints (documented) and an `/object_info` probe that verifies required node types before flipping a modality available (fail closed otherwise).
- **R7 — ComfyUI API / template version drift.** Mitigated by pinning the ComfyUI version, validating templates against `/object_info` at activation, and degrading to `unavailable` on mismatch rather than failing mid-run.
- **R8 — Cross-origin / unauthenticated `/view`.** ComfyUI's `/view` is unauthenticated; mitigated by the gateway downloading bytes and re-publishing through authenticated media (D6) — the raw URL is never surfaced to the browser.
- **R9 — Legacy canned/verifier regressions.** Routing falls back to canned when ComfyUI is unconfigured (exactly like the video route), so offline verification and the six-step legacy pipeline stay unchanged.
