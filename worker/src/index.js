// @ts-check
// The one Worker: serves the static pages, answers /api/*, and runs the
// nightly clean-up. Every request comes here first (run_worker_first), so
// every response gets the security headers.

import { availabilityRoutes } from "./api/availability.js";
import { bookingRoutes } from "./api/bookings.js";
import { eventRoutes } from "./api/events.js";
import { memberAuthRoutes } from "./api/member-auth.js";
import { withSecurityHeaders } from "./headers.js";
import { json, methodNotAllowed, redirect } from "./http.js";
import { LOGIN_PAGES, pageAccess, pagePath } from "./pages.js";
import { runRetention } from "./retention.js";
import { createRouter } from "./router.js";
import { readAdminSession, readMemberSession } from "./sessions.js";
import { alarmUntil } from "./throttle.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/** Every /api route. Each module lists its own. */
export const ROUTES = [...memberAuthRoutes, ...availabilityRoutes, ...bookingRoutes, ...eventRoutes];

const api = createRouter(ROUTES);

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<{ response: Response, noStore: boolean, turnstile?: boolean }>}
 */
async function route(request, env) {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);

  if (url.pathname === "/api/health") {
    if (!READ_METHODS.has(request.method)) return { response: methodNotAllowed("GET, HEAD"), noStore: true };
    return { response: json({ ok: true }), noStore: true };
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return { response: await api(request, env, now), noStore: true };
  }

  // Pages and files. Nothing outside /api accepts changes.
  if (!READ_METHODS.has(request.method)) {
    return { response: methodNotAllowed("GET, HEAD"), noStore: true };
  }

  const access = pageAccess(url.pathname);
  if (access === "member" && !(await readMemberSession(request, env.DB, now))) {
    return { response: redirect("/login", url), noStore: true };
  }
  if (access === "admin" && !(await readAdminSession(request, env.DB, now))) {
    return { response: redirect("/admin/login", url), noStore: true };
  }

  const page = pagePath(url.pathname);
  if (LOGIN_PAGES.has(page)) {
    const turnstile = (await alarmUntil(env.DB, now)) !== null;
    return { response: await env.ASSETS.fetch(request), noStore: true, turnstile };
  }
  return { response: await env.ASSETS.fetch(request), noStore: access === "member" || access === "admin" };
}

/** @type {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    try {
      const { response, noStore, turnstile } = await route(request, env);
      return withSecurityHeaders(response, { noStore, turnstile });
    } catch (error) {
      // Log the kind of failure only, never request data.
      console.error("unhandled_error", error instanceof Error ? error.name : typeof error);
      return withSecurityHeaders(json({ error: "server_error", message: "Something went wrong. Please try again." }, 500), {
        noStore: true,
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRetention(env.DB, Math.floor(controller.scheduledTime / 1000)));
  },
};
