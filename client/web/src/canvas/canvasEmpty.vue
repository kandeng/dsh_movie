<template>
  <div class="canvasEmpty">
    <div class="emptyHint">
      <IconClick :size="24" aria-hidden="true" />
      <span>点击下方按钮创建节点</span>
    </div>
    <div class="emptyActions">
      <button
        v-for="item in MOVIE_NODES"
        :key="item.classType"
        class="emptyAction"
        type="button"
        @pointerdown.stop
        @dblclick.stop
        @click.stop="emit('create', item.classType)">
        <span class="actionIcon"><component :is="iconFor(item.classType)" :size="22" aria-hidden="true" /></span>
        <span>{{ item.displayName }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 空画布引导层：移植自 vidsay `panels/canvas/components/canvasEmpty.vue`。
 * vidsay 列出图片/视频/音频生成三个快捷创建项；dsh_movie 改为六步影片节点，
 * 视觉规格（200px 圆角卡 + 40px 图标块）与 vidsay 完全一致。
 */
import { IconClick, IconFileText, IconListDetails, IconPhoto, IconLayoutGrid, IconVideo, IconMovie, IconBox } from "@tabler/icons-vue";
import { MOVIE_NODES } from "@dsh-movie/protocol";

const emit = defineEmits<{ create: [classType: string] }>();

const ICONS: Record<string, typeof IconBox> = {
  MovieScript: IconFileText,
  MovieShotPlan: IconListDetails,
  MovieAsset: IconPhoto,
  MovieStoryboard: IconLayoutGrid,
  MovieClip: IconVideo,
  MovieAssemble: IconMovie,
};
function iconFor(classType: string) {
  return ICONS[classType] ?? IconBox;
}
</script>

<style scoped lang="scss">
.canvasEmpty {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 32px;
  padding: 24px;
  pointer-events: none;
  user-select: none;

  .emptyHint {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--el-text-color-secondary);
    font-size: 14px;
    font-weight: 500;
  }

  .emptyActions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    max-width: 100%;

    .emptyAction {
      display: flex;
      align-items: center;
      gap: 16px;
      width: 200px;
      max-width: 100%;
      min-height: 56px;
      padding: 6px 8px;
      border: 1px solid var(--el-border-color-light);
      border-radius: 16px;
      background: var(--el-fill-color-light);
      color: var(--el-text-color-primary);
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
      pointer-events: auto;
      transition: background-color 0.15s, border-color 0.15s;

      &:hover:not(:disabled) {
        background: var(--el-fill-color);
        border-color: var(--el-border-color-darker);
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
        outline-offset: 3px;
      }

      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .actionIcon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 40px;
        height: 40px;
        border-radius: 12px;
        background: var(--el-fill-color-darker);
      }
    }
  }
}
</style>
