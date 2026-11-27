// @ts-check
// The /api router. Every route says who may call it. Every state-changing request (POST)
// must pass the CSRF checks from docs/architecture.md, section 5:
//   1. Origin is our own origin, 2. X-CSRF-Token matches the session (logged-in routes),
//   3. the body is JSON. GET requests never change anything.

import { ConfigError, textEqual } from "./crypto.js";
import { HttpError, json, methodNotAllowed, readJsonBody } from "./http.js";
import { readAdminSession, readMemberSession } from "./sessions.js";

/** @typedef {import("./sessions.js").MemberSession} MemberSession */
/** @typedef {import("./sessions.js").AdminSession} AdminSession */

/**
 * @typedef {{
 *   request: Request,
 *   env: Env,
 *   url: URL,
 *   now: number,
 *   params: string[],
 *   body: Record<string, unknown>,
 *   member: MemberSession | null,
 *   admin: AdminSession | null,
 * }} Ctx
 */

/** @typedef {(ctx: Ctx) => Promise<Response>} Handler */

/**
 * public = anyone (logins); member / admin = needs that session.
 * @typedef {{ method: "GET" | "POST", path: string, access: "public" | "member" | "admin", handler: Handler }} Route
 */

/**
 * @typedef {{ route: Route, pattern: RegExp }} CompiledRoute
 */

/** "/api/bookings/:id/cancel" → a regex where each :name is one path segment. @param {string} path */
function compile(path) {
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-z_]+/g, "([^/]+)");
  return new RegExp(`^${source}$`);
}

/** @param {string} message */
const forbidden = (message) => new HttpError(403, "csrf", message);

/**
 * @param {Route[]} routes
 * @returns {(request: Request, env: Env, now: number) => Promise<Response>}
 */
export function createRouter(routes) {
  /** @type {CompiledRoute[]} */
  const compiled = routes.map((route) => ({ route, pattern: compile(route.path) }));

  return async function handle(request, env, now) {
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    const matches = compiled
      .map((entry) => ({ entry, match: entry.pattern.exec(url.pathname) }))
      .filter((m) => m.match !== null);
    if (matches.length === 0) return json({ error: "not_found", message: "We couldn't find that." }, 404);
    const found = matches.find((m) => m.entry.route.method === method);
    if (!found || !found.match) {
      const allowed = [...new Set(matches.map((m) => m.entry.route.method))];
      return methodNotAllowed(allowed.includes("GET") ? [...allowed, "HEAD"].join(", ") : allowed.join(", "));
    }
    const { route } = found.entry;

    try {
      /** @type {Record<string, unknown>} */
      let body = {};
      if (method === "POST") {
        // CSRF check 1: the request comes from our own pages.
        if (request.headers.get("Origin") !== url.origin) throw forbidden("Please reload the page and try again.");
        // CSRF check 3: JSON only (a plain HTML form elsewhere can't send it).
        const type = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") throw new HttpError(415, "json_required", "Please reload the page and try again.");
        body = await readJsonBody(request);
      }

      /** @type {Ctx} */
      const ctx = { request, env, url, now, params: found.match.slice(1), body, member: null, admin: null };

      if (route.access === "member") {
        ctx.member = await readMemberSession(request, env.DB, now);
        if (!ctx.member) throw new HttpError(401, "not_logged_in", "Please log in again.");
      } else if (route.access === "admin") {
        ctx.admin = await readAdminSession(request, env.DB, now);
        if (!ctx.admin) throw new HttpError(401, "not_logged_in", "Please log in again.");
      }

      // CSRF check 2: logged-in changes need the session's token.
      if (method === "POST" && route.access !== "public") {
        const expected = ctx.member?.csrfToken ?? ctx.admin?.csrfToken ?? "";
        const sent = request.headers.get("X-CSRF-Token") ?? "";
        if (sent === "" || !textEqual(sent, expected)) throw forbidden("Please reload the page and try again.");
      }

      return await route.handler(ctx);
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse();
      if (error instanceof ConfigError) {
        // Say which setting is wrong in the log (never its value); tell the visitor nothing.
        console.error("config_error", error.message);
        return json({ error: "unavailable", message: "Login is temporarily unavailable. Please try again later." }, 503);
      }
      throw error;
    }
  };
}
