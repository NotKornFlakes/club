// @ts-check
// Booking rules shared by member and admin code, the member booking limit, and the
// database's refusals in plain words.

import { CLUB } from "./club.js";
import { HttpError } from "./http.js";

// These come from the club's settings file. The database also refuses any member booking
// over its own ceiling of 2 hours, whatever a club's file says.

/** Members can cancel only this long (or more) before the start. Admins can always cancel. */
export const CANCEL_CUTOFF_SECONDS = CLUB.booking.cancel_cutoff_hours * 3600;
/** The longest member booking. */
export const MAX_MEMBER_SECONDS = CLUB.booking.max_length_minutes * 60;
/** How much a member may book: none, a number of upcoming bookings, or hours in any 7 days. */
export const BOOKING_LIMIT = CLUB.booking.limit;

const WEEK = 7 * 86_400;

/** @typedef {import("./club-config.js").Limit} Limit */

// One statement per kind of limit, so two quick requests can't both get past it: SQLite
// runs each statement as a whole, and D1 runs one write at a time. Only the member's own
// active bookings count; admin bookings and leagues have no member and never do. Lanes
// booked together count once: only each booking's first row (group_id NULL) is counted.
// Parameters: ?1 resource, ?2 member, ?3 start, ?4 end, ?5 now, ?6 the limit, ?7 seven days
// in seconds. Values are always bound, never written into the SQL text.

const INSERT_NO_LIMIT = `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
  VALUES (?1, 'member', ?2, ?3, ?4, ?5) RETURNING id`;

// At most ?6 bookings that haven't ended yet (each counts until it ends).
const INSERT_UPCOMING = `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
  SELECT ?1, 'member', ?2, ?3, ?4, ?5
  WHERE (SELECT COUNT(*) FROM bookings WHERE member_id = ?2 AND status = 'active' AND group_id IS NULL AND ends_at > ?5) < ?6
  RETURNING id`;

// At most ?6 seconds booked in any 7 days in a row ([w, w + 7 days)). Only 7-day stretches
// that overlap the new booking can go over. Their total peaks where a stretch starts at a
// booking's start or ends at a booking's end, so those are the ones checked: for the new
// booking and for each of the member's bookings nearby.
const INSERT_HOURS_PER_WEEK = `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
  SELECT ?1, 'member', ?2, ?3, ?4, ?5
  WHERE NOT EXISTS (
    SELECT 1 FROM (
      SELECT ?3 AS w
      UNION SELECT ?4 - ?7
      UNION SELECT starts_at FROM bookings
        WHERE member_id = ?2 AND status = 'active' AND group_id IS NULL AND starts_at > ?3 - ?7 AND starts_at < ?4
      UNION SELECT ends_at - ?7 FROM bookings
        WHERE member_id = ?2 AND status = 'active' AND group_id IS NULL AND ends_at > ?3 AND ends_at < ?4 + ?7
    ) AS stretch
    WHERE min(?4, stretch.w + ?7) - max(?3, stretch.w)
      + (SELECT COALESCE(SUM(min(b.ends_at, stretch.w + ?7) - max(b.starts_at, stretch.w)), 0)
         FROM bookings b
         WHERE b.member_id = ?2 AND b.status = 'active' AND b.group_id IS NULL
           AND b.starts_at < stretch.w + ?7 AND b.ends_at > stretch.w)
      > ?6
  )
  RETURNING id`;

// Every other lane of the same booking: inserted only if the first lane's row (?6, same
// member, time and moment) went in, and pointing at it.
const INSERT_MORE_LANES = `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at, group_id)
  SELECT ?1, 'member', ?2, ?3, ?4, ?5, lead.id FROM bookings lead
  WHERE lead.resource_id = ?6 AND lead.member_id = ?2 AND lead.starts_at = ?3 AND lead.ends_at = ?4
    AND lead.created_at = ?5 AND lead.status = 'active' AND lead.group_id IS NULL`;

/**
 * Saves a member's booking (one resource, or several lanes together) if it stays within
 * the club's limit. All lanes go in one transaction: all of them are booked, or none.
 * Returns the booking's id (its first lane's row), or throws the plain-words refusal
 * (limit reached, slot taken, suspended...).
 * @param {D1Database} db
 * @param {Limit} limit
 * @param {{ resourceIds: number[], memberId: number, start: number, end: number, now: number }} booking
 * @returns {Promise<number>}
 */
export async function insertMemberBooking(db, limit, { resourceIds, memberId, start, end, now }) {
  const [lead, ...more] = resourceIds;
  if (lead === undefined) throw new RangeError("no resource");
  const first =
    limit.kind === "upcoming"
      ? db.prepare(INSERT_UPCOMING).bind(lead, memberId, start, end, now, limit.max)
      : limit.kind === "hours_per_week"
        ? db.prepare(INSERT_HOURS_PER_WEEK).bind(lead, memberId, start, end, now, limit.hours * 3600, WEEK)
        : db.prepare(INSERT_NO_LIMIT).bind(lead, memberId, start, end, now);
  /** @type {D1Result<Record<string, unknown>>[]} */
  let results = [];
  try {
    results = await db.batch([first, ...more.map((id) => db.prepare(INSERT_MORE_LANES).bind(id, memberId, start, end, now, lead))]);
  } catch (error) {
    bookingRefusal(error);
  }
  const row = results[0]?.results[0];
  if (!row) throw limitRefusal(limit);
  return Number(row.id);
}

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What a member sees when a booking would go over the club's limit. @param {Limit} limit */
export function limitRefusal(limit) {
  if (limit.kind === "hours_per_week") {
    return new HttpError(
      409,
      "over_hours_limit",
      `That would be more than ${count(limit.hours, "hour", "hours")} of bookings in 7 days in a row. Please pick a shorter time or another day.`,
    );
  }
  const max = limit.kind === "upcoming" ? limit.max : 0;
  return new HttpError(
    409,
    "too_many_upcoming",
    `You already have ${count(max, "upcoming booking", "upcoming bookings")}. You can book again when one has finished or been cancelled.`,
  );
}

/**
 * Turns a database refusal (from a trigger or constraint) into a plain-words answer.
 * Anything unexpected is rethrown.
 * @param {unknown} error
 * @returns {never}
 */
export function bookingRefusal(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("slot_taken")) {
    throw new HttpError(409, "slot_taken", "Sorry, someone just booked that time. Please pick another.");
  }
  if (text.includes("member_suspended")) {
    throw new HttpError(403, "suspended", "Your booking access is suspended. Contact management.");
  }
  if (text.includes("member_not_active")) {
    throw new HttpError(403, "not_active", "Your account can't make bookings. Contact management.");
  }
  throw error;
}
