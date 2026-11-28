// @ts-check
// Club events at other locations: view only for members.

import { json } from "../http.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** @param {Ctx} ctx */
async function upcomingEvents(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, title, location, details, starts_at, ends_at FROM club_events
     WHERE ends_at > ? ORDER BY starts_at LIMIT 200`,
  )
    .bind(ctx.now)
    .all();
  return json({
    events: results.map((e) => ({
      id: Number(e.id),
      title: String(e.title),
      location: String(e.location),
      details: e.details === null ? null : String(e.details),
      starts_at: Number(e.starts_at),
      ends_at: Number(e.ends_at),
    })),
  });
}

/** @type {Route[]} */
export const eventRoutes = [{ method: "GET", path: "/api/events", access: "member", handler: upcomingEvents }];
