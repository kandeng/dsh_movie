import { defineStore } from "pinia";
import { computed, ref } from "vue";
import axios from "axios";
import { translate } from "@dsh-movie/i18n/vue";
import { localpartFromEmail } from "@dsh-movie/protocol";
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
  /** The sign-up email this session's localpart was derived from. */
  email: string;
};

type ProfileResponse = { displayname?: string; avatar_url?: string };

type RegisterResponse = { ok?: boolean; userId?: string; error?: string };

/** Which form field a login/register failure should be flagged on. */
export type AuthField = "email" | "password" | "confirm";

/**
 * A login/register failure tied to a specific form field, so the Account page
 * can flag the offending input (red border + inline message) instead of only
 * showing a generic alert. Failures that are not attributable to a field
 * (e.g. Synapse unreachable) are thrown as plain `Error`.
 */
export class AuthFieldError extends Error {
  readonly field: AuthField;
  constructor(field: AuthField, message: string) {
    super(message);
    this.name = "AuthFieldError";
    this.field = field;
  }
}

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
    // M7: session liveness. `sessionValid` flips false when a re-validation
    // proves the stored token is dead; `revalidating` guards concurrent checks.
    const sessionValid = ref(true);
    const revalidating = ref(false);

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
    /** The sign-up email of the current session (empty when signed out). */
    const email = computed(() => session.value?.email ?? "");
    /**
     * dsh_movie has no SMTP / email-OTP path, so a signed-up email is never
     * verified. The Account page shows a standing warning that an unverified
     * email cannot be used to recover a forgotten password.
     */
    const emailVerified = computed(() => false);

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

    /** Log into Synapse with the sign-up email + password (Mode-B, direct). */
    async function login(identifier: string, password: string): Promise<void> {
      const normalized = identifier.trim().toLowerCase();
      if (!normalized) throw new AuthFieldError("email", translate("请输入邮箱"));
      if (!password) throw new AuthFieldError("password", translate("请输入密码"));
      // The Account page is email-keyed, but Synapse only knows the localpart,
      // so re-derive the same deterministic localpart used at sign-up.
      const localpart = localpartFromEmail(normalized);
      if (!localpart) throw new AuthFieldError("email", translate("邮箱格式不正确"));
      busy.value = true;
      try {
        const matrixSession = await loginWithPassword(sdkConfig, toMatrixId(localpart), password);
        session.value = {
          userId: matrixSession.userId,
          accessToken: matrixSession.accessToken,
          deviceId: matrixSession.deviceId ?? "",
          displayName: localpartOf(matrixSession.userId),
          avatarUrl: "",
          email: normalized,
        };
        restored.value = true;
        await refreshProfile();
      } catch (error) {
        // A rejected credential is a password-field problem; surface it there.
        if (error instanceof AuthFieldError) throw error;
        throw new AuthFieldError("password", translate("邮箱或密码错误"));
      } finally {
        busy.value = false;
      }
    }

    /**
     * Register a new account from an email + password (+ optional display name)
     * through the host `/auth/register` listener, then sign in automatically.
     * Synapse open registration stays disabled; this is the only way to create
     * an account. No email verification is performed.
     * @param email - the sign-up email (case-insensitive).
     * @param password - the password (must be at least 8 characters).
     * @param name - an optional display name for the new account.
     */
    async function register(email: string, password: string, name: string): Promise<void> {
      const normalized = email.trim().toLowerCase();
      if (!normalized) throw new AuthFieldError("email", translate("请输入邮箱"));
      if (!localpartFromEmail(normalized)) throw new AuthFieldError("email", translate("邮箱格式不正确"));
      if (password.length < 8) throw new AuthFieldError("password", translate("密码至少需要 8 位"));
      busy.value = true;
      try {
        await axios.post<RegisterResponse>(
          `${clientConfig.authUrl}/auth/register`,
          { email: normalized, password, name: name.trim() },
        );
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const code = axios.isAxiosError(error)
          ? (error.response?.data as RegisterResponse | undefined)?.error
          : undefined;
        if (status === 409 || code === "email-taken") throw new AuthFieldError("email", translate("该邮箱已被注册"));
        if (code === "invalid-email") throw new AuthFieldError("email", translate("邮箱格式不正确"));
        if (code === "invalid-password") throw new AuthFieldError("password", translate("密码至少需要 8 位"));
        if (status === 400) throw new AuthFieldError("email", translate("邮箱或密码格式不正确"));
        if (status === 503) throw new Error(translate("Synapse 暂时不可用，请稍后再试"));
        throw new Error(translate("注册失败，请稍后再试"));
      } finally {
        busy.value = false;
      }
      // Auto-login after a successful sign-up (matches vidsay behavior).
      await login(normalized, password);
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
      sessionValid.value = false;
    }

    /**
     * Re-validate the stored token against Synapse (`whoami`) without a full
     * restore. On failure the session is invalidated (bouncing guarded routes to
     * login). Leg C/Leg B re-read the token per call/socket, so a still-valid
     * session needs no propagation. Returns whether the token is valid.
     */
    async function revalidate(): Promise<boolean> {
      const current = session.value;
      if (!current?.accessToken) {
        sessionValid.value = false;
        return false;
      }
      if (revalidating.value) return sessionValid.value;
      revalidating.value = true;
      try {
        const verified = await whoami(sdkConfig, current.accessToken);
        if (!verified) {
          invalidate();
          return false;
        }
        sessionValid.value = true;
        return true;
      } catch {
        // A network blip is not proof the token died; keep the session.
        return sessionValid.value;
      } finally {
        revalidating.value = false;
      }
    }

    async function logout(): Promise<void> {
      session.value = null;
      restored.value = false;
      sessionValid.value = true;
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
      email,
      emailVerified,
      sessionValid,
      revalidating,
      login,
      register,
      logout,
      restore,
      revalidate,
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
