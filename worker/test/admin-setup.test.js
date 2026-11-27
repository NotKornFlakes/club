// @ts-check
// First-time admin setup (needs ADMIN_SETUP_TOKEN and fewer than 2 admins), and one admin
// resetting the other's login. Its own file, so it starts with an empty admins table.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { base32Decode, totpCode, totpStep } from "../src/totp.js";
import { ORIGIN, db, newIp, nowSeconds, post, resetThrottle } from "./helpers.js";

const TOKEN = env.ADMIN_SETUP_TOKEN;
const PASSWORD = "a long enough admin password";

/** @param {string} secret @param {number} [offset] */
async function codeFor(secret, offset = 0) {
  return totpCode(/** @type {Uint8Array<ArrayBuffer>} */ (base32Decode(secret)), totpStep(nowSeconds()) + offset);
}

/** @param {string} username @returns {Promise<{ secret: string, response: Response }>} */
async function enrol(username) {
  const start = await (await post("/api/admin/setup/start", { setup_token: TOKEN }, { ip: newIp() })).json();
  const response = await post(
    "/api/admin/setup",
    { setup_token: TOKEN, username, password: PASSWORD, totp_secret: start.totp_secret, totp_code: await codeFor(start.totp_secret) },
    { ip: newIp() },
  );
  return { secret: start.totp_secret, response };
}

/** @param {string} username @param {string} password @param {string} code */
const login = (username, password, code) => post("/api/admin/login", { username, password, totp_code: code }, { ip: newIp() });

beforeEach(resetThrottle);

describe("first-time setup", () => {
  it("refuses a wrong setup token, and counts it as a failed admin login", async () => {
    const response = await post("/api/admin/setup/start", { setup_token: "wrong-token" }, { ip: newIp() });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("wrong_token");
    const failures = await db.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE kind = 'admin'").first();
    expect(failures?.n).toBe(1);
  });

  it("is closed when the ADMIN_SETUP_TOKEN secret has been deleted", async () => {
    const ctx = createExecutionContext();
    const handler = /** @type {NonNullable<typeof worker.fetch>} */ (worker.fetch);
    const request = new Request(`${ORIGIN}/api/admin/setup/start`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": newIp() },
      body: JSON.stringify({ setup_token: TOKEN }),
    });
    const response = await handler(
      /** @type {Request<unknown, IncomingRequestCfProperties>} */ (request),
      /** @type {Env} */ ({ ...env, ADMIN_SETUP_TOKEN: "" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("setup_closed");
  });

  it("hands out a new authenticator key as text and as an otpauth:// link", async () => {
    const body = await (await post("/api/admin/setup/start", { setup_token: TOKEN }, { ip: newIp() })).json();
    expect(body.totp_secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauth_uri).toContain(`secret=${body.totp_secret}`);
  });

  it("refuses a short password or a code that doesn't match the key", async () => {
    const start = await (await post("/api/admin/setup/start", { setup_token: TOKEN }, { ip: newIp() })).json();
    const base = { setup_token: TOKEN, username: "someone", totp_secret: start.totp_secret };
    const short = await post("/api/admin/setup", { ...base, password: "too short", totp_code: await codeFor(start.totp_secret) });
    expect((await short.json()).error).toBe("weak_password");
    const wrong = await post("/api/admin/setup", { ...base, password: PASSWORD, totp_code: "000000" });
    expect(wrong.status).toBe(400);
  });

  it("enrols two admins who can then log in, then closes", async () => {
    const first = await enrol("owner");
    expect(first.response.status).toBe(201);
    // The setup code is used up; the next one works.
    expect((await login("owner", PASSWORD, await codeFor(first.secret))).status).toBe(401);
    expect((await login("owner", PASSWORD, await codeFor(first.secret, 1))).status).toBe(200);

    expect((await enrol("backup")).response.status).toBe(201);
    const third = await post("/api/admin/setup/start", { setup_token: TOKEN }, { ip: newIp() });
    expect(third.status).toBe(403);
    expect((await third.json()).error).toBe("setup_closed");

    const audit = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.enrol'").first();
    expect(audit?.n).toBe(2);
  });
});

describe("resetting the other admin", () => {
  it("gives them a new password and key once, logs them out, and can't be done to yourself", async () => {
    await db.prepare("UPDATE admins SET totp_last_step = 0").run();
    const owner = await db.prepare("SELECT id, totp_secret_enc FROM admins WHERE username = 'owner'").first();
    const backup = await db.prepare("SELECT id FROM admins WHERE username = 'backup'").first();
    // Log the owner in with a fresh code (the helpers don't know their key, so read it back).
    const { decryptText, pepperKeys } = await import("../src/crypto.js");
    const ownerSecret = await decryptText(String(owner?.totp_secret_enc), await pepperKeys(env.PEPPER));
    const ownerLogin = await login("owner", PASSWORD, await codeFor(ownerSecret));
    const cookie = (ownerLogin.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const me = await (await post("/api/admin/logout", {}, { cookie, csrf: "x" })).status;
    expect(me).toBe(403); // wrong CSRF token: nothing happens
    const csrf = (await (await (await import("./helpers.js")).get("/api/admin/me", { cookie })).json()).csrf_token;

    // The backup admin has a session that must end.
    await db
      .prepare("INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, created_at, expires_at) VALUES ('old', ?, 'c', ?, ?)")
      .bind(backup?.id, nowSeconds(), nowSeconds() + 3600)
      .run();

    const reset = await post(`/api/admin/admins/${backup?.id}/reset`, {}, { cookie, csrf });
    expect(reset.status).toBe(200);
    const creds = await reset.json();
    expect(creds.password.length).toBeGreaterThanOrEqual(16);
    expect(creds.totp_secret).toMatch(/^[A-Z2-7]{32}$/);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_id = ?").bind(backup?.id).first())?.n).toBe(0);
    expect((await login("backup", creds.password, await codeFor(creds.totp_secret))).status).toBe(200);
    expect((await login("backup", PASSWORD, await codeFor(creds.totp_secret, 1))).status).toBe(401);

    const self = await post(`/api/admin/admins/${owner?.id}/reset`, {}, { cookie, csrf });
    expect(self.status).toBe(400);
  });
});
