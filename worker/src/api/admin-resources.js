// @ts-check
// Admin: courts and rooms (create, rename, order, retire) and their weekly opening hours,
// and loading the club's starting list (from its settings file) into an empty list.

import { auditEntry } from "../audit.js";
import { CLUB } from "../club.js";
import { HttpError, json } from "../http.js";
import { isQuarterHour } from "../time.js";
import { bool, idParam, int, onlyFields, str } from "../validate.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** @param {Ctx} ctx */
const adminId = (ctx) => /** @type {import("../sessions.js").AdminSession} */ (ctx.admin).adminId;

/** @param {Ctx} ctx */
async function listResources(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT id, name, active, sort_order FROM resources ORDER BY sort_order, name").all();
  const hours = await ctx.env.DB.prepare(
    "SELECT resource_id, weekday, opens_local, closes_local FROM opening_hours ORDER BY weekday, opens_local",
  ).all();
  return json({
    resources: results.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      active: r.active === 1,
      sort_order: Number(r.sort_order),
      hours: hours.results
        .filter((h) => h.resource_id === r.id)
        .map((h) => ({ weekday: Number(h.weekday), opens: String(h.opens_local), closes: String(h.closes_local) })),
    })),
  });
}

/** @param {Record<string, unknown>} body */
const resourceName = (body) => str(body, "name", { max: 60, label: "the name" });

/** @param {Ctx} ctx */
async function createResource(ctx) {
  onlyFields(ctx.body, ["name", "sort_order"]);
  const name = resourceName(ctx.body);
  const sort = ctx.body.sort_order === undefined ? 0 : int(ctx.body, "sort_order", { min: -1000, max: 1000, label: "the order" });
  const clash = await ctx.env.DB.prepare("SELECT id FROM resources WHERE name = ?").bind(name).first();
  if (clash) throw new HttpError(409, "exists", "There's already a court or room with that name.");
  const [created] = /** @type {D1Result<Record<string, unknown>>[]} */ (
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO resources (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id").bind(
        name,
        sort,
        ctx.now,
        ctx.now,
      ),
      auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "resource.create", target: `resource:${name}` }),
    ])
  );
  return json({ id: Number(created?.results[0]?.id) }, 201);
}

/** Rename, reorder, or retire / bring back. Resources are never deleted (bookings point at them). @param {Ctx} ctx */
async function updateResource(ctx) {
  onlyFields(ctx.body, ["name", "active", "sort_order"]);
  const id = idParam(ctx.params[0]);
  const name = resourceName(ctx.body);
  const active = bool(ctx.body, "active");
  const sort = int(ctx.body, "sort_order", { min: -1000, max: 1000, label: "the order" });
  if (!(await ctx.env.DB.prepare("SELECT id FROM resources WHERE id = ?").bind(id).first())) {
    throw new HttpError(404, "not_found", "We couldn't find that court or room.");
  }
  const clash = await ctx.env.DB.prepare("SELECT id FROM resources WHERE name = ? AND id <> ?").bind(name, id).first();
  if (clash) throw new HttpError(409, "exists", "There's already a court or room with that name.");
  await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE resources SET name = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?").bind(
        name,
        active ? 1 : 0,
        sort,
        ctx.now,
        id,
      ),
      auditEntry(ctx.env.DB, {
        at: ctx.now,
        adminId: adminId(ctx),
        action: "resource.update",
        target: `resource:${id}`,
        details: { name, active, sort_order: sort },
      }),
  ]);
  return json({ ok: true });
}

/**
 * Replaces a resource's weekly hours. Each day can have several ranges (e.g. 9-12 and 14-20),
 * on quarter hours, within one day, not overlapping. A day with no range is closed.
 * @param {Ctx} ctx
 */
async function setHours(ctx) {
  onlyFields(ctx.body, ["hours"]);
  const id = idParam(ctx.params[0]);
  const exists = await ctx.env.DB.prepare("SELECT id FROM resources WHERE id = ?").bind(id).first();
  if (!exists) throw new HttpError(404, "not_found", "We couldn't find that court or room.");
  const list = ctx.body.hours;
  if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, "bad_input", "Please check the opening hours.");
  /** @type {Array<{ weekday: number, opens: string, closes: string }>} */
  const hours = [];
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400, "bad_input", "Please check the opening hours.");
    const row = /** @type {Record<string, unknown>} */ (item);
    onlyFields(row, ["weekday", "opens", "closes"]);
    const weekday = int(row, "weekday", { min: 0, max: 6, label: "the day" });
    const opens = str(row, "opens", { max: 5, label: "the opening time" });
    const closes = str(row, "closes", { max: 5, label: "the closing time" });
    if (!isQuarterHour(opens) || !isQuarterHour(closes) || opens === "24:00") {
      throw new HttpError(400, "bad_input", "Opening hours must be on the quarter hour (:00, :15, :30 or :45).");
    }
    if (opens >= closes) throw new HttpError(400, "bad_input", "Each closing time must be after its opening time, on the same day.");
    hours.push({ weekday, opens, closes });
  }
  hours.sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens));
  for (let i = 1; i < hours.length; i += 1) {
    const before = hours[i - 1];
    const current = hours[i];
    if (before && current && before.weekday === current.weekday && current.opens < before.closes) {
      throw new HttpError(400, "bad_input", "Two opening times on the same day overlap.");
    }
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM opening_hours WHERE resource_id = ?").bind(id),
    ...hours.map((h) =>
      ctx.env.DB.prepare("INSERT INTO opening_hours (resource_id, weekday, opens_local, closes_local) VALUES (?, ?, ?, ?)").bind(
        id,
        h.weekday,
        h.opens,
        h.closes,
      ),
    ),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "resource.hours", target: `resource:${id}`, details: { hours } }),
  ]);
  return json({ ok: true });
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Adds the club's starting courts and rooms from its settings file, each open the same hours
 * every day. Only while there are none: after that, the admin pages own them.
 * @param {Ctx} ctx
 */
async function loadStartingList(ctx) {
  onlyFields(ctx.body, []);
  const db = ctx.env.DB;
  const notEmpty = () => new HttpError(409, "not_empty", "The club's starting list can only be added while there are no courts or rooms.");
  if (await db.prepare("SELECT id FROM resources LIMIT 1").first()) throw notEmpty();
  const { opens, closes } = CLUB.starting_hours;
  try {
    await db.batch([
      ...CLUB.starting_resources.flatMap((name, i) => [
        db.prepare("INSERT INTO resources (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(name, i + 1, ctx.now, ctx.now),
        ...WEEKDAYS.map((weekday) =>
          db
            .prepare("INSERT INTO opening_hours (resource_id, weekday, opens_local, closes_local) SELECT id, ?, ?, ? FROM resources WHERE name = ?")
            .bind(weekday, opens, closes, name),
        ),
      ]),
      auditEntry(db, {
        at: ctx.now,
        adminId: adminId(ctx),
        action: "resource.starting_list",
        details: { resources: CLUB.starting_resources, opens, closes },
      }),
    ]);
  } catch (error) {
    // Another admin added a court or room at the same moment; the batch changed nothing.
    if (String(error).includes("UNIQUE")) throw notEmpty();
    throw error;
  }
  return json({ added: CLUB.starting_resources.length }, 201);
}

/** @type {Route[]} */
export const adminResourceRoutes = [
  { method: "GET", path: "/api/admin/resources", access: "admin", handler: listResources },
  { method: "POST", path: "/api/admin/resources", access: "admin", handler: createResource },
  { method: "POST", path: "/api/admin/resources/starting-list", access: "admin", handler: loadStartingList },
  { method: "POST", path: "/api/admin/resources/:id/update", access: "admin", handler: updateResource },
  { method: "POST", path: "/api/admin/resources/:id/hours", access: "admin", handler: setHours },
];
