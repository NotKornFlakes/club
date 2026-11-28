// @ts-check
// Members' own bookings: book, list, cancel (the club's cancel cutoff), and "Add to calendar".
// A booking can be several lanes at once (an area with "lanes" in the club's settings, up to
// its max_per_booking): one row per lane, linked by group_id, shown and cancelled as one.

import { bookingWindow, openRanges, withinOpenHours } from "../availability.js";
import { BOOKING_LIMIT, CANCEL_CUTOFF_SECONDS, MAX_MEMBER_SECONDS, insertMemberBooking } from "../bookings.js";
import { CLUB } from "../club.js";
import { activeSuspension, suspendedMessage } from "../discipline.js";
import { HttpError, json } from "../http.js";
import { bookingIcs } from "../ics.js";
import { SLOT_SECONDS, clubParts } from "../time.js";
import { idParam, int, onlyFields } from "../validate.js";

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

/** "Lane 3", "Lane 3 and Lane 4". @param {string[]} names */
const namesOf = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The resource or lanes asked for: resource_id, or resource_ids (several lanes). @param {Record<string, unknown>} body */
function resourceIdsOf(body) {
  if (body.resource_ids === undefined) return [int(body, "resource_id", { min: 1, max: Number.MAX_SAFE_INTEGER, label: "the place" })];
  if (body.resource_id !== undefined) throw new HttpError(400, "bad_input", "Please choose the lanes again.");
  const list = body.resource_ids;
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) throw new HttpError(400, "bad_input", "Please choose the lanes again.");
  const ids = list.map((v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0));
  if (ids.includes(0) || new Set(ids).size !== ids.length) throw new HttpError(400, "bad_input", "Please choose the lanes again.");
  return ids;
}

/**
 * The active resources asked for. Several at once only for lanes in the same area, up to
 * that area's max_per_booking. More (the whole alley) is a party request, not a booking.
 * @param {D1Database} db @param {number[]} ids
 */
async function bookableResources(db, ids) {
  /** @type {Array<{ id: number, name: string, area: string }>} */
  const found = [];
  for (const id of ids) {
    const row = await db.prepare("SELECT id, name, area FROM resources WHERE id = ? AND active = 1").bind(id).first();
    if (!row) throw new HttpError(404, "not_found", "We couldn't find that court or room.");
    found.push({ id: Number(row.id), name: String(row.name), area: String(row.area) });
  }
  if (found.length > 1) {
    const area = CLUB.areas.find((a) => a.id === found[0]?.area);
    if (!area?.lanes || found.some((r) => r.area !== area.id)) {
      throw new HttpError(400, "bad_input", "Only lanes in the same area can be booked together.");
    }
    if (found.length > area.lanes.max_per_booking) {
      throw new HttpError(
        400,
        "too_many_lanes",
        `You can book up to ${area.lanes.max_per_booking} at once. For more, or the whole alley, ask the club about a party (Bar & Banquets).`,
      );
    }
  }
  return found;
}

/** @param {Ctx} ctx */
async function createBooking(ctx) {
  const { env, now, body } = ctx;
  const member = memberOf(ctx);
  onlyFields(body, ["resource_id", "resource_ids", "starts_at", "ends_at", "agree"]);
  const ids = resourceIdsOf(body);
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

  const resources = await bookableResources(env.DB, ids);
  for (const resource of resources) {
    if (!withinOpenHours(await openRanges(env.DB, resource.id, date), start, end)) {
      throw new HttpError(400, "closed", "That time is outside the opening hours. Please pick another.");
    }
  }

  // Saved only if it stays within the club's booking limit (see ../bookings.js).
  const id = await insertMemberBooking(env.DB, BOOKING_LIMIT, { resourceIds: ids, memberId: member.memberId, start, end, now });
  const booking = bookingView({ id, resource_name: namesOf(resources.map((r) => r.name)), starts_at: start, ends_at: end }, now);
  return json({ booking }, 201);
}

/**
 * The member's active bookings that haven't ended, one entry per booking: lanes booked
 * together come back as one ("Lane 3 and Lane 4"), under the id of its first active row.
 * @param {Ctx} ctx @param {number | null} [only] just the booking this row belongs to
 */
async function groupedBookings(ctx, only = null) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT b.id, COALESCE(b.group_id, b.id) AS booking, b.starts_at, b.ends_at, r.name AS resource_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.member_id = ? AND b.status = 'active' AND b.ends_at > ?
     ORDER BY b.starts_at, r.sort_order, r.name, b.id`,
  )
    .bind(memberOf(ctx).memberId, ctx.now)
    .all();
  /** @type {Map<number, { id: number, key: number, starts_at: number, ends_at: number, names: string[] }>} */
  const groups = new Map();
  for (const row of results) {
    const key = Number(row.booking);
    const group = groups.get(key) ?? { id: Number(row.id), key, starts_at: Number(row.starts_at), ends_at: Number(row.ends_at), names: [] };
    group.names.push(String(row.resource_name));
    groups.set(key, group);
  }
  const list = [...groups.values()];
  return only === null ? list : list.filter((g) => g.key === only);
}

/** @param {Ctx} ctx */
async function myBookings(ctx) {
  const groups = await groupedBookings(ctx);
  return json({ bookings: groups.map((g) => bookingView({ ...g, resource_name: namesOf(g.names) }, ctx.now)) });
}

/**
 * The member's own active booking (all its lanes), or 404, also for anyone else's: we
 * never confirm it exists.
 * @param {Ctx} ctx
 */
async function ownBooking(ctx) {
  const id = idParam(ctx.params[0]);
  const row = await ctx.env.DB.prepare("SELECT COALESCE(group_id, id) AS booking FROM bookings WHERE id = ? AND member_id = ? AND status = 'active'")
    .bind(id, memberOf(ctx).memberId)
    .first();
  const group = row ? (await groupedBookings(ctx, Number(row.booking)))[0] : undefined;
  if (!group) throw new HttpError(404, "not_found", "We couldn't find that booking. It may already be cancelled.");
  return { ...group, resource_name: namesOf(group.names) };
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
  // Every lane of the booking at once.
  const cancelled = await ctx.env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?1, cancelled_by = 'member'
     WHERE (id = ?2 OR group_id = ?2) AND member_id = ?3 AND status = 'active' AND starts_at - ?1 >= ?4
     RETURNING id`,
  )
    .bind(ctx.now, row.key, memberOf(ctx).memberId, CANCEL_CUTOFF_SECONDS)
    .first();
  if (!cancelled) throw new HttpError(404, "not_found", "We couldn't find that booking. It may already be cancelled.");
  return json({ ok: true });
}

/** @param {Ctx} ctx */
async function bookingCalendar(ctx) {
  const row = await ownBooking(ctx);
  const summary = `${String(row.resource_name)} booking`;
  const body = bookingIcs({
    uid: `booking-${row.key}@${ctx.url.hostname}`,
    start: Number(row.starts_at),
    end: Number(row.ends_at),
    now: ctx.now,
    summary,
    description: "Bookings can be cancelled up to 24 hours before the start time. If you can't make it, please let management know.",
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="booking-${row.key}.ics"`,
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
