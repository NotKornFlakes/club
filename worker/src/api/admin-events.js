// @ts-check
// Admin: club events at other locations (members see them view-only).

import { auditEntry } from "../audit.js";
import { HttpError, json } from "../http.js";
import { clubTimeToUtc, isClubTime } from "../time.js";
import { date, idParam, onlyFields, optionalStr, str } from "../validate.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** @param {Ctx} ctx */
const adminId = (ctx) => /** @type {import("../sessions.js").AdminSession} */ (ctx.admin).adminId;
const FIELDS = ["title", "location", "details", "start_date", "start_time", "end_date", "end_time"];

/** @param {Record<string, unknown>} body @param {string} key @param {string} label */
function time(body, key, label) {
  const value = str(body, key, { max: 5, label });
  if (!isClubTime(value) || value === "24:00") throw new HttpError(400, "bad_input", `Please check ${label}.`);
  return value;
}

/** @param {Record<string, unknown>} body */
function readEvent(body) {
  onlyFields(body, FIELDS);
  const title = str(body, "title", { max: 120, label: "the title" });
  const location = str(body, "location", { max: 120, label: "the place" });
  const details = optionalStr(body, "details", { max: 2000, label: "the details" });
  const start = clubTimeToUtc(date(body, "start_date", "the start date"), time(body, "start_time", "the start time"));
  const end = clubTimeToUtc(date(body, "end_date", "the end date"), time(body, "end_time", "the end time"));
  if (end <= start) throw new HttpError(400, "bad_input", "The event must end after it starts.");
  return { title, location, details, start, end };
}

/** @param {Ctx} ctx @param {number} id @returns {Promise<string>} the title */
async function eventExists(ctx, id) {
  const row = await ctx.env.DB.prepare("SELECT title FROM club_events WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that event.");
  return String(row.title);
}

/** @param {Ctx} ctx */
async function listEvents(ctx) {
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, title, location, details, starts_at, ends_at FROM club_events WHERE ends_at > ? ORDER BY starts_at LIMIT 500",
  )
    .bind(ctx.now - 30 * 86_400)
    .all();
  return json({ events: results });
}

/** @param {Ctx} ctx */
async function createEvent(ctx) {
  const e = readEvent(ctx.body);
  const [created] = /** @type {D1Result<Record<string, unknown>>[]} */ (
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO club_events (title, location, details, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(e.title, e.location, e.details, e.start, e.end, adminId(ctx), ctx.now, ctx.now),
      auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "event.create", details: { title: e.title, starts_at: e.start } }),
    ])
  );
  return json({ id: Number(created?.results[0]?.id) }, 201);
}

/** @param {Ctx} ctx */
async function updateEvent(ctx) {
  const id = idParam(ctx.params[0]);
  const e = readEvent(ctx.body);
  await eventExists(ctx, id);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE club_events SET title = ?, location = ?, details = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?",
    ).bind(e.title, e.location, e.details, e.start, e.end, ctx.now, id),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "event.update", target: `event:${id}`, details: { title: e.title } }),
  ]);
  return json({ ok: true });
}

/** @param {Ctx} ctx */
async function deleteEvent(ctx) {
  onlyFields(ctx.body, []);
  const id = idParam(ctx.params[0]);
  const title = await eventExists(ctx, id);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM club_events WHERE id = ?").bind(id),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "event.delete", target: `event:${id}`, details: { title } }),
  ]);
  return json({ ok: true });
}

/** @type {Route[]} */
export const adminEventRoutes = [
  { method: "GET", path: "/api/admin/events", access: "admin", handler: listEvents },
  { method: "POST", path: "/api/admin/events", access: "admin", handler: createEvent },
  { method: "POST", path: "/api/admin/events/:id/update", access: "admin", handler: updateEvent },
  { method: "POST", path: "/api/admin/events/:id/delete", access: "admin", handler: deleteEvent },
];
