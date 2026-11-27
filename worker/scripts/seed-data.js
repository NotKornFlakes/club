// @ts-check
// Test data for YOUR COMPUTER ONLY: 5 fake members with known PINs, 1 test admin,
// resources, opening hours, a few bookings and club events.
//
// scripts/seed.mjs applies it with `wrangler d1 execute --local`; it never touches the
// live database. Even if these rows somehow reached it, none of the logins would work:
// the hashes are made with the fake PEPPER from .dev.vars, not the real one.

import { encryptText, hashSecret, pepperKeys } from "../src/crypto.js";
import { addDays, clubTimeToUtc, clubToday, nextSlot } from "../src/time.js";

/** Fake members. Member numbers and PINs are made up and exist only in local test data. */
export const SEED_MEMBERS = Object.freeze([
  { id: 1, number: "1001", pin: "111111", name: "Test Member A" },
  { id: 2, number: "1002", pin: "222222", name: "Test Member B" },
  { id: 3, number: "1003", pin: "333333", name: "Test Member C" },
  { id: 4, number: "1004", pin: "444444", name: "Test Member D" },
  { id: 5, number: "1005", pin: "555555", name: "Test Member E" },
]);

/** The test admin. `npm run totp` prints its current 6-digit code. */
export const SEED_ADMIN = Object.freeze({
  id: 1,
  username: "admin",
  password: "local-test-only-admin",
  totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
});

/** @typedef {{ sql: string, params: Array<string | number | null> }} Statement */

/** Tables in an order that respects foreign keys when deleting. */
const TABLES = [
  "booking_slots",
  "league_skips",
  "bookings",
  "leagues",
  "no_shows",
  "suspensions",
  "member_sessions",
  "admin_sessions",
  "login_failures",
  "opening_hours",
  "resources",
  "club_events",
  "audit_log",
  "system_state",
  "members",
  "admins",
];

/**
 * Every statement needed to reset the local database to the test data.
 * @param {{ pepper: string, now: number }} options now = Unix seconds
 * @returns {Promise<Statement[]>}
 */
export async function buildSeed({ pepper, now }) {
  const keys = await pepperKeys(pepper);
  const today = clubToday(now);
  /** @type {Statement[]} */
  const out = TABLES.map((table) => ({ sql: `DELETE FROM ${table}`, params: [] }));

  out.push({
    sql: `INSERT INTO admins (id, username, password_hash, totp_secret_enc, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      SEED_ADMIN.id,
      SEED_ADMIN.username,
      await hashSecret(SEED_ADMIN.password, keys),
      await encryptText(SEED_ADMIN.totpSecret, keys),
      now,
      now,
    ],
  });

  for (const member of SEED_MEMBERS) {
    out.push({
      sql: `INSERT INTO members (id, member_number, display_name, pin_hash, pin_issued_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [member.id, member.number, member.name, await hashSecret(member.pin, keys), now, now, now],
    });
  }

  const resources = [
    { id: 1, name: "Basketball court", sort: 1, hours: [[0, 6, "07:00", "22:00"]] },
    { id: 2, name: "Room 1", sort: 2, hours: [[1, 6, "09:00", "21:00"]] },
    { id: 3, name: "Room 2", sort: 3, hours: [[1, 5, "09:00", "12:00"], [1, 5, "14:00", "20:00"]] },
  ];
  for (const resource of resources) {
    out.push({
      sql: "INSERT INTO resources (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      params: [resource.id, resource.name, resource.sort, now, now],
    });
    for (const [from, to, opens, closes] of resource.hours) {
      for (let weekday = Number(from); weekday <= Number(to); weekday += 1) {
        out.push({
          sql: "INSERT INTO opening_hours (resource_id, weekday, opens_local, closes_local) VALUES (?, ?, ?, ?)",
          params: [resource.id, weekday, opens, closes],
        });
      }
    }
  }

  /** @param {number} days @param {string} time */
  const at = (days, time) => clubTimeToUtc(addDays(today, days), time);
  const soon = nextSlot(now) + 3 * 3600; // within 24 hours, so it can't be cancelled

  const memberBookings = [
    { member: 1, resource: 1, start: soon, end: soon + 3600 },
    { member: 5, resource: 1, start: at(1, "18:00"), end: at(1, "19:00") },
    { member: 4, resource: 2, start: at(2, "10:00"), end: at(2, "11:30") },
  ];
  for (const b of memberBookings) {
    out.push({
      sql: `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
            VALUES (?, 'member', ?, ?, ?, ?)`,
      params: [b.resource, b.member, b.start, b.end, now],
    });
  }
  out.push({
    sql: `INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id)
          VALUES (1, 'admin', 'Floor maintenance', ?, ?, ?, ?)`,
    params: [at(3, "09:00"), at(3, "12:00"), now, SEED_ADMIN.id],
  });

  const events = [
    { title: "Members' dinner", location: "Riverside Hall", details: "Tickets from management.", start: at(5, "19:00"), end: at(5, "22:00") },
    { title: "Open tournament", location: "City Sports Centre", details: null, start: at(12, "10:00"), end: at(12, "16:00") },
  ];
  for (const e of events) {
    out.push({
      sql: `INSERT INTO club_events (title, location, details, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [e.title, e.location, e.details, e.start, e.end, SEED_ADMIN.id, now, now],
    });
  }

  return out;
}

/** @param {string | number | null} value */
function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Not a finite number");
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The statements as one SQL file for `wrangler d1 execute --file`. Values are our own
 * constants and hashes (no user input), quoted as SQL literals.
 * @param {Statement[]} statements
 */
export function toSqlScript(statements) {
  return statements
    .map(({ sql, params }) => {
      let i = 0;
      const text = sql.replace(/\?/g, () => sqlLiteral(params[i++] ?? null));
      if (i !== params.length) throw new Error(`Placeholder count mismatch in: ${sql}`);
      return `${text.replace(/\s+/g, " ").trim()};`;
    })
    .join("\n")
    .concat("\n");
}
