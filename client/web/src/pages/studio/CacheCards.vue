<script setup lang="ts">
/**
 * CacheCards — the editor body for a "Utilities → Cache" node.
 *
 * A Cache node records every arriving upstream artifact as a persistent *card*
 * (accumulated across runs, stored server-side per room). This component is a
 * vertical, accordion list of those cards:
 *   - header = «source node name» «global arrival seq» + Shuffle / Delete icons;
 *   - Shuffle = press-hold-drag to reorder (host-only, `cache/reorder`);
 *   - Delete  = remove one card (host-only, `cache/delete`);
 *   - clicking anywhere else expands the card to show its pieces (text / image /
 *     audio / video). `mxc://` pieces are resolved through the host page's
 *     authenticated media resolver (`resolveMedia`).
 *
 * Cards are fetched with `cache/get` on open and refetched whenever the node's
 * run status flips to `success` (a fresh run appended arrivals).
 */
import { onBeforeUnmount, ref, watch } from "vue";
import { LegCError, RpcClient } from "@dsh-movie/sdk";
import type { CacheCard, CachePiece, NodeRunStatus } from "@dsh-movie/protocol";
import { translate } from "@dsh-movie/i18n/vue";
import { sdkConfig } from "@/config";
import { useAuthStore } from "@/stores/auth";
import shuffleIcon from "@/icons/canvas_shuffle.svg";
import deleteIcon from "@/icons/canvas_delete.svg";

interface Props {
  /** The owning room ("" disables all RPC). */
  roomId: string;
  /** The Cache node's graph id (matches the executor's cache key). */
  nodeId: string;
  /** Guests read only: reorder/delete are hidden and mutations are refused. */
  readonly: boolean;
  /** The node's live run status; a flip to `success` triggers a refetch. */
  status: NodeRunStatus;
  /** Resolve an `mxc://` URI to an authenticated blob URL (host page owns it). */
  resolveMedia: (uri: string) => Promise<string | null>;
}

const props = defineProps<Props>();

const auth = useAuthStore();
const rpc = new RpcClient(sdkConfig, { getToken: () => auth.session?.accessToken ?? null });

const cards = ref<CacheCard[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const expandedSeq = ref<number | null>(null);
const mediaByUrl = ref<Map<string, string>>(new Map());
const requested = new Set<string>();

// ── Drag (Shuffle) state ──
const listEl = ref<HTMLElement | null>(null);
const dragSeq = ref<number | null>(null);
let pendingSeq: number | null = null;
let holdTimer: number | null = null;
let dragStartY = 0;

function describeError(thrown: unknown): string {
  if (thrown instanceof LegCError) return `${thrown.code}: ${thrown.message}`;
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}

async function refresh(): Promise<void> {
  if (props.roomId === "" || props.nodeId === "") return;
  loading.value = true;
  try {
    const res = await rpc.call("cache/get", { roomId: props.roomId, nodeId: props.nodeId });
    cards.value = res.cards;
    error.value = null;
  } catch (thrown) {
    error.value = describeError(thrown);
  } finally {
    loading.value = false;
  }
}

async function persistOrder(order: number[]): Promise<void> {
  try {
    const res = await rpc.call("cache/reorder", { roomId: props.roomId, nodeId: props.nodeId, order });
    cards.value = res.cards;
    error.value = null;
  } catch (thrown) {
    error.value = describeError(thrown);
    await refresh();
  }
}

async function remove(seq: number): Promise<void> {
  const prev = cards.value;
  cards.value = prev.filter((card): boolean => card.seq !== seq);
  if (expandedSeq.value === seq) expandedSeq.value = null;
  try {
    const res = await rpc.call("cache/delete", { roomId: props.roomId, nodeId: props.nodeId, seq });
    cards.value = res.cards;
    error.value = null;
  } catch (thrown) {
    error.value = describeError(thrown);
    cards.value = prev;
  }
}

function toggle(seq: number): void {
  expandedSeq.value = expandedSeq.value === seq ? null : seq;
  if (expandedSeq.value === seq) {
    const card = cards.value.find((candidate): boolean => candidate.seq === seq);
    if (card !== undefined) ensureMedia(card);
  }
}

function ensureMedia(card: CacheCard): void {
  for (const piece of card.pieces) {
    const artifact = piece.artifact;
    if (!artifact.startsWith("mxc://") || requested.has(artifact)) continue;
    requested.add(artifact);
    void props
      .resolveMedia(artifact)
      .then((url) => {
        if (url === null || url === "") return;
        const next = new Map(mediaByUrl.value);
        next.set(artifact, url);
        mediaByUrl.value = next;
      })
      .catch(() => {
        // Media fetch failure degrades to the raw-uri text view (R8).
      });
  }
}

function pieceKind(piece: CachePiece): "image" | "video" | "audio" | "text" {
  const declared = (piece.sourceType ?? "").toUpperCase();
  if (declared === "IMAGE") return "image";
  if (declared === "VIDEO") return "video";
  if (declared === "AUDIO") return "audio";
  if (declared === "TEXT") return "text";
  const tail = piece.artifact.toLowerCase().split("?")[0].split("#")[0];
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(tail)) return "image";
  if (/\.(mp4|webm|mov|mkv|m4v)$/.test(tail)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(tail)) return "audio";
  return "text";
}

function pieceSrc(piece: CachePiece): string {
  const artifact = piece.artifact;
  if (artifact.startsWith("mxc://")) return mediaByUrl.value.get(artifact) ?? "";
  return artifact;
}

// ── Shuffle: press-hold-drag reordering ──
function clearHold(): void {
  if (holdTimer !== null) {
    window.clearTimeout(holdTimer);
    holdTimer = null;
  }
}

function armDrag(seq: number): void {
  dragSeq.value = seq;
}

function onHandleDown(event: PointerEvent, seq: number): void {
  if (props.readonly) return;
  event.preventDefault();
  pendingSeq = seq;
  dragStartY = event.clientY;
  clearHold();
  holdTimer = window.setTimeout((): void => {
    armDrag(seq);
  }, 180);
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragUp, { once: true });
}

function onDragMove(event: PointerEvent): void {
  if (dragSeq.value === null) {
    if (pendingSeq !== null && Math.abs(event.clientY - dragStartY) > 6) {
      clearHold();
      armDrag(pendingSeq);
    } else {
      return;
    }
  }
  const container = listEl.value;
  if (container === null) return;
  const children = Array.from(container.children) as HTMLElement[];
  const draggedIndex = children.findIndex((el): boolean => Number(el.dataset.seq) === dragSeq.value);
  if (draggedIndex < 0) return;
  const pointer = event.clientY;
  let targetIndex = draggedIndex;
  for (let i = 0; i < children.length; i++) {
    if (i === draggedIndex) continue;
    const rect = children[i].getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (i < draggedIndex && pointer < mid) {
      targetIndex = i;
      break;
    }
    if (i > draggedIndex && pointer > mid) targetIndex = i;
  }
  if (targetIndex !== draggedIndex) {
    const next = cards.value.slice();
    const moved = next.splice(draggedIndex, 1)[0];
    next.splice(targetIndex, 0, moved);
    cards.value = next;
  }
}

function onDragUp(): void {
  clearHold();
  window.removeEventListener("pointermove", onDragMove);
  if (dragSeq.value !== null) void persistOrder(cards.value.map((card): number => card.seq));
  dragSeq.value = null;
  pendingSeq = null;
}

onBeforeUnmount(() => {
  clearHold();
  window.removeEventListener("pointermove", onDragMove);
});

watch(
  () => [props.roomId, props.nodeId],
  () => {
    expandedSeq.value = null;
    void refresh();
  },
  { immediate: true },
);

watch(
  () => props.status,
  (status) => {
    if (status === "success") void refresh();
  },
);
</script>

<template>
  <div class="cacheCards">
    <p v-if="error !== null" class="cacheError">{{ error }}</p>
    <div v-if="loading && cards.length === 0" class="cacheState">{{ translate("加载中…") }}</div>
    <div v-else-if="cards.length === 0" class="cacheState">
      {{ translate("尚无缓存卡片：连接上游节点并运行工作流后，产物会作为卡片累积在这里") }}
    </div>
    <div v-else ref="listEl" class="cardList">
      <div
        v-for="card in cards"
        :key="card.seq"
        class="cacheCard"
        :class="{ dragging: card.seq === dragSeq, expanded: expandedSeq === card.seq }"
        :data-seq="card.seq">
        <div class="cardHead" @click="toggle(card.seq)">
          <span class="cardName" :title="`${card.sourceName} ${card.seq}`">
            {{ card.sourceName }} {{ card.seq }}
          </span>
          <span class="cardCount">{{ card.pieces.length }}</span>
          <div class="cardActions">
            <button
              type="button"
              class="iconBtn"
              :class="{ handle: true }"
              :title="translate('按住拖动以排序')"
              :disabled="readonly"
              @click.stop
              @pointerdown="onHandleDown($event, card.seq)">
              <span class="btnIcon" :style="{ '--icon': `url(&quot;${shuffleIcon}&quot;)` }" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="iconBtn danger"
              :title="translate('删除卡片')"
              :disabled="readonly"
              @click.stop="remove(card.seq)">
              <span class="btnIcon" :style="{ '--icon': `url(&quot;${deleteIcon}&quot;)` }" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div v-if="expandedSeq === card.seq" class="cardBody">
          <div v-for="(piece, index) in card.pieces" :key="index" class="piece">
            <img
              v-if="pieceKind(piece) === 'image' && pieceSrc(piece) !== ''"
              class="pieceMedia"
              :src="pieceSrc(piece)"
              :alt="translate('图像内容')" />
            <video
              v-else-if="pieceKind(piece) === 'video' && pieceSrc(piece) !== ''"
              class="pieceMedia"
              :src="pieceSrc(piece)"
              controls
              playsinline />
            <audio
              v-else-if="pieceKind(piece) === 'audio' && pieceSrc(piece) !== ''"
              class="pieceAudio"
              :src="pieceSrc(piece)"
              controls />
            <pre v-else class="pieceText">{{ piece.artifact }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.cacheCards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.cacheState {
  padding: 24px 12px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.cacheError {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
  font-size: 12px;
}

.cardList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
}

.cacheCard {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  overflow: hidden;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;

  &.expanded {
    border-color: var(--el-border-color);
  }

  &.dragging {
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
    border-color: var(--el-color-primary);
    cursor: grabbing;
  }
}

.cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: var(--el-fill-color-light);
  }
}

.cardName {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cardCount {
  flex: 0 0 auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 20px;
  text-align: center;
}

.cardActions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.iconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--el-fill-color-dark);
    color: var(--el-text-color-primary);
  }

  &.danger:hover:not(:disabled) {
    color: var(--el-color-danger);
  }

  &.handle {
    cursor: grab;
  }

  &:disabled {
    color: var(--el-text-color-placeholder);
    cursor: not-allowed;
  }
}

.btnIcon {
  display: block;
  width: 16px;
  height: 16px;
  background-color: currentColor;
  mask-image: var(--icon);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--icon);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}

.cardBody {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.piece {
  display: flex;
  flex-direction: column;
}

.pieceMedia {
  max-width: 100%;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.pieceAudio {
  width: 100%;
}

.pieceText {
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}
</style>
