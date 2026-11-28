// @ts-check
// Admin: the day's schedule with who booked each slot, one-off admin bookings (no date
// limit, no member rules), and cancelling any booking at any time.

import { daySlots } from "../availability.js";
import { auditEntry } from "../audit.js";
import { HttpError, json } from "../http.js";
import { DAY_SECONDS, SLOT_SECONDS, clubTimeToUtc, isClubDate } from "../time.js";
import { bool, date, idParam, int, onlyFields, optionalStr, quarterTime } from "../validate.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** @param {Ctx} ctx */
const adminId = (ctx) => /** @type {import("../sessions.js").AdminSession} */ (ctx.admin).adminId;

/** Who a booking is for, in words the admin understands. @param {Record<string, unknown>} b */
export function bookedBy(b) {
  if (b.kind === "member") {
    return b.display_name ? `Member ${String(b.member_number)} (${String(b.display_name)})` : `Member ${String(b.member_number)}`;
  }
  if (b.kind === "league") return `League: ${String(b.league_name ?? b.label ?? "")}`;
  return `Admin: ${String(b.label ?? "booking")}`;
}

/** @param {Record<string, unknown>} b */
function bookingView(b) {
  return {
    id: Number(b.id),
    kind: String(b.kind),
    resource: String(b.resource),
    starts_at: Number(b.starts_at),
    ends_at: Number(b.ends_at),
    booked_by: bookedBy(b),
  };
}

/** @param {Ctx} ctx */
async function schedule(ctx) {
  const resourceId = idParam(ctx.url.searchParams.get("resource_id"));
  const day = ctx.url.searchParams.get("date") ?? "";
  if (!isClubDate(day)) throw new HttpError(400, "bad_input", "Please pick a date.");
  const resource = await ctx.env.DB.prepare("SELECT id, name, active FROM resources WHERE id = ?").bind(resourceId).first();
  if (!resource) throw new HttpError(404, "not_found", "We couldn't find that court or room.");
  const from = clubTimeToUtc(day, "00:00");
  const to = clubTimeToUtc(day, "24:00");
  const { results } = await ctx.env.DB.prepare(
    `SELECT b.id, b.kind, b.label, b.starts_at, b.ends_at, r.name AS resource,
            m.member_number, m.display_name, l.name AS league_name
     FROM bookings b
     JOIN resources r ON r.id = b.resource_id
     LEFT JOIN members m ON m.id = b.member_id
     LEFT JOIN leagues l ON l.id = b.league_id
     WHERE b.resource_id = ? AND b.status = 'active' AND b.starts_at < ? AND b.ends_at > ?
     ORDER BY b.starts_at`,
  )
    .bind(resourceId, to, from)
    .all();
  const bookings = results.map(bookingView);
  const slots = (await daySlots(ctx.env.DB, resourceId, day, ctx.now)).map((slot) => {
    const booking = bookings.find((b) => b.starts_at <= slot.start && b.ends_at > slot.start);
    return { ...slot, booking_id: booking?.id ?? null, booked_by: booking?.booked_by ?? null };
  });
  return json({ resource: { id: Number(resource.id), name: String(resource.name), active: resource.active === 1 }, date: day, slots, bookings });
}

/** @param {Ctx} ctx */
async function createAdminBooking(ctx) {
  const { body, env, now } = ctx;
  onlyFields(body, ["resource_id", "start_date", "start_time", "end_date", "end_time", "label", "whole_area"]);
  const resourceId = int(body, "resource_id", { min: 1, max: Number.MAX_SAFE_INTEGER, label: "the place" });
  const start = clubTimeToUtc(date(body, "start_date", "the start date"), quarterTime(body, "start_time", "the start time"));
  const end = clubTimeToUtc(date(body, "end_date", "the end date"), quarterTime(body, "end_time", "the end time"));
  const label = optionalStr(body, "label", { max: 80, label: "the label" }) ?? "Admin booking";
  if (end <= start || start % SLOT_SECONDS !== 0 || end % SLOT_SECONDS !== 0) {
    throw new HttpError(400, "bad_input", "The booking must end after it starts.");
  }
  if (end - start > 30 * DAY_SECONDS) {
    throw new HttpError(400, "too_long", "One admin booking can be at most 30 days. For a longer closure, make two.");
  }
  if (end <= now) throw new HttpError(400, "bad_input", "That time is already over.");
  const resource = await env.DB.prepare("SELECT name, area FROM resources WHERE id = ?").bind(resourceId).first();
  if (!resource) throw new HttpError(404, "not_found", "We couldn't find that court or room.");
  // "Book all lanes": every active resource in this one's area, as one booking.
  const wholeArea = body.whole_area === undefined ? false : bool(body, "whole_area");
  /** @type {number[]} */
  let ids = [resourceId];
  if (wholeArea) {
    if (String(resource.area) === "") throw new HttpError(400, "bad_input", "That court or room isn't in an area yet.");
    const { results: all } = await env.DB.prepare("SELECT id FROM resources WHERE area = ? AND active = 1 ORDER BY sort_order, name, id")
      .bind(String(resource.area))
      .all();
    ids = all.map((r) => Number(r.id));
  }
  const [lead, ...more] = ids;
  /** @type {D1Result<Record<string, unknown>>[]} */
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id)
         VALUES (?, 'admin', ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(lead, label, start, end, now, adminId(ctx)),
      // The other lanes point at the first one: one booking, cancelled as one.
      ...more.map((id) =>
        env.DB.prepare(
          `INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id, group_id)
           SELECT ?1, 'admin', ?2, ?3, ?4, ?5, ?6, lead.id FROM bookings lead
           WHERE lead.resource_id = ?7 AND lead.kind = 'admin' AND lead.starts_at = ?3 AND lead.ends_at = ?4
             AND lead.created_at = ?5 AND lead.status = 'active' AND lead.group_id IS NULL`,
        ).bind(id, label, start, end, now, adminId(ctx), lead),
      ),
      auditEntry(env.DB, {
        at: now,
        adminId: adminId(ctx),
        action: "booking.admin_create",
        target: wholeArea ? `area:${String(resource.area)}` : `resource:${resourceId}`,
        details: { label, starts_at: start, ends_at: end, ...(wholeArea ? { whole_area: String(resource.area), resources: ids.length } : {}) },
      }),
    ]);
  } catch (error) {
    if (String(error).includes("slot_taken")) {
      const which = wholeArea ? "One of the lanes is already booked then." : "That time clashes with an existing booking.";
      throw new HttpError(409, "slot_taken", `${which} Cancel it first if you need the time.`);
    }
    throw error;
  }
  return json({ id: Number(results[0]?.results[0]?.id), resources: ids.length }, 201);
}

/** Admins can cancel any booking at any time, including within 24 hours. @param {Ctx} ctx */
async function cancelAnyBooking(ctx) {
  onlyFields(ctx.body, []);
  const id = idParam(ctx.params[0]);
  const row = await ctx.env.DB.prepare(
    `SELECT b.id, b.kind, b.label, b.starts_at, b.ends_at, r.name AS resource,
            m.member_number, m.display_name, l.name AS league_name
     FROM bookings b
     JOIN resources r ON r.id = b.resource_id
     LEFT JOIN members m ON m.id = b.member_id
     LEFT JOIN leagues l ON l.id = b.league_id
     WHERE b.id = ? AND b.status = 'active'`,
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that booking. It may already be cancelled.");
  // The whole booking: every lane booked together with this one.
  const key = Number((await ctx.env.DB.prepare("SELECT COALESCE(group_id, id) AS k FROM bookings WHERE id = ?").bind(id).first())?.k ?? id);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?1, cancelled_by = 'admin', cancelled_by_admin_id = ?2
       WHERE (id = ?3 OR group_id = ?3) AND status = 'active'`,
    ).bind(ctx.now, adminId(ctx), key),
    auditEntry(ctx.env.DB, {
      at: ctx.now,
      adminId: adminId(ctx),
      action: "booking.cancel",
      target: `booking:${id}`,
      details: { booked_by: bookedBy(row), resource: String(row.resource), starts_at: Number(row.starts_at), ends_at: Number(row.ends_at) },
    }),
  ]);
  return json({ ok: true });
}

/** @type {Route[]} */
export const adminScheduleRoutes = [
  { method: "GET", path: "/api/admin/schedule", access: "admin", handler: schedule },
  { method: "POST", path: "/api/admin/bookings", access: "admin", handler: createAdminBooking },
  { method: "POST", path: "/api/admin/bookings/:id/cancel", access: "admin", handler: cancelAnyBooking },
];
