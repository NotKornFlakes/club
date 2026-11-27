// @ts-check
// Member login: PIN + pepper, sessions, logout, lockouts, per-IP block, flood gate,
// club-wide alarm with Turnstile, and refusing to run without its settings.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { sha256Hex } from "../src/crypto.js";
import {
  ORIGIN,
  cookieFrom,
  db,
  get,
  loginMember,
  makeMember,
  newIp,
  nowSeconds,
  post,
  resetThrottle,
} from "./helpers.js";

/** @param {string} number @param {string} pin @param {string} [ip] */
const tryLogin = (number, pin, ip = newIp()) => post("/api/login", { member_number: number, pin }, { ip });

/** @param {Response} response */
async function errorOf(response) {
  return /** @type {{ error: string, message: string }} */ (await response.json()).error;
}

/**
 * Calls the Worker directly with a changed environment (missing settings, stub bindings).
 * @param {Request} request @param {Partial<Env>} changes
 */
async function callWith(request, changes) {
  const ctx = createExecutionContext();
  const handler = /** @type {NonNullable<typeof worker.fetch>} */ (worker.fetch);
  const incoming = /** @type {Request<unknown, IncomingRequestCfProperties>} */ (request);
  const response = await handler(incoming, /** @type {Env} */ ({ ...env, ...changes }), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** @param {string} number @param {string} pin @param {string} ip @param {string} [token] */
function loginRequest(number, pin, ip, token) {
  /** @type {Record<string, string>} */
  const body = { member_number: number, pin };
  if (token) body.turnstile_token = token;
  return new Request(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(resetThrottle);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("logging in", () => {
  it("works with the right member number and PIN, and sets a strict session cookie", async () => {
    const member = await makeMember({ pin: "246810" });
    const response = await tryLogin(member.number, "246810");
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; /);
    for (const part of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=2592000"]) {
      expect(setCookie).toContain(part);
    }
  });

  it("stores only a hash of the session token, with a 30-day expiry", async () => {
    const member = await makeMember();
    const response = await tryLogin(member.number, member.pin);
    const token = cookieFrom(response).split("=")[1] ?? "";
    const row = await db.prepare("SELECT * FROM member_sessions WHERE member_id = ?").bind(member.id).first();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.token_hash).not.toBe(token);
    expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(30 * 86_400);
  });

  it("gives /api/me the member number and a CSRF token, and never caches it", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    const response = await session.get("/api/me");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const me = await response.json();
    expect(me).toEqual({ member_number: member.number, csrf_token: session.csrf });
    expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same answer for a wrong PIN, an unknown number and a disabled member", async () => {
    const member = await makeMember();
    const disabled = await makeMember({ status: "disabled" });
    const answers = await Promise.all([
      tryLogin(member.number, "000000"),
      tryLogin("NO-SUCH-MEMBER", "000000"),
      tryLogin(disabled.number, disabled.pin),
    ]);
    const bodies = await Promise.all(answers.map((r) => r.json()));
    expect(answers.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("refuses badly formed input without counting it as a try", async () => {
    const member = await makeMember();
    for (const pin of ["12345", "1234567", "abcdef"]) {
      expect((await tryLogin(member.number, pin)).status).toBe(400);
    }
    const row = await db.prepare("SELECT failed_logins FROM members WHERE id = ?").bind(member.id).first();
    expect(row?.failed_logins).toBe(0);
  });

  it("refuses unknown fields", async () => {
    const member = await makeMember();
    const response = await post("/api/login", { member_number: member.number, pin: member.pin, admin: true });
    expect(response.status).toBe(400);
  });
});

describe("sessions and logout", () => {
  it("logout ends the session and clears the cookie", async () => {
    const session = await loginMember(await makeMember());
    const response = await session.post("/api/logout");
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session=; .*Max-Age=0/);
    expect((await session.get("/api/me")).status).toBe(401);
  });

  it("an expired session no longer works", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    await db.prepare("UPDATE member_sessions SET expires_at = ? WHERE member_id = ?").bind(nowSeconds() - 1, member.id).run();
    expect((await session.get("/api/me")).status).toBe(401);
  });

  it("a disabled member is logged out at once", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    await db.prepare("UPDATE members SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    expect((await session.get("/api/me")).status).toBe(401);
  });

  it("a made-up or tampered cookie is refused", async () => {
    expect((await get("/api/me", { cookie: "__Host-session=not-a-real-token" })).status).toBe(401);
    expect((await get("/api/me", { cookie: `__Host-session=${"A".repeat(43)}` })).status).toBe(401);
  });
});

describe("private pages", () => {
  it("send logged-out visitors to the login page", async () => {
    const response = await get("/app");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/login`);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("open for a logged-in member, and are never cached", async () => {
    const session = await loginMember(await makeMember());
    const response = await session.get("/app");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You're logged in as member");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("the login page and home page are public", async () => {
    expect((await get("/login")).status).toBe(200);
    expect(await (await get("/")).text()).toContain('href="/login"');
  });
});

describe("lockouts (5 tries; 15 min, 1 hour, 24 hours)", () => {
  /** @param {{ id: number, number: string }} member */
  async function failFive(member) {
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await tryLogin(member.number, "000000"));
    return answers;
  }

  /** @param {number} id */
  const lockState = (id) => db.prepare("SELECT lock_level, locked_until, failed_logins FROM members WHERE id = ?").bind(id).first();

  /** @param {number} id */
  const expireLock = (id) => db.prepare("UPDATE members SET locked_until = ? WHERE id = ?").bind(nowSeconds() - 1, id).run();

  it("locks for 15 minutes after 5 wrong PINs, even against the right PIN", async () => {
    const member = await makeMember();
    const answers = await failFive(member);
    expect(answers.slice(0, 4).map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(answers[4]?.status).toBe(423);
    const state = await lockState(member.id);
    expect(state?.lock_level).toBe(1);
    expect(Number(state?.locked_until) - nowSeconds()).toBeGreaterThan(14 * 60);
    expect(Number(state?.locked_until) - nowSeconds()).toBeLessThanOrEqual(15 * 60);

    const right = await tryLogin(member.number, member.pin);
    expect(right.status).toBe(423);
    expect(await errorOf(right)).toBe("locked");
  });

  it("escalates to 1 hour, then 24 hours, and stays at 24 hours", async () => {
    const member = await makeMember();
    const expected = [15 * 60, 3600, 86_400, 86_400];
    for (const seconds of expected) {
      await failFive(member);
      await resetThrottle(); // keep the per-IP block and alarm out of this test
      const state = await lockState(member.id);
      const length = Number(state?.locked_until) - nowSeconds();
      expect(length).toBeGreaterThan(seconds - 60);
      expect(length).toBeLessThanOrEqual(seconds);
      await expireLock(member.id);
    }
  });

  it("a successful login resets the count and the level", async () => {
    const member = await makeMember();
    await failFive(member);
    await expireLock(member.id);
    await tryLogin(member.number, "000000");
    expect((await tryLogin(member.number, member.pin)).status).toBe(200);
    expect(await lockState(member.id)).toEqual({ lock_level: 0, locked_until: null, failed_logins: 0 });
  });

  it("7 days without failures resets the level", async () => {
    const member = await makeMember();
    await failFive(member);
    await db
      .prepare("UPDATE members SET locked_until = ?, last_failed_at = ? WHERE id = ?")
      .bind(nowSeconds() - 8 * 86_400, nowSeconds() - 8 * 86_400, member.id)
      .run();
    await resetThrottle();
    await failFive(member);
    expect((await lockState(member.id))?.lock_level).toBe(1);
  });

  it("parallel tries can't get past 5 before the lock", async () => {
    const member = await makeMember();
    const answers = await Promise.all(Array.from({ length: 8 }, () => tryLogin(member.number, "000000")));
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(statuses.filter((s) => s === 423)).toHaveLength(4);
    const failures = await db.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE member_id = ?").bind(member.id).first();
    expect(failures?.n).toBe(5); // only 5 PINs were actually checked
  });
});

describe("per-IP block", () => {
  it("blocks an IP after too many failures in an hour, even with a right PIN; other IPs still work", async () => {
    const ip = newIp();
    const members = await Promise.all(Array.from({ length: 9 }, () => makeMember()));
    // One wrong PIN each for 8 different members (the test limit), all from one IP.
    for (const member of members.slice(0, 8)) expect((await tryLogin(member.number, "000000", ip)).status).toBe(401);
    const last = /** @type {{ number: string, pin: string }} */ (members[8]);
    const blocked = await tryLogin(last.number, last.pin, ip);
    expect(blocked.status).toBe(429);
    expect(await errorOf(blocked)).toBe("ip_blocked");
    expect((await tryLogin(last.number, last.pin, newIp())).status).toBe(200);
  });

  it("counts a whole IPv6 /64 together", async () => {
    const members = await Promise.all(Array.from({ length: 9 }, () => makeMember()));
    for (const [i, member] of members.slice(0, 8).entries()) {
      await tryLogin(member.number, "000000", `2001:db8:aa:bb::${i + 1}`);
    }
    const last = /** @type {{ number: string, pin: string }} */ (members[8]);
    expect((await tryLogin(last.number, last.pin, "2001:db8:aa:bb:ffff::1")).status).toBe(429);
  });

  it("stores IPs only as HMACs, never the raw address", async () => {
    const member = await makeMember();
    await tryLogin(member.number, "000000", "192.0.2.55");
    const row = await db.prepare("SELECT ip_hash FROM login_failures WHERE member_id = ?").bind(member.id).first();
    expect(String(row?.ip_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row?.ip_hash)).not.toBe(await sha256Hex("192.0.2.55"));
  });
});

describe("flood gate", () => {
  it("drops a burst before any database or hashing work", async () => {
    const member = await makeMember();
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const response = await callWith(loginRequest(member.number, "000000", newIp()), {
      LOGIN_LIMITER: /** @type {RateLimit} */ (/** @type {unknown} */ (limiter)),
    });
    expect(response.status).toBe(429);
    expect(await errorOf(response)).toBe("slow_down");
    expect(limiter.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const failures = await db.prepare("SELECT COUNT(*) AS n FROM login_failures").first();
    expect(failures?.n).toBe(0);
  });
});

describe("club-wide alarm", () => {
  /** Enough failures, from different IPs and members, to cross the short-window limit. */
  async function setOffAlarm() {
    const threshold = JSON.parse(env.THROTTLE_SETTINGS).alarm_short_failures;
    for (let i = 0; i < threshold; i += 1) await tryLogin(`NOBODY-${i}`, "000000");
  }

  it("is off normally, and the login page has the strict CSP", async () => {
    expect(await (await get("/api/login-status")).json()).toEqual({ alarm: false, turnstile_site_key: null });
    expect((await get("/login")).headers.get("Content-Security-Policy")).not.toContain("challenges.cloudflare.com");
  });

  it("switches on when failures spike, once in the audit log, and requires Turnstile", async () => {
    await setOffAlarm();
    await tryLogin("NOBODY-extra", "000000"); // still on: no second audit entry
    expect(await (await get("/api/login-status")).json()).toEqual({ alarm: true, turnstile_site_key: env.TURNSTILE_SITE_KEY });
    const audit = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login_alarm.on'").first();
    expect(audit?.n).toBe(1);

    const member = await makeMember();
    const response = await tryLogin(member.number, member.pin);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "turnstile_required", turnstile_site_key: env.TURNSTILE_SITE_KEY });
  });

  it("lets the login page load Turnstile only while it's on", async () => {
    await setOffAlarm();
    for (const path of ["/login", "/login.html"]) {
      const csp = (await get(path)).headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
      expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    }
    expect((await get("/")).headers.get("Content-Security-Policy")).not.toContain("challenges.cloudflare.com");
  });

  it("accepts a login with a passing Turnstile check, and refuses a failing one", async () => {
    await setOffAlarm();
    const member = await makeMember();
    const realFetch = globalThis.fetch;
    const verify = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") return realFetch(input, init);
      const form = /** @type {FormData} */ (init?.body);
      const ok = form.get("response") === "good-token" && form.get("secret") === env.TURNSTILE_SECRET;
      return new Response(JSON.stringify({ success: ok }), { headers: { "Content-Type": "application/json" } });
    });

    const bad = await callWith(loginRequest(member.number, member.pin, newIp(), "bad-token"), {});
    expect(bad.status).toBe(403);
    expect(await errorOf(bad)).toBe("turnstile_failed");

    const good = await callWith(loginRequest(member.number, member.pin, newIp(), "good-token"), {});
    expect(good.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("switches off by itself after the hold time", async () => {
    await setOffAlarm();
    await db.prepare("UPDATE system_state SET value = ? WHERE key = 'login_alarm_until'").bind(String(nowSeconds() - 1)).run();
    expect((await (await get("/api/login-status")).json()).alarm).toBe(false);
  });
});

describe("missing or broken settings", () => {
  it.each([
    ["THROTTLE_SETTINGS missing", { THROTTLE_SETTINGS: "" }],
    ["THROTTLE_SETTINGS not JSON", { THROTTLE_SETTINGS: "{oops" }],
    ["THROTTLE_SETTINGS missing a key", { THROTTLE_SETTINGS: JSON.stringify({ ip_failures_per_hour: 5 }) }],
    [
      "THROTTLE_SETTINGS with a zero",
      { THROTTLE_SETTINGS: JSON.stringify({ ...JSON.parse(env.THROTTLE_SETTINGS), alarm_delay_ms: 0 }) },
    ],
    ["PEPPER missing", { PEPPER: "" }],
    ["IP_HASH_KEY too short", { IP_HASH_KEY: "short" }],
  ])("refuse logins when %s", async (_label, changes) => {
    const member = await makeMember();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await callWith(loginRequest(member.number, member.pin, newIp()), changes);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "unavailable",
      message: "Login is temporarily unavailable. Please try again later.",
    });
    // The log names the problem but never a value.
    expect(String(errors.mock.calls[0]?.[1])).not.toMatch(/\d/);
  });
});

describe("CSRF protection on login and logout", () => {
  it("refuses a login from another site, with no Origin, or not as JSON", async () => {
    const member = await makeMember();
    const body = { member_number: member.number, pin: member.pin };
    expect((await post("/api/login", body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/login", body, { origin: null })).status).toBe(403);
    expect((await post("/api/login", body, { contentType: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post("/api/login", body, { contentType: "text/plain" })).status).toBe(415);
  });

  it("refuses a logout without the session's CSRF token", async () => {
    const session = await loginMember(await makeMember());
    expect((await post("/api/logout", {}, { cookie: session.cookie })).status).toBe(403);
    expect((await post("/api/logout", {}, { cookie: session.cookie, csrf: "wrong" })).status).toBe(403);
    expect((await session.get("/api/me")).status).toBe(200); // still logged in
  });
});
