/**
 * Deterministic canvas op-script executor/verifier (Phase-3 P3-M3, design doc §5).
 *
 * The browser half of the `canvas.*` channel. A natural-language intent is
 * submitted to the host (Leg C `canvas/script` POST), which runs the real-LLM
 * generator and streams back a validated {@link CanvasScript} on the
 * `canvas/script` mux channel correlated by a `txnId`. This composable then
 * applies the script to the live canvas DETERMINISTICALLY and transactionally:
 *
 *  1. snapshot the graph (`bridge.exportGraph`);
 *  2. apply each op through the txn-correlated bridge (`bridge.request`), which
 *     awaits the iframe's `commandResult`;
 *  3. verify a per-op postcondition from `commandResult.data`;
 *  4. retry transient failures (timeouts) with capped backoff;
 *  5. on a hard failure, roll back to the snapshot and mark the rest skipped;
 *  6. on success, persist once (atomic) via `workflowStore.save`;
 *  7. report per-op outcomes back to the host (Leg C `canvas/result`).
 *
 * Autosave is suppressed for the duration of an apply (via `onApplyStart` /
 * `onApplyEnd`) so the executor's single explicit save stays authoritative and
 * no mid-script `graphChanged` echo races the revision.
 */

import { onScopeDispose, ref, type Ref } from "vue";
import { LegCError, MuxSocket, RpcClient, backoff, type MuxStream } from "@dsh-movie/sdk";
import {
  isCanvasScript,
  type BridgeCommandPayloads,
  type BridgeCommandType,
  type CanvasOp,
  type CanvasScript,
  type CanvasScriptResult,
  type OpResult,
  type WorkflowGraph,
} from "@dsh-movie/protocol";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";
import type { CanvasBridge } from "@/composables/useCanvasBridge";
import type { WorkflowStoreHandle } from "@/composables/useWorkflowStore";

/** The coarse progress phase of one intent run, surfaced to the Studio UI. */
export type CanvasScriptStage =
  | "idle"
  | "submitting"
  | "generating"
  | "applying"
  | "saving"
  | "reporting"
  | "done"
  | "error";

/** Options for {@link useCanvasScript}. */
export interface UseCanvasScriptOptions {
  /** The canvas bridge driving the live iframe. */
  bridge: CanvasBridge;
  /** The Leg C workflow store used for the single atomic save. */
  workflowStore: WorkflowStoreHandle;
  /** Override the access-token getter (defaults to the auth store). */
  getToken?: () => string | null;
  /** Called before ops are applied (Studio sets its `suppressSave` guard). */
  onApplyStart?: () => void;
  /** Called after the apply/rollback/save settles (Studio clears the guard). */
  onApplyEnd?: () => void;
}

/** The handle returned by {@link useCanvasScript}. */
export interface CanvasScriptHandle {
  /** True while an intent run is in flight. */
  busy: Ref<boolean>;
  /** The current {@link CanvasScriptStage}. */
  stage: Ref<CanvasScriptStage>;
  /** The transaction id of the most recent run, or `null`. */
  lastTxn: Ref<string | null>;
  /** Per-op outcomes of the most recent run. */
  opResults: Ref<OpResult[]>;
  /** The last surfaced error message, or `null`. */
  error: Ref<string | null>;
  /**
   * Submit an intent, apply the generated script, and report the outcome.
   * @param roomId - the room whose canvas is edited.
   * @param intent - the natural-language canvas instruction.
   * @returns the transaction result, or `null` when the run failed/was rejected.
   */
  runIntent(roomId: string, intent: string): Promise<CanvasScriptResult | null>;
}

/** Per-op bridge round-trip timeout (the iframe queues until ready). */
const REQUEST_TIMEOUT_MS = 8_000;
/** Transient retries before an op is treated as a hard failure. */
const MAX_RETRIES = 2;
/** Whole-generation guard so a hung LLM turn cannot wedge the UI forever. */
const GENERATE_TIMEOUT_MS = 120_000;
/**
 * Client-side bound on observe->re-plan follow-ups (Phase-3 P3-M4, §5). Mirrors
 * the gateway's own `MAX_REPLANS` cap so the browser never loops past the host;
 * the server also stops returning `replanTxnId` once its cap is reached.
 */
const MAX_REPLANS = 2;

/** Turn an unknown throw into a short human-readable message. */
function describeError(error: unknown): string {
  if (error instanceof LegCError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Sleep for a number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A timeout/not-ready rejection is worth retrying; a command error is not. */
function isTransient(message: string): boolean {
  return message.includes("timed out");
}

/**
 * Verify a per-op postcondition from the iframe's `commandResult.data`.
 * Shapes come from `comfy-bridge/bridge-extension.js` (e.g. `node.add` returns
 * `{ id }`, `edge.add` returns `{ link }`). A false result is a hard failure.
 * @param op - the applied op.
 * @param data - the `commandResult.data` payload (may be null).
 * @returns true when the data satisfies the op's expected effect.
 */
function postconditionOk(op: CanvasOp, data: unknown): boolean {
  const payload = data ?? {};
  const d = (typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  switch (op.op) {
    case "node.add":
    case "node.remove":
    case "node.move":
    case "node.setWidget":
    case "edge.remove":
      // The bridge echoes LiteGraph node ids as JSON numbers OR numeric strings
      // (e.g. 7 or "7") depending on serialization; accept either form.
      return d.id !== null && d.id !== undefined && Number.isFinite(Number(d.id));
    case "node.setStatus":
      return d.status === (op.payload as { status: unknown }).status;
    case "edge.add":
      return d.link !== null && d.link !== undefined;
    case "group.collapse":
      return d.title === (op.payload as { title: unknown }).title;
    case "view.fit":
      return true;
    default:
      return true;
  }
}

/** Narrow an unknown mux data frame to the `{stage:'script', script}` payload. */
function isScriptFrame(value: unknown): value is { stage: "script"; script: CanvasScript } {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { stage?: unknown; script?: unknown };
  return frame.stage === "script" && isCanvasScript(frame.script);
}

/**
 * Create a canvas op-script executor bound to a bridge + workflow store.
 * @param options - the bridge, store, and optional token/autosave hooks.
 * @returns the {@link CanvasScriptHandle}; the mux socket closes on scope dispose.
 */
export function useCanvasScript(options: UseCanvasScriptOptions): CanvasScriptHandle {
  const { bridge, workflowStore } = options;
  const auth = useAuthStore();
  const getToken = options.getToken ?? ((): string | null => auth.session?.accessToken ?? null);

  const rpc = new RpcClient(sdkConfig, { getToken });
  const mux = new MuxSocket(sdkConfig, { reconnect: true });

  const busy = ref(false);
  const stage = ref<CanvasScriptStage>("idle");
  const lastTxn = ref<string | null>(null);
  const opResults = ref<OpResult[]>([]);
  const error = ref<string | null>(null);

  /** The in-flight stream's rejector, so dispose can unblock a pending run. */
  let pendingReject: ((reason: Error) => void) | null = null;

  /** Apply one op through the bridge, verifying its postcondition, with retry. */
  async function applyOp(index: number, op: CanvasOp): Promise<OpResult> {
    let lastMessage = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(backoff(attempt - 1, { baseMs: 150, maxMs: 1_000 }));
      try {
        // The op discriminator IS a bridge command type and the payload is its
        // correlated payload; the cast is sound by the CanvasOp construction.
        const data = await bridge.request(
          op.op as BridgeCommandType,
          op.payload as BridgeCommandPayloads[BridgeCommandType],
          REQUEST_TIMEOUT_MS,
        );
        if (postconditionOk(op, data)) return { index, op, ok: true };
        // A postcondition miss is a hard failure (the iframe applied something
        // unexpected): do not retry, let the caller roll back.
        return { index, op, ok: false, error: `postcondition failed for ${op.op}` };
      } catch (caught) {
        lastMessage = caught instanceof Error ? caught.message : String(caught);
        if (isTransient(lastMessage) && attempt < MAX_RETRIES) continue;
        return { index, op, ok: false, error: lastMessage };
      }
    }
    return { index, op, ok: false, error: lastMessage || "op failed" };
  }

  /** Snapshot, apply, verify, roll back or persist; returns the txn result. */
  async function executeScript(roomId: string, script: CanvasScript): Promise<CanvasScriptResult> {
    options.onApplyStart?.();
    const results: OpResult[] = [];
    let committed = true;
    try {
      stage.value = "applying";
      const snapshot: WorkflowGraph | null = await bridge.exportGraph();
      for (let index = 0; index < script.ops.length; index++) {
        const op = script.ops[index] as CanvasOp;
        if (!committed) {
          results.push({ index, op, ok: false, error: "skipped: a prior op failed" });
          continue;
        }
        const result = await applyOp(index, op);
        results.push(result);
        if (!result.ok && snapshot !== null) {
          // Hard failure: restore the pre-script graph and stop applying.
          committed = false;
          await bridge.loadWorkflow(snapshot).catch(() => {});
        } else if (!result.ok) {
          committed = false;
        }
      }
      if (committed) {
        stage.value = "saving";
        const final = await bridge.exportGraph();
        if (final !== null) await workflowStore.save(roomId, final).catch(() => {});
      }
    } finally {
      options.onApplyEnd?.();
    }
    return { txnId: script.txnId, committed, opResults: results };
  }

  /** Open the `canvas/script` mux stream and await the generated script. */
  function awaitScript(roomId: string, txnId: string): Promise<CanvasScript> {
    stage.value = "generating";
    const token = getToken() ?? "";
    return new Promise<CanvasScript>((resolve, reject) => {
      let settled = false;
      let stream: MuxStream;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingReject = null;
        stream.close();
        reject(new Error("canvas script generation timed out"));
      }, GENERATE_TIMEOUT_MS);
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingReject = null;
        fn();
      };
      pendingReject = (reason: Error): void => {
        finish(() => { stream.close(); reject(reason); });
      };
      stream = mux.open("canvas/script", { roomId, txnId, token }, {
        onData(payload: unknown): void {
          if (isScriptFrame(payload)) finish(() => { stream.close(); resolve(payload.script); });
        },
        onError(payload: unknown): void {
          const message = (payload as { message?: string } | null)?.message ?? "canvas script stream error";
          finish(() => { stream.close(); reject(new Error(message)); });
        },
        onEnd(): void {
          finish(() => reject(new Error("canvas script stream ended without a script")));
        },
      });
    });
  }

  async function runIntent(roomId: string, intent: string): Promise<CanvasScriptResult | null> {
    if (busy.value) return null;
    busy.value = true;
    error.value = null;
    opResults.value = [];
    lastTxn.value = null;
    try {
      stage.value = "submitting";
      const ack = await rpc.call("canvas/script", { roomId, intent });
      if (!ack.accepted) throw new Error("canvas/script was not accepted by the host");
      lastTxn.value = ack.txnId;
      const script = await awaitScript(roomId, ack.txnId);
      let result = await executeScript(roomId, script);
      // Aggregate every op across the initial + any corrective re-plan passes so
      // the Studio results strip shows the full history; indices are rebased to
      // stay unique across passes.
      const aggregated: OpResult[] = [...result.opResults];
      opResults.value = aggregated;
      stage.value = "reporting";
      // Report the outcome. When the transaction did not fully commit the host
      // may answer with a fresh `replanTxnId` for a corrective script (the
      // observe->re-plan loop); pull + apply it on the same mux channel.
      let report = await rpc
        .call("canvas/result", {
          roomId,
          txnId: result.txnId,
          committed: result.committed,
          opResults: result.opResults,
        })
        .catch(() => null);
      let replans = 0;
      while (report?.replanTxnId !== undefined && replans < MAX_REPLANS) {
        replans += 1;
        lastTxn.value = report.replanTxnId;
        const fixScript = await awaitScript(roomId, report.replanTxnId);
        const fixResult = await executeScript(roomId, fixScript);
        const offset = aggregated.length;
        aggregated.push(
          ...fixResult.opResults.map((entry): OpResult => ({ ...entry, index: entry.index + offset })),
        );
        opResults.value = [...aggregated];
        result = { txnId: fixResult.txnId, committed: fixResult.committed, opResults: aggregated };
        stage.value = "reporting";
        report = await rpc
          .call("canvas/result", {
            roomId,
            txnId: fixResult.txnId,
            committed: fixResult.committed,
            opResults: fixResult.opResults,
          })
          .catch(() => null);
      }
      stage.value = "done";
      return result;
    } catch (caught) {
      error.value = describeError(caught);
      stage.value = "error";
      return null;
    } finally {
      busy.value = false;
    }
  }

  onScopeDispose(() => {
    pendingReject?.(new Error("canvas script executor disposed"));
    pendingReject = null;
    mux.close();
  });

  return { busy, stage, lastTxn, opResults, error, runIntent };
}
