// @ts-check
// Members' own bookings: book, list, cancel (the club's cancel cutoff), and "Add to calendar".

import { bookingWindow, openRanges, withinOpenHours } from "../availability.js";
import { CANCEL_CUTOFF_SECONDS, MAX_MEMBER_SECONDS, MAX_UPCOMING, bookingRefusal } from "../bookings.js";
import { CLUB } from "../club.js";
import { activeSuspension, suspendedMessage } from "../discipline.js";
import { HttpError, json } from "../http.js";
import { bookingIcs } from "../ics.js";
import { SLOT_SECONDS, clubParts } from "../time.js";
import { idParam, int, onlyFields } from "../validate.js";
import { activeResource } from "./availability.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */
/** @typedef {import("../sessions.js").MemberSession} MemberSession */

const FAR_FUTURE = 4_102_444_800; // 2100-01-01, a sanity limit for times

/** @param {Ctx} ctx */
const memberOf = (ctx) => /** @type {MemberSession} */ (ctx.member);

/**
 * @param {Record<string, unknown>} row @param {number} now
 */
function bookingView(row, now) {
  const start = Number(row.starts_at);
  return {
    id: Number(row.id),
    resource: String(row.resource_name),
    starts_at: start,
    ends_at: Number(row.ends_at),
    can_cancel: start - now >= CANCEL_CUTOFF_SECONDS,
    cancel_until: start - CANCEL_CUTOFF_SECONDS,
  };
}

/** @param {Ctx} ctx */
async function createBooking(ctx) {
  const { env, now, body } = ctx;
  const member = memberOf(ctx);
  onlyFields(body, ["resource_id", "starts_at", "ends_at", "agree"]);
  const resourceId = int(body, "resource_id", { min: 1, max: Number.MAX_SAFE_INTEGER, label: "the place" });
  const start = int(body, "starts_at", { min: 0, max: FAR_FUTURE, label: "the start time" });
  const end = int(body, "ends_at", { min: 0, max: FAR_FUTURE, label: "the end time" });
  if (body.agree !== true) {
    throw new HttpError(400, "must_agree", "Please tick “I agree to the booking rules” to book.");
  }

  if (start % SLOT_SECONDS !== 0 || end % SLOT_SECONDS !== 0 || end <= start) {
    throw new HttpError(400, "bad_input", "Please pick a start time and length from the list.");
  }
  if (end - start > MAX_MEMBER_SECONDS) {
    throw new HttpError(400, "too_long", `A booking can be at most ${CLUB.phrases.max_length}.`);
  }
  if (start <= now) {
    throw new HttpError(400, "started", "That time has already started. Please pick a later one.");
  }
  const date = clubParts(start).date;
  const window = bookingWindow(now);
  if (date > window.last) throw new HttpError(400, "outside_window", `You can book up to ${CLUB.phrases.days_ahead} ahead.`);

  // The database refuses this too; checking first gives the member the end date.
  const suspension = await activeSuspension(env.DB, member.memberId, now);
  if (suspension) throw new HttpError(403, "suspended", suspendedMessage(suspension.until_date));

  const resource = await activeResource(env.DB, resourceId);
  if (!withinOpenHours(await openRanges(env.DB, resource.id, date), start, end)) {
    throw new HttpError(400, "closed", "That time is outside the opening hours. Please pick another.");
  }

  // One statement, so two quick requests can't both get under the club's limit. The
  // database's own trigger still refuses anything over its ceiling.
  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
       SELECT ?, 'member', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM bookings WHERE member_id = ? AND status = 'active' AND ends_at > ?) < ?
       RETURNING id`,
    )
      .bind(resource.id, member.memberId, start, end, now, member.memberId, now, MAX_UPCOMING)
      .first();
  } catch (error) {
    bookingRefusal(error);
  }
  if (!row) bookingRefusal(new Error("too_many_upcoming"));
  const booking = bookingView({ id: row.id, resource_name: resource.name, starts_at: start, ends_at: end }, now);
  return json({ booking }, 201);
}

/** @param {Ctx} ctx */
async function myBookings(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT b.id, b.starts_at, b.ends_at, r.name AS resource_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.member_id = ? AND b.status = 'active' AND b.ends_at > ?
     ORDER BY b.starts_at`,
  )
    .bind(memberOf(ctx).memberId, ctx.now)
    .all();
  return json({ bookings: results.map((row) => bookingView(row, ctx.now)) });
}

/**
 * The member's own active booking, or 404 (also for anyone else's: we never confirm it exists).
 * @param {Ctx} ctx
 */
async function ownBooking(ctx) {
  const id = idParam(ctx.params[0]);
  const row = await ctx.env.DB.prepare(
    `SELECT b.id, b.starts_at, b.ends_at, r.name AS resource_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.id = ? AND b.member_id = ? AND b.status = 'active'`,
  )
    .bind(id, memberOf(ctx).memberId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that booking. It may already be cancelled.");
  return row;
}

/** @param {Ctx} ctx */
async function cancelBooking(ctx) {
  onlyFields(ctx.body, []);
  const row = await ownBooking(ctx);
  const view = bookingView(row, ctx.now);
  if (!view.can_cancel) {
    throw new HttpError(
      403,
      "too_late",
      `Bookings can't be cancelled within ${CLUB.phrases.cancel_cutoff} of the start. If you can't make it, please let management know.`,
    );
  }
  // The status check makes a double cancel a no-op rather than an error from the trigger.
  // RETURNING, not meta.changes: D1 also counts the slot rows the trigger removes.
  const cancelled = await ctx.env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'member'
     WHERE id = ? AND member_id = ? AND status = 'active' AND starts_at - ? >= ?
     RETURNING id`,
  )
    .bind(ctx.now, view.id, memberOf(ctx).memberId, ctx.now, CANCEL_CUTOFF_SECONDS)
    .first();
  if (!cancelled) throw new HttpError(404, "not_found", "We couldn't find that booking. It may already be cancelled.");
  return json({ ok: true });
}

/** @param {Ctx} ctx */
async function bookingCalendar(ctx) {
  const row = await ownBooking(ctx);
  const summary = `${String(row.resource_name)} booking`;
  const body = bookingIcs({
    uid: `booking-${Number(row.id)}@${ctx.url.hostname}`,
    start: Number(row.starts_at),
    end: Number(row.ends_at),
    now: ctx.now,
    summary,
    description: "Bookings can be cancelled up to 24 hours before the start time. If you can't make it, please let management know.",
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="booking-${Number(row.id)}.ics"`,
    },
  });
}

/** @type {Route[]} */
export const bookingRoutes = [
  { method: "POST", path: "/api/bookings", access: "member", handler: createBooking },
  { method: "GET", path: "/api/my-bookings", access: "member", handler: myBookings },
  { method: "POST", path: "/api/bookings/:id/cancel", access: "member", handler: cancelBooking },
  { method: "GET", path: "/api/bookings/:id/ics", access: "member", handler: bookingCalendar },
];
