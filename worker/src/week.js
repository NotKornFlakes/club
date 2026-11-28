// @ts-check
// The week view: seven days of 15-minute slots for one area of the club (for example Gym,
// Bowling lanes or Rooms). Public, so it shows only what anyone may see: whether a time is
// free, taken, closed or past, and the names of programs (leagues marked public). Never who
// booked, never admin labels, never a private league's name.

import { bookingWindow } from "./availability.js";
import { CLUB } from "./club.js";
import { SLOT_SECONDS, addDays, clubTimeToUtc, clubToday, weekdayOf } from "./time.js";

export const WEEK_DAYS = 7;
/** How far ahead the week view looks: programs are set for a season. */
export const VIEW_DAYS_AHEAD = 91;

/**
 * One character per 15-minute slot:
 *   f free to book · l open, but further ahead than members can book · t taken
 *   x closed · o already started · A, B, C... a program (its index in `programs`)
 */
export const SLOT = Object.freeze({ free: "f", later: "l", taken: "t", closed: "x", past: "o" });
const MAX_PROGRAMS = 26;

/**
 * @typedef {{
 *   area: { id: string, name: string, any_label: string | null, lanes: { max_per_booking: number } | null },
 *   areas: Array<{ id: string, name: string }>,
 *   resources: Array<{ id: number, name: string }>,
 *   from: string, today: string, now: number, prev: string | null, next: string | null,
 *   last_book_date: string,
 *   grid: { start: string, end: string, slot_minutes: number } | null,
 *   programs: string[],
 *   days: Array<{ date: string, weekday: number, starts: number[], slots: Record<string, string> }>,
 * }} WeekView
 */

/** "08:00" → 480. @param {string} hhmm */
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** 480 → "08:00". @param {number} m */
const hhmmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * The first date the view may start on, and the last.
 * @param {number} now
 */
export function viewRange(now) {
  const today = clubToday(now);
  return { first: today, last: addDays(today, VIEW_DAYS_AHEAD - WEEK_DAYS) };
}

/**
 * @param {D1Database} db
 * @param {{ area: string, from: string, now: number }} options from = first date, already in range
 * @returns {Promise<WeekView>}
 */
export async function weekView(db, { area, from, now }) {
  const def = CLUB.areas.find((a) => a.id === area);
  if (!def) throw new RangeError(`unknown area ${area}`);
  const range = viewRange(now);
  const window = bookingWindow(now);

  const { results: resourceRows } = await db
    .prepare("SELECT id, name FROM resources WHERE active = 1 AND area = ? ORDER BY sort_order, name")
    .bind(area)
    .all();
  const resources = resourceRows.map((r) => ({ id: Number(r.id), name: String(r.name) }));

  const { results: hourRows } = await db
    .prepare(
      `SELECT h.resource_id, h.weekday, h.opens_local, h.closes_local
       FROM opening_hours h JOIN resources r ON r.id = h.resource_id
       WHERE r.active = 1 AND r.area = ?`,
    )
    .bind(area)
    .all();

  // The grid runs from the earliest opening to the latest closing in this area, in whole hours.
  const opens = hourRows.map((h) => minutesOf(String(h.opens_local)));
  const closes = hourRows.map((h) => minutesOf(String(h.closes_local)));
  const grid =
    opens.length === 0
      ? null
      : { start: Math.floor(Math.min(...opens) / 60) * 60, end: Math.min(24 * 60, Math.ceil(Math.max(...closes) / 60) * 60) };

  const rangeStart = clubTimeToUtc(from, "00:00");
  const rangeEnd = clubTimeToUtc(addDays(from, WEEK_DAYS), "00:00");
  const { results: takenRows } = await db
    .prepare(
      `SELECT s.resource_id, s.slot_start, l.name AS program
       FROM booking_slots s
       JOIN bookings b ON b.id = s.booking_id
       JOIN resources r ON r.id = s.resource_id
       LEFT JOIN leagues l ON l.id = b.league_id AND l.public = 1
       WHERE r.active = 1 AND r.area = ? AND s.slot_start >= ? AND s.slot_start < ?`,
    )
    .bind(area, rangeStart, rangeEnd)
    .all();

  const programs = [...new Set(takenRows.map((t) => t.program).filter((p) => typeof p === "string"))].sort().slice(0, MAX_PROGRAMS);
  /** resource id → slot start → state character */
  const taken = new Map(resources.map((r) => [r.id, new Map()]));
  for (const t of takenRows) {
    const index = typeof t.program === "string" ? programs.indexOf(t.program) : -1;
    taken.get(Number(t.resource_id))?.set(Number(t.slot_start), index >= 0 ? String.fromCharCode(65 + index) : SLOT.taken);
  }

  const days = [];
  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const date = addDays(from, i);
    const weekday = weekdayOf(date);
    /** @type {number[]} */
    const starts = [];
    if (grid) {
      // Usually one conversion is enough. On a daylight-saving day inside the grid's hours,
      // convert every slot instead.
      const count = (grid.end - grid.start) / (SLOT_SECONDS / 60);
      const first = clubTimeToUtc(date, hhmmOf(grid.start));
      const last = clubTimeToUtc(date, hhmmOf(grid.end - SLOT_SECONDS / 60));
      for (let k = 0; k < count; k += 1) {
        starts.push(last - first === (count - 1) * SLOT_SECONDS ? first + k * SLOT_SECONDS : clubTimeToUtc(date, hhmmOf(grid.start + k * 15)));
      }
    }
    /** @type {Record<string, string>} */
    const slots = {};
    for (const r of resources) {
      const open = hourRows
        .filter((h) => Number(h.resource_id) === r.id && Number(h.weekday) === weekday)
        .map((h) => ({ start: clubTimeToUtc(date, String(h.opens_local)), end: clubTimeToUtc(date, String(h.closes_local)) }));
      const booked = taken.get(r.id);
      slots[String(r.id)] = starts
        .map((start) => {
          const state = booked?.get(start);
          if (state) return state;
          if (!open.some((o) => start >= o.start && start + SLOT_SECONDS <= o.end)) return SLOT.closed;
          if (start <= now) return SLOT.past;
          if (date > window.last) return SLOT.later;
          return SLOT.free;
        })
        .join("");
    }
    days.push({ date, weekday, starts, slots });
  }

  return {
    area: { id: def.id, name: def.name, any_label: def.any_label, lanes: def.lanes },
    areas: CLUB.areas.map((a) => ({ id: a.id, name: a.name })),
    resources,
    from,
    today: range.first,
    now,
    prev: from > range.first ? (addDays(from, -WEEK_DAYS) < range.first ? range.first : addDays(from, -WEEK_DAYS)) : null,
    next: addDays(from, WEEK_DAYS) <= range.last ? addDays(from, WEEK_DAYS) : null,
    last_book_date: window.last,
    grid: grid ? { start: hhmmOf(grid.start), end: hhmmOf(grid.end), slot_minutes: SLOT_SECONDS / 60 } : null,
    programs,
    days,
  };
}
