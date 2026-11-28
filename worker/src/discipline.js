// @ts-check
// No-shows and suspensions, on the honor system: no check-in and no automatic tracking.
// Management tells the admin; the admin records it here (admin screens: step 6).
// Members see their own no-show dates (never the notes) and any active suspension.

import { auditEntry } from "./audit.js";
import { HttpError } from "./http.js";
import { addDays, addMonths, clubParts, clubTimeToUtc, clubToday } from "./time.js";

export const DEFAULT_SUSPENSION_MONTHS = 6;
/** No-shows are shown (and kept) for 12 months. */
const NO_SHOW_DAYS = 365;

/** "Suspended until [date]" means through the end of that club date. @param {string} untilDate */
export function suspensionEndsAt(untilDate) {
  return clubTimeToUtc(addDays(untilDate, 1), "00:00");
}

/** The club date a suspension runs through. @param {number} endsAt */
export function suspensionUntilDate(endsAt) {
  return clubParts(endsAt - 1).date;
}

/** The default "until" date for a new suspension: 6 months from today. @param {number} now */
export function defaultSuspensionUntil(now) {
  return addMonths(clubToday(now), DEFAULT_SUSPENSION_MONTHS);
}

/**
 * The member's suspension in force right now, if any.
 * @param {D1Database} db @param {number} memberId @param {number} now
 * @returns {Promise<{ id: number, until_date: string, reason: string } | null>}
 */
export async function activeSuspension(db, memberId, now) {
  const row = await db
    .prepare(
      `SELECT id, ends_at, reason FROM suspensions
       WHERE member_id = ? AND lifted_at IS NULL AND starts_at <= ? AND ends_at > ?
       ORDER BY ends_at DESC LIMIT 1`,
    )
    .bind(memberId, now, now)
    .first();
  if (!row) return null;
  return { id: Number(row.id), until_date: suspensionUntilDate(Number(row.ends_at)), reason: String(row.reason) };
}

/** The plain-words notice a suspended member sees. @param {string} untilDate */
export function suspendedMessage(untilDate) {
  const [y, m, d] = untilDate.split("-").map(Number);
  const pretty = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(
    new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)),
  );
  return `Your booking access is suspended until ${pretty}. Contact management.`;
}

/**
 * The member's own no-show dates in the last 12 months (dates only; notes are admin-only).
 * @param {D1Database} db @param {number} memberId @param {number} now
 * @returns {Promise<string[]>}
 */
export async function memberNoShowDates(db, memberId, now) {
  const { results } = await db
    .prepare("SELECT on_date FROM no_shows WHERE member_id = ? AND on_date > ? ORDER BY on_date DESC")
    .bind(memberId, addDays(clubToday(now), -NO_SHOW_DAYS))
    .all();
  return results.map((row) => String(row.on_date));
}

/**
 * @param {D1Database} db @param {number} memberId
 * @returns {Promise<string>} the member number
 */
async function memberNumberOf(db, memberId) {
  const row = await db.prepare("SELECT member_number FROM members WHERE id = ?").bind(memberId).first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that member.");
  return String(row.member_number);
}

/**
 * Records a no-show (date + optional note) and logs it.
 * @param {D1Database} db
 * @param {{ memberId: number, onDate: string, note: string | null, adminId: number, now: number }} input
 */
export async function recordNoShow(db, { memberId, onDate, note, adminId, now }) {
  if (onDate > clubToday(now)) throw new HttpError(400, "bad_input", "A no-show date can't be in the future.");
  if (onDate <= addDays(clubToday(now), -NO_SHOW_DAYS)) {
    throw new HttpError(400, "bad_input", "That date is more than 12 months ago.");
  }
  const number = await memberNumberOf(db, memberId);
  /** @type {D1Result<Record<string, unknown>>[]} */
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO no_shows (member_id, on_date, note, recorded_by_admin_id, recorded_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(memberId, onDate, note, adminId, now),
    auditEntry(db, { at: now, adminId, action: "no_show.record", target: `member:${number}`, details: { on_date: onDate } }),
  ]);
  return Number(inserted?.results[0]?.id);
}

/**
 * Removes a no-show recorded by mistake, and logs it.
 * @param {D1Database} db @param {{ id: number, adminId: number, now: number }} input
 */
export async function deleteNoShow(db, { id, adminId, now }) {
  const row = await db
    .prepare("SELECT n.on_date, m.member_number FROM no_shows n JOIN members m ON m.id = n.member_id WHERE n.id = ?")
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that no-show.");
  await db.batch([
    db.prepare("DELETE FROM no_shows WHERE id = ?").bind(id),
    auditEntry(db, {
      at: now,
      adminId,
      action: "no_show.delete",
      target: `member:${String(row.member_number)}`,
      details: { on_date: String(row.on_date) },
    }),
  ]);
}

/**
 * Suspends a member from booking through `untilDate`. In one batch (all or nothing): adds
 * the suspension, logs it with the list of bookings it cancels, logs each cancelled booking,
 * and cancels the member's upcoming bookings so others can have the slots. The suspension
 * row goes in first, so the database refuses any booking made in the meantime.
 * @param {D1Database} db
 * @param {{ memberId: number, untilDate: string, reason: string, adminId: number, now: number }} input
 */
export async function suspendMember(db, { memberId, untilDate, reason, adminId, now }) {
  if (untilDate < clubToday(now)) throw new HttpError(400, "bad_input", "The end date can't be in the past.");
  if (untilDate > addMonths(clubToday(now), 24)) throw new HttpError(400, "bad_input", "A suspension can be at most 2 years.");
  const number = await memberNumberOf(db, memberId);
  if (await activeSuspension(db, memberId, now)) {
    throw new HttpError(409, "already_suspended", "This member is already suspended. Lift that suspension first to change it.");
  }
  const endsAt = suspensionEndsAt(untilDate);
  const target = `member:${number}`;

  // In every statement below: ?1 = member id, ?2 = now. "Upcoming" = active and not started.
  /** @type {D1Result<Record<string, unknown>>[]} */
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(memberId, now, endsAt, reason, adminId, now),
    db
      .prepare(
        `INSERT INTO audit_log (at, admin_id, action, target, details)
         SELECT ?3, ?4, 'member.suspend', ?5, json_object('until', ?6, 'reason', ?7,
                'cancelled_bookings', (SELECT json_group_array(id) FROM bookings WHERE member_id = ?1 AND status = 'active' AND starts_at > ?2))`,
      )
      .bind(memberId, now, now, adminId, target, untilDate, reason),
    db
      .prepare(
        `INSERT INTO audit_log (at, admin_id, action, target, details)
         SELECT ?3, ?4, 'booking.cancel', 'booking:' || id,
                json_object('reason', 'suspension', 'member', ?5, 'resource_id', resource_id,
                            'starts_at', starts_at, 'ends_at', ends_at)
         FROM bookings WHERE member_id = ?1 AND status = 'active' AND starts_at > ?2`,
      )
      .bind(memberId, now, now, adminId, target),
    db
      .prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?2, cancelled_by = 'suspension', cancelled_by_admin_id = ?3
         WHERE member_id = ?1 AND status = 'active' AND starts_at > ?2 RETURNING id, resource_id, starts_at, ends_at`,
      )
      .bind(memberId, now, adminId),
  ]);
  return {
    suspensionId: Number(results[0]?.results[0]?.id),
    untilDate,
    cancelled: (results[3]?.results ?? []).map((row) => ({
      id: Number(row.id),
      resource_id: Number(row.resource_id),
      starts_at: Number(row.starts_at),
      ends_at: Number(row.ends_at),
    })),
  };
}

/**
 * Lifts a suspension early, and logs it.
 * @param {D1Database} db @param {{ suspensionId: number, adminId: number, now: number }} input
 */
export async function liftSuspension(db, { suspensionId, adminId, now }) {
  const row = await db
    .prepare(
      `SELECT s.id, m.member_number FROM suspensions s JOIN members m ON m.id = s.member_id
       WHERE s.id = ? AND s.lifted_at IS NULL AND s.ends_at > ?`,
    )
    .bind(suspensionId, now)
    .first();
  if (!row) throw new HttpError(404, "not_found", "That suspension has already ended or been lifted.");
  await db.batch([
    db.prepare("UPDATE suspensions SET lifted_at = ?, lifted_by_admin_id = ? WHERE id = ?").bind(now, adminId, suspensionId),
    auditEntry(db, { at: now, adminId, action: "member.unsuspend", target: `member:${String(row.member_number)}` }),
  ]);
}
