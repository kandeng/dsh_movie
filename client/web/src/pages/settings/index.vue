<script setup lang="ts">
import settingsCenter from "@/components/settings/index.vue";
</script>

<template>
  <div class="settingsPage">
    <settingsCenter />
  </div>
</template>

<style scoped lang="scss">
// ACT: 整页布局由设置组件自身接管（Account / Supply 同款网格），此处不再加内边距。
.settingsPage {
  height: 100%;
}
</style>
