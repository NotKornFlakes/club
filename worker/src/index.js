// @ts-check
// The one Worker: serves the static pages, answers /api/*, and runs the
// nightly clean-up. Every request comes here first (run_worker_first), so
// every response gets the security headers.

import { withSecurityHeaders } from "./headers.js";
import { json, methodNotAllowed } from "./http.js";
import { runRetention } from "./retention.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<{ response: Response, noStore: boolean }>}
 */
async function route(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (!READ_METHODS.has(request.method)) {
      // No state-changing endpoints exist yet. CSRF checks arrive with the first one.
      return { response: methodNotAllowed("GET, HEAD"), noStore: true };
    }
    if (url.pathname === "/api/health") {
      return { response: json({ ok: true }), noStore: true };
    }
    return { response: json({ error: "not_found" }, 404), noStore: true };
  }

  // Static pages. Nothing private exists yet; login checks arrive with member auth.
  if (!READ_METHODS.has(request.method)) {
    return { response: methodNotAllowed("GET, HEAD"), noStore: true };
  }
  return { response: await env.ASSETS.fetch(request), noStore: false };
}

/** @type {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    try {
      const { response, noStore } = await route(request, env);
      return withSecurityHeaders(response, { noStore });
    } catch (error) {
      // Log the kind of failure only, never request data.
      console.error("unhandled_error", error instanceof Error ? error.name : typeof error);
      return withSecurityHeaders(json({ error: "server_error" }, 500), { noStore: true });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRetention(env.DB, Math.floor(controller.scheduledTime / 1000)));
  },
};
