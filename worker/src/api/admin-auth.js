// @ts-check
// Admin login (username + strong password + 6-digit authenticator code), first-time setup,
// logout, and the admin "who am I" with the club-wide alarm status.
// Admin logins go through the same throttling as members, with their own lockout counters.

import { auditEntry } from "../audit.js";
import { CLUB } from "../club.js";
import { decryptText, encryptText, hashIp, hashRounds, hashSecret, pepperKeys, textEqual, verifyDummy, verifySecret } from "../crypto.js";
import { HttpError, clientIp, json } from "../http.js";
import { ADMIN_COOKIE, clearCookie, createAdminSession } from "../sessions.js";
import { throttleSettings } from "../settings.js";
import { ALARM_KEY, alarmUntil, claimAttempt, clearLock, guardLogin, lockedError, lockedUntil, recordFailure } from "../throttle.js";
import { newTotpSecret, otpauthUri, verifyTotp } from "../totp.js";
import { bool, onlyFields, optionalStr, str } from "../validate.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,40}$/;
export const MIN_PASSWORD_LENGTH = 16;
/** How many admins setup allows (club settings; 2 unless the club says otherwise). */
export const MAX_ADMINS = CLUB.max_admins;
/** The name authenticator apps show next to the code. */
const ISSUER = `${CLUB.name} admin`;
const WRONG = "That username, password and code don't match. Please check them and try again.";

/** @param {Record<string, unknown>} body */
function password(body) {
  const value = str(body, "password", { max: 200, label: "the password", trim: false });
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, "weak_password", `The password must be at least ${MIN_PASSWORD_LENGTH} characters. Use your password manager.`);
  }
  return value;
}

/** Throttling shared by every admin login-like request. @param {Ctx} ctx */
async function guard(ctx) {
  const settings = throttleSettings(ctx.env.THROTTLE_SETTINGS);
  const keys = await pepperKeys(ctx.env.PEPPER);
  const ipHash = await hashIp(clientIp(ctx.request), ctx.env.IP_HASH_KEY);
  const turnstileToken = optionalStr(ctx.body, "turnstile_token", { max: 2048 });
  await guardLogin({ env: ctx.env, ipHash, settings, now: ctx.now, turnstileToken });
  return { settings, keys, ipHash };
}

/**
 * Setup works only while the ADMIN_SETUP_TOKEN secret exists and fewer than 2 admins exist.
 * A wrong token counts as a failed admin login.
 * @param {Ctx} ctx @param {{ settings: import("../settings.js").ThrottleSettings, ipHash: string }} throttle
 */
async function checkSetupToken(ctx, { settings, ipHash }) {
  const expected = ctx.env.ADMIN_SETUP_TOKEN;
  const count = Number((await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM admins").first())?.n ?? 0);
  if (typeof expected !== "string" || expected.length < 32 || count >= MAX_ADMINS) {
    throw new HttpError(403, "setup_closed", "Admin setup is closed. An existing admin can reset an admin's login.");
  }
  const token = str(ctx.body, "setup_token", { max: 200, label: "the setup token" });
  if (!textEqual(token, expected)) {
    await recordFailure({ db: ctx.env.DB, kind: "admin", ipHash, memberId: null, settings, now: ctx.now });
    throw new HttpError(403, "wrong_token", "That setup token is wrong.");
  }
}

/** Step 1: check the token and hand out a new authenticator key (not stored yet). @param {Ctx} ctx */
async function setupStart(ctx) {
  onlyFields(ctx.body, ["setup_token", "turnstile_token"]);
  await checkSetupToken(ctx, await guard(ctx));
  const secret = newTotpSecret();
  return json({ totp_secret: secret, otpauth_uri: otpauthUri(secret, "admin", ISSUER) });
}

/** Step 2: choose a username and password, and prove the authenticator works. @param {Ctx} ctx */
async function setupFinish(ctx) {
  const { body, env, now } = ctx;
  onlyFields(body, ["setup_token", "username", "password", "totp_secret", "totp_code", "turnstile_token"]);
  const throttle = await guard(ctx);
  await checkSetupToken(ctx, throttle);
  const username = str(body, "username", { max: 40, pattern: USERNAME_PATTERN, label: "the username (3 to 40 letters, numbers, dots, dashes)" });
  const pass = password(body);
  const secret = str(body, "totp_secret", { max: 64, pattern: /^[A-Z2-7]{32}$/, label: "the key" });
  const code = str(body, "totp_code", { max: 6, label: "the 6-digit code" });
  const step = await verifyTotp(secret, code, now, 0);
  if (step === null) {
    throw new HttpError(400, "wrong_code", "That code doesn't match. Check the key in your authenticator app and try the newest code.");
  }
  const existing = await env.DB.prepare("SELECT id FROM admins WHERE username = ?").bind(username).first();
  if (existing) throw new HttpError(409, "username_taken", "That username is taken. Please choose another.");
  const [created] = /** @type {D1Result<Record<string, unknown>>[]} */ (
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO admins (username, password_hash, totp_secret_enc, totp_last_step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(username, await hashSecret(pass, throttle.keys, hashRounds(env)), await encryptText(secret, throttle.keys), step, now, now),
      auditEntry(env.DB, { at: now, adminId: null, action: "admin.enrol", target: `admin:${username}` }),
    ])
  );
  return json({ ok: true, admin_id: Number(created?.results[0]?.id) }, 201);
}

/** @param {Ctx} ctx */
async function login(ctx) {
  const { body, env, now } = ctx;
  onlyFields(body, ["username", "password", "totp_code", "turnstile_token"]);
  const username = str(body, "username", { max: 40, label: "your username" });
  const pass = str(body, "password", { max: 200, label: "your password", trim: false });
  const code = str(body, "totp_code", { max: 6, label: "the 6-digit code" });
  const { settings, keys, ipHash } = await guard(ctx);
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "bad_input", "Please enter the 6-digit code from your authenticator app.");

  const admin = await env.DB.prepare("SELECT id, password_hash, totp_secret_enc, totp_last_step, status FROM admins WHERE username = ?")
    .bind(username)
    .first();
  if (!admin || admin.status !== "active") {
    await verifyDummy(pass, keys, hashRounds(env));
    await recordFailure({ db: env.DB, kind: "admin", ipHash, memberId: null, settings, now });
    throw new HttpError(401, "wrong", WRONG);
  }
  const adminId = Number(admin.id);
  const claim = await claimAttempt(env.DB, "admin", adminId, now);
  if (!claim) throw lockedError((await lockedUntil(env.DB, "admin", adminId)) ?? now);

  const passwordOk = await verifySecret(pass, String(admin.password_hash), keys, hashRounds(env));
  const step = passwordOk
    ? await verifyTotp(await decryptText(String(admin.totp_secret_enc), keys), code, now, Number(admin.totp_last_step))
    : null;
  // A code can be used once: only one request can move totp_last_step past it.
  const fresh =
    step !== null &&
    (await env.DB.prepare("UPDATE admins SET totp_last_step = ? WHERE id = ? AND totp_last_step < ? RETURNING id")
      .bind(step, adminId, step)
      .first());
  if (!fresh) {
    await recordFailure({ db: env.DB, kind: "admin", ipHash, memberId: null, settings, now });
    if (claim.lockedUntil) throw lockedError(claim.lockedUntil);
    throw new HttpError(401, "wrong", WRONG);
  }

  await clearLock(env.DB, "admin", adminId, now);
  const cookie = await createAdminSession(env.DB, adminId, now);
  await auditEntry(env.DB, { at: now, adminId, action: "admin.login", target: `admin:${username}` }).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

/** @param {Ctx} ctx */
async function logout(ctx) {
  if (ctx.admin) await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(ctx.admin.tokenHash).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(ADMIN_COOKIE) });
}

/** The admin, their CSRF token, and the club-wide alarm (with its recent history). @param {Ctx} ctx */
async function me(ctx) {
  const admin = /** @type {import("../sessions.js").AdminSession} */ (ctx.admin);
  const until = await alarmUntil(ctx.env.DB, ctx.now);
  const { results } = await ctx.env.DB.prepare(
    "SELECT at, action, details FROM audit_log WHERE action IN ('login_alarm.on', 'login_alarm.manual_on') ORDER BY at DESC LIMIT 10",
  ).all();
  const failures = await ctx.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM login_failures WHERE at > ?1) AS hour, (SELECT COUNT(*) FROM login_failures WHERE at > ?2) AS day",
  )
    .bind(ctx.now - 3600, ctx.now - 86_400)
    .first();
  return json({
    username: admin.username,
    csrf_token: admin.csrfToken,
    alarm: { on: until !== null, until },
    alarm_history: results.map((r) => ({
      at: Number(r.at),
      window: r.action === "login_alarm.manual_on" ? "manual" : String(JSON.parse(String(r.details)).window),
    })),
    failed_logins: { last_hour: Number(failures?.hour ?? 0), last_day: Number(failures?.day ?? 0) },
  });
}

/**
 * Turns the club-wide alarm on now (for the usual hold time) or off early. Useful to test
 * Turnstile on the live site, or to act on an attack before it crosses the limits.
 * @param {Ctx} ctx
 */
async function setAlarm(ctx) {
  onlyFields(ctx.body, ["on"]);
  const on = bool(ctx.body, "on");
  const settings = throttleSettings(ctx.env.THROTTLE_SETTINGS);
  const until = on ? ctx.now + settings.alarm_hold_minutes * 60 : ctx.now;
  const adminId = /** @type {import("../sessions.js").AdminSession} */ (ctx.admin).adminId;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(ALARM_KEY, String(until), ctx.now),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId, action: on ? "login_alarm.manual_on" : "login_alarm.off", details: on ? { until } : {} }),
  ]);
  return json({ on, until: on ? until : null });
}

/** @type {Route[]} */
export const adminAuthRoutes = [
  { method: "POST", path: "/api/admin/alarm", access: "admin", handler: setAlarm },
  { method: "POST", path: "/api/admin/setup/start", access: "public", handler: setupStart },
  { method: "POST", path: "/api/admin/setup", access: "public", handler: setupFinish },
  { method: "POST", path: "/api/admin/login", access: "public", handler: login },
  { method: "POST", path: "/api/admin/logout", access: "admin", handler: logout },
  { method: "GET", path: "/api/admin/me", access: "admin", handler: me },
];

/** Exported for the "reset another admin" action. */
export { ISSUER };
