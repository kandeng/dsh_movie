<script setup lang="ts">
import { useRouter } from "vue-router";
import { translate } from "@dsh-movie/i18n/vue";

// ACT: 设置页占位（design doc §4.4）：dsh_movie 不移植 vidsay 的完整设置面板，
// 这里只保留一个入口占位页，账户相关设置已并入 /account。后续里程碑再按需扩展。
const router = useRouter();
</script>

<template>
  <div class="settings">
    <el-empty :description="translate('设置功能即将上线，敬请期待。')">
      <el-button type="primary" @click="router.push('/account')">{{ translate("返回账户") }}</el-button>
    </el-empty>
  </div>
</template>

<style scoped lang="scss">
.settings {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 14px;
}
</style>
