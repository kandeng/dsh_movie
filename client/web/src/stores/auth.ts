import { defineStore } from "pinia";
import { computed, ref } from "vue";
import axios from "axios";
import { translate } from "@dsh-movie/i18n/vue";
import {
  loginWithPassword,
  whoami,
  setDisplayName,
  setAvatar,
  changePassword as sdkChangePassword,
} from "@dsh-movie/sdk";
import { fetchMediaBlobUrl } from "@/lib/matrixMedia";
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
    // Resolved (blob) URL for the avatar `mxc://` uri, safe to bind to `<img>`.
    const avatarHttpUrl = ref("");

    /** Build the SDK-facing Matrix half-session from the stored auth session. */
    function matrixSession() {
      const current = session.value;
      if (!current) return null;
      return {
        accessToken: current.accessToken,
        userId: current.userId,
        deviceId: current.deviceId || null,
      };
    }

    /** Resolve the session's avatar `mxc://` into a displayable blob URL. */
    async function resolveAvatar(): Promise<void> {
      const current = session.value;
      const mxc = current?.avatarUrl ?? "";
      if (!mxc || !current?.accessToken) {
        avatarHttpUrl.value = "";
        return;
      }
      try {
        avatarHttpUrl.value = await fetchMediaBlobUrl(mxc, current.accessToken);
      } catch {
        avatarHttpUrl.value = "";
      }
    }

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
        await resolveAvatar();
      } catch {
        // Display name and avatar are best-effort; ignore failures.
      }
    }

    /**
     * Update the account profile on Synapse: display name and/or avatar.
     * @param displayName - the new display name (trimmed; ignored when empty).
     * @param avatarDataUri - an optional `data:` image URI to upload as avatar.
     */
    async function updateProfile(displayName: string, avatarDataUri?: string): Promise<void> {
      const current = session.value;
      const half = matrixSession();
      if (!current || !half) throw new Error(translate("请先登录"));
      busy.value = true;
      try {
        const name = displayName.trim();
        if (name && name !== current.displayName) {
          await setDisplayName(sdkConfig, half, name);
          session.value = { ...session.value!, displayName: name };
        }
        if (avatarDataUri) {
          const blob = await (await fetch(avatarDataUri)).blob();
          const mxc = await setAvatar(sdkConfig, half, blob);
          session.value = { ...session.value!, avatarUrl: mxc };
          await resolveAvatar();
        }
      } finally {
        busy.value = false;
      }
    }

    /**
     * Change the account password on Synapse. On success all devices are logged
     * out, so the local session is cleared and the caller must re-login.
     */
    async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
      const half = matrixSession();
      if (!half) throw new Error(translate("请先登录"));
      if (!oldPassword || !newPassword) throw new Error(translate("请输入密码"));
      busy.value = true;
      try {
        await sdkChangePassword(sdkConfig, half, oldPassword, newPassword);
        // Password changed with logout_devices: the current token is now dead.
        invalidate();
      } finally {
        busy.value = false;
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
      avatarHttpUrl,
      login,
      logout,
      restore,
      invalidate,
      refreshProfile,
      updateProfile,
      changePassword,
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
