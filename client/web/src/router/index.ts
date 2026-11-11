import { createRouter, createWebHashHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

/**
 * Phase-2 routes (hash history so the built app can be served from any path):
 * - `/chat`    the merged one-shot room + stage view (ported in Task 6).
 * - `/account` Mode-B login / profile / logout.
 * Later milestones add `/plaza`, `/studio`, `/settings`; they are stubbed as
 * redirects to `/chat` for now so deep links never 404 during the skeleton.
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    {
      path: "/chat",
      component: () => import("@/pages/chat/index.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/account",
      component: () => import("@/pages/account/index.vue"),
    },
    // Stubs for deferred milestones (M3-M5); keep them resolving to /chat.
    { path: "/plaza", redirect: "/chat" },
    { path: "/studio", redirect: "/chat" },
    { path: "/settings", redirect: "/account" },
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
