<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { clientConfig } from "@/config";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const form = reactive({ identifier: "", password: "" });
const error = ref("");

// The login guard lands here with `?login=1`; make sure any persisted session
// is restored so an already-signed-in user is forwarded straight to the target.
onMounted(async () => {
  if (!auth.restored) await auth.restore();
  if (auth.signedIn) void afterSignIn();
});

function afterSignIn() {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/chat";
  void router.replace(redirect);
}

async function onSubmit() {
  error.value = "";
  try {
    await auth.login(form.identifier, form.password);
    ElMessage.success("Signed in");
    afterSignIn();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="accountPage">
    <el-card v-if="!auth.signedIn" class="authCard" shadow="always">
      <template #header>
        <div class="cardHead">
          <h2>Sign in</h2>
          <p class="sub">Log in with your Matrix account on the local homeserver.</p>
        </div>
      </template>

      <el-form label-position="top" @submit.prevent="onSubmit">
        <el-form-item label="Matrix user">
          <el-input
            v-model="form.identifier"
            placeholder="movie_demo"
            autocomplete="username"
            :disabled="auth.busy"
          />
        </el-form-item>
        <el-form-item label="Password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="••••••••"
            autocomplete="current-password"
            show-password
            :disabled="auth.busy"
            @keyup.enter="onSubmit"
          />
        </el-form-item>

        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="alert" />

        <el-button type="primary" class="submit" :loading="auth.busy" @click="onSubmit">
          {{ auth.busy ? "Signing in…" : "Sign in" }}
        </el-button>
      </el-form>

      <div class="hint">
        <div>homeserver: <el-tag size="small">{{ clientConfig.homeserverUrl }}</el-tag></div>
        <div>gateway: <el-tag size="small">{{ clientConfig.gatewayUrl }}</el-tag></div>
      </div>
    </el-card>

    <el-card v-else class="authCard" shadow="always">
      <template #header>
        <div class="cardHead">
          <h2>Account</h2>
          <p class="sub">You are signed in.</p>
        </div>
      </template>

      <el-descriptions :column="1" border>
        <el-descriptions-item label="Display name">{{ auth.displayName }}</el-descriptions-item>
        <el-descriptions-item label="Matrix ID">{{ auth.myUserId }}</el-descriptions-item>
        <el-descriptions-item label="Device ID">{{ auth.deviceId || "—" }}</el-descriptions-item>
      </el-descriptions>

      <div class="actions">
        <el-button type="primary" @click="router.push('/chat')">Go to Chat</el-button>
        <el-button @click="auth.logout()">Sign out</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.accountPage {
  display: flex;
  justify-content: center;
  padding: 48px 16px;
}

.authCard {
  width: 100%;
  max-width: 420px;
}

.cardHead h2 {
  margin: 0;
}

.sub {
  margin: 4px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.alert {
  margin-bottom: 12px;
}

.submit {
  width: 100%;
}

.hint {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
}
</style>
