<template>
  <div class="canvasEmpty">
    <div class="emptyHint">
      <IconClick :size="24" aria-hidden="true" />
      <span>{{ translate("点击工具栏「添加节点」打开家族级联面板，即可创建常用节点或整套模板") }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 空画布引导层（Phase-5 D11/D12）：移植自 vidsay `panels/canvas/components/canvasEmpty.vue`。
 * 新房间打开于空画布（不再预置演示图），此层仅给出指向工具栏「添加节点」家族级联的
 * 提示。原先的四张快捷创建卡片已移除：它们既不可点击编辑、又易与真实画布节点混淆，
 * 创建动作统一收敛到级联面板（与快捷卡片功能完全等价）。
 */
import { IconClick } from "@tabler/icons-vue";
import { translate } from "@dsh-movie/i18n/vue";
</script>

<style scoped lang="scss">
.canvasEmpty {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
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
}
</style>
