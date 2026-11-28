// @ts-check
// Test data for YOUR COMPUTER ONLY: 5 fake members with known PINs, 1 test admin, the
// club's starting courts, lanes and rooms (from its settings file), four programs and two
// leagues in the gym, a few bookings and club events.
//
// scripts/seed.mjs applies it with `wrangler d1 execute --local`; it never touches the
// live database. Even if these rows somehow reached it, none of the logins would work:
// the hashes are made with the fake PEPPER from .dev.vars, not the real one.

import { seasonDates } from "../src/api/admin-leagues.js";
import { CLUB } from "../src/club.js";
import { encryptText, hashSecret, pepperKeys } from "../src/crypto.js";
import { addDays, addMonths, clubTimeToUtc, clubToday, nextSlot } from "../src/time.js";

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

/**
 * Made-up seasons in the gym. Programs are public: the week view shows them by name.
 * Lengths are placeholders (2 hours) until the club confirms them.
 */
export const SEED_PROGRAMS = Object.freeze([
  { name: "Pickleball", weekdays: [1, 2, 3, 4, 5], starts: "11:00", ends: "13:00" },
  { name: "Open gym", weekdays: [1, 2, 3, 4, 5], starts: "15:00", ends: "17:00" },
  { name: "Ping Pong", weekdays: [0], starts: "14:00", ends: "16:00" },
  { name: "Youth", weekdays: [6], starts: "08:00", ends: "10:00" },
]);
/** Two made-up league seasons in the gym. Not public: the week view shows them as "Taken". */
export const SEED_LEAGUES = Object.freeze([
  { name: "Monday charity basketball", weekdays: [1], starts: "18:00", ends: "20:00" },
  { name: "Tuesday basketball league", weekdays: [2], starts: "19:00", ends: "21:00" },
]);
/** How long the seed seasons run, from today. */
export const SEED_SEASON_MONTHS = 3;

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

  // The club's starting courts, lanes and rooms, each open its starting hours every day.
  for (const [i, { name, area }] of CLUB.starting_resources.entries()) {
    out.push({
      sql: "INSERT INTO resources (id, name, area, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      params: [i + 1, name, area, i + 1, now, now],
    });
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      out.push({
        sql: "INSERT INTO opening_hours (resource_id, weekday, opens_local, closes_local) VALUES (?, ?, ?, ?)",
        params: [i + 1, weekday, CLUB.starting_hours.opens, CLUB.starting_hours.closes],
      });
    }
  }

  /** @param {number} days @param {string} time */
  const at = (days, time) => clubTimeToUtc(addDays(today, days), time);
  const soon = nextSlot(now) + 3 * 3600; // within 24 hours, so it can't be cancelled

  /** The ids of the club's starting resources in one area. @param {string} area */
  const inArea = (area) => CLUB.starting_resources.flatMap((r, i) => (r.area === area ? [i + 1] : []));
  const gym = inArea("gym")[0] ?? 1;
  const lanes = inArea("bowling");
  const rooms = inArea("rooms");

  // Programs and leagues first, booked the way the admin page does it (every date of the
  // season), so the bookings below are placed around them.
  const seasonLast = addMonths(today, SEED_SEASON_MONTHS);
  let leagueId = 0;
  let leagueBookingId = 100;
  for (const [group, isPublic] of /** @type {const} */ ([[SEED_PROGRAMS, 1], [SEED_LEAGUES, 0]])) {
    for (const season of group) {
      for (const weekday of season.weekdays) {
        leagueId += 1;
        out.push({
          sql: `INSERT INTO leagues (id, name, resource_id, weekday, starts_local, ends_local, first_date, last_date, public, created_by_admin_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [leagueId, season.name, gym, weekday, season.starts, season.ends, today, seasonLast, isPublic, SEED_ADMIN.id, now],
        });
        const dates = seasonDates({ ...season, weekday, resourceId: gym, first: today, last: seasonLast, renewedFrom: null, isPublic: isPublic === 1 });
        for (const d of dates.filter((day) => day.start > now)) {
          leagueBookingId += 1;
          out.push({
            sql: `INSERT INTO bookings (id, resource_id, kind, league_id, label, starts_at, ends_at, created_at, created_by_admin_id)
                  VALUES (?, ?, 'league', ?, ?, ?, ?, ?, ?)`,
            params: [leagueBookingId, gym, leagueId, season.name, d.start, d.end, now, SEED_ADMIN.id],
          });
        }
      }
    }
  }

  // Member bookings at times no program or league uses (rooms, a lane, and 9-10 p.m. in the gym).
  const memberBookings = [
    { id: 1, member: 1, resource: rooms[0] ?? gym, start: soon, end: soon + 3600 },
    { id: 2, member: 5, resource: gym, start: at(1, "21:00"), end: at(1, "22:00") },
    { id: 3, member: 3, resource: rooms[1] ?? rooms[0] ?? gym, start: at(2, "10:00"), end: at(2, "11:30") },
    { id: 5, member: 2, resource: lanes[2] ?? gym, start: at(3, "19:00"), end: at(3, "20:00") },
  ];
  for (const b of memberBookings) {
    out.push({
      sql: `INSERT INTO bookings (id, resource_id, kind, member_id, starts_at, ends_at, created_at)
            VALUES (?, ?, 'member', ?, ?, ?, ?)`,
      params: [b.id, b.resource, b.member, b.start, b.end, now],
    });
  }
  const maintenance = { id: 4, resource: lanes.at(-1) ?? gym, start: at(3, "09:00"), end: at(3, "12:00") };
  out.push({
    sql: `INSERT INTO bookings (id, resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id)
          VALUES (?, ?, 'admin', 'Lane maintenance', ?, ?, ?, ?)`,
    params: [maintenance.id, maintenance.resource, maintenance.start, maintenance.end, now, SEED_ADMIN.id],
  });

  // Member 1003 has two no-shows on record; member 1004 is suspended (so has no bookings).
  for (const [days, note] of [[-20, "Court booked, nobody came."], [-75, null]]) {
    out.push({
      sql: "INSERT INTO no_shows (member_id, on_date, note, recorded_by_admin_id, recorded_at) VALUES (3, ?, ?, ?, ?)",
      params: [addDays(today, Number(days)), note, SEED_ADMIN.id, now],
    });
  }
  const suspendedUntil = addMonths(today, 2);
  out.push({
    sql: `INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at)
          VALUES (4, ?, ?, '3 missed bookings (test data)', ?, ?)`,
    params: [now, clubTimeToUtc(addDays(suspendedUntil, 1), "00:00"), SEED_ADMIN.id, now],
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

// ---------- Local-only guard ----------

/** The placeholder database ID in wrangler.json. The live ID is never committed. */
export const LOCAL_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

/** Flags that would make wrangler reach a database on Cloudflare, or pick other settings. */
const FORBIDDEN_FLAGS = ["--remote", "--preview", "--env", "-e", "--persist-to"];

/**
 * The only two wrangler commands the seed runs: apply migrations, then load the data.
 * Before returning them, it checks that they can only reach the local database, and throws
 * (so nothing runs) if:
 *   - the seed was given any option at all (e.g. --remote, --env, --config);
 *   - CLOUDFLARE_ENV is set (it would pick another set of settings);
 *   - wrangler.json's database isn't the local placeholder, or is marked remote.
 * Both commands pass --local (wrangler then never contacts Cloudflare) and
 * --config wrangler.json (so no other or redirected settings file is used).
 * @param {string[]} args the seed's own command-line arguments
 * @param {{ d1_databases?: Array<Record<string, unknown>> }} config the parsed wrangler.json
 * @param {string} sqlFile path of the generated SQL file
 * @param {Record<string, string | undefined>} env the environment variables
 * @returns {[string[], string[]]}
 */
export function seedCommands(args, config, sqlFile, env) {
  if (args.length > 0) {
    throw new Error("npm run seed takes no options. It only ever writes to the local database.");
  }
  if (env.CLOUDFLARE_ENV) {
    throw new Error("CLOUDFLARE_ENV is set. Unset it: the seed only ever writes to the local database.");
  }
  const databases = config.d1_databases ?? [];
  const db = databases[0];
  if (
    databases.length !== 1 ||
    !db ||
    db.binding !== "DB" ||
    db.database_id !== LOCAL_DATABASE_ID ||
    db.remote !== undefined ||
    db.preview_database_id !== undefined
  ) {
    throw new Error(
      `wrangler.json's database must be the local placeholder (${LOCAL_DATABASE_ID}, not remote). ` +
        "The seed refuses to run against anything else.",
    );
  }
  const local = ["--local", "--config", "wrangler.json"];
  /** @type {[string[], string[]]} */
  const commands = [
    ["d1", "migrations", "apply", "DB", ...local, "--force"],
    ["d1", "execute", "DB", ...local, "--file", sqlFile],
  ];
  for (const command of commands) {
    if (!command.includes("--local") || command.some((arg) => FORBIDDEN_FLAGS.includes(arg))) {
      throw new Error("Refusing to run a seed command that isn't local-only.");
    }
  }
  return commands;
}
