// @ts-check
// Member login (member number + 6-digit PIN), logout and "who am I".

import { hashIp, pepperKeys, verifyDummy, verifySecret } from "../crypto.js";
import { activeSuspension, memberNoShowDates, suspendedMessage } from "../discipline.js";
import { HttpError, clientIp, json } from "../http.js";
import { MEMBER_COOKIE, clearCookie, createMemberSession } from "../sessions.js";
import { throttleSettings } from "../settings.js";
import { alarmUntil, claimAttempt, clearLock, guardLogin, lockedError, lockedUntil, recordFailure } from "../throttle.js";
import { onlyFields, optionalStr, str } from "../validate.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

export const MEMBER_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
const WRONG = "That member number and PIN don't match. Please check them and try again.";

/** @param {Ctx} ctx */
async function login(ctx) {
  const { env, now, body } = ctx;
  onlyFields(body, ["member_number", "pin", "turnstile_token"]);
  const memberNumber = str(body, "member_number", { max: 20, label: "your member number" });
  const pin = str(body, "pin", { max: 6, label: "your PIN", trim: false });
  const turnstileToken = optionalStr(body, "turnstile_token", { max: 2048 });

  // Settings and keys first: if any is missing, refuse rather than guess.
  const settings = throttleSettings(env.THROTTLE_SETTINGS);
  const keys = await pepperKeys(env.PEPPER);
  const ipHash = await hashIp(clientIp(ctx.request), env.IP_HASH_KEY);

  await guardLogin({ env, ipHash, settings, now, turnstileToken });

  if (!MEMBER_NUMBER_PATTERN.test(memberNumber) || !/^\d{6}$/.test(pin)) {
    throw new HttpError(400, "bad_input", "Please enter your member number and your 6-digit PIN.");
  }

  const member = await env.DB.prepare("SELECT id, pin_hash, status FROM members WHERE member_number = ?")
    .bind(memberNumber)
    .first();

  if (!member || member.status !== "active" || typeof member.pin_hash !== "string") {
    // Same work and the same answer as a wrong PIN, so nothing reveals which numbers exist.
    await verifyDummy(pin, keys);
    await recordFailure({ db: env.DB, kind: "member", ipHash, memberId: member ? Number(member.id) : null, settings, now });
    throw new HttpError(401, "wrong", WRONG);
  }

  const memberId = Number(member.id);
  const claim = await claimAttempt(env.DB, "member", memberId, now);
  if (!claim) throw lockedError((await lockedUntil(env.DB, "member", memberId)) ?? now);

  if (!(await verifySecret(pin, member.pin_hash, keys))) {
    await recordFailure({ db: env.DB, kind: "member", ipHash, memberId, settings, now });
    if (claim.lockedUntil) throw lockedError(claim.lockedUntil);
    throw new HttpError(401, "wrong", WRONG);
  }

  await clearLock(env.DB, "member", memberId, now);
  const cookie = await createMemberSession(env.DB, memberId, now);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

/** @param {Ctx} ctx */
async function logout(ctx) {
  const session = ctx.member;
  if (session) {
    await ctx.env.DB.prepare("DELETE FROM member_sessions WHERE token_hash = ?").bind(session.tokenHash).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(MEMBER_COOKIE) });
}

/**
 * The logged-in member, the CSRF token their pages send with every change, any suspension
 * in force, and their own no-show dates for the last 12 months (dates only, never notes).
 * @param {Ctx} ctx
 */
async function me(ctx) {
  const member = /** @type {import("../sessions.js").MemberSession} */ (ctx.member);
  const suspension = await activeSuspension(ctx.env.DB, member.memberId, ctx.now);
  return json({
    member_number: member.memberNumber,
    csrf_token: member.csrfToken,
    suspension: suspension ? { until_date: suspension.until_date, message: suspendedMessage(suspension.until_date) } : null,
    no_shows: await memberNoShowDates(ctx.env.DB, member.memberId, ctx.now),
  });
}

/**
 * Whether the club-wide alarm is on, so the login page knows to show Turnstile.
 * @param {Ctx} ctx
 */
async function loginStatus(ctx) {
  const alarm = (await alarmUntil(ctx.env.DB, ctx.now)) !== null;
  return json({ alarm, turnstile_site_key: alarm ? ctx.env.TURNSTILE_SITE_KEY : null });
}

/** @type {Route[]} */
export const memberAuthRoutes = [
  { method: "POST", path: "/api/login", access: "public", handler: login },
  { method: "GET", path: "/api/login-status", access: "public", handler: loginStatus },
  { method: "POST", path: "/api/logout", access: "member", handler: logout },
  { method: "GET", path: "/api/me", access: "member", handler: me },
];
