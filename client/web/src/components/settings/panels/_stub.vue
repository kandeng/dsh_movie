<template>
  <div class="stub">
    <section class="settingSection">
      <h3>{{ title }}</h3>
      <p class="description">该面板在 vidsay 中依赖其后端能力（模型服务、插件市场、MCP、网络代理、使用统计等）。</p>
      <p class="description">dsh_movie 当前未接入对应后端，此设置暂不可用。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<style lang="scss" scoped>
.stub {
  padding: 0 4px 8px;

  .settingSection h3 {
    margin: 0 0 12px;
    color: var(--el-text-color-primary);
    font-size: 14px;
    font-weight: 600;
  }

  .description {
    margin: 0 0 8px;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.6;
  }
}
</style>
