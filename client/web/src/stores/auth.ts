import { defineStore } from "pinia";
import { computed, ref } from "vue";
import axios from "axios";
import { translate } from "@dsh-movie/i18n/vue";
import { loginWithPassword, whoami } from "@dsh-movie/sdk";
import { clientConfig, sdkConfig, toMatrixId } from "@/config";

/**
 * Mode-B auth store.
 *
 * The browser is the trust anchor: it logs straight into Synapse with a Matrix
 * username + password (SDK Leg A), keeps the resulting access token, and hands
 * that same token to the DSH host gateway which introspects it via
 * `ctx.matrixIdentity.whoami` to derive the `matrix:<mxid>` principal.
 *
 * All of vidsay's better-auth machinery (email/password website accounts,
 * email-OTP verification, password reset, `/api/matrix/token` shadow-token
 * brokering) is intentionally removed - dsh_movie has a single identity
 * provider (Synapse), so there is no separate website account layer.
 */

export type AuthSession = {
  /** Matrix mxid `@localpart:serverName` (the chat + principal identity). */
  userId: string;
  /** The Matrix access token; also the Leg B/C principal credential. */
  accessToken: string;
  deviceId: string;
  displayName: string;
  /** `mxc://` uri or empty string. */
  avatarUrl: string;
};

type ProfileResponse = { displayname?: string; avatar_url?: string };

/** Extract the localpart from `@localpart:serverName`, used as a display fallback. */
export function localpartOf(userId: string): string {
  if (!userId) return "";
  const bare = userId.startsWith("@") ? userId.slice(1) : userId;
  return bare.split(":")[0] || bare;
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export const useAuthStore = defineStore(
  "auth",
  () => {
    const session = ref<AuthSession | null>(null);
    const busy = ref(false);
    const restored = ref(false);

    const signedIn = computed(() => Boolean(session.value?.accessToken));
    const myUserId = computed(() => session.value?.userId ?? "");
    const accessToken = computed(() => session.value?.accessToken ?? "");
    const deviceId = computed(() => session.value?.deviceId ?? "");
    const displayName = computed(
      () => session.value?.displayName || localpartOf(session.value?.userId ?? ""),
    );
    const avatarUrl = computed(() => session.value?.avatarUrl ?? "");

    /** Read the Matrix profile (displayname/avatar); failure never blocks login. */
    async function refreshProfile(): Promise<void> {
      const current = session.value;
      if (!current?.accessToken) return;
      try {
        const { data } = await axios.get<ProfileResponse>(
          `${clientConfig.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(current.userId)}`,
          { headers: authHeaders(current.accessToken) },
        );
        session.value = {
          ...current,
          displayName: typeof data.displayname === "string" && data.displayname ? data.displayname : current.displayName,
          avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : current.avatarUrl,
        };
      } catch {
        // Display name and avatar are best-effort; ignore failures.
      }
    }

    /** Log into Synapse with a Matrix username (localpart or full mxid) + password. */
    async function login(identifier: string, password: string): Promise<void> {
      const user = identifier.trim();
      if (!user) throw new Error(translate("请输入用户名"));
      if (!password) throw new Error(translate("请输入密码"));
      busy.value = true;
      try {
        const matrixSession = await loginWithPassword(sdkConfig, toMatrixId(user), password);
        session.value = {
          userId: matrixSession.userId,
          accessToken: matrixSession.accessToken,
          deviceId: matrixSession.deviceId ?? "",
          displayName: localpartOf(matrixSession.userId),
          avatarUrl: "",
        };
        restored.value = true;
        await refreshProfile();
      } finally {
        busy.value = false;
      }
    }

    /**
     * Restore a persisted session on reload: verify the stored token against
     * Synapse (`whoami`). Returns whether the user is still signed in.
     */
    async function restore(): Promise<boolean> {
      if (restored.value) return signedIn.value;
      restored.value = true;
      const current = session.value;
      if (!current?.accessToken) {
        session.value = null;
        return false;
      }
      const verified = await whoami(sdkConfig, current.accessToken);
      if (!verified) {
        session.value = null;
        return false;
      }
      void refreshProfile();
      return true;
    }

    /** Clear the session when a token is rejected (e.g. Synapse was reset). */
    function invalidate(): void {
      session.value = null;
      restored.value = false;
    }

    async function logout(): Promise<void> {
      session.value = null;
      restored.value = false;
    }

    return {
      session,
      busy,
      restored,
      signedIn,
      myUserId,
      accessToken,
      deviceId,
      displayName,
      avatarUrl,
      login,
      logout,
      restore,
      invalidate,
      refreshProfile,
    };
  },
  {
    // Persist only the Matrix half-session; there is no separate website cookie.
    persist: {
      key: "dsh-movie.auth",
      pick: ["session"],
      storage: localStorage,
    },
  },
);
