// @ts-check
// Club time. Everything is stored as Unix seconds (UTC). Open hours, league times and club
// dates are local values in the club's time zone (its settings file), converted per date
// with Intl so they stay right across daylight saving changes. See docs/architecture.md,
// section 6 "Time".

import { CLUB } from "./club.js";

export const CLUB_TIME_ZONE = CLUB.time_zone;
export const SLOT_SECONDS = 900; // 15 minutes
export const DAY_SECONDS = 86_400;

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CLUB_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-4]):([0-5]\d)$/;

/**
 * The club-time calendar parts of a moment.
 * @param {number} unixSeconds
 * @returns {{ date: string, time: string, weekday: number, year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function clubParts(unixSeconds) {
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of partsFormat.formatToParts(new Date(unixSeconds * 1000))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const year = p.year ?? 0;
  const month = p.month ?? 0;
  const day = p.day ?? 0;
  const hour = (p.hour ?? 0) % 24;
  const minute = p.minute ?? 0;
  const second = p.second ?? 0;
  const date = `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
  return { date, time: `${pad(hour)}:${pad(minute)}`, weekday: weekdayOf(date), year, month, day, hour, minute, second };
}

/** @param {number} n */
function pad(n) {
  return String(n).padStart(2, "0");
}

/** Club time minus UTC, in seconds, at a moment (e.g. -18000 for New York in winter). @param {number} unixSeconds */
function offsetAt(unixSeconds) {
  const p = clubParts(unixSeconds);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - unixSeconds;
}

/** @param {string} date @returns {boolean} a real calendar date as YYYY-MM-DD */
export function isClubDate(date) {
  const m = DATE_PATTERN.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

/** @param {string} time @returns {boolean} HH:MM from 00:00 to 24:00 */
export function isClubTime(time) {
  const m = TIME_PATTERN.exec(time);
  return Boolean(m) && (m?.[1] !== "24" || m?.[2] === "00");
}

/** @param {string} time HH:MM on a quarter hour */
export function isQuarterHour(time) {
  return isClubTime(time) && ["00", "15", "30", "45"].includes(time.slice(3));
}

/**
 * The moment a club date and time happens, as Unix seconds. "24:00" means midnight at the
 * end of that date. On the autumn change, a time that happens twice means the first one.
 * (Open hours sit within one day, so the 1-3 a.m. change hour doesn't affect normal hours.)
 * @param {string} date YYYY-MM-DD @param {string} time HH:MM
 */
export function clubTimeToUtc(date, time) {
  if (!isClubDate(date) || !isClubTime(time)) throw new RangeError(`Bad club date/time: ${date} ${time}`);
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wallClock = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0) / 1000;
  let guess = wallClock - offsetAt(wallClock);
  const second = offsetAt(guess);
  if (wallClock - second !== guess) guess = wallClock - second;
  return guess;
}

/** @param {string} date YYYY-MM-DD @param {number} days @returns {string} */
export function addDays(date, days) {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. @param {string} date YYYY-MM-DD */
export function weekdayOf(date) {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1)).getUTCDay();
}

/** Today's club date. @param {number} now Unix seconds */
export function clubToday(now) {
  return clubParts(now).date;
}

/** The start of the 15-minute slot at or after a moment. @param {number} unixSeconds */
export function nextSlot(unixSeconds) {
  return Math.ceil(unixSeconds / SLOT_SECONDS) * SLOT_SECONDS;
}

/** Whole days from one club date to another. @param {string} from @param {string} to */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (DAY_SECONDS * 1000));
}

/**
 * The same day-of-month some months later (or the month's last day if it's shorter).
 * @param {string} date YYYY-MM-DD @param {number} months
 */
export function addMonths(date, months) {
  const [y, mo, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d ?? 1, lastDay));
  return target.toISOString().slice(0, 10);
}
