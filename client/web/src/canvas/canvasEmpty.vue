<template>
  <div class="canvasEmpty">
    <div class="emptyHint">
      <IconClick :size="24" aria-hidden="true" />
      <span>从下方快捷创建，或点击工具栏「添加节点」打开家族级联面板</span>
    </div>
    <div class="emptyActions">
      <button
        v-for="item in QUICK_CREATE"
        :key="item.classType"
        class="emptyAction"
        type="button"
        @pointerdown.stop
        @dblclick.stop
        @click.stop="emit('create', item.classType)">
        <span class="actionIcon"><component :is="iconFor(item.modality)" :size="22" aria-hidden="true" /></span>
        <span>{{ item.displayName }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 空画布引导层（Phase-5 D11/D12）：移植自 vidsay `panels/canvas/components/canvasEmpty.vue`。
 * 新房间现在打开于空画布（不再预置六步演示图），此层给出指向「添加节点」家族级联的
 * 提示，并列出几个常用的功能节点（输入源 / 生成器）作为快捷创建。视觉规格
 * （200px 圆角卡 + 40px 图标块）与 vidsay 完全一致。
 */
import { IconClick, IconFileText, IconPhoto, IconVideo, IconVolume2, IconBox } from "@tabler/icons-vue";
import { FUNCTIONAL_NODES, type NodeModality } from "@dsh-movie/protocol";

const emit = defineEmits<{ create: [classType: string] }>();

/** The common functional primitives offered as empty-canvas quick-create. */
const QUICK_CREATE_CLASS_TYPES = ["TextInput", "ImageInput", "TextGenerator", "ImageGenerator"];
const QUICK_CREATE = QUICK_CREATE_CLASS_TYPES.map((classType) => {
  const schema = FUNCTIONAL_NODES.find((node) => node.classType === classType);
  return {
    classType,
    displayName: schema?.displayName ?? classType,
    modality: (schema?.modality ?? "text") as NodeModality,
  };
});

const MODALITY_ICON: Record<string, typeof IconBox> = {
  text: IconFileText,
  image: IconPhoto,
  video: IconVideo,
  audio: IconVolume2,
};
function iconFor(modality: string) {
  return MODALITY_ICON[modality] ?? IconBox;
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
