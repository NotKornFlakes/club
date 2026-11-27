// @ts-check
// The local seed data loads into the real schema, and its PINs and admin login work.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptText, pepperKeys, verifySecret } from "../src/crypto.js";
import { LOCAL_DATABASE_ID, SEED_ADMIN, SEED_MEMBERS, buildSeed, seedCommands, toSqlScript } from "../scripts/seed-data.js";
import seedScript from "../scripts/seed.mjs?raw";
import wranglerConfig from "../wrangler.json";

const db = env.DB;
const PEPPER = "test-pepper-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const statements = await buildSeed({ pepper: PEPPER, now: NOW });
  await db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
});

describe("local seed data", () => {
  it("has 5 members whose known PINs work with the local pepper", async () => {
    const keys = await pepperKeys(PEPPER);
    const { results } = await db.prepare("SELECT member_number, pin_hash FROM members ORDER BY id").all();
    expect(results).toHaveLength(5);
    for (const [i, member] of SEED_MEMBERS.entries()) {
      expect(results[i]?.member_number).toBe(member.number);
      expect(await verifySecret(member.pin, String(results[i]?.pin_hash), keys)).toBe(true);
    }
  });

  it("has a test admin whose password and authenticator key work", async () => {
    const keys = await pepperKeys(PEPPER);
    const admin = await db.prepare("SELECT * FROM admins").first();
    expect(admin?.username).toBe(SEED_ADMIN.username);
    expect(await verifySecret(SEED_ADMIN.password, String(admin?.password_hash), keys)).toBe(true);
    expect(SEED_ADMIN.password.length).toBeGreaterThanOrEqual(16);
    expect(await decryptText(String(admin?.totp_secret_enc), keys)).toBe(SEED_ADMIN.totpSecret);
  });

  it("is useless with any other pepper, like the live one", async () => {
    const other = await pepperKeys("some-other-pepper-cccccccccccccccccccccccc");
    const row = await db.prepare("SELECT pin_hash FROM members WHERE member_number = '1001'").first();
    expect(await verifySecret("111111", String(row?.pin_hash), other)).toBe(false);
  });

  it("has resources, hours, bookings (with their slots), events, no-shows and a suspension", async () => {
    const counts = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM resources) AS resources, (SELECT COUNT(*) FROM opening_hours) AS hours,
                (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM booking_slots) AS slots,
                (SELECT COUNT(*) FROM club_events) AS events, (SELECT COUNT(*) FROM no_shows) AS no_shows,
                (SELECT COUNT(*) FROM suspensions) AS suspensions,
                (SELECT COUNT(*) FROM bookings WHERE member_id = 4) AS suspended_member_bookings`,
      )
      .first();
    expect(counts).toEqual({
      resources: 3,
      hours: 7 + 6 + 10,
      bookings: 4,
      slots: 4 + 4 + 6 + 12,
      events: 2,
      no_shows: 2,
      suspensions: 1,
      suspended_member_bookings: 0,
    });
  });

  it("can be applied twice (it resets the data first)", async () => {
    const statements = await buildSeed({ pepper: PEPPER, now: NOW });
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
