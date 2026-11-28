// @ts-check
// Reads and checks one club's settings file (clubs/<club>/club.json) and works out the
// wording the pages and messages use. Pure: it imports nothing from the rest of the Worker,
// so tests can try other clubs' values. See README, "The club's settings".
//
// The repo is public. A club file never holds secrets or the private throttle settings:
// only the keys listed here are allowed, and any other key is refused.

/**
 * Limits the database itself enforces for every club (worker/migrations/0001_init.sql).
 * A club can set the same or less, never more.
 */
export const CEILINGS = Object.freeze({ max_length_minutes: 120, max_upcoming: 2 });

/** How many admins setup allows when a club's file doesn't say. */
export const DEFAULT_MAX_ADMINS = 2;

/** The placeholders the rules text may use. Each is filled from the booking limits. */
export const RULE_PLACEHOLDERS = Object.freeze([
  "cancel_cutoff",
  "missed_bookings",
  "suspension_length",
  "max_length",
  "max_upcoming",
  "days_ahead",
]);

const TOP_KEYS = [
  "name",
  "intro",
  "address",
  "contact",
  "website",
  "time_zone",
  "max_admins",
  "colors",
  "booking",
  "rules",
  "starting_resources",
  "starting_hours",
];
const BOOKING_KEYS = [
  "max_length_minutes",
  "max_upcoming",
  "days_ahead",
  "cancel_cutoff_hours",
  "suspension_months",
  "missed_bookings_limit",
];

/**
 * @typedef {{ accent: string, accent_text: string }} Scheme
 * @typedef {{
 *   max_length_minutes: number, max_upcoming: number, days_ahead: number,
 *   cancel_cutoff_hours: number, suspension_months: number, missed_bookings_limit: number,
 * }} BookingLimits
 * @typedef {{
 *   days_ahead: string, max_length: string, max_upcoming: string, cancel_cutoff: string,
 *   missed_bookings: string, suspension_length: string, admin_limit: string, time_zone_city: string,
 * }} Phrases
 * @typedef {{
 *   name: string, intro: string, address: string, contact: string, website: string,
 *   time_zone: string, max_admins: number,
 *   colors: { light: Scheme, dark: Scheme },
 *   booking: BookingLimits,
 *   rules: ReadonlyArray<string>,
 *   starting_resources: ReadonlyArray<string>,
 *   starting_hours: { opens: string, closes: string },
 *   phrases: Phrases,
 * }} Club
 */

/** A club file that can't be used. The message names the setting, never a secret. */
export class ClubConfigError extends Error {}

/** @param {string} path @param {string} issue */
const problem = (path, issue) => new ClubConfigError(`Club settings: ${path} ${issue}`);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value @param {string} path @param {string[]} keys @param {string[]} [optional]
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, path, keys, optional = []) {
  if (!isObject(value)) throw problem(path, "must be a group of settings ({ ... })");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw problem(`${path}.${key}`, "is not an allowed setting");
  }
  for (const key of keys) {
    if (!optional.includes(key) && !(key in value)) throw problem(`${path}.${key}`, "is missing");
  }
  return value;
}

/** @param {unknown} value @param {string} path @param {number} max */
function text(value, path, max) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw problem(path, `must be text, 1 to ${max} characters`);
  }
  return value;
}

/** @param {unknown} value @param {string} path @param {number} min @param {number} max @param {number} [step] */
function whole(value, path, min, max, step = 1) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max || value % step !== 0) {
    const steps = step === 1 ? "" : `, in steps of ${step}`;
    throw problem(path, `must be a whole number from ${min} to ${max}${steps}`);
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function color(value, path) {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw problem(path, 'must be a color like "#4a5560"');
  return value.toLowerCase();
}

/** @param {unknown} value @param {string} path */
function quarterHour(value, path) {
  if (typeof value !== "string" || !/^([01]\d|2[0-4]):(00|15|30|45)$/.test(value) || value > "24:00") {
    throw problem(path, 'must be a time like "09:00", on the quarter hour');
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function timeZone(value, path) {
  const zone = text(value, path, 64);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw problem(path, "must be a time zone name, for example America/New_York");
  }
  return zone;
}

/** @param {unknown} value @param {string} path */
function website(value, path) {
  const address = text(value, path, 200);
  /** @type {URL} */
  let url;
  try {
    url = new URL(address);
  } catch {
    throw problem(path, 'must be a full address like "https://example.org"');
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw problem(path, "must start with https:// and hold no login");
  }
  return address;
}

/** @param {unknown} value @param {string} path @param {number} maxItems @param {number} maxLength */
function textList(value, path, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw problem(path, `must be a list of 1 to ${maxItems} items`);
  }
  return value.map((item, i) => text(item, `${path}[${i}]`, maxLength));
}

/** "1 hour", "2 hours". @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "2 hours", "90 minutes". @param {number} minutes */
const duration = (minutes) => (minutes % 60 === 0 ? count(minutes / 60, "hour", "hours") : count(minutes, "minute", "minutes"));

/**
 * Checks a club's settings and adds the wording built from them. Throws ClubConfigError,
 * naming the setting, if anything is wrong.
 * @param {unknown} raw the parsed club.json
 * @returns {Readonly<Club>}
 */
export function parseClub(raw) {
  const top = exactKeys(raw, "club", TOP_KEYS, ["max_admins"]);
  const zone = timeZone(top.time_zone, "time_zone");
  const maxAdmins = top.max_admins === undefined ? DEFAULT_MAX_ADMINS : whole(top.max_admins, "max_admins", 1, 10);

  const colors = exactKeys(top.colors, "colors", ["light", "dark"]);
  /** @param {"light" | "dark"} name @returns {Scheme} */
  const scheme = (name) => {
    const s = exactKeys(colors[name], `colors.${name}`, ["accent", "accent_text"]);
    return Object.freeze({ accent: color(s.accent, `colors.${name}.accent`), accent_text: color(s.accent_text, `colors.${name}.accent_text`) });
  };

  const b = exactKeys(top.booking, "booking", BOOKING_KEYS);
  /** @type {BookingLimits} */
  const booking = Object.freeze({
    max_length_minutes: whole(b.max_length_minutes, "booking.max_length_minutes", 15, CEILINGS.max_length_minutes, 15),
    max_upcoming: whole(b.max_upcoming, "booking.max_upcoming", 1, CEILINGS.max_upcoming),
    days_ahead: whole(b.days_ahead, "booking.days_ahead", 1, 365),
    cancel_cutoff_hours: whole(b.cancel_cutoff_hours, "booking.cancel_cutoff_hours", 0, 168),
    suspension_months: whole(b.suspension_months, "booking.suspension_months", 1, 24),
    missed_bookings_limit: whole(b.missed_bookings_limit, "booking.missed_bookings_limit", 1, 20),
  });

  /** @type {Phrases} */
  const phrases = Object.freeze({
    days_ahead: count(booking.days_ahead, "day", "days"),
    max_length: duration(booking.max_length_minutes),
    max_upcoming: count(booking.max_upcoming, "upcoming booking", "upcoming bookings"),
    cancel_cutoff: count(booking.cancel_cutoff_hours, "hour", "hours"),
    missed_bookings: count(booking.missed_bookings_limit, "booking", "bookings"),
    suspension_length: count(booking.suspension_months, "month", "months"),
    admin_limit: count(maxAdmins, "admin", "admins"),
    time_zone_city: (zone.split("/").pop() ?? zone).replaceAll("_", " "),
  });

  const rules = textList(top.rules, "rules", 10, 300).map((template, i) => {
    const filled = template.replace(/\{([a-z_]+)\}/g, (match, /** @type {string} */ key) => {
      if (!RULE_PLACEHOLDERS.includes(key)) throw problem(`rules[${i}]`, `uses an unknown placeholder ${match}`);
      return phrases[/** @type {keyof Phrases} */ (key)];
    });
    if (/[{}]/.test(filled)) throw problem(`rules[${i}]`, "has a { or } that isn't a placeholder");
    return filled;
  });

  const resources = textList(top.starting_resources, "starting_resources", 20, 60);
  if (new Set(resources).size !== resources.length) throw problem("starting_resources", "has the same name twice");
  const hours = exactKeys(top.starting_hours, "starting_hours", ["opens", "closes"]);
  const opens = quarterHour(hours.opens, "starting_hours.opens");
  const closes = quarterHour(hours.closes, "starting_hours.closes");
  if (opens >= closes) throw problem("starting_hours", "must close after it opens");

  return Object.freeze({
    name: text(top.name, "name", 80),
    intro: text(top.intro, "intro", 200),
    address: text(top.address, "address", 200),
    contact: text(top.contact, "contact", 200),
    website: website(top.website, "website"),
    time_zone: zone,
    max_admins: maxAdmins,
    colors: Object.freeze({ light: scheme("light"), dark: scheme("dark") }),
    booking,
    rules: Object.freeze(rules),
    starting_resources: Object.freeze(resources),
    starting_hours: Object.freeze({ opens, closes }),
    phrases,
  });
}

/**
 * The part of a club's settings the browser code needs (all of it public).
 * @param {Readonly<Club>} club
 */
export function publicClub(club) {
  return {
    name: club.name,
    time_zone: club.time_zone,
    booking: club.booking,
    rules: club.rules,
    phrases: club.phrases,
    starting_resources: club.starting_resources,
    starting_hours: club.starting_hours,
  };
}
