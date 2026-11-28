// @ts-check
// Admin: leagues and programs. A league is one season: one resource, one weekday, a start and
// end time, and a first and last date at most 12 months out. A league marked public is a
// program: the week view shows it with its name (otherwise just "Taken"). Creating it books every free date in
// one batch; dates that clash with an existing booking are skipped and listed for the admin.
// See docs/architecture.md, section 6 "Leagues".

import { auditEntry } from "../audit.js";
import { HttpError, json } from "../http.js";
import { addDays, addMonths, clubTimeToUtc, clubToday, weekdayOf } from "../time.js";
import { bool, date, idParam, int, onlyFields, quarterTime, str } from "../validate.js";
import { bookedBy } from "./admin-schedule.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */
/** @typedef {{ name: string, resourceId: number, weekday: number, starts: string, ends: string, first: string, last: string, renewedFrom: number | null, isPublic: boolean }} Season */

/** @param {Ctx} ctx */
const adminId = (ctx) => /** @type {import("../sessions.js").AdminSession} */ (ctx.admin).adminId;
const MAX_TRIES = 3;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Every date of the season on its weekday, with its times in UTC. @param {Season} season */
export function seasonDates(season) {
  const dates = [];
  let day = season.first;
  while (weekdayOf(day) !== season.weekday) day = addDays(day, 1);
  for (; day <= season.last; day = addDays(day, 7)) {
    dates.push({ date: day, start: clubTimeToUtc(day, season.starts), end: clubTimeToUtc(day, season.ends) });
  }
  return dates;
}

/** @param {Ctx} ctx @param {Season} season */
function checkSeason(ctx, season) {
  const today = clubToday(ctx.now);
  if (season.ends <= season.starts) throw new HttpError(400, "bad_input", "The league must end after it starts, on the same day.");
  if (season.first < today) throw new HttpError(400, "bad_input", "The first date can't be in the past.");
  if (season.last < season.first) throw new HttpError(400, "bad_input", "The last date must be on or after the first date.");
  if (season.last > addMonths(today, 12)) {
    throw new HttpError(400, "too_long", "A season can end at most 12 months from today. Renew it when it ends.");
  }
}

/**
 * Creates a season: books every free date, records every clash, in one batch. If a member
 * books one of the times in between, the batch fails as a whole and we look again.
 * @param {Ctx} ctx @param {Season} season
 */
async function createSeason(ctx, season) {
  const { env, now } = ctx;
  checkSeason(ctx, season);
  const resource = await env.DB.prepare("SELECT name FROM resources WHERE id = ?").bind(season.resourceId).first();
  if (!resource) throw new HttpError(404, "not_found", "We couldn't find that court or room.");
  const dates = seasonDates(season).filter((d) => d.start > now);
  if (dates.length === 0) throw new HttpError(400, "bad_input", `There's no ${WEEKDAYS[season.weekday]} in those dates.`);

  const league = await env.DB.prepare(
    `INSERT INTO leagues (name, resource_id, weekday, starts_local, ends_local, first_date, last_date, renewed_from, public, created_by_admin_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(season.name, season.resourceId, season.weekday, season.starts, season.ends, season.first, season.last, season.renewedFrom, season.isPublic ? 1 : 0, adminId(ctx), now)
    .first();
  const leagueId = Number(league?.id);

  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    // Which dates already have a booking in that time?
    const found = await env.DB.batch(
      dates.map((d) =>
        env.DB.prepare(
          `SELECT b.id, b.kind, b.label, m.member_number, m.display_name, l.name AS league_name
           FROM booking_slots s JOIN bookings b ON b.id = s.booking_id
           LEFT JOIN members m ON m.id = b.member_id LEFT JOIN leagues l ON l.id = b.league_id
           WHERE s.resource_id = ? AND s.slot_start >= ? AND s.slot_start < ? ORDER BY s.slot_start LIMIT 1`,
        ).bind(season.resourceId, d.start, d.end),
      ),
    );
    const clashes = dates
      .map((d, i) => ({ ...d, booking: /** @type {Record<string, unknown> | undefined} */ (found[i]?.results[0]) }))
      .filter((d) => d.booking !== undefined);
    const free = dates.filter((d) => !clashes.some((c) => c.date === d.date));

    try {
      await env.DB.batch([
        ...free.map((d) =>
          env.DB.prepare(
            `INSERT INTO bookings (resource_id, kind, league_id, label, starts_at, ends_at, created_at, created_by_admin_id)
             VALUES (?, 'league', ?, ?, ?, ?, ?, ?)`,
          ).bind(season.resourceId, leagueId, season.name, d.start, d.end, now, adminId(ctx)),
        ),
        ...clashes.map((c) =>
          env.DB.prepare("INSERT INTO league_skips (league_id, on_date, clashing_booking_id) VALUES (?, ?, ?)").bind(
            leagueId,
            c.date,
            Number(c.booking?.id),
          ),
        ),
        auditEntry(env.DB, {
          at: now,
          adminId: adminId(ctx),
          action: season.renewedFrom ? "league.renew" : "league.create",
          target: `league:${leagueId}`,
          details: {
            name: season.name,
            resource: String(resource.name),
            first_date: season.first,
            last_date: season.last,
            public: season.isPublic,
            booked: free.length,
            skipped: clashes.map((c) => c.date),
          },
        }),
      ]);
      return json(
        {
          league_id: leagueId,
          booked: free.map((d) => d.date),
          skipped: clashes.map((c) => ({ date: c.date, booked_by: bookedBy(c.booking ?? {}) })),
        },
        201,
      );
    } catch (error) {
      if (!String(error).includes("slot_taken") || attempt === MAX_TRIES) {
        await env.DB.prepare("DELETE FROM leagues WHERE id = ?").bind(leagueId).run();
        if (String(error).includes("slot_taken")) {
          throw new HttpError(409, "busy", "Bookings kept changing while the league was being added. Please try again.");
        }
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

/** @param {Record<string, unknown>} body */
function readSeason(body) {
  onlyFields(body, ["name", "resource_id", "weekday", "starts_local", "ends_local", "first_date", "last_date", "public"]);
  return {
    name: str(body, "name", { max: 80, label: "the league name" }),
    resourceId: int(body, "resource_id", { min: 1, max: Number.MAX_SAFE_INTEGER, label: "the place" }),
    weekday: int(body, "weekday", { min: 0, max: 6, label: "the day of the week" }),
    starts: quarterTime(body, "starts_local", "the start time"),
    ends: quarterTime(body, "ends_local", "the end time"),
    first: date(body, "first_date", "the first date"),
    last: date(body, "last_date", "the last date"),
    renewedFrom: null,
    // Public = a program: shown with its name on This Week and Book.
    isPublic: body.public === undefined ? false : bool(body, "public"),
  };
}

/** @param {Ctx} ctx */
async function createLeague(ctx) {
  return createSeason(ctx, readSeason(ctx.body));
}

/** @param {Ctx} ctx @param {number} id */
async function leagueRow(ctx, id) {
  const row = await ctx.env.DB.prepare("SELECT * FROM leagues WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that league.");
  return row;
}

/** The next season: same place, day and times, starting the week after the old one ends. @param {Ctx} ctx */
async function renewLeague(ctx) {
  onlyFields(ctx.body, ["last_date"]);
  const old = await leagueRow(ctx, idParam(ctx.params[0]));
  if (old.cancelled_at !== null) throw new HttpError(400, "cancelled", "That league was cancelled. Create a new one instead.");
  const renewed = await ctx.env.DB.prepare("SELECT id FROM leagues WHERE renewed_from = ? AND cancelled_at IS NULL").bind(old.id).first();
  if (renewed) throw new HttpError(409, "renewed", "That season has already been renewed.");
  const today = clubToday(ctx.now);
  const afterOld = addDays(String(old.last_date), 1);
  return createSeason(ctx, {
    name: String(old.name),
    resourceId: Number(old.resource_id),
    weekday: Number(old.weekday),
    starts: String(old.starts_local),
    ends: String(old.ends_local),
    first: afterOld > today ? afterOld : today,
    last: date(ctx.body, "last_date", "the new last date"),
    renewedFrom: Number(old.id),
    isPublic: Number(old.public) === 1,
  });
}

/** Cancels a league: its future dates are freed. @param {Ctx} ctx */
async function cancelLeague(ctx) {
  onlyFields(ctx.body, []);
  const league = await leagueRow(ctx, idParam(ctx.params[0]));
  if (league.cancelled_at !== null) throw new HttpError(400, "cancelled", "That league is already cancelled.");
  /** @type {D1Result<Record<string, unknown>>[]} */
  const [, freed] = await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE leagues SET cancelled_at = ? WHERE id = ?").bind(ctx.now, league.id),
    ctx.env.DB.prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?1, cancelled_by = 'admin', cancelled_by_admin_id = ?2
       WHERE league_id = ?3 AND status = 'active' AND starts_at > ?1 RETURNING id`,
    ).bind(ctx.now, adminId(ctx), league.id),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "league.cancel", target: `league:${Number(league.id)}`, details: { name: String(league.name) } }),
  ]);
  return json({ cancelled_dates: freed?.results.length ?? 0 });
}

/** @param {Ctx} ctx */
async function listLeagues(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT l.id, l.name, l.weekday, l.starts_local, l.ends_local, l.first_date, l.last_date, l.cancelled_at, l.renewed_from, l.public,
            r.name AS resource,
            (SELECT COUNT(*) FROM bookings b WHERE b.league_id = l.id AND b.status = 'active') AS booked,
            (SELECT COUNT(*) FROM league_skips k WHERE k.league_id = l.id) AS skipped,
            (SELECT COUNT(*) FROM leagues n WHERE n.renewed_from = l.id AND n.cancelled_at IS NULL) AS renewed
     FROM leagues l JOIN resources r ON r.id = l.resource_id
     ORDER BY l.cancelled_at IS NOT NULL, l.last_date DESC LIMIT 200`,
  ).all();
  const today = clubToday(ctx.now);
  return json({
    max_last_date: addMonths(today, 12),
    leagues: results.map((l) => ({
      id: Number(l.id),
      name: String(l.name),
      resource: String(l.resource),
      weekday: WEEKDAYS[Number(l.weekday)],
      starts_local: String(l.starts_local),
      ends_local: String(l.ends_local),
      first_date: String(l.first_date),
      last_date: String(l.last_date),
      public: Number(l.public) === 1,
      cancelled: l.cancelled_at !== null,
      renewed: Number(l.renewed) > 0,
      ended: String(l.last_date) < today,
      booked: Number(l.booked),
      skipped: Number(l.skipped),
    })),
  });
}

/** The clash list for one league. @param {Ctx} ctx */
async function leagueSkips(ctx) {
  const league = await leagueRow(ctx, idParam(ctx.params[0]));
  const { results } = await ctx.env.DB.prepare(
    `SELECT k.on_date, b.kind, b.label, m.member_number, m.display_name, l.name AS league_name
     FROM league_skips k LEFT JOIN bookings b ON b.id = k.clashing_booking_id
     LEFT JOIN members m ON m.id = b.member_id LEFT JOIN leagues l ON l.id = b.league_id
     WHERE k.league_id = ? ORDER BY k.on_date`,
  )
    .bind(league.id)
    .all();
  return json({
    skipped: results.map((r) => ({ date: String(r.on_date), booked_by: r.kind ? bookedBy(r) : "A booking that has since been removed" })),
  });
}

/** @type {Route[]} */
export const adminLeagueRoutes = [
  { method: "GET", path: "/api/admin/leagues", access: "admin", handler: listLeagues },
  { method: "POST", path: "/api/admin/leagues", access: "admin", handler: createLeague },
  { method: "GET", path: "/api/admin/leagues/:id/skips", access: "admin", handler: leagueSkips },
  { method: "POST", path: "/api/admin/leagues/:id/renew", access: "admin", handler: renewLeague },
  { method: "POST", path: "/api/admin/leagues/:id/cancel", access: "admin", handler: cancelLeague },
];
