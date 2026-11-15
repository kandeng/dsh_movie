import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * Shared draggable-divider state for the docked chatbox split (Chat + Studio).
 *
 * Both pages lay out as `[main panel | 4px divider | chat column]` and both let
 * the user drag the divider to resize the chat column. The chosen width is kept
 * in a **module-level singleton**, so a width dragged on the Chat page is
 * reused when the user navigates to Studio (and vice-versa) instead of snapping
 * back to the per-page default. A full page reload still falls back to default.
 *
 * The default puts the divider at **2/3 of the panel width from the left**, i.e.
 * the chat column is 1/3 of the panel; every value is clamped to
 * `[CHAT_MIN, 55vw]` so the chatbox can never starve the main panel (or vanish).
 */

/** Minimum chat column width in px. */
const CHAT_MIN = 320;
/** Fallback width (px) used before the first mount measures the panel. */
const CHAT_FALLBACK = 400;

/** Session-shared chat column width in px (survives page navigation). */
const sharedChatWidth = ref(CHAT_FALLBACK);
/** Whether the user (or a prior page this session) already chose a width. */
const sharedChosen = ref(false);

/** Clamp a candidate chat column width into `[CHAT_MIN, 55vw]`. */
function clampWidth(value: number): number {
  const max = Math.round(window.innerWidth * 0.55);
  return Math.min(max, Math.max(CHAT_MIN, value));
}

/**
 * Wire the draggable divider for one page.
 *
 * @param panel - ref to the page's root element (used to measure the default).
 * @returns the reactive chat column width plus the divider pointer handlers.
 */
export function useChatSplitWidth(panel: Ref<HTMLElement | undefined>) {
  const resizing = ref(false);

  // On mount: reuse a width chosen earlier this session (other page), otherwise
  // derive the default (divider at 2/3 from the left => chat column = 1/3).
  onMounted(() => {
    if (sharedChosen.value) {
      sharedChatWidth.value = clampWidth(sharedChatWidth.value);
      return;
    }
    const panelWidth = panel.value?.clientWidth ?? 0;
    sharedChatWidth.value = panelWidth > 0 ? clampWidth(Math.round(panelWidth / 3)) : CHAT_FALLBACK;
    sharedChosen.value = true;
  });

  function onResizeDown(event: PointerEvent): void {
    event.preventDefault();
    resizing.value = true;
    document.addEventListener("pointermove", onResizeMove);
    document.addEventListener("pointerup", onResizeUp);
  }
  function onResizeMove(event: PointerEvent): void {
    if (!resizing.value) return;
    sharedChatWidth.value = clampWidth(window.innerWidth - event.clientX);
    sharedChosen.value = true;
  }
  function onResizeUp(): void {
    if (!resizing.value) return;
    resizing.value = false;
    document.removeEventListener("pointermove", onResizeMove);
    document.removeEventListener("pointerup", onResizeUp);
  }
  onBeforeUnmount(onResizeUp);

  return { chatWidth: sharedChatWidth, resizing, onResizeDown };
}
