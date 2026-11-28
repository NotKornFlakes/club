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
export const CEILINGS = Object.freeze({ max_length_minutes: 120 });

/**
 * The kinds of booking limit a club can choose (booking.limit in its settings):
 *   none            no limit on how much a member books (still 30 days ahead, 2 hours each)
 *   upcoming        at most `max` bookings that haven't finished yet
 *   hours_per_week  at most `hours` hours booked in any 7 days in a row
 * Admin bookings and leagues never count: only a member's own bookings do.
 */
export const LIMIT_KINDS = Object.freeze(["none", "upcoming", "hours_per_week"]);

/** How many admins setup allows when a club's file doesn't say. */
export const DEFAULT_MAX_ADMINS = 2;

/** The placeholders the rules text may use. Each is filled from the booking limits. */
export const RULE_PLACEHOLDERS = Object.freeze([
  "cancel_cutoff",
  "missed_bookings",
  "suspension_length",
  "max_length",
  "booking_limit",
  "days_ahead",
]);

const TOP_KEYS = [
  "name",
  "motto",
  "founded",
  "contact",
  "redirects",
  "time_zone",
  "max_admins",
  "colors",
  "areas",
  "booking",
  "rules",
  "starting_resources",
  "starting_hours",
];
const BOOKING_KEYS = [
  "max_length_minutes",
  "limit",
  "days_ahead",
  "cancel_cutoff_hours",
  "suspension_months",
  "missed_bookings_limit",
];

/**
 * @typedef {{ kind: "none" } | { kind: "upcoming", max: number } | { kind: "hours_per_week", hours: number }} Limit
 * @typedef {{ accent: string, accent_text: string }} Scheme
 * @typedef {{ background: string, text: string, highlight: string }} Brand
 * @typedef {{ label: string, url: string }} Link
 * @typedef {{ address: string, phone: string, email: string, map: string, links: ReadonlyArray<Link> }} Contact
 * @typedef {{ id: string, name: string, any_label: string | null, lanes: { max_per_booking: number } | null }} Area
 * @typedef {{ name: string, area: string }} StartingResource
 * @typedef {{
 *   max_length_minutes: number, limit: Limit, days_ahead: number,
 *   cancel_cutoff_hours: number, suspension_months: number, missed_bookings_limit: number,
 * }} BookingLimits
 * @typedef {{
 *   days_ahead: string, max_length: string, booking_limit: string, cancel_cutoff: string,
 *   missed_bookings: string, suspension_length: string, admin_limit: string, time_zone_city: string,
 * }} Phrases
 * @typedef {{
 *   name: string, motto: string, founded: number, since: string, contact: Contact,
 *   redirects: Readonly<Record<string, string>>,
 *   time_zone: string, max_admins: number,
 *   colors: { brand: Brand, light: Scheme, dark: Scheme },
 *   areas: ReadonlyArray<Area>,
 *   booking: BookingLimits,
 *   rules: ReadonlyArray<string>,
 *   starting_resources: ReadonlyArray<StartingResource>,
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
function httpsUrl(value, path) {
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

/** @param {unknown} value @param {string} path @param {number} maxItems @returns {unknown[]} */
function list(value, path, maxItems) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw problem(path, `must be a list of 1 to ${maxItems} items`);
  }
  return value;
}

/** @param {unknown} value @param {string} path @param {number} maxItems @param {number} maxLength */
function textList(value, path, maxItems, maxLength) {
  return list(value, path, maxItems).map((item, i) => text(item, `${path}[${i}]`, maxLength));
}

/** @param {unknown} value @param {string} path */
function email(value, path) {
  const address = text(value, path, 120);
  if (!/^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(address)) throw problem(path, "must be an email address");
  return address;
}

/** @param {unknown} value @param {string} path */
function phone(value, path) {
  const number = text(value, path, 30);
  if (!/^[0-9+().\- ]{7,30}$/.test(number)) throw problem(path, 'must be a phone number like "315-471-7929"');
  return number;
}

/** @param {unknown} raw @returns {Contact} */
function contactDetails(raw) {
  const c = exactKeys(raw, "contact", ["address", "phone", "email", "map", "links"]);
  const links = list(c.links, "contact.links", 6).map((item, i) => {
    const link = exactKeys(item, `contact.links[${i}]`, ["label", "url"]);
    return Object.freeze({ label: text(link.label, `contact.links[${i}].label`, 30), url: httpsUrl(link.url, `contact.links[${i}].url`) });
  });
  return Object.freeze({
    address: text(c.address, "contact.address", 200),
    phone: phone(c.phone, "contact.phone"),
    email: email(c.email, "contact.email"),
    map: httpsUrl(c.map, "contact.map"),
    links: Object.freeze(links),
  });
}

/**
 * Old page addresses (from the club's previous website) → this site's pages, so old links
 * and bookmarks keep working. Both sides must be plain paths on this site.
 * @param {unknown} raw @returns {Readonly<Record<string, string>>}
 */
function redirectList(raw) {
  if (raw === undefined) return Object.freeze({});
  if (!isObject(raw) || Object.keys(raw).length > 100) throw problem("redirects", "must be a group of up to 100 old → new paths");
  /** @type {Record<string, string>} */
  const out = {};
  for (const [from, to] of Object.entries(raw)) {
    if (!/^\/[a-z0-9._\/-]{1,100}$/.test(from)) throw problem(`redirects["${from}"]`, "must be a lowercase path like /about.html");
    if (typeof to !== "string" || !/^\/[a-z0-9\/-]{0,100}$/.test(to)) throw problem(`redirects["${from}"]`, 'must go to a path on this site, like "/history"');
    if (from.startsWith("/api/") || from === to) throw problem(`redirects["${from}"]`, "can't be an /api/ path or point at itself");
    out[from] = to;
  }
  return Object.freeze(out);
}

/** @param {unknown} raw @returns {ReadonlyArray<Area>} */
function areaList(raw) {
  const areas = list(raw, "areas", 6).map((item, i) => {
    const a = exactKeys(item, `areas[${i}]`, ["id", "name", "any_label", "lanes"], ["any_label", "lanes"]);
    if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]{0,19}$/.test(a.id)) {
      throw problem(`areas[${i}].id`, 'must be a short lowercase id like "gym"');
    }
    const anyLabel = a.any_label === undefined ? null : text(a.any_label, `areas[${i}].any_label`, 30);
    // "lanes": many alike resources (bowling lanes). The week view counts free lanes, a day
    // view shows each lane, and a member can book up to max_per_booking lanes at once.
    let lanes = null;
    if (a.lanes !== undefined) {
      const l = exactKeys(a.lanes, `areas[${i}].lanes`, ["max_per_booking"]);
      lanes = Object.freeze({ max_per_booking: whole(l.max_per_booking, `areas[${i}].lanes.max_per_booking`, 1, 8) });
    }
    return Object.freeze({ id: a.id, name: text(a.name, `areas[${i}].name`, 30), any_label: anyLabel, lanes });
  });
  if (new Set(areas.map((a) => a.id)).size !== areas.length) throw problem("areas", "has the same id twice");
  return Object.freeze(areas);
}

/** @param {unknown} raw @returns {Limit} */
function bookingLimit(raw) {
  const kind = isObject(raw) ? raw.kind : undefined;
  if (kind === "none") {
    exactKeys(raw, "booking.limit", ["kind"]);
    return Object.freeze({ kind: "none" });
  }
  if (kind === "upcoming") {
    const l = exactKeys(raw, "booking.limit", ["kind", "max"]);
    return Object.freeze({ kind: "upcoming", max: whole(l.max, "booking.limit.max", 1, 50) });
  }
  if (kind === "hours_per_week") {
    const l = exactKeys(raw, "booking.limit", ["kind", "hours"]);
    return Object.freeze({ kind: "hours_per_week", hours: whole(l.hours, "booking.limit.hours", 1, 168) });
  }
  throw problem("booking.limit", `must be { "kind": ${LIMIT_KINDS.map((k) => `"${k}"`).join(", ")} ... }`);
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
  const top = exactKeys(raw, "club", TOP_KEYS, ["max_admins", "redirects"]);
  const zone = timeZone(top.time_zone, "time_zone");
  const maxAdmins = top.max_admins === undefined ? DEFAULT_MAX_ADMINS : whole(top.max_admins, "max_admins", 1, 10);

  const colors = exactKeys(top.colors, "colors", ["brand", "light", "dark"]);
  const brand = exactKeys(colors.brand, "colors.brand", ["background", "text", "highlight"]);
  /** @param {"light" | "dark"} name @returns {Scheme} */
  const scheme = (name) => {
    const s = exactKeys(colors[name], `colors.${name}`, ["accent", "accent_text"]);
    return Object.freeze({ accent: color(s.accent, `colors.${name}.accent`), accent_text: color(s.accent_text, `colors.${name}.accent_text`) });
  };

  const b = exactKeys(top.booking, "booking", BOOKING_KEYS);
  /** @type {BookingLimits} */
  const booking = Object.freeze({
    max_length_minutes: whole(b.max_length_minutes, "booking.max_length_minutes", 15, CEILINGS.max_length_minutes, 15),
    limit: bookingLimit(b.limit),
    days_ahead: whole(b.days_ahead, "booking.days_ahead", 1, 365),
    cancel_cutoff_hours: whole(b.cancel_cutoff_hours, "booking.cancel_cutoff_hours", 0, 168),
    suspension_months: whole(b.suspension_months, "booking.suspension_months", 1, 24),
    missed_bookings_limit: whole(b.missed_bookings_limit, "booking.missed_bookings_limit", 1, 20),
  });

  /** @type {Phrases} */
  const phrases = Object.freeze({
    days_ahead: count(booking.days_ahead, "day", "days"),
    max_length: duration(booking.max_length_minutes),
    // "You can have <booking_limit>."
    booking_limit:
      booking.limit.kind === "upcoming"
        ? `up to ${count(booking.limit.max, "upcoming booking", "upcoming bookings")} at a time`
        : booking.limit.kind === "hours_per_week"
          ? `up to ${count(booking.limit.hours, "hour", "hours")} of bookings in any 7 days`
          : "as many bookings as you like",
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

  const areas = areaList(top.areas);
  const resources = list(top.starting_resources, "starting_resources", 40).map((item, i) => {
    const r = exactKeys(item, `starting_resources[${i}]`, ["name", "area"]);
    if (!areas.some((a) => a.id === r.area)) throw problem(`starting_resources[${i}].area`, "must be one of the areas' ids");
    return Object.freeze({ name: text(r.name, `starting_resources[${i}].name`, 60), area: String(r.area) });
  });
  if (new Set(resources.map((r) => r.name)).size !== resources.length) throw problem("starting_resources", "has the same name twice");
  const hours = exactKeys(top.starting_hours, "starting_hours", ["opens", "closes"]);
  const opens = quarterHour(hours.opens, "starting_hours.opens");
  const closes = quarterHour(hours.closes, "starting_hours.closes");
  if (opens >= closes) throw problem("starting_hours", "must close after it opens");

  const founded = whole(top.founded, "founded", 1600, 2100);
  return Object.freeze({
    name: text(top.name, "name", 80),
    motto: text(top.motto, "motto", 80),
    founded,
    since: `Since ${founded}`,
    contact: contactDetails(top.contact),
    redirects: redirectList(top.redirects),
    time_zone: zone,
    max_admins: maxAdmins,
    colors: Object.freeze({
      brand: Object.freeze({
        background: color(brand.background, "colors.brand.background"),
        text: color(brand.text, "colors.brand.text"),
        highlight: color(brand.highlight, "colors.brand.highlight"),
      }),
      light: scheme("light"),
      dark: scheme("dark"),
    }),
    areas,
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
    areas: club.areas,
    starting_resources: club.starting_resources,
    starting_hours: club.starting_hours,
  };
}
