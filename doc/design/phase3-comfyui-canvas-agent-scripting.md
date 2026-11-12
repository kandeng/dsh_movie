# Phase 3 Plan: ComfyUI iframe Canvas + Agent Graph Scripting + Supervision Loop

- Status: P3-M1 + P3-M2 delivered via Phase 2 M5-M7 (bridge extension, movie-step node types, workflow round-trip); P3-M3 implemented and verified (see §7 build notes); P3-M4-M6 pending go-ahead
- Depends on: `phase2-client-and-protocol.md` (§3 canvas decision gate assumed passed: ComfyUI iframe adopted), `phase1-dsh-matrix-feasibility.md`
- Scope: Studio-page canvas = embedded ComfyUI; manual graph editing; scriptable bridge API; chat-driven agent scripting of the graph; supervision loop design

## 1. Decisions from discussion

1. **Manual editing**: user creates/modifies/deletes/moves nodes and links edges directly in the ComfyUI LiteGraph editor inside the iframe — native capability, no extra work beyond embedding.
2. **Scriptable canvas**: the iframe exposes a versioned command API implemented by a bridge extension we own (a ComfyUI frontend extension running inside the iframe), reached over `postMessage`; the parent never touches ComfyUI internals directly.
3. **Chat-driven scripting**: chat → DSH server agent (DSH's native Cordis agent loop — note: *not* a pi-coding agent; pi belongs to the abandoned Toonflow stack) → intent analysis → **constrained op-script** streamed to the client → deterministic browser executor applies it through the bridge API → results streamed back for server-side evaluation/iteration.
4. **Supervision loop**: split into (a) a deterministic client-side executor/verifier loop (transactions, postcondition checks, retry/rollback) and (b) the intelligent observe→re-plan loop, which stays server-side in the DSH agent loop. **pi-core in the browser is feasible but NOT recommended** as the supervisor (§5).

## 2. Canvas embedding model (recap + refinement)

- **No Python ComfyUI server (frontend-only deployment)**: the unmodified ComfyUI frontend build (pinned version; GPL-safe — served as-is, not vendored) is served by our own host (e.g. `/comfy/`) and embedded same-origin in the Studio canvas slot iframe. The `dsh-comfyui-protocol` plugin (Phase 1 §3) on the DSH host implements the minimal ComfyUI backend protocol subset the frontend demands: `GET /system_stats`, `GET /object_info` (generated from our movie-step node schemas), `GET /extensions`, `WS /ws` (status + execution lifecycle), `GET/POST /userdata` (mapped onto the Leg C workflow store), plus no-op/forwarded `/queue`, `/history`, `/prompt`. **Leg B is this implementation.** Same-origin iframe gives session-cookie auth (no cross-origin ticket handshake); one less process to operate.
- **ComfyUI is a pure editor/visualizer**: its `/prompt` execution queue is bypassed (accepted but never executed natively); execution lifecycle events are emitted by our DSH workflow executor as ComfyUI WS messages and painted as node status badges by the bridge extension.
- **Movie-step node types** appear in `/object_info` (served by us) and are registered client-side by our bridge extension (`LiteGraph.registerNodeType`): six step groups + artifact nodes (script, shot plan, character/scene asset, storyboard, clip, assembled movie), each with typed input/output slots matching the Leg B workflow-JSON interchange. No Python node definitions exist anywhere — there is no ComfyUI backend.
- Workflow persistence: the bridge extension serializes/deserializes the graph in ComfyUI workflow-JSON shape; authoritative copies live in the server workflow store (Leg C).

## 3. Bridge API contract v1 (postMessage, versioned)

Parent → iframe commands: `hello/version`, `graph.load(json)`, `graph.export`, `node.add(type,pos,props)`, `node.remove(id)`, `node.move(id,x,y)`, `node.setWidget(id,key,value)`, `node.setStatus(id,status)`, `edge.add(fromId,slot,toId,slot)`, `edge.remove(id)`, `group.collapse(id,flag)`, `view.fit(ids?)`.
Iframe → parent events: `ready`, `graphChanged(json,rev)`, `nodeSelected(id)`, `nodeMoved/edgeAdded/…(op-level)`, `execPainted(id,status)`, `bridgeError(code)`.
Every message carries `{v:1, txn?, type, payload}`; the contract lives as typed TS in the shared `dsh_movie/protocol` package with an e2e conformance test (Phase 2 M5 carry-over).

## 4. Graph authority, transactions, concurrency

- **Server-authoritative graph**: every mutation — manual (iframe `graphChanged`) or agent (op-script) — commits to the Leg C workflow store with a revision gate (vidsay RoomGraph precedent); the server broadcasts the converged graph; clients (including the iframe via `graph.load`) converge idempotently by revision.
- Agent op-scripts execute as **transactions** (`txnId`): executor applies ops in order, verifies postconditions, and reports `opResults[{op, ok, error}]`; a failed transaction rolls back to the pre-txn snapshot.
- Manual + agent concurrency: server serializes commits; a client whose base revision is stale re-bases (reload converged graph) before re-committing. Undo stack kept per client view (view-state, not synced).

## 5. Agent scripting channel and the supervision loop

**Op-script, not arbitrary JS.** The server agent emits a constrained operation script (JSON op sequence over the §3 command catalog, e.g. `[{op:"node.add",...},{op:"edge.add",...}]`), never eval-able arbitrary JavaScript: avoids executing untrusted/LLM-hallucinated code in the user's browser session, keeps transactions verifiable, and makes replays/diffs testable. A tiny DSL sugar layer may compile to the same ops later.

**Client executor/verifier loop (deterministic, no LLM):**
1. receive `canvasScript{txnId, ops}` over Leg C stream; 2. snapshot graph; 3. apply ops via bridge; 4. check postconditions (node exists, edge connected, widget value, status painted); 5. retry with backoff within budget on transient bridge errors; 6. rollback on hard failure; 7. stream `opResults` back.

**Intelligent supervision stays server-side:** the DSH agent loop observes `opResults` + Leg B execution events, evaluates against the step rubric, and issues fix-up op-scripts (observe → re-plan → act), i.e. the evaluate/iterate task of the canonical loop runs where the model and the skills live.

**pi-core verdict (Q4):** using `@earendil-works/pi-agent-core` in the browser as the supervision loop — as Toonflow's canvas did — is *technically feasible and proven*, but rejected for dsh_movie because: (i) it re-imports the pi/Toonflow stack we deliberately abandoned; (ii) an in-browser LLM loop needs server-proxied model keys plus duplicated prompt/skill infrastructure for no gain, since every decision still needs server context; (iii) the supervision required here is deterministic verification, which a small transactional executor does more reliably and testably than an LLM loop; (iv) stack unity: DSH's own `sdk`/web profile is the sanctioned path if a genuine in-browser agentic feature ever appears. Offline E2E supervision of the webpage (tests) continues via Playwright against a debug Chrome, per existing practice.

## 6. Server-side graph tasks: build vs copy-paste vs delegate

When the DSH host receives graph-operation requests from the client canvas, the work splits three ways — new JS is limited to graph plumbing; heavy media machinery is delegated.

| Task | Source | Notes |
|---|---|---|
| Workflow JSON validation | New, small (zod) | Node/link/widget shapes adapted from vidsay client `canvasFile.ts`; one TS node-schema registry (in `dsh_movie/protocol`) feeds both the validator and `/object_info` |
| Node registry & definition metadata | New, small | TS schema → `/object_info` generator (required by §2 boot protocol) |
| Topological sorting (execution order) | New (~30 lines, Kahn + cycle detection) | Absent from both DSH and vidsay; DSH `ctx.workflowEngine` is subagent orchestration, not a media-DAG scheduler |
| Model loading / caching | **Delegate — never on the DSH host** | Owned by the inference endpoint (cloud provider or company GPU server); invisible to DSH |
| GPU inference runner (diffusion/video/samplers/VAE/controlnet) | **Delegate — runs on the GPU server** | Reached over HTTPS via OpenAI-compatible (or provider-native) APIs; zero inference code on the DSH host |
| Preview image encoding, `/view` blob serving | Copy-paste + thin new | Proxy/cache blobs returned by providers (vidsay `routes/assets`, ffmpeg serving patterns); if an in-house ComfyUI API worker runs on the GPU server, proxy its `/view` over HTTPS |
| Queue management, cancellation, history | DSH-native + copy-paste | `ctx.jobs` (+ `jobs-local`, `tool-jobs`) is the queue/cancel/ownership contract; graph-state history copies vidsay `graphFanout.ts` (revision gate, `semanticKey` dedup, `commitRoomGraphGated`), `agentWorkspace.ts` store, `spoke.ts` fan-out |
| Error reporting, progress events | DSH-native shape + copy-paste | Leg B WS emitter speaks the ComfyUI envelope (`status/executing/progress/executed`); patterns copied from `productionState.ts`/`spoke.ts`; errors also land in the append-only session log and the `opResults` channel (§5) |

**GPU delegation — provider-API mode only (deployment clarified):** all inference runs off the DSH host. Whether cloud (e.g. Bailian text2image/text2video) or self-hosted on the company GPU server inside the firewall (vLLM / ComfyUI-as-API / any diffusion service), the DSH host reaches it over **HTTPS with OpenAI-compatible (or provider-native) APIs** through DSH `ctx.llm`/`ctx.credentials`; copy vidsay's `aiRouter` provider abstraction + `routes/ffmpeg` assembly. The CPU server hosting DSH runs zero Python and zero model code; queue = `ctx.jobs`, progress = Leg B emitter. (The earlier "headless ComfyUI GPU worker" option collapses into this: such a worker, if used, lives on the GPU server and is consumed as an HTTPS provider, not co-located with DSH.)

Explicitly NOT copied from vidsay: `responder.ts` (pi-brain), better-auth wiring, the pi runtime (per Phase 1).

## 7. Milestones

- **P3-M1**: bridge extension inside ComfyUI iframe implementing §3 contract v1; conformance e2e test (boot protocol + postMessage handshake); DSH host serving the pinned frontend build with the minimal backend subset (session-cookie auth).
- **P3-M2**: movie-step LiteGraph node types + manual edit persistence round-trip (edit → server store → reload convergence).
- **P3-M3**: op-script executor/verifier with transactions, rollback, `opResults` stream; Leg C `canvas.*` namespace. — ✅ DONE (2026-08-09): chat intent → validated op-script → mux stream → deterministic client executor (snapshot / apply / postcondition / retry / rollback / `opResults` report).
  - Build notes: the Leg C `canvas.*` op-script catalog lives in `protocol/src/op-script.ts` — 9 op types (`node.add|remove|move|setWidget|setStatus`, `edge.add|remove`, `group.collapse`, `view.fit`), a strict subset of the §3 bridge commands — with `isCanvasOp`/`isCanvasScript` guards and an `opToBridgeCommand` mapper. Server-side schema validation in `server/plugins/dsh-movie-gateway/src/op-script-validator.ts` (schemastery) rejects unknown/malformed ops before streaming. The real-LLM intent→op-script generator in `canvas-agent.ts` (DSH Cordis agent loop; Bailian `qwen3.8-max` over `openai-completions`) emits constrained JSON ops only, never arbitrary JS (§5). Gateway dispatch: `POST /api/canvas/script` (role-gated; starts generation; returns `{txnId, accepted}`) + mux channel `canvas/script` (re-auths via `identity.whoami`, streams `{stage:'generating'}` → `{stage:'script', script}` → `end`), and `POST /api/canvas/result` records `{txnId, committed, opResults}` per room. The client executor `client/web/src/composables/useCanvasScript.ts` snapshots via `bridge.exportGraph()`, applies ops transactionally with postcondition checks + capped-exponential retry on transient bridge timeouts, rolls back to the snapshot on any hard failure, persists the committed graph to the Leg C workflow store, and reports `opResults`. Studio exposes an "AI 编排画布" input plus a green/red results strip.
  - Verified: `server/scripts/verify-canvas-script.ts` passes offline validator checks + live role-gating + a live Bailian generation (intent → validated 3-op script over mux). All 8 workspace projects typecheck green; web build green; `verify-gateway` / `verify-two-user-canvas` / `verify-comfy-bridge` stay green. Browser E2E on Studio: the happy path commits (rev bumps, ops green) and a deliberately-invalid op rolls back to the snapshot. Note: the bridge echoes LiteGraph node ids as JSON numbers *or* numeric strings depending on serialization — the executor postcondition accepts either form.
  - Deferred to P3-M4: the real Leg B media executor (GPU/provider-API inference per §6 — Bailian is chat-only, so Leg B execution stays canned), the six director/step pipeline subagent teams, and the server-side observe→re-plan supervision loop (§5). P3-M3 delivers only the intent→script→execute→report transport plus deterministic client-side verification.
- **P3-M4**: build the director/step pipeline teams (six movie steps on `ctx.subagent`/`ctx.team` — prerequisite carried from Phase 1 M4 / Phase 2 M7); agents emit canvas op-scripts from chat intent (intent → ops → execute → evaluate → fix-up), wired to the Leg B executor status paint; Leg B executor internals per §6 (validation, registry, topo-sort on `ctx.jobs`, provider-API mode over HTTPS to cloud/GPU-server endpoints).
- **P3-M5**: multi-user convergence + stale-revision rebase; undo/redo view-state; stress test 200-node graphs.
- **P3-M6**: hardening, Playwright E2E of chat→graph flows, design-doc update; Phase 4 kickoff (asset repository lineage painted onto canvas).

## 8. Risks

| Risk | Mitigation |
|---|---|
| ComfyUI frontend/LiteGraph API churn | pin frontend build; bridge extension isolates the surface; boot + WS conformance tests against the pinned version; fallbacks = real sidecar or Vue Flow |
| Custom frontend-node serialization fidelity | round-trip test in P3-M2; server store holds canonical JSON |
| Manual vs agent edit races | server-authoritative revision-gated commits; rebase on stale |
| Hallucinated/invalid ops | op catalog schema validation server-side before streaming; verifier postconditions client-side |
| iframe perf on large graphs | group collapse, lazy status paint, 200-node stress gate |
| GPL boundary | embed only; zero ComfyUI code vendored (unchanged from Phase 2) |
