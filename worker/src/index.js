// @ts-check
// The one Worker: serves the static pages, answers /api/*, and runs the
// nightly clean-up. Every request comes here first (run_worker_first), so
// every response gets the security headers.

import { adminAuditRoutes } from "./api/admin-audit.js";
import { adminAuthRoutes } from "./api/admin-auth.js";
import { adminEventRoutes } from "./api/admin-events.js";
import { adminLeagueRoutes } from "./api/admin-leagues.js";
import { adminMemberRoutes } from "./api/admin-members.js";
import { adminResourceRoutes } from "./api/admin-resources.js";
import { adminScheduleRoutes } from "./api/admin-schedule.js";
import { availabilityRoutes } from "./api/availability.js";
import { bookingRoutes } from "./api/bookings.js";
import { eventRoutes } from "./api/events.js";
import { memberAuthRoutes } from "./api/member-auth.js";
import { weekRoutes } from "./api/week.js";
import { clubScript, clubStylesheet, fillClubPage } from "./club-pages.js";
import { CLUB } from "./club.js";
import { isDemo } from "./demo.js";
import { withSecurityHeaders } from "./headers.js";
import { json, methodNotAllowed, redirect } from "./http.js";
import { LOGIN_PAGES, pageAccess, pagePath } from "./pages.js";
import { runRetention } from "./retention.js";
import { createRouter } from "./router.js";
import { readAdminSession, readMemberSession } from "./sessions.js";
import { alarmUntil } from "./throttle.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/** Every /api route. Each module lists its own. */
export const ROUTES = [
  ...memberAuthRoutes,
  ...availabilityRoutes,
  ...bookingRoutes,
  ...eventRoutes,
  ...weekRoutes,
  ...adminAuthRoutes,
  ...adminMemberRoutes,
  ...adminResourceRoutes,
  ...adminEventRoutes,
  ...adminScheduleRoutes,
  ...adminLeagueRoutes,
  ...adminAuditRoutes,
];

const api = createRouter(ROUTES);

/**
 * A page from the static files, with the club's text filled in. The browser's "has it
 * changed?" headers are dropped, so the stored file's ETag can't answer for the filled page.
 * @param {Request} request
 * @param {Env} env
 * @param {string} page the page path, e.g. "/week"
 */
async function servePage(request, env, page) {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  return fillClubPage(await env.ASSETS.fetch(new Request(request, { headers })), page, { demo: isDemo(env) });
}

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

  // The club's colours and the settings the page scripts need, made from its settings file.
  if (url.pathname === "/club.css") return { response: clubStylesheet(), noStore: false };
  if (url.pathname === "/js/club.js") return { response: clubScript(), noStore: false };
  // The club's old website's page addresses (its settings file), so old links keep working.
  const moved = CLUB.redirects[url.pathname.toLowerCase()];
  if (moved) return { response: new Response(null, { status: 301, headers: { Location: new URL(moved, url).toString() } }), noStore: false };

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
    return { response: await servePage(request, env, page), noStore: true, turnstile };
  }
  // Private pages and every admin page (including setup) are never cached.
  const noStore = access === "member" || access === "admin" || page === "/admin" || page.startsWith("/admin/");
  return { response: access === "file" ? await env.ASSETS.fetch(request) : await servePage(request, env, page), noStore };
}

/** @type {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    try {
      const { response, noStore, turnstile } = await route(request, env);
      return withSecurityHeaders(response, { noStore, turnstile, demo: isDemo(env) });
    } catch (error) {
      // Log the kind of failure only, never request data.
      console.error("unhandled_error", error instanceof Error ? error.name : typeof error);
      return withSecurityHeaders(json({ error: "server_error", message: "Something went wrong. Please try again." }, 500), {
        noStore: true,
        demo: isDemo(env),
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRetention(env.DB, Math.floor(controller.scheduledTime / 1000)));
  },
};
