// @ts-check
// Login sessions. The cookie holds a random 32-byte token; D1 keeps only its SHA-256, so a
// copy of the database can't be used to log in. Every request re-checks that the member or
// admin is still active. (docs/architecture.md, section 5 "Sessions".)

import { randomToken, sha256Hex } from "./crypto.js";
import { getCookie } from "./http.js";

export const MEMBER_COOKIE = "__Host-session";
export const ADMIN_COOKIE = "__Host-admin";
export const MEMBER_SESSION_SECONDS = 30 * 86_400;
export const ADMIN_SESSION_SECONDS = 12 * 3600;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** @typedef {{ memberId: number, memberNumber: string, csrfToken: string, tokenHash: string }} MemberSession */
/** @typedef {{ adminId: number, username: string, csrfToken: string, tokenHash: string }} AdminSession */

/** @param {string} name @param {string} value @param {number} maxAge */
function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** A Set-Cookie value that removes a login cookie. @param {string} name */
export function clearCookie(name) {
  return cookie(name, "", 0);
}

/** @param {Request} request @param {string} name @returns {Promise<string | null>} */
async function tokenHashFrom(request, name) {
  const token = getCookie(request, name);
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  return sha256Hex(token);
}

/**
 * Starts a member session. Returns the Set-Cookie header value.
 * @param {D1Database} db @param {number} memberId @param {number} now
 */
export async function createMemberSession(db, memberId, now) {
  const token = randomToken();
  await db
    .prepare(
      "INSERT INTO member_sessions (token_hash, member_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), memberId, randomToken(), now, now + MEMBER_SESSION_SECONDS)
    .run();
  return cookie(MEMBER_COOKIE, token, MEMBER_SESSION_SECONDS);
}

/** @param {Request} request @param {D1Database} db @param {number} now @returns {Promise<MemberSession | null>} */
export async function readMemberSession(request, db, now) {
  const tokenHash = await tokenHashFrom(request, MEMBER_COOKIE);
  if (!tokenHash) return null;
  const row = await db
    .prepare(
      `SELECT s.member_id, s.csrf_token, m.member_number
       FROM member_sessions s JOIN members m ON m.id = s.member_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND m.status = 'active'`,
    )
    .bind(tokenHash, now)
    .first();
  if (!row) return null;
  return {
    memberId: Number(row.member_id),
    memberNumber: String(row.member_number),
    csrfToken: String(row.csrf_token),
    tokenHash,
  };
}

/** Logs one member out of every device. @param {D1Database} db @param {number} memberId */
export function endAllMemberSessions(db, memberId) {
  return db.prepare("DELETE FROM member_sessions WHERE member_id = ?").bind(memberId);
}

/**
 * Starts an admin session. Returns the Set-Cookie header value.
 * @param {D1Database} db @param {number} adminId @param {number} now
 */
export async function createAdminSession(db, adminId, now) {
  const token = randomToken();
  await db
    .prepare("INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), adminId, randomToken(), now, now + ADMIN_SESSION_SECONDS)
    .run();
  return cookie(ADMIN_COOKIE, token, ADMIN_SESSION_SECONDS);
}

/** @param {Request} request @param {D1Database} db @param {number} now @returns {Promise<AdminSession | null>} */
export async function readAdminSession(request, db, now) {
  const tokenHash = await tokenHashFrom(request, ADMIN_COOKIE);
  if (!tokenHash) return null;
  const row = await db
    .prepare(
      `SELECT s.admin_id, s.csrf_token, a.username
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND a.status = 'active'`,
    )
    .bind(tokenHash, now)
    .first();
  if (!row) return null;
  return { adminId: Number(row.admin_id), username: String(row.username), csrfToken: String(row.csrf_token), tokenHash };
}

/** Logs one admin out of every device. @param {D1Database} db @param {number} adminId */
export function endAllAdminSessions(db, adminId) {
  return db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(adminId);
}
