// @ts-check
// GET /api/week?area=gym&from=YYYY-MM-DD: the week view (see ../week.js). Public and
// read-only: anyone can see what's free, taken and on. Booking still needs a member login.

import { CLUB } from "../club.js";
import { HttpError, json } from "../http.js";
import { isClubDate } from "../time.js";
import { viewRange, weekView } from "../week.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** @param {Ctx} ctx */
async function week(ctx) {
  const area = ctx.url.searchParams.get("area") ?? CLUB.areas[0]?.id ?? "";
  if (!CLUB.areas.some((a) => a.id === area)) throw new HttpError(400, "bad_input", `Please choose one of: ${CLUB.areas.map((a) => a.name).join(", ")}.`);
  const range = viewRange(ctx.now);
  const asked = ctx.url.searchParams.get("from") ?? range.first;
  if (!isClubDate(asked)) throw new HttpError(400, "bad_input", "Please choose a date.");
  // An old link (a past week) or one too far ahead shows the nearest week we can show.
  const from = asked < range.first ? range.first : asked > range.last ? range.last : asked;
  return json(await weekView(ctx.env.DB, { area, from, now: ctx.now }));
}

/** @type {Route[]} */
export const weekRoutes = [{ method: "GET", path: "/api/week", access: "public", handler: week }];
