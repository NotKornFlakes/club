// @ts-check
// Opening hours and 15-minute slots for one resource on one club date. Members only ever
// see "free", "taken" or "past": never who booked.

import { CLUB } from "./club.js";
import { SLOT_SECONDS, addDays, clubTimeToUtc, clubToday, weekdayOf } from "./time.js";

/** Members can book any slot on or before the club date this many days from today (club settings). */
export const BOOKING_WINDOW_DAYS = CLUB.booking.days_ahead;

/** @typedef {{ start: number, end: number }} Range */
/** @typedef {{ start: number, end: number, state: "free" | "taken" | "past" }} Slot */

/**
 * The first and last club dates a member can book.
 * @param {number} now Unix seconds
 */
export function bookingWindow(now) {
  const first = clubToday(now);
  return { first, last: addDays(first, BOOKING_WINDOW_DAYS) };
}

/**
 * When a resource is open on a club date, as UTC ranges (a day can have split hours).
 * @param {D1Database} db @param {number} resourceId @param {string} date YYYY-MM-DD
 * @returns {Promise<Range[]>}
 */
export async function openRanges(db, resourceId, date) {
  const { results } = await db
    .prepare(
      "SELECT opens_local, closes_local FROM opening_hours WHERE resource_id = ? AND weekday = ? ORDER BY opens_local",
    )
    .bind(resourceId, weekdayOf(date))
    .all();
  return results.map((row) => ({
    start: clubTimeToUtc(date, String(row.opens_local)),
    end: clubTimeToUtc(date, String(row.closes_local)),
  }));
}

/**
 * Every 15-minute slot in the open hours, marked free, taken or past.
 * @param {D1Database} db @param {number} resourceId @param {string} date @param {number} now
 * @returns {Promise<Slot[]>}
 */
export async function daySlots(db, resourceId, date, now) {
  const ranges = await openRanges(db, resourceId, date);
  if (ranges.length === 0) return [];
  const from = Math.min(...ranges.map((r) => r.start));
  const to = Math.max(...ranges.map((r) => r.end));
  const { results } = await db
    .prepare("SELECT slot_start FROM booking_slots WHERE resource_id = ? AND slot_start >= ? AND slot_start < ?")
    .bind(resourceId, from, to)
    .all();
  const taken = new Set(results.map((row) => Number(row.slot_start)));

  /** @type {Slot[]} */
  const slots = [];
  for (const range of ranges) {
    for (let start = range.start; start < range.end; start += SLOT_SECONDS) {
      /** @type {Slot["state"]} */
      const state = start <= now ? "past" : taken.has(start) ? "taken" : "free";
      slots.push({ start, end: start + SLOT_SECONDS, state });
    }
  }
  return slots;
}

/**
 * Does [start, end) sit inside one opening range on that club date?
 * @param {Range[]} ranges @param {number} start @param {number} end
 */
export function withinOpenHours(ranges, start, end) {
  return ranges.some((range) => start >= range.start && end <= range.end);
}
