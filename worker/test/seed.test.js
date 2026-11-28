// @ts-check
// The local seed data loads into the real schema, and its PINs and admin login work.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { PBKDF2_ITERATIONS, decryptText, pepperKeys, verifySecret } from "../src/crypto.js";
import { LOCAL_DATABASE_ID, SEED_ADMIN, SEED_ALLEY_LEAGUE, SEED_LEAGUES, SEED_MEMBERS, SEED_PROGRAMS, buildSeed, seedCommands, toSqlScript } from "../scripts/seed-data.js";
import seedScript from "../scripts/seed.mjs?raw";
import { CLUB } from "../src/club.js";
import wranglerConfig from "../wrangler.json";

const db = env.DB;
const PEPPER = "test-pepper-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const statements = await buildSeed({ pepper: PEPPER, now: NOW, rounds: PBKDF2_ITERATIONS });
  await db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
});

describe("local seed data", () => {
  it("has 5 members whose known PINs work with the local pepper", async () => {
    const keys = await pepperKeys(PEPPER);
    const { results } = await db.prepare("SELECT member_number, pin_hash FROM members ORDER BY id").all();
    expect(results).toHaveLength(5);
    for (const [i, member] of SEED_MEMBERS.entries()) {
      expect(results[i]?.member_number).toBe(member.number);
      expect(await verifySecret(member.pin, String(results[i]?.pin_hash), keys, PBKDF2_ITERATIONS)).toBe(true);
    }
  });

  it("has a test admin whose password and authenticator key work", async () => {
    const keys = await pepperKeys(PEPPER);
    const admin = await db.prepare("SELECT * FROM admins").first();
    expect(admin?.username).toBe(SEED_ADMIN.username);
    expect(await verifySecret(SEED_ADMIN.password, String(admin?.password_hash), keys, PBKDF2_ITERATIONS)).toBe(true);
    expect(SEED_ADMIN.password.length).toBeGreaterThanOrEqual(16);
    expect(await decryptText(String(admin?.totp_secret_enc), keys)).toBe(SEED_ADMIN.totpSecret);
  });

  it("is useless with any other pepper, like the live one", async () => {
    const other = await pepperKeys("some-other-pepper-cccccccccccccccccccccccc");
    const row = await db.prepare("SELECT pin_hash FROM members WHERE member_number = '1001'").first();
    expect(await verifySecret("111111", String(row?.pin_hash), other, PBKDF2_ITERATIONS)).toBe(false);
  });

  it("has the club's starting rooms and hours, bookings (with their slots), events, no-shows and a suspension", async () => {
    const counts = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM resources) AS resources, (SELECT COUNT(*) FROM opening_hours) AS hours,
                (SELECT COUNT(*) FROM bookings WHERE kind <> 'league') AS bookings,
                (SELECT COUNT(*) FROM booking_slots) AS slots,
                (SELECT SUM((ends_at - starts_at) / 900) FROM bookings) AS slots_needed,
                (SELECT COUNT(*) FROM club_events) AS events, (SELECT COUNT(*) FROM no_shows) AS no_shows,
                (SELECT COUNT(*) FROM suspensions) AS suspensions,
                (SELECT COUNT(*) FROM bookings WHERE member_id = 4) AS suspended_member_bookings`,
      )
      .first();
    expect(counts).toMatchObject({
      resources: CLUB.starting_resources.length,
      hours: CLUB.starting_resources.length * 7,
      bookings: 8,
      events: 2,
      no_shows: 2,
      suspensions: 1,
      suspended_member_bookings: 0,
    });
    expect(counts?.slots).toBe(counts?.slots_needed);

    const { results: rooms } = await db.prepare("SELECT name, area FROM resources ORDER BY sort_order").all();
    expect(rooms).toEqual(CLUB.starting_resources.map((r) => ({ name: r.name, area: r.area })));
    const { results: hours } = await db.prepare("SELECT DISTINCT opens_local, closes_local FROM opening_hours").all();
    expect(hours).toEqual([{ opens_local: CLUB.starting_hours.opens, closes_local: CLUB.starting_hours.closes }]);
  });

  it("has four programs (public) and two leagues (private) in the gym, booked every week", async () => {
    const { results: all } = await db.prepare("SELECT l.id, l.name, l.public, l.whole_area, r.area FROM leagues l JOIN resources r ON r.id = l.resource_id ORDER BY l.id").all();
    const rows = all.filter((r) => r.whole_area === 0);
    const seasons = [...SEED_PROGRAMS.map((p) => ({ ...p, public: 1 })), ...SEED_LEAGUES.map((l) => ({ ...l, public: 0 }))];
    expect(rows.map((r) => [r.name, r.public])).toEqual(seasons.flatMap((x) => x.weekdays.map(() => [x.name, x.public])));
    expect(SEED_PROGRAMS.map((p) => p.name)).toEqual(["Pickleball", "Open gym", "Ping Pong", "Youth"]);
    expect(rows.every((r) => r.area === "gym")).toBe(true);
    for (const row of rows) {
      const n = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE league_id = ? AND status = 'active'").bind(row.id).first();
      // About 13 weeks in a 3-month season (today's may already have passed).
      expect(Number(n?.n), String(row.name)).toBeGreaterThanOrEqual(12);
    }
  });

  it("has a Friday League on all 8 bowling lanes, shown by name", async () => {
    const league = await db.prepare("SELECT l.id, l.public, r.area FROM leagues l JOIN resources r ON r.id = l.resource_id WHERE l.name = ?").bind(SEED_ALLEY_LEAGUE.name).first();
    expect(league).toMatchObject({ public: 1, area: "bowling" });
    const per = await db
      .prepare("SELECT COUNT(DISTINCT resource_id) AS lanes, COUNT(*) AS n FROM bookings WHERE league_id = ?")
      .bind(league?.id)
      .first();
    expect(per?.lanes).toBe(8);
    expect(Number(per?.n)).toBeGreaterThanOrEqual(12 * 8);
  });

  it("has a member booking two lanes as one booking", async () => {
    const { results } = await db.prepare("SELECT id, group_id, member_id FROM bookings WHERE id IN (5, 8) ORDER BY id").all();
    expect(results).toEqual([
      { id: 5, group_id: null, member_id: 2 },
      { id: 8, group_id: 5, member_id: 2 },
    ]);
  });

  it("gives member 1001 three upcoming bookings (Pastime has no limit)", async () => {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE member_id = 1 AND status = 'active' AND ends_at > ?").bind(NOW).first();
    expect(row?.n).toBe(3);
  });

  it("can be applied twice (it resets the data first)", async () => {
    const statements = await buildSeed({ pepper: PEPPER, now: NOW, rounds: PBKDF2_ITERATIONS });
    await db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM members").first())?.n).toBe(5);
  });

  it("renders as a SQL file with every value quoted", async () => {
    const sql = toSqlScript([{ sql: "INSERT INTO t VALUES (?, ?, ?)", params: [1, "it's", null] }]);
    expect(sql).toBe("INSERT INTO t VALUES (1, 'it''s', NULL);\n");
    expect(() => toSqlScript([{ sql: "SELECT ?", params: [] }])).toThrow(/mismatch/);
    expect(() => toSqlScript([{ sql: "SELECT 1", params: [1] }])).toThrow(/mismatch/);
  });
});

describe("the seed can only reach the local database", () => {
  const config = /** @type {{ d1_databases: Array<Record<string, unknown>> }} */ (wranglerConfig);
  /** @param {Record<string, unknown>} changes */
  const withDb = (changes) => ({ d1_databases: [{ ...config.d1_databases[0], ...changes }] });

  it("the committed wrangler.json points at the local placeholder database", () => {
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases[0]?.database_id).toBe(LOCAL_DATABASE_ID);
    expect(() => seedCommands([], config, "/tmp/seed.sql", {})).not.toThrow();
  });

  it("runs only two wrangler commands, both --local with wrangler.json, never anything remote", () => {
    const commands = seedCommands([], config, "/tmp/seed.sql", {});
    expect(commands).toEqual([
      ["d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.json", "--force"],
      ["d1", "execute", "DB", "--local", "--config", "wrangler.json", "--file", "/tmp/seed.sql"],
    ]);
    for (const command of commands) {
      expect(command.join(" ")).not.toMatch(/--remote|--preview|--env|production/);
    }
  });

  it.each([
    [["--remote"]],
    [["--preview"]],
    [["--env", "production"]],
    [["--config", "wrangler.remote.json"]],
    [["--local"]],
    [["anything"]],
  ])("refuses to run with options %j", (args) => {
    expect(() => seedCommands(args, config, "/tmp/seed.sql", {})).toThrow(/takes no options/);
  });

  it("refuses when CLOUDFLARE_ENV picks another environment", () => {
    expect(() => seedCommands([], config, "/tmp/seed.sql", { CLOUDFLARE_ENV: "production" })).toThrow(/CLOUDFLARE_ENV/);
  });

  it.each([
    ["a real database ID", withDb({ database_id: "3f2b1c4d-0000-4000-8000-123456789abc" })],
    ["a database marked remote", withDb({ remote: true })],
    ["a preview database", withDb({ preview_database_id: "3f2b1c4d-0000-4000-8000-123456789abc" })],
    ["a second database", { d1_databases: [...config.d1_databases, { binding: "DB2", database_id: LOCAL_DATABASE_ID }] }],
    ["no database", { d1_databases: [] }],
  ])("refuses a wrangler.json with %s", (_label, changed) => {
    expect(() => seedCommands([], changed, "/tmp/seed.sql", {})).toThrow(/local placeholder/);
  });

  it("the seed script runs wrangler only through those checked commands", () => {
    expect(seedScript).toContain("seedCommands(process.argv.slice(2), config, file.pathname, process.env)");
    expect(seedScript).not.toMatch(/--remote|--preview|--env/);
    // run() is only ever called with the two checked commands.
    expect([...seedScript.matchAll(/\brun\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["migrate", "load"]);
  });
});
