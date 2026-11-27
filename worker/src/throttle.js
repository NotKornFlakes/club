// @ts-check
// Login throttling, in this order, before any hashing (docs/architecture.md, section 5):
//   1. flood gate (LOGIN_LIMITER binding), 2. per-IP block, 3. per-account lockout,
//   4. club-wide alarm (extra delay + Turnstile while it's on).
// Members and admins share the IP block and the alarm; each has its own lockout counters.

import { ConfigError } from "./crypto.js";
import { HttpError } from "./http.js";
import { clubParts } from "./time.js";

/** @typedef {import("./settings.js").ThrottleSettings} ThrottleSettings */
/** @typedef {"member" | "admin"} LoginKind */

/** Public and fixed (it's in the brief): 5 tries, then 15 min, 1 hour, 24 hours. */
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_SECONDS = Object.freeze([0, 15 * 60, 60 * 60, 24 * 60 * 60]);
/** 7 days with no failures resets the lockout level. */
export const LOCK_RESET_SECONDS = 7 * 86_400;
const HOUR = 3600;
const DAY = 86_400;
export const ALARM_KEY = "login_alarm_until";

/**
 * Claims one attempt in a single atomic UPDATE, before the PIN is checked: the counter
 * goes up, and on the 5th failure in a row the account locks. If the PIN turns out to be
 * right, clearLock() undoes it. Because D1 runs one statement at a time, parallel
 * requests can't all slip in under the limit. Returns null if the account is locked.
 * Only these two fixed table names are ever used.
 * @param {"members" | "admins"} table
 */
function claimSql(table) {
  return `UPDATE ${table} SET
      failed_logins = CASE WHEN eff_failed + 1 >= ${LOCK_AFTER_FAILURES} THEN 0 ELSE eff_failed + 1 END,
      lock_level = CASE WHEN eff_failed + 1 >= ${LOCK_AFTER_FAILURES} THEN MIN(eff_level + 1, 3) ELSE eff_level END,
      locked_until = CASE WHEN eff_failed + 1 >= ${LOCK_AFTER_FAILURES}
                          THEN ?1 + (CASE MIN(eff_level + 1, 3) WHEN 1 THEN ${LOCK_SECONDS[1]} WHEN 2 THEN ${LOCK_SECONDS[2]} ELSE ${LOCK_SECONDS[3]} END)
                          ELSE locked_until END,
      last_failed_at = ?1,
      updated_at = ?1
    FROM (SELECT
            CASE WHEN last_failed_at IS NOT NULL AND last_failed_at > ?1 - ${LOCK_RESET_SECONDS} THEN failed_logins ELSE 0 END AS eff_failed,
            CASE WHEN last_failed_at IS NOT NULL AND last_failed_at > ?1 - ${LOCK_RESET_SECONDS} THEN lock_level ELSE 0 END AS eff_level
          FROM ${table} WHERE id = ?2) AS eff
    WHERE ${table}.id = ?2 AND (${table}.locked_until IS NULL OR ${table}.locked_until <= ?1)
    RETURNING locked_until`;
}

const SQL = Object.freeze({
  claim: { member: claimSql("members"), admin: claimSql("admins") },
  clear: {
    member:
      "UPDATE members SET failed_logins = 0, lock_level = 0, locked_until = NULL, last_failed_at = NULL, updated_at = ?1 WHERE id = ?2",
    admin:
      "UPDATE admins SET failed_logins = 0, lock_level = 0, locked_until = NULL, last_failed_at = NULL, updated_at = ?1 WHERE id = ?2",
  },
  lockedUntil: {
    member: "SELECT locked_until FROM members WHERE id = ?",
    admin: "SELECT locked_until FROM admins WHERE id = ?",
  },
});

/**
 * @param {D1Database} db @param {LoginKind} kind @param {number} id @param {number} now
 * @returns {Promise<{ lockedUntil: number | null } | null>} null = locked, try later
 */
export async function claimAttempt(db, kind, id, now) {
  const row = await db.prepare(SQL.claim[kind]).bind(now, id).first();
  if (!row) return null;
  const until = row.locked_until === null ? null : Number(row.locked_until);
  return { lockedUntil: until !== null && until > now ? until : null };
}

/** After a right PIN, or when an admin clears a lockout. @param {D1Database} db @param {LoginKind} kind @param {number} id @param {number} now */
export async function clearLock(db, kind, id, now) {
  await db.prepare(SQL.clear[kind]).bind(now, id).run();
}

/** @param {D1Database} db @param {LoginKind} kind @param {number} id */
export async function lockedUntil(db, kind, id) {
  const row = await db.prepare(SQL.lockedUntil[kind]).bind(id).first();
  return row?.locked_until === null || row?.locked_until === undefined ? null : Number(row.locked_until);
}

/** The answer for a locked account. @param {number} until */
export function lockedError(until) {
  const { date, time } = clubParts(until);
  return new HttpError(
    423,
    "locked",
    `Too many wrong tries. You can try again after ${time} on ${date}, or ask management to unlock your account.`,
    { locked_until: until },
  );
}

/** Is the club-wide alarm on? @param {D1Database} db @param {number} now */
export async function alarmUntil(db, now) {
  const row = await db.prepare("SELECT value FROM system_state WHERE key = ?").bind(ALARM_KEY).first();
  const until = Number(row?.value ?? 0);
  return until > now ? until : null;
}

/**
 * Steps 1, 2 and 4: run before any hashing. Throws an HttpError to refuse.
 * @param {{ env: Env, ipHash: string, settings: ThrottleSettings, now: number, turnstileToken: string | null }} options
 */
export async function guardLogin({ env, ipHash, settings, now, turnstileToken }) {
  // 1. Flood gate: a burst from one IP is dropped at almost no cost.
  const { success } = await env.LOGIN_LIMITER.limit({ key: ipHash });
  if (!success) throw new HttpError(429, "slow_down", "Too many tries. Please wait a minute and try again.");

  // 2. Per-IP block: too many failures from this network in the past hour.
  const ipRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip_hash = ? AND at > ?")
    .bind(ipHash, now - HOUR)
    .first();
  if (Number(ipRow?.n ?? 0) >= settings.ip_failures_per_hour) {
    throw new HttpError(429, "ip_blocked", "Too many failed logins from this network. Please try again in an hour.");
  }

  // 4. Club-wide alarm: Turnstile is required and every login is slowed.
  if (await alarmUntil(env.DB, now)) {
    if (!turnstileToken) {
      throw new HttpError(403, "turnstile_required", "Please complete the check below, then log in again.", {
        turnstile_site_key: env.TURNSTILE_SITE_KEY,
      });
    }
    if (!(await verifyTurnstile(env, turnstileToken))) {
      throw new HttpError(403, "turnstile_failed", "The check didn't work. Please try it again.", {
        turnstile_site_key: env.TURNSTILE_SITE_KEY,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, settings.alarm_delay_ms));
  }
}

/** @param {Env} env @param {string} token */
async function verifyTurnstile(env, token) {
  if (typeof env.TURNSTILE_SECRET !== "string" || env.TURNSTILE_SECRET === "") {
    throw new ConfigError("TURNSTILE_SECRET is missing");
  }
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  if (!response.ok) return false;
  const result = /** @type {{ success?: unknown }} */ (await response.json());
  return result.success === true;
}

/**
 * Records a failed login, then checks whether the club-wide alarm must switch on (or stay
 * on longer). Each time it switches on, an audit log entry is written.
 * @param {{ db: D1Database, kind: LoginKind, ipHash: string, memberId: number | null, settings: ThrottleSettings, now: number }} options
 */
export async function recordFailure({ db, kind, ipHash, memberId, settings, now }) {
  await db
    .prepare("INSERT INTO login_failures (at, kind, ip_hash, member_id) VALUES (?, ?, ?, ?)")
    .bind(now, kind, ipHash, memberId)
    .run();
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM login_failures WHERE at > ?1) AS short_count,
              (SELECT COUNT(*) FROM login_failures WHERE at > ?2) AS long_count`,
    )
    .bind(now - settings.alarm_short_minutes * 60, now - DAY)
    .first();
  const short = Number(counts?.short_count ?? 0) >= settings.alarm_short_failures;
  const long = Number(counts?.long_count ?? 0) >= settings.alarm_long_failures;
  if (!short && !long) return;

  const wasOn = await alarmUntil(db, now);
  const until = now + settings.alarm_hold_minutes * 60;
  /** @type {D1PreparedStatement[]} */
  const statements = [
    db
      .prepare(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(ALARM_KEY, String(until), now),
  ];
  if (!wasOn) {
    statements.push(
      db
        .prepare("INSERT INTO audit_log (at, admin_id, action, target, details) VALUES (?, NULL, 'login_alarm.on', NULL, ?)")
        .bind(now, JSON.stringify({ window: short ? "short" : "long", until })),
    );
  }
  await db.batch(statements);
}
