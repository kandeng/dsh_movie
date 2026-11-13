import { createRouter, createWebHashHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

/**
 * Phase-2 routes (hash history so the built app can be served from any path):
 * - `/chat`     the merged one-shot room + stage view.
 * - `/plaza`    the generated-video gallery (M3).
 * - `/account`  Mode-B login / profile edit / change password / logout (M3).
 * - `/settings` placeholder entry (full settings UI not ported; M3).
 * - `/studio`   the step-by-step Studio shell: stage slot + docked chatbox (M4).
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    {
      path: "/chat",
      component: () => import("@/pages/chat/index.vue"),
      meta: { requiresAuth: true, shell: true },
    },
    {
      path: "/account",
      component: () => import("@/pages/account/index.vue"),
      meta: { shell: true },
    },
    {
      path: "/plaza",
      component: () => import("@/pages/plaza/index.vue"),
      meta: { shell: true },
    },
    {
      path: "/settings",
      component: () => import("@/pages/settings/index.vue"),
      meta: { shell: true },
    },
    {
      path: "/studio",
      component: () => import("@/pages/studio/index.vue"),
      meta: { requiresAuth: true, shell: true },
    },
  ],
});

// Routes marked `requiresAuth` restore the persisted session first; if still
// signed out, bounce to the account page with a redirect back-link.
router.beforeEach(async (to) => {
  if (to.meta.requiresAuth !== true) return true;
  const auth = useAuthStore();
  if (!auth.restored) await auth.restore();
  if (auth.signedIn) return true;
  return { path: "/account", query: { login: "1", redirect: to.fullPath } };
});

export default router;
