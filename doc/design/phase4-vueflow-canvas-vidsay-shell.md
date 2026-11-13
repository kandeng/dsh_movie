# Phase 4 Plan (as-built): Vue Flow Canvas + vidsay Shell Port (Path B)

- Status: ✅ DONE (2026-08-09)
- Depends on: `phase3-comfyui-canvas-agent-scripting.md` (§9 Phase 4 Addendum), `phase2-client-and-protocol.md`, `phase1-dsh-matrix-feasibility.md`
- Scope: **client-only**. The dsh_movie backend, protocol, and the three legs are kept AS-IS. No server/protocol change was made or required.

## 1. Goal (restated)

Adopt the vidsay look-and-feel into `dsh_movie/client/web` — the `appShell` left-rail + top bar, the language picker, the theme system, and a **Vue Flow canvas replacing the ComfyUI iframe** — while:

1. keeping the in-browser pi-agent loop out (Path B never vendored the scaffolds),
2. routing ALL client↔server traffic through the existing **3 legs** (Leg A Matrix/Synapse chat, Leg B ComfyUI-protocol execution + status, Leg C DSH gateway RPC + WS mux with the server-authoritative `WorkflowGraph`),
3. stubbing the SaaS/pi surfaces the backend does not serve.

## 2. The key architectural seam (why this was bounded)

`client/web/src/composables/useCanvasBridge.ts` defines the `CanvasBridge` **interface** (`loadWorkflow`, `exportGraph`, `setNodeStatus`, `setReadonly`, `viewFit`, `request`, `sendCommand`, `whenReady`, `onReady`, `onNodeSelected`, `onGraphChanged`, `onExecPainted`, `onBridgeError`, `onCommandResult`).

Phase 4 added `client/web/src/composables/useVueFlowBridge.ts`, which implements the **same interface** over a Vue Flow store + the graph mapper. Because the seam is an interface, every downstream consumer works **UNCHANGED**:

- `useCanvasScript.ts` — op-script executor (postcondition shapes preserved 1:1)
- `useExecStatus.ts` — Leg B execution status
- `useWorkspaceGraph.ts` + `useWorkflowStore.ts` — Leg C persistence + `workflow/watch`
- `useRoomRole.ts` — P3-M5 host/member governance
- `useMovieRun.ts` — movie pipeline run

No backend, protocol, op-catalog, postcondition, or gateway change. The §3 command/event contract from Phase 3 is preserved verbatim (`graph.load/export`, `node.add/remove/move/setWidget/setStatus`, `edge.add/remove`, `group.collapse`, `view.fit`, `setReadonly`; events `ready`/`graphChanged`/`nodeSelected`/`execPainted`/`bridgeError`/`commandResult`).

## 3. Decisions D1–D5 (as realized)

### D1 — Graph model: ComfyUI `WorkflowGraph` stays server-authoritative ✅
The ComfyUI `WorkflowGraph` (`protocol/src/leg-b.ts`) remains the persisted + executed shape (Leg B/C, P3-M5 governance, and all verifiers untouched). The Vue Flow graph `{nodes, edges, viewport}` is **only the client view model**. A bidirectional mapper lives in `client/web/src/canvas/graphMapper.ts`:

- `workflowToVueFlow(graph)` / `vueFlowToWorkflow(nodes, edges, viewport, base?)`.
- Node id: ComfyUI numeric ⇄ Vue Flow `String(id)` (`nextNodeId` allocates fresh numeric ids for adds).
- Handles: `in-<slot>` (target) / `out-<slot>` (source) ⇄ ComfyUI input/output slot indices (`inHandle(i)` / `outHandle(i)`).
- Edges: Vue Flow edge id `link-<linkId>`; `edge.data.linkId` carries the ComfyUI link id; ComfyUI `links` tuples reconstructed on export.
- Widgets: schema widgets zipped with `widgets_values`/defaults (`schemaFor`, `buildNodeData`).
- Viewport: persisted in `graph.extra.ds {scale, offset}`.

The "persist Vue Flow natively" alternative was rejected (forces a protocol + governance re-do).

### D2 — Node palette: one generic static node, not runtime UMD plugins ✅
vidsay loads node types as runtime UMD plugins (`window.toonflowNodes`) from `packages/nodes/*`. dsh_movie instead ships **one generic `client/web/src/canvas/MovieNode.vue`**, registered for all six `MOVIE_NODES` classTypes via Vue Flow `nodeTypes` in `client/web/src/canvas/VueFlowCanvas.vue`. It is fully data-driven off each node's schema:

- Widget editors: STRING (multiline → textarea), COMBO (→ select), INT/FLOAT (→ number), BOOLEAN (→ checkbox), else text.
- Per-slot input (left, `Handle type="target"`) and output (right, `Handle type="source"`) ports, each inside a `position: relative` row so Vue Flow measures correct handle attach points.
- Status badge (idle/running/progress/success/error) driving the node border color.

Executing non-movie vidsay node types via Leg B is out of scope (render-only until a later milestone).

### D3 — pi-core removal: moot by construction ✅
Path B never vendored `@toonflow/nodeScaffold`/`toolScaffold`, so there is no in-browser pi-core (`runAgentLoop`, `createAssistantMessageEventStream`, `toonflowNodeHost.ai`, `pi-coding-agent`) present to remove. Node "generate" semantics are served by the server-side DSH agent over Leg C `canvas/*` + `movie/*` and Leg A chat, exactly as in Phase 3. No `@earendil-works/*` dependency exists.

### D4 — @toonflow packages: not vendored; canvas rebuilt natively ✅
Rather than vendoring the 13 `@toonflow/*` packages, the canvas view was rebuilt directly on `@vue-flow/core` (+ `background`, `minimap`) with dsh_movie-native components (`MovieNode.vue`, `VueFlowCanvas.vue`, `graphMapper.ts`, `useVueFlowBridge.ts`). `i18n` was already vendored as `@dsh-movie/i18n`. This keeps the dependency surface minimal and avoids the Bun→pnpm `workspace:*` reconciliation risk (R3).

### D5 — Chat: dsh_movie Leg A data layer + vidsay UI skin ✅ (from Phase 3)
`client/web/src/components/groupChat.vue` (46.6KB) is the vidsay UI skin wired to dsh_movie's `useMatrixChat.ts` (Leg A, 33KB) + `@dsh-movie/i18n` + `@/stores/auth`. Confirmed free of `@toonflow`/mcpControl/pi-core imports. The `/chat` one-shot page and the `/studio` docked chatbox both consume it; the in-place `modeSwitcher.vue` carries the active room across the mode switch.

## 4. Vue Flow store sharing (the wiring detail)

`useVueFlow(id)` called in the Studio `setup()` (via `useVueFlowBridge`):

1. creates the store,
2. registers it in Vue Flow's global `Storage` keyed by `id` (`movie-canvas`),
3. `provide(VueFlow, store)`.

So the descendant `<VueFlowCanvas>`'s `<VueFlow>` component `inject`s the **same** store — the bridge and the canvas view stay in sync with no id-prop wiring on the component.

## 5. Leg B badge paint rewiring

The ComfyUI iframe's internal WS socket is gone. Studio now drives node badges from the parent-side Leg B socket: a watcher maps `execStatus.statusById` → `bridge.setNodeStatus(id, status)`.

Status paint is **view-only** (never serialized into `WorkflowGraph`), so `useVueFlowBridge.paintStatus` sets a `STATUS_SUPPRESS_MS` (80ms) tail that makes the debounced deep-watch on `[getNodes, getEdges]` skip the resulting tick — avoiding spurious `graphChanged` emissions (autosave / revision bumps) on every badge repaint. Graph loads use a longer `LOAD_SUPPRESS_MS` (400ms) tail for the same reason; edits debounce at `CHANGE_DEBOUNCE_MS` (200ms).

## 6. App shell (vidsay look-and-feel)

Ported into `client/web/src`:

- `components/appShell.vue` — left icon rail (广场 `/plaza`, 一键生成 `/chat`, 分步生成 `/studio`; divider; 账户 `/account`, 设置 `/settings`) with CSS-mask icons colored by `currentColor`, a ResizeObserver-measured centered brand (`--brand-x`), an account dropdown, and the language picker. Uses `<slot/>` for page content; `100dvh` root.
- `components/languageSelect.vue` — popover/panel language grid with flags + a "跟随系统" card; `changeLanguage` → `updateUiSettings({language})`.

dsh_movie adaptations vs vidsay:

- Text brand **"DSH Movie"** (no vidsay logo asset).
- Routes `/plaza` `/chat` `/studio` `/account` `/settings` (dsh_movie has no `/home`/`/hello`).
- Account button → `go("/account")` when signed out (dsh_movie has **no `loginDialog`**; Mode-B login is inline on the account page).
- Avatar via `auth.avatarHttpUrl` (the resolved blob URL), **not** `auth.avatarUrl` (which is `mxc://`).
- i18n imports retargeted `@toonflow/i18n` → `@dsh-movie/i18n`.

`App.vue`:

- Renders the shell for routes tagged `meta.shell` (all five page routes); non-shell routes render bare.
- Keeps the Phase-3 theme `watchEffect` (theme/primaryColor/fontScale/radius → document root) and the M7 session revalidation (60s timer + visibilitychange/focus → `auth.revalidate()`).
- Adds vidsay's browser-zoom-prevention listeners (Ctrl+wheel and Ctrl `+`/`=`/`-`/`0` `preventDefault`, still forwarding the events so Vue Flow can zoom the canvas).
- Adds the `.vue-flow` theme vars (mapped to Element Plus tokens) + LTR isolation for canvas/number inputs.

`router/index.ts`: added `meta.shell: true` to `/chat`, `/account`, `/plaza`, `/settings`, `/studio`; the `requiresAuth` guard is unchanged.

`registerLanguage()` (`lib/i18n.ts`) already binds `uiSettings.language` → `setLocale`, so the language picker works with no extra wiring. `stores/settings.ts` is a self-contained localStorage-backed store exposing the same surface the shell needs (`uiSettings`, `updateUiSettings`, `defaultUiSettings`, `settingsStorage`, `loadSettings`).

## 7. Stub inventory (gap features)

Path B ported only **Shell + Canvas** (Option B), so most vidsay SaaS/pi surfaces (`lib/tf.ts` `api.toonflow.net`, `providerBilling`, `mcpControl`, `agentControl`, `singleAgentDialog`, `agent/*`, `localModels`, `anonymousData`) were **never ported** — there is nothing to call and no route to render.

The only SaaS surfaces that exist in dsh_movie are on the account page:

- **钱包 (Wallet)** section — "钱包功能即将上线，敬请期待。" text stub, no backend call.
- **账单 (Billing)** section — "账单功能即将上线，敬请期待。" text stub, no backend call.

Both are already the desired "UI visible, disabled/coming-soon, no backend calls" state. Grep confirms no surviving `/api/*` (toonflow server) or `api.toonflow.net` call in `client/web/src`.

## 8. New + changed files

New:
- `client/web/src/canvas/graphMapper.ts` (Vue Flow ⇄ WorkflowGraph)
- `client/web/src/canvas/MovieNode.vue` (generic movie-step node)
- `client/web/src/canvas/VueFlowCanvas.vue` (`<VueFlow>` wrapper + nodeTypes)
- `client/web/src/composables/useVueFlowBridge.ts` (the `CanvasBridge` implementation)
- `client/web/src/components/appShell.vue`
- `client/web/src/components/languageSelect.vue`
- `client/web/src/icons/photo.svg`, `client/web/src/icons/settings.svg`, `client/web/src/assets/languageFlags.svg` (copied read-only from vidsay)

Changed:
- `client/web/src/pages/studio/index.vue` — iframe bridge → Vue Flow bridge + `<VueFlowCanvas>`; `execStatus.statusById` → `setNodeStatus` watcher; "添加节点" palette (`el-dropdown` over `MOVIE_NODES`).
- `client/web/src/App.vue` — shell host, zoom-prevention, `.vue-flow` theme vars.
- `client/web/src/router/index.ts` — `meta.shell` on all page routes.
- `client/web/package.json` — `@vue-flow/core` ^1.48.2, `@vue-flow/background` ^1.3.2, `@vue-flow/minimap` ^1.5.4 (`@tabler/icons-vue` already present).
- `doc/design/phase3-comfyui-canvas-agent-scripting.md` — §9 Phase 4 Addendum.

## 9. Verification

- `pnpm -r --if-present typecheck` → **EXIT=0** across all 8 workspace projects (protocol, client/i18n, client/sdk, server, client/web via vue-tsc).
- `client/web` production build (`pnpm build`) → **green** (~2.3s; `languageFlags.svg` bundled).
- Server-side verifiers (`verify-gateway`, `verify-comfy-bridge`, `verify-canvas-convergence`, `verify-canvas-script`, `verify-movie-executor`, `verify-movie-pipeline`, `verify-workspace-history`, `verify-canvas-scale`) exercise the **unchanged** Leg B/C backend; they require a live Synapse + gateway and are unaffected by these client-only changes.
- Browser E2E (two-user canvas convergence, undo/redo, host transfer, agent op-script, movie pipeline) requires a running stack; the flows are preserved by the interface seam (consumers unchanged) and are to be re-run against a live deployment.

## 10. Out of scope (unchanged from the plan)

- Executing non-movie vidsay node types via Leg B (render-only until a later milestone).
- Real explore/payment/plugin-market/singleAgent/MCP/provider-billing backends (stubbed / not ported).
- Any dsh_movie backend/protocol change (D1 keeps it AS-IS).
