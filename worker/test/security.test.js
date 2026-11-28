// @ts-check
// Hardening checks that cover the whole site at once:
// - CSRF: every POST route in the router table refuses a missing or foreign Origin and
//   non-JSON bodies, and logged-in routes refuse a missing or wrong CSRF token.
// - Access: every logged-in route refuses no session and the other kind of session.
// - Headers: every page and API answer has the security headers and the strict CSP.
// - Throttling: admin logins hit the same per-IP block, flood gate and alarm as members.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { ROUTES } from "../src/index.js";
import { CSP, SECURITY_HEADERS } from "../src/headers.js";
import { MAX_BODY_BYTES } from "../src/http.js";
import { ORIGIN, db, get, loginAdmin, loginMember, makeAdmin, makeMember, newIp, nowSeconds, post, resetThrottle } from "./helpers.js";

/** @type {import("./helpers.js").Session} */
let member;
/** @type {import("./helpers.js").Session} */
let admin;

beforeAll(async () => {
  member = await loginMember(await makeMember());
  admin = await loginAdmin(await makeAdmin());
});
beforeEach(resetThrottle);

/** @param {string} path */
const concrete = (path) => path.replace(/:[a-z_]+/g, "1");

/** @param {Response} response */
function expectHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name), name).toBe(value);
}

const postRoutes = ROUTES.filter((r) => r.method === "POST");
const sessionPosts = postRoutes.filter((r) => r.access !== "public");
const sessionGets = ROUTES.filter((r) => r.method === "GET" && r.access !== "public");

describe("the route table", () => {
  it("has only these routes open without a login (logins, login status, and the week view)", () => {
    const open = ROUTES.filter((r) => r.access === "public").map((r) => `${r.method} ${r.path}`).sort();
    // The week view is public and read-only: free, taken, closed and program names only.
    // test/week.test.js checks it never shows who booked, admin labels or private leagues.
    expect(open).toEqual([
      "GET /api/login-status",
      "GET /api/week",
      "POST /api/admin/login",
      "POST /api/admin/setup",
      "POST /api/admin/setup/start",
      "POST /api/login",
    ]);
  });

  it("puts every admin route behind the admin login", () => {
    for (const r of ROUTES.filter((route) => route.path.startsWith("/api/admin/"))) {
      if (!["/api/admin/login", "/api/admin/setup", "/api/admin/setup/start"].includes(r.path)) expect(r.access, r.path).toBe("admin");
    }
  });

  it("only uses GET (read) and POST (change)", () => {
    expect(new Set(ROUTES.map((r) => r.method))).toEqual(new Set(["GET", "POST"]));
  });
});

describe("CSRF on every state-changing route", () => {
  it.each(postRoutes.map((r) => [concrete(r.path), r.access]))("%s refuses a missing or foreign Origin", async (path, access) => {
    const session = access === "admin" ? admin : member;
    const options = access === "public" ? {} : { cookie: session.cookie, csrf: session.csrf };
    for (const origin of [null, "https://evil.example", "http://club.example.workers.dev"]) {
      const response = await post(path, {}, { ...options, origin });
      expect(response.status, String(origin)).toBe(403);
      expectHeaders(response);
    }
  });

  it.each(postRoutes.map((r) => [concrete(r.path), r.access]))("%s refuses a body that isn't JSON", async (path, access) => {
    const session = access === "admin" ? admin : member;
    const options = access === "public" ? {} : { cookie: session.cookie, csrf: session.csrf };
    for (const contentType of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", null]) {
      expect((await post(path, {}, { ...options, contentType })).status, String(contentType)).toBe(415);
    }
  });

  it.each(sessionPosts.map((r) => [concrete(r.path), r.access]))("%s refuses a missing or wrong CSRF token", async (path, access) => {
    const session = access === "admin" ? admin : member;
    expect((await post(path, {}, { cookie: session.cookie })).status).toBe(403);
    expect((await post(path, {}, { cookie: session.cookie, csrf: "wrong-token" })).status).toBe(403);
    const other = access === "admin" ? member : admin;
    expect((await post(path, {}, { cookie: session.cookie, csrf: other.csrf })).status).toBe(403);
  });
});

describe("logins are checked on every route", () => {
  it.each([...sessionGets, ...sessionPosts].map((r) => [r.method, concrete(r.path), r.access]))(
    "%s %s refuses no session and the other kind of session",
    async (method, path, access) => {
      const other = access === "admin" ? member : admin;
      const call = (/** @type {import("./helpers.js").CallOptions} */ options) => (method === "GET" ? get(path, options) : post(path, {}, options));
      const anonymous = await call({});
      expect(anonymous.status).toBe(401);
      expectHeaders(anonymous);
      expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
      expect((await call({ cookie: other.cookie, csrf: other.csrf })).status).toBe(401);
    },
  );
});

describe("request handling", () => {
  it("refuses an oversized body", async () => {
    const response = await post("/api/login", {}, { raw: JSON.stringify({ member_number: "x".repeat(MAX_BODY_BYTES) }) });
    expect(response.status).toBe(413);
  });

  it("refuses broken JSON and JSON that isn't an object", async () => {
    for (const raw of ["{not json", "[1,2]", "null", "\"text\""]) expect((await post("/api/login", {}, { raw })).status, raw).toBe(400);
  });

  it("answers unknown API paths with 404 and wrong methods with 405 + Allow", async () => {
    expect((await get("/api/does-not-exist")).status).toBe(404);
    const wrong = await get("/api/login");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("POST");
    expectHeaders(wrong);
  });

  it("refuses a Turnstile token longer than Cloudflare's maximum (2048)", async () => {
    const response = await post("/api/login", { member_number: "1", pin: "123456", turnstile_token: "x".repeat(2049) });
    expect(response.status).toBe(400);
  });
});

describe("security headers on every page", () => {
  const publicPages = ["/", "/rules", "/login", "/admin/login", "/admin/setup", "/no-such-page"];
  const memberPages = ["/app", "/book", "/events"];
  const adminPages = ["/admin/", "/admin/members", "/admin/schedule", "/admin/leagues", "/admin/resources", "/admin/events", "/admin/audit"];

  it.each([
    ...publicPages.map((p) => [p, "nobody"]),
    ...memberPages.map((p) => [p, "member"]),
    ...adminPages.map((p) => [p, "admin"]),
  ])("%s (as %s) has every header and the strict CSP", async (path, who) => {
    const session = who === "member" ? member : who === "admin" ? admin : null;
    const response = await get(path, session ? { cookie: session.cookie } : {});
    expect([200, 404]).toContain(response.status);
    expectHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
    if (who !== "nobody" || path.includes("login") || path.includes("setup")) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("the CSP allows no inline script, no other sites, and no framing", () => {
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|http:/);
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("default-src 'none'");
  });
});

describe("throttling also protects admin logins", () => {
  /** @param {string} ip @param {string} [code] */
  const badAdminLogin = (ip, code = "000000") => post("/api/admin/login", { username: "nobody-admin", password: "x".repeat(20), totp_code: code }, { ip });

  it("blocks an IP after too many failed admin logins", async () => {
    const ip = newIp();
    const limit = JSON.parse(env.THROTTLE_SETTINGS).ip_failures_per_hour;
    for (let i = 0; i < limit; i += 1) expect((await badAdminLogin(ip)).status).toBe(401);
    expect((await badAdminLogin(ip)).status).toBe(429);
    // Member logins from the same network are blocked too: the IP block is shared.
    expect((await post("/api/login", { member_number: "1", pin: "123456" }, { ip })).status).toBe(429);
  });

  it("puts admin logins through the flood gate", async () => {
    const ctx = createExecutionContext();
    const handler = /** @type {NonNullable<typeof worker.fetch>} */ (worker.fetch);
    const request = new Request(`${ORIGIN}/api/admin/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": newIp() },
      body: JSON.stringify({ username: "a", password: "b", totp_code: "123456" }),
    });
    const limiter = /** @type {RateLimit} */ (/** @type {unknown} */ ({ limit: vi.fn(async () => ({ success: false })) }));
    const response = await handler(/** @type {Request<unknown, IncomingRequestCfProperties>} */ (request), { ...env, LOGIN_LIMITER: limiter }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(429);
  });

  it("switches the alarm on for a slow attack over a day (the long window), and admin login then needs Turnstile", async () => {
    const settings = JSON.parse(env.THROTTLE_SETTINGS);
    // Spread out, so the short window never fills: all older than it, inside 24 hours.
    const old = nowSeconds() - (settings.alarm_short_minutes + 5) * 60;
    await db.batch(
      Array.from({ length: settings.alarm_long_failures - 1 }, (_, i) =>
        db.prepare("INSERT INTO login_failures (at, kind, ip_hash) VALUES (?, 'member', ?)").bind(old - i * 60, `spread-${i}`),
      ),
    );
    expect((await (await get("/api/login-status")).json()).alarm).toBe(false);
    await post("/api/login", { member_number: "nobody", pin: "000000" }, { ip: newIp() });
    expect((await (await get("/api/login-status")).json()).alarm).toBe(true);
    const log = await db.prepare("SELECT details FROM audit_log WHERE action = 'login_alarm.on' ORDER BY id DESC LIMIT 1").first();
    expect(JSON.parse(String(log?.details)).window).toBe("long");
    const response = await badAdminLogin(newIp());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("turnstile_required");
  });

  it("keeps the alarm on while failures continue (it holds after the last crossing)", async () => {
    const settings = JSON.parse(env.THROTTLE_SETTINGS);
    for (let i = 0; i < settings.alarm_short_failures; i += 1) await post("/api/login", { member_number: `n${i}`, pin: "000000" }, { ip: newIp() });
    const first = Number((await db.prepare("SELECT value FROM system_state WHERE key = 'login_alarm_until'").first())?.value);
    expect(first).toBeGreaterThan(nowSeconds());
    // Pretend the hold is nearly over, then another failure with a valid Turnstile check extends it.
    await db.prepare("UPDATE system_state SET value = ? WHERE key = 'login_alarm_until'").bind(String(nowSeconds() + 5)).run();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      String(input instanceof Request ? input.url : input).includes("siteverify")
        ? new Response(JSON.stringify({ success: true }))
        : realFetch(input, init),
    );
    const ctx = createExecutionContext();
    const handler = /** @type {NonNullable<typeof worker.fetch>} */ (worker.fetch);
    const request = new Request(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": newIp() },
      body: JSON.stringify({ member_number: "nobody", pin: "000000", turnstile_token: "ok" }),
    });
    expect((await handler(/** @type {Request<unknown, IncomingRequestCfProperties>} */ (request), env, ctx)).status).toBe(401);
    await waitOnExecutionContext(ctx);
    vi.restoreAllMocks();
    const extended = Number((await db.prepare("SELECT value FROM system_state WHERE key = 'login_alarm_until'").first())?.value);
    expect(extended).toBeGreaterThanOrEqual(nowSeconds() + settings.alarm_hold_minutes * 60 - 5);
    const entries = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login_alarm.on'").first();
    expect(entries?.n).toBe(2); // the long-window test above, and this one; extending adds none
  });
});

describe("admin alarm switch", () => {
  it("turns the alarm on (Turnstile required) and off, both logged", async () => {
    expect((await (await admin.post("/api/admin/alarm", { on: true })).json()).on).toBe(true);
    expect((await (await get("/api/login-status")).json()).alarm).toBe(true);
    expect((await get("/login")).headers.get("Content-Security-Policy")).toContain("https://challenges.cloudflare.com");
    const me = await (await admin.get("/api/admin/me")).json();
    expect(me.alarm_history[0].window).toBe("manual");
    expect((await admin.post("/api/admin/alarm", { on: false })).status).toBe(200);
    expect((await (await get("/api/login-status")).json()).alarm).toBe(false);
    const log = await db.prepare("SELECT action FROM audit_log WHERE action IN ('login_alarm.manual_on', 'login_alarm.off') ORDER BY id").all();
    expect(log.results.map((r) => r.action)).toEqual(["login_alarm.manual_on", "login_alarm.off"]);
    expect((await admin.post("/api/admin/alarm", { on: "yes" })).status).toBe(400);
  });
});
