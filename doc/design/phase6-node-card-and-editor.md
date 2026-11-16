# Phase 6 Plan: Node Card as Presence Token + Docked Node Editor (draft → publish governance)

- Status: ✅ IMPLEMENTED (2026-08-09) — client-only; M1–M5 built and verified (vue-tsc typecheck + vite build green; 28 new i18n keys × 21 locale catalogs, coverage 21/21).
- Depends on: `phase4-vueflow-canvas-vidsay-shell.md` (canvas shell, MovieNode chrome), `phase5-functional-node-palette.md` (functional registry, families/modalities, verdicts), P3-M5 room governance (host-exclusive writes, `workspace` commit/revert/undo, host transfer), P2-M6 (workflow store + artifact inspector)
- Scope: **client-only** (`client/web/src/` + `client/i18n/src/locales/`). No `WorkflowGraph` / `PromptGraph` wire-shape change, no server executor change, no new plugin. The chat media upload pipeline and the gateway ws canvas sync are reused AS-IS.
- Carry-over note: `phase5` §9 assigned "removing the six deprecated step class types" to Phase 6. That item is **re-scoped to Phase 7** (D10): this phase already changes node rendering and edit governance, and multiplying that with a persisted-graph class-type migration in one phase is unnecessary risk.

## 1. Goal

Split the node's two current jobs — *being present on the canvas* and *being read/edited* — into two surfaces:

1. **The node card** becomes a presence token: identity, execution status, ports/edges, and a small read-only content stub. It is never a reading or editing surface.
2. **The editor card** (the current right-side inspector, converted) is the single place to read and edit a node: content source, content display, and node properties. It opens only by double-click or the toolbar **Edit Node** button, and while open it freezes the rest of the canvas UI.

Motivation (design discussion, 2026-08-09):

- Today `MovieNode.vue` embeds live textareas/selects/checkboxes in a 220px card: accidental edits while dragging, `nodrag/nowheel` gesture conflicts, DOM weight per node, and a duplicate editing surface alongside the inspector.
- Editing needs an atomic commit boundary (one undo entry, one sync broadcast, one clean version snapshot) and a governance rule (who may publish). The agreed model is a **private draft buffer + explicit publish**, with **host-only publishing** and a social proposal ritual (chat → host transfer → commit → transfer back → consensus → rollback) instead of per-user server drafts and conflict resolution.

## 2. Current state (what exists today)

- `canvas/MovieNode.vue` — 220px card rendering inline editable widgets (`STRING` multiline textarea, `COMBO` select, `INT/FLOAT` number, `BOOLEAN` checkbox), input/output port name+type lists, the protocol class blurb, status row, reviewer verdict line, and hover-revealed handles. Widget edits call `updateNodeData` **locally**.
- `pages/studio/index.vue` — single-click in cursor mode sets `selectedNode` and opens the floating **inspector aside** (step, live status, output summary, media preview via `selectedOutput` / `outputMediaKind`); tool modes `cursor|connect|delete` plus one-shot arms `handArmed` / `groupArmed` and the add-node cascade; `nextTick`-deferred return-to-cursor; viewport-center drop (`viewportCenter()` / `nextDropPos()`).
- Studio **media viewer dialog** (`viewerVisible / viewerKind / viewerUrl / viewerText`) renders video / image / read-only `<pre>` text for execution outputs.
- P3-M5 governance: `workspace.undo/redo/commit(message)/revert(rev, message)/getCommit(rev)`; host transfer dialog over Matrix power levels; `bridge.setReadonly(!isHost)` role watch; host "read-only preview" lock.
- i18n: Chinese-string keys, 21 locale catalogs, and — as of the Phase-5 follow-up — a registered `"zh-CN"` catalog (`zhCn.json`, identity map plus English-keyed leaf entries), so English-keyed `translate()` calls resolve in Simplified Chinese too.
- First-frame video covers already use `<video src="…#t=0.5" preload="metadata">` in `pages/plaza/index.vue` and `components/groupChat.vue`.

## 3. Decisions D1–D13

### D1 — The card is a presence token with a read-only content stub
`MovieNode.vue` keeps exactly three content rows plus handles (visual spec in D11): (1) modality icon + localized node type in the family accent color, (2) the node's user-editable **name**, (3) the read-only content stub. Status is carried by the border color + a corner dot only; the reviewer PASS/FAIL verdict line stays (it is output data, not status). It drops: all widget inputs, the port name/type lists, the class blurb paragraph, the modality chip row, the family badge pill, the legacy `step/6` badge, and the status word. Card height becomes near-uniform, which also stabilizes the viewport-center drop/stacking math.

The card gains one **read-only content stub** (display, not reading/editing), by modality:

| modality | stub |
|---|---|
| image | thumbnail (`object-fit: cover`, ~40px strip) |
| video | first frame via `<video src="…#t=0.5" preload="metadata">` (plaza/groupChat technique; no server-side extraction) |
| audio | duration chip + waveform glyph |
| text | the node's user-written description if present, else the **first paragraph** of the content clamped to **two lines** (CSS line-clamp; remainder chopped) |

The same two-line rule applies to generator/reviewer text parameters (prompt / criteria) as their stub. The stub always renders **canonical** content (what runs execute); drafts are never shown on the card.

### D2 — The inspector is converted into the docked editor card
The floating right-side aside becomes the **editor**; there is no centered editor dialog. Consequences:

- **Single-click no longer opens any panel.** Selection still exists (highlight, tool targets, and the Edit Node button's selection path); the editor opens only via D3's entry points.
- Geometry: ~400px wide with internal scroll, in the inspector's existing slot over the canvas.
- Rows, top to bottom (visual spec in D11): icon + node type (read-only), name input (non-empty), description input (optional), content source controls (D5/D12), the content area (sourced content, editable for text-input nodes; produced output read-only for generators/reviewers/combiners — one area, mode by family; media opens in the viewer dialog), and a minimal status line (D13). The inspector's `selectedOutput` / `outputMediaKind` rendering ports into the content area and the viewer dialog. Generated outputs are never editable — re-run instead.
- Heavy media and long text leave the aside: "Open" pops the existing viewer dialog, which gains an **audio branch** and an **editable full-height text focus mode** for long content (script, shot plan). The aside itself keeps an inline textarea for short parameters (prompt, criteria).
- The inspector's live-status content survives only as the D13 minimal residue: a header chip when non-idle, plus an error-reason line.

### D3 — Entry points: double-click + toolbar Edit Node button; no card pencil, no context menu
- **Double-click** a node opens its editor — gated to cursor mode (in connect a double-click is two picks; in delete it is a delete), consistent with the existing gating discipline. Keyboard Enter on a focused node and double-tap are accepted equivalents.
- **Toolbar Edit Node button**, sibling of Add Node / Add Edge for grammar consistency: with exactly one node selected it opens that node's editor immediately; with none selected it arms a **one-shot pick** (`editArmed`, same pattern as `handArmed`/`groupArmed`: next node click opens its editor, Esc / empty-canvas click / other tool cancels); with multiple selected it is disabled. While armed or locked it shows the pressed accent.
- Rejected for UX inconsistency with the toolbar grammar: a hover/selected pencil button on the card, and a right-click context menu. (A general node context menu may return in a later phase.)

Entry matrix:

| state | Edit Node button | double-click node | single-click node |
|---|---|---|---|
| cursor, no selection | arms pick | opens editor (lock) | select only |
| cursor, 1 selected | opens editor immediately | opens editor (lock) | select |
| cursor, multi-selected | disabled | opens editor (lock) | adjust selection |
| connect / delete / group / hand / add cascade | disabled | ignored (mode consumes clicks) | mode action |
| `editArmed` | pressed; click cancels | opens editor | **opens editor (the pick)** |
| locked (editor open) | unreachable (scrim) | unreachable | unreachable |

### D4 — The edit lock is orthogonal state, not a 7th tool mode; freeze by unreachability
Two refs, both orthogonal to `toolMode`:

- `editArmed: boolean` — the one-shot pick arm (D3).
- `editingNodeId: number | null` — the **lock**; non-null ⇔ editor open ⇔ canvas frozen. Closing the editor clears it.

Why not `"edit"` in `CanvasToolMode`: a true mode must save/restore the prior mode (a mid-connect-pick would be lost), grows a 7th column in the gating matrix every handler must learn, and can be armed with nothing on screen ("stuck mode"). The lock leaves `toolMode` untouched, so closing the editor returns to the exact prior state for free; every existing handler gains one shared early return `if (editingNodeId.value !== null) return;` (~6 guard sites: keyboard shortcuts, tool setters, bridge node/edge handlers) instead of per-mode clauses.

Freeze implementation — **disable by unreachability, not by per-feature logic**: a full-viewport scrim covers canvas + toolbars + chat (with `@contextmenu.prevent` so no browser menu over the editor; wheel absorbed), and the editor aside renders **above** the scrim (dimmed canvas, bright editor = obvious "you are editing" cue). The scrim physically absorbs left/right/middle click and wheel; the `editingNodeId` guard covers only what a scrim cannot (keyboard, programmatic/remote paths) plus toolbar `:disabled` bindings for visual feedback. Alive while locked: the editor's own controls, its close button, Esc. During `editArmed` (pick) the canvas is not frozen — only the pick is live.

This closes the motivating hazard: with the editor open, Delete / Run / undo / Add Node are unreachable, so "delete the node I am editing" is impossible locally.

### D5 — One content reference shape for all provenances
`contentRef = { origin: 'upload' | 'market' | 'chat' | 'inline', uri?, mime?, name?, text?, msgId? }`. Upload, market and chat all yield `uri + meta` (chat additionally records the source `msgId`); inline (text-input nodes only) yields `text`. The editor UI differs per origin but the stored shape is one, so the future asset/plugin market changes nothing except a new picker dialog returning the same shape.

- **Upload**: file input + drag-drop zone reusing the chat media upload pipeline/storage (one shared blob store for chat and canvas assets), with progress, per-modality mime whitelist, and a size cap.
- **Chat** (D12): clipboard paste into the content area plus a "Pick from chat" dialog listing recent room media/text messages; both reference the existing media URL, no new storage.
- **Market**: a disabled "Browse market" button with a coming-soon tooltip; the contract is fixed now, the implementation is out of scope.
- **Inline**: the text editor of D2's content area.

### D6 — Private draft buffer + atomic publish; live-apply rejected
The editor edits a **local draft**; **Save/Publish** commits it as exactly one canonical mutation = one undo entry = one sync broadcast = one clean version-snapshot candidate. A dirty indicator lives in the editor header only (the card never shows drafts); closing with a dirty draft raises a discard-confirm (nested `el-dialog`, transfer-dialog pattern).

Live write-through is rejected: per-keystroke canonical writes pollute undo, spam the room sync, expose invalid intermediates (`duration: ""`) to teammates and runs, and would land half-typed content inside version snapshots. Draft loss on reload is accepted for Phase 6 (dirty-confirm covers close; a localStorage buffer is a later nicety).

### D7 — Governance: host-only publishing + a social proposal ritual; single writer by construction
Editing (publishing) is **host-only**, consistent with host-exclusive topology. Non-host members opening a node get the editor **read-only** with a banner: "Read-only — only the host can edit; propose changes in chat."

The proposal ritual is human protocol over existing mechanisms, not new software:

1. a member describes the proposal in the room chat;
2. the host transfers the crown (existing transfer dialog / Matrix power levels); the temp host edits their draft and publishes, then transfers back;
3. teammates review the synced canonical (read-only editor) and reach consensus in chat;
4. on rejection the host rolls back: `workspace.revert(rev, message)` — **verified present** (`onRevert`, studio).

Rules adopted with it: the workspace is **quiescent while a proposal is under review** (snapshots are workspace-level, so an unrelated commit inside the review window would be lost to a full rollback), and **no run starts during the review window** (a run in that window uses the proposed content; rollback does not un-run it). Because there is exactly one publisher at any time, last-publish-wins conflicts cannot occur and no conflict-resolution infrastructure is needed. The chat description + snapshot + transfer events form a de-facto audit trail.

### D8 — Editor lifecycle edge cases
- **Remote deletion of the node being edited**: the lock cannot stop remote ops, so the editor watches node existence and auto-closes with a toast.
- **Run in flight**: live status chip in the header; Save disabled while the node is queued/running (edits apply to the next run).
- **One editor instance**: opening another node requires closing the current one (Save / Cancel / discard first).
- Esc and the close button release the lock; the prior tool state is untouched (D4).

### D9 — i18n: Chinese keys × 21 catalogs
New keys (Chinese-as-key, per repo convention; the registered `zh-CN` catalog carries identity + English-leaf entries): 编辑节点, pick-arm hint tooltip, read-only banner text, discard-confirm title/body, row labels (节点名称 / 节点描述 / 内容来源 / 从聊天粘贴 / 选择聊天消息 / 上传本地文件 / 浏览市场（即将推出）), 名称不能为空, 打开, 展开编辑, 保存, 取消, 未保存更改, plus stub- and status-related strings. All 21 locale files updated; coverage verified 21/21 per key (en falls back where the key is English).

### D10 — Deprecated step class types move to Phase 7
`phase5` §9 slated their removal for "Phase 6". Re-scoped: this phase changes node rendering and edit governance; adding a persisted-graph class-type migration to the same phase multiplies rollback risk (R5) for no gain. Step types stay deprecated-but-executable through Phase 6.

### D11 — Visual spec: three-row card, six-row editor; no decoration without meaning
Design philosophy (review, 2026-08-09): keep it simple — abandon every decoration with no semantic or functional meaning.

**Node card**, top to bottom:

```
┌───────────────────────────────┐
│ ▨ Text Input                  │ 1 icon (family accent hue) + localized type
│ My hero script                │ 2 node name (shown here, edited in editor)
│ ┌───────────────────────────┐ │
│ │ thumb / first frame /     │ │ 3 stub: image thumb, video first frame,
│ │ two clamped desc lines    │ │   audio duration chip, text 2-line clamp
│ └───────────────────────────┘ │
● corner status dot   ○ ─── ○   │ handles; border color = running status
└───────────────────────────────┘
```

1. Colorful icon + node type (e.g. "Text Input"), current color theme (family accent hue).
2. Node name — displayed on the card, edited only in the editor card.
3. The D1 stub table.

Nothing else: no modality chip (icon + type name already say it), no family pill (accent hue + type name already say it), no step badge, no status word, no port lists, no blurb.

**Editor card**, top to bottom:

1. Colorful icon + node type — read-only.
2. Name textbox — **cannot be empty**: trim-non-empty validated on Save (empty blocks Save with an inline hint); a new node defaults to the localized type name.
3. Description textbox — may be empty.
4. Content source row (D5/D12): upload from local disk; download from the asset market (disabled, implemented later); copy & paste from the chat; manual typing for text-input nodes.
5. Content area: image thumbnail / video first frame; two clamped lines of the description, or the first paragraph of externally sourced text; for text-input nodes this area IS the manual text editor; for generators/reviewers/combiners it shows the produced output read-only. "Open" pops the viewer dialog (audio branch + text focus mode).
6. Status line — the minimal residue of D13.

Persistence: node data gains an optional `description`; the name reuses the existing `title`. Both are additive fields inside the persisted node record — no wire-shape surgery.

### D12 — Chat as a content provenance (`origin: 'chat'`)
Two mechanisms, one origin: (a) **clipboard paste** into the content area (an image or text copied from a chat message); pasted media blobs go through the same upload pipeline as D5 uploads; (b) a **"Pick from chat" dialog** listing the room's recent `m.image` / `m.video` / `m.text` messages (reusing the message list the chat page already aggregates) that inserts a reference to the existing media URL plus `msgId`. No new blob storage and no new server endpoint: the result is `contentRef{origin:'chat', uri, msgId}`.

### D13 — Running status: what it is for, and how little of it we keep
Raised twice in review: *what is the use of the colorful running status?* It is the only per-node execution feedback on the canvas: without it a failed node is indistinguishable from an idle one, a running graph shows no progress, and the editor's Save-disable rule (D8) has no visible cause. The semantics are functional; the current presentation is triple-redundant (dot + capitalized word + border color). Minimal residue:

- **Card**: border/ring color + one corner dot. No status word.
- **Editor**: a header chip shown **only when non-idle** (queued/running/success/error), plus an error-reason line when `error`. Idle shows nothing.
- **No enumeration/list of statuses anywhere** — the inspector's status block is not ported.
- The reviewer verdict line stays on card and editor: a verdict is output data, not status.

## 4. Client changes (`client/web/src/`)

- `canvas/MovieNode.vue`: rewrite to the D11 three-row card (icon+type / name / stub); drop the widget/port-list/blurb DOM and the `setWidget`/`onText`/`onNumber`/`onSelect`/`onBool` writers, the modality chip, the family pill and the step badge; status reduces to border color + corner dot (D13); stub renderers per modality incl. the `#t=0.5` first-frame video and the two-line clamp; keep handles and the verdict line.
- `canvas/NodeStub.vue` (new, optional split): the read-only stub renderers (thumb / first-frame / duration chip / clamped text), fed from canonical node data.
- `pages/studio/index.vue`: remove the single-click inspector open; add `editArmed` + `editingNodeId`; Edit Node toolbar button (D3 state table); `@node-double-click` wiring gated to cursor mode; the scrim layer + `editingNodeId` guards; convert the inspector aside into the D11 six-row editor (~400px, scroll); name/description inputs with the non-empty name rule; the "Pick from chat" dialog (D12); port `selectedOutput`/`outputMediaKind` into the editor's content area; draft buffer + Save/Publish through the governed command path (replacing local `updateNodeData` widget writes); discard-confirm dialog; remote-delete watcher.
- Viewer dialog: add the audio branch and the editable text focus mode (D2).
- `canvas/VueFlowCanvas.vue`: expose the double-click event and the focus/Enter path; no new tool mode.
- Upload: reuse the chat media upload composable/pipeline; no new server endpoint.
- `client/i18n/src/locales/*.json`: D9 keys × 21.

## 5. Milestones

- **P6-M1 — Card token + stubs.** MovieNode rewrite + stub renderers. Acceptance: `pnpm -C client/web run typecheck` green; a populated canvas shows thumb / first-frame / duration / two-line text stubs from canonical content; the card renders exactly the D11 three rows (no modality chip, family pill, step badge, or status word); no input/select/textarea DOM inside any node card; pan/zoom remains smooth on a 20-node graph.
- **P6-M2 — Editor conversion + entry points + lock.** Inspector→editor, double-click + Edit Node button + `editArmed`, scrim freeze, guards, Esc/close release. Acceptance: the D3 entry matrix holds row by row; while the editor is open the toolbar, canvas, chat and wheel are inert and right-click shows no browser menu; closing restores the prior tool state (a mid-connect arm survives); Delete/Run/undo are unreachable while open.
- **P6-M3 — Source & content pipeline.** `contentRef`, upload via the chat pipeline, chat paste + Pick-from-chat dialog (D12), market placeholder, inline text editor, Open-in-viewer (image/video/audio) + text focus mode. Acceptance: uploading an image/video/audio file and publishing updates the card stub accordingly; editing a text node's content and publishing updates the two-line stub; pasting a copied chat image or picking a room message references it and paints the stub; the market button is disabled with the coming-soon tooltip; Save blocks with the inline hint when the name is empty.
- **P6-M4 — Governance + atomic publish.** Host-only editing with read-only banner; draft + Save = one canonical mutation. Acceptance: a guest double-clicks into a read-only editor; a host Save produces exactly one undo step and one sync broadcast (guest canvas updates once); dirty-close raises the discard confirm; deleting the edited node from another session auto-closes the editor with a toast; the full proposal ritual (transfer → publish → transfer back → `revert`) round-trips a room to its prior revision.
- **P6-M5 — i18n + docs.** D9 keys in all 21 catalogs; `doc/architecture.md` canvas/edit-governance section updated; this plan's status flipped. Acceptance: per-key coverage 21/21 (en fallback where keyed English); `pnpm -C client/i18n run typecheck` and web typecheck green; Simplified Chinese and Filipino spot-check of the editor and stubs.

## 6. Verification strategy

- Static: `pnpm -C client/i18n run typecheck`, `pnpm -C client/web run typecheck`, web production build.
- Live-gateway regression: existing `verify-*` scripts stay green (no server change expected; they guard against accidental protocol drift).
- Browser: manual pass per milestone against the local dev server (entry matrix, freeze, stubs, upload, ritual), since the user verifies UI behavior personally; no new pure verifiers required.
- i18n: JSON parse + per-key coverage script across the 21 catalogs (the EOF-append workflow used in Phase 5).

## 7. Out of scope

- Per-user server-side drafts, draft-sync channels, and the draft-viewing UI ("teammates view an author's unpublished draft") — the read-only editor over canonical content covers viewing in Phase 6; shared drafts are a later phase if the ritual proves too heavy.
- Publish-authority matrices, scoped commit leases, chat-attached proposal previews, per-node revert (workspace-level rollback only).
- The asset/plugin market implementation (contract only, D5).
- Removal of the six deprecated step class types — Phase 7 (D10).
- Conditional/switch nodes, loops, auto-retry (Phase 5 carry-over).
- Node context menu and card pencil affordance (D3 rejects them).
- localStorage draft persistence (accepted loss, D6).

## 8. Risks

- **R1 — Dialog/scrim z-order stacking.** The viewer dialog must open above both the scrim and the editor aside; element-plus `append-to-body` ordering needs an explicit z-index contract. Mitigated by a single stacking-context audit in M2/M3.
- **R2 — First-frame stub cost at scale.** Many `<video preload="metadata">` elements decode headers concurrently. Mitigated by rendering stubs only for nodes in the viewport (or above a zoom threshold) and capping concurrent decodes; fallback to a modality glyph while loading.
- **R3 — Freeze over-reach.** The scrim may block legitimately-needed popovers (tooltips, the add cascade) or element-plus teleports. Mitigated by the M2 acceptance pass enumerating every overlay that must remain reachable while locked (only the editor's own).
- **R4 — Transfer-window exposure.** The ritual increases host-transfer frequency; the crown carries topology/run privileges and may not come back (disconnect, malice). Accepted as a social risk for trusted team rooms; commit leases are the documented escape hatch (out of scope).
- **R5 — Workspace-level rollback granularity.** A rollback inside a non-quiescent review window eats unrelated commits. Mitigated by the quiescence rule (D7) and by history UI showing revisions; per-node revert deferred.
- **R6 — Draft loss.** Drafts are ephemeral (reload loses them). Mitigated by the dirty-confirm on close; documented as accepted Phase-6 behavior.
- **R7 — i18n churn.** ~15–20 new keys × 21 catalogs per change round; mitigated by the established EOF-append batch workflow and coverage checks.
- **R8 — Chat-referenced content staleness.** A `chat`-origin `contentRef` points at a room message URL; redaction or media expiry breaks the stub/output. Mitigated by a render fallback to the modality glyph and a "source message unavailable" note in the editor content area.
