// @ts-check
// Admin: the audit log (read only), and the admin list, where one admin can reset the
// other's login if they lose their password or authenticator.

import { auditEntry } from "../audit.js";
import { encryptText, hashRounds, hashSecret, pepperKeys, randomToken } from "../crypto.js";
import { HttpError, json } from "../http.js";
import { endAllAdminSessions } from "../sessions.js";
import { clearLock } from "../throttle.js";
import { newTotpSecret, otpauthUri } from "../totp.js";
import { idParam, onlyFields } from "../validate.js";
import { ISSUER } from "./admin-auth.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** @param {Ctx} ctx */
const adminOf = (ctx) => /** @type {import("../sessions.js").AdminSession} */ (ctx.admin);
const PAGE = 50;

/** Newest first, 50 at a time. @param {Ctx} ctx */
async function auditLog(ctx) {
  const before = ctx.url.searchParams.get("before");
  const beforeId = before ? idParam(before) : Number.MAX_SAFE_INTEGER;
  const { results } = await ctx.env.DB.prepare(
    `SELECT l.id, l.at, l.action, l.target, l.details, a.username
     FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id
     WHERE l.id < ? ORDER BY l.id DESC LIMIT ?`,
  )
    .bind(beforeId, PAGE)
    .all();
  return json({
    entries: results.map((e) => ({
      id: Number(e.id),
      at: Number(e.at),
      who: e.username === null ? "System" : String(e.username),
      action: String(e.action),
      target: e.target === null ? null : String(e.target),
      details: JSON.parse(String(e.details)),
    })),
    more: results.length === PAGE,
  });
}

/** @param {Ctx} ctx */
async function listAdmins(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT id, username, status, locked_until FROM admins ORDER BY username").all();
  return json({
    admins: results.map((a) => ({
      id: Number(a.id),
      username: String(a.username),
      status: String(a.status),
      locked_until: Number(a.locked_until ?? 0) > ctx.now ? Number(a.locked_until) : null,
      is_me: Number(a.id) === adminOf(ctx).adminId,
    })),
  });
}

/**
 * Gives the other admin a new temporary password and a new authenticator key, shown once,
 * and logs them out everywhere. They log in with these, then keep using the new key.
 * @param {Ctx} ctx
 */
async function resetAdmin(ctx) {
  onlyFields(ctx.body, []);
  const id = idParam(ctx.params[0]);
  if (id === adminOf(ctx).adminId) throw new HttpError(400, "self", "You can't reset your own login. Ask the other admin.");
  const target = await ctx.env.DB.prepare("SELECT username FROM admins WHERE id = ?").bind(id).first();
  if (!target) throw new HttpError(404, "not_found", "We couldn't find that admin.");
  const keys = await pepperKeys(ctx.env.PEPPER);
  const password = randomToken(18); // 24 characters
  const secret = newTotpSecret();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE admins SET password_hash = ?, totp_secret_enc = ?, totp_last_step = 0, failed_logins = 0, lock_level = 0,
              locked_until = NULL, last_failed_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(await hashSecret(password, keys, hashRounds(ctx.env)), await encryptText(secret, keys), ctx.now, id),
    endAllAdminSessions(ctx.env.DB, id),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminOf(ctx).adminId, action: "admin.reset", target: `admin:${String(target.username)}` }),
  ]);
  return json({
    username: String(target.username),
    password,
    totp_secret: secret,
    otpauth_uri: otpauthUri(secret, String(target.username), ISSUER),
  });
}

/** @param {Ctx} ctx */
async function clearAdminLockout(ctx) {
  onlyFields(ctx.body, []);
  const id = idParam(ctx.params[0]);
  const target = await ctx.env.DB.prepare("SELECT username FROM admins WHERE id = ?").bind(id).first();
  if (!target) throw new HttpError(404, "not_found", "We couldn't find that admin.");
  await clearLock(ctx.env.DB, "admin", id, ctx.now);
  await auditEntry(ctx.env.DB, {
    at: ctx.now,
    adminId: adminOf(ctx).adminId,
    action: "admin.clear_lockout",
    target: `admin:${String(target.username)}`,
  }).run();
  return json({ ok: true });
}

/** @type {Route[]} */
export const adminAuditRoutes = [
  { method: "GET", path: "/api/admin/audit", access: "admin", handler: auditLog },
  { method: "GET", path: "/api/admin/admins", access: "admin", handler: listAdmins },
  { method: "POST", path: "/api/admin/admins/:id/reset", access: "admin", handler: resetAdmin },
  { method: "POST", path: "/api/admin/admins/:id/clear-lockout", access: "admin", handler: clearAdminLockout },
];
