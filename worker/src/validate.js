// @ts-check
// Hand-written input checks (type, length, format) for request bodies and query strings.
// Every handler names the fields it accepts; anything else is refused.

import { HttpError } from "./http.js";
import { isClubDate, isQuarterHour } from "./time.js";

/** @param {string} message */
function bad(message) {
  return new HttpError(400, "bad_input", message);
}

/**
 * Refuses fields the handler doesn't know about.
 * @param {Record<string, unknown>} body @param {string[]} allowed
 */
export function onlyFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw bad("Something went wrong sending that. Please reload the page and try again.");
  }
}

/**
 * @param {Record<string, unknown>} body @param {string} key
 * @param {{ min?: number, max: number, pattern?: RegExp, label?: string, trim?: boolean }} rules
 * @returns {string}
 */
export function str(body, key, rules) {
  const raw = body[key];
  const label = rules.label ?? key;
  if (typeof raw !== "string") throw bad(`Please fill in ${label}.`);
  const value = rules.trim === false ? raw : raw.trim();
  if (value.length < (rules.min ?? 1)) throw bad(`Please fill in ${label}.`);
  if (value.length > rules.max) throw bad(`${capitalize(label)} is too long.`);
  if (rules.pattern && !rules.pattern.test(value)) throw bad(`Please check ${label}.`);
  return value;
}

/**
 * Like str(), but missing, null or blank gives null.
 * @param {Record<string, unknown>} body @param {string} key
 * @param {{ max: number, pattern?: RegExp, label?: string }} rules
 * @returns {string | null}
 */
export function optionalStr(body, key, rules) {
  const raw = body[key];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  return str(body, key, { ...rules, min: 1 });
}

/**
 * @param {Record<string, unknown>} body @param {string} key
 * @param {{ min: number, max: number, label?: string }} rules
 * @returns {number}
 */
export function int(body, key, rules) {
  const raw = body[key];
  const label = rules.label ?? key;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw bad(`Please check ${label}.`);
  if (raw < rules.min || raw > rules.max) throw bad(`Please check ${label}.`);
  return raw;
}

/** @param {Record<string, unknown>} body @param {string} key @returns {boolean} */
export function bool(body, key) {
  const raw = body[key];
  if (typeof raw !== "boolean") throw bad(`Please check ${key}.`);
  return raw;
}

/** A club date (YYYY-MM-DD). @param {Record<string, unknown>} body @param {string} key @param {string} [label] */
export function date(body, key, label = "the date") {
  const value = str(body, key, { max: 10, label });
  if (!isClubDate(value)) throw bad(`Please check ${label}.`);
  return value;
}

/** A club time on a quarter hour (HH:MM). @param {Record<string, unknown>} body @param {string} key @param {string} [label] */
export function quarterTime(body, key, label = "the time") {
  const value = str(body, key, { max: 5, label });
  if (!isQuarterHour(value)) throw bad(`Please pick ${label} on the quarter hour (:00, :15, :30 or :45).`);
  return value;
}

/** A numeric id from a URL path or query string. @param {string | null | undefined} raw */
export function idParam(raw) {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) throw new HttpError(404, "not_found", "We couldn't find that.");
  return Number(raw);
}

/** @param {string} text */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
