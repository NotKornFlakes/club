// @ts-check
// What members can see before booking: the resources, and each day's 15-minute grid.

import { bookingWindow, daySlots } from "../availability.js";
import { HttpError, json } from "../http.js";
import { isClubDate } from "../time.js";
import { idParam } from "../validate.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/**
 * An active resource, or 404.
 * @param {D1Database} db @param {number} id
 */
export async function activeResource(db, id) {
  const row = await db.prepare("SELECT id, name FROM resources WHERE id = ? AND active = 1").bind(id).first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that court or room.");
  return { id: Number(row.id), name: String(row.name) };
}

/** @param {Ctx} ctx */
async function listResources(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT id, name FROM resources WHERE active = 1 ORDER BY sort_order, name").all();
  const window = bookingWindow(ctx.now);
  return json({
    resources: results.map((r) => ({ id: Number(r.id), name: String(r.name) })),
    first_date: window.first,
    last_date: window.last,
  });
}

/** @param {Ctx} ctx */
async function availability(ctx) {
  const resourceId = idParam(ctx.url.searchParams.get("resource_id"));
  const date = ctx.url.searchParams.get("date") ?? "";
  if (!isClubDate(date)) throw new HttpError(400, "bad_input", "Please pick a date.");
  const window = bookingWindow(ctx.now);
  if (date < window.first || date > window.last) {
    throw new HttpError(400, "outside_window", "You can book up to 30 days ahead.", window);
  }
  const resource = await activeResource(ctx.env.DB, resourceId);
  const slots = await daySlots(ctx.env.DB, resource.id, date, ctx.now);
  return json({ resource, date, first_date: window.first, last_date: window.last, open: slots.length > 0, slots });
}

/** @type {Route[]} */
export const availabilityRoutes = [
  { method: "GET", path: "/api/resources", access: "member", handler: listResources },
  { method: "GET", path: "/api/availability", access: "member", handler: availability },
];
