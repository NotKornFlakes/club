// @ts-check
// Admin login: password + authenticator code, codes used once, lockouts, separate 12-hour
// cookie, first-time setup, and resetting the other admin.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto.js";
import {
  ORIGIN,
  cookieFrom,
  db,
  get,
  loginAdmin,
  loginMember,
  makeAdmin,
  makeMember,
  newIp,
  post,
  resetThrottle,
  totpNow,
} from "./helpers.js";

/** @param {{ username: string, password: string }} admin @param {string} code */
const tryLogin = (admin, code) =>
  post("/api/admin/login", { username: admin.username, password: admin.password, totp_code: code }, { ip: newIp() });

beforeEach(resetThrottle);

describe("admin login", () => {
  it("needs the password and the current code, and sets a separate 12-hour cookie", async () => {
    const admin = await makeAdmin();
    const response = await tryLogin(admin, await totpNow(admin.totpSecret));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-admin=[A-Za-z0-9_-]{43}; /);
    for (const part of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=43200"]) expect(setCookie).toContain(part);
    const token = cookieFrom(response).split("=")[1] ?? "";
    const row = await db.prepare("SELECT token_hash, expires_at - created_at AS length FROM admin_sessions WHERE admin_id = ?").bind(admin.id).first();
    expect(row).toEqual({ token_hash: await sha256Hex(token), length: 12 * 3600 });
  });

  it("refuses a wrong password, a wrong code, or an unknown admin, all the same way", async () => {
    const admin = await makeAdmin();
    const code = await totpNow(admin.totpSecret);
    const answers = await Promise.all([
      tryLogin({ ...admin, password: "wrong password, long enough" }, code),
      tryLogin(admin, code === "000000" ? "111111" : "000000"),
      tryLogin({ ...admin, username: "nobody-here" }, code),
    ]);
    expect(answers.map((r) => r.status)).toEqual([401, 401, 401]);
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);
  });

  it("accepts each code only once", async () => {
    const admin = await makeAdmin();
    const code = await totpNow(admin.totpSecret);
    expect((await tryLogin(admin, code)).status).toBe(200);
    expect((await tryLogin(admin, code)).status).toBe(401);
  });

  it("locks after 5 wrong tries, with its own counter", async () => {
    const admin = await makeAdmin();
    for (let i = 0; i < 4; i += 1) expect((await tryLogin({ ...admin, password: "x".repeat(20) }, "000000")).status).toBe(401);
    expect((await tryLogin({ ...admin, password: "x".repeat(20) }, "000000")).status).toBe(423);
    expect((await tryLogin(admin, await totpNow(admin.totpSecret))).status).toBe(423);
  });

  it("member and admin sessions don't open each other's doors", async () => {
    const member = await loginMember(await makeMember());
    const admin = await loginAdmin(await makeAdmin());
    expect((await member.get("/api/admin/me")).status).toBe(401);
    expect((await member.get("/api/admin/members")).status).toBe(401);
    expect((await admin.get("/api/me")).status).toBe(401);
  });

  it("logs each admin login in the audit log", async () => {
    const admin = await makeAdmin();
    await loginAdmin(admin);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.login' AND admin_id = ?").bind(admin.id).first();
    expect(row?.n).toBe(1);
  });

  it("logout ends the admin session", async () => {
    const admin = await loginAdmin(await makeAdmin());
    expect((await admin.post("/api/admin/logout")).status).toBe(200);
    expect((await admin.get("/api/admin/me")).status).toBe(401);
  });
});

describe("admin pages", () => {
  it("send logged-out visitors to the admin login page", async () => {
    for (const path of ["/admin/", "/admin/members", "/admin/audit"]) {
      const response = await get(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("Location")).toBe(`${ORIGIN}/admin/login`);
    }
  });

  it("are not opened by a member login", async () => {
    const member = await loginMember(await makeMember());
    expect((await member.get("/admin/members")).status).toBe(302);
  });

  it("open for an admin, never cached", async () => {
    const admin = await loginAdmin(await makeAdmin());
    const response = await admin.get("/admin/members");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("the admin login and setup pages are public", async () => {
    expect((await get("/admin/login")).status).toBe(200);
    expect((await get("/admin/setup")).status).toBe(200);
  });
});

describe("the club-wide alarm on the admin page", () => {
  it("shows on, with its history, once failures spike", async () => {
    const admin = await loginAdmin(await makeAdmin());
    expect((await (await admin.get("/api/admin/me")).json()).alarm.on).toBe(false);
    const threshold = JSON.parse(env.THROTTLE_SETTINGS).alarm_short_failures;
    for (let i = 0; i < threshold; i += 1) {
      await post("/api/login", { member_number: `NOBODY-${i}`, pin: "000000" }, { ip: newIp() });
    }
    const me = await (await admin.get("/api/admin/me")).json();
    expect(me.alarm.on).toBe(true);
    expect(me.alarm_history[0]).toMatchObject({ window: "short" });
    expect(me.failed_logins.last_hour).toBeGreaterThanOrEqual(threshold);
  });
});
