// @ts-check
// The nightly job deletes data past its retention period and keeps the rest.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { runRetention } from "../src/retention.js";

const db = env.DB;
const NOW = 1_800_000_000 - (1_800_000_000 % 900);
const DAY = 86_400;
const OLD = NOW - 400 * DAY; // past every 12-month limit
const RECENT = NOW - 10 * DAY; // inside every limit

/** @param {number} unixSeconds */
const dateOf = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** @param {string} table @returns {Promise<number>} */
async function count(table) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first(); // table name is a test constant
  return Number(row?.n);
}

beforeAll(async () => {
  await db.batch([
    db
      .prepare("INSERT INTO admins (id, username, password_hash, totp_secret_enc, created_at, updated_at) VALUES (1, 'admin1', 'x', 'x', ?, ?)")
      .bind(NOW, NOW),
    db.prepare("INSERT INTO members (id, member_number, created_at, updated_at) VALUES (1, 'M1', ?, ?)").bind(OLD, OLD),
    db.prepare("INSERT INTO resources (id, name, created_at, updated_at) VALUES (1, 'Court', ?, ?)").bind(OLD, OLD),

    // Bookings: one ended over 12 months ago, one recently
    db
      .prepare("INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id) VALUES (1, 'admin', 'old', ?, ?, ?, 1)")
      .bind(OLD - 3600, OLD, OLD - 7200),
    db
      .prepare("INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id) VALUES (1, 'admin', 'recent', ?, ?, ?, 1)")
      .bind(RECENT - 3600, RECENT, RECENT - 7200),

    // No-shows
    db.prepare("INSERT INTO no_shows (member_id, on_date, recorded_by_admin_id, recorded_at) VALUES (1, ?, 1, ?)").bind(dateOf(OLD), OLD),
    db.prepare("INSERT INTO no_shows (member_id, on_date, recorded_by_admin_id, recorded_at) VALUES (1, ?, 1, ?)").bind(dateOf(RECENT), RECENT),

    // Suspensions: ended long ago; lifted long ago (but would have run on); still active
    db
      .prepare("INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at) VALUES (1, ?, ?, 'ended', 1, ?)")
      .bind(OLD - 180 * DAY, OLD, OLD - 180 * DAY),
    db
      .prepare("INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at, lifted_at, lifted_by_admin_id) VALUES (1, ?, ?, 'lifted', 1, ?, ?, 1)")
      .bind(OLD - DAY, NOW + 30 * DAY, OLD - DAY, OLD),
    db
      .prepare("INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at) VALUES (1, ?, ?, 'active', 1, ?)")
      .bind(RECENT, NOW + 90 * DAY, RECENT),

    // Leagues
    db
      .prepare("INSERT INTO leagues (name, resource_id, weekday, starts_local, ends_local, first_date, last_date, created_by_admin_id, created_at) VALUES ('old', 1, 2, '18:00', '20:00', ?, ?, 1, ?)")
      .bind(dateOf(OLD - 200 * DAY), dateOf(OLD), OLD - 200 * DAY),
    db
      .prepare("INSERT INTO leagues (name, resource_id, weekday, starts_local, ends_local, first_date, last_date, created_by_admin_id, created_at) VALUES ('recent', 1, 2, '18:00', '20:00', ?, ?, 1, ?)")
      .bind(dateOf(RECENT - 200 * DAY), dateOf(RECENT), RECENT - 200 * DAY),

    // Club events
    db
      .prepare("INSERT INTO club_events (title, location, starts_at, ends_at, created_by_admin_id, created_at, updated_at) VALUES ('old', 'Elsewhere', ?, ?, 1, ?, ?)")
      .bind(OLD - 3600, OLD, OLD, OLD),
    db
      .prepare("INSERT INTO club_events (title, location, starts_at, ends_at, created_by_admin_id, created_at, updated_at) VALUES ('recent', 'Elsewhere', ?, ?, 1, ?, ?)")
      .bind(RECENT - 3600, RECENT, RECENT, RECENT),

    // Audit log: over 24 months old, and recent
    db.prepare("INSERT INTO audit_log (at, admin_id, action) VALUES (?, 1, 'old')").bind(NOW - 800 * DAY),
    db.prepare("INSERT INTO audit_log (at, admin_id, action) VALUES (?, 1, 'recent')").bind(RECENT),

    // Login failures: 8 days old, and 1 day old
    db.prepare("INSERT INTO login_failures (at, kind, ip_hash) VALUES (?, 'member', 'h1')").bind(NOW - 8 * DAY),
    db.prepare("INSERT INTO login_failures (at, kind, ip_hash) VALUES (?, 'member', 'h2')").bind(NOW - DAY),

    // Sessions: expired, and still valid
    db
      .prepare("INSERT INTO member_sessions (token_hash, member_id, csrf_token, created_at, expires_at) VALUES ('expired', 1, 'c', ?, ?)")
      .bind(NOW - 31 * DAY, NOW - DAY),
    db
      .prepare("INSERT INTO member_sessions (token_hash, member_id, csrf_token, created_at, expires_at) VALUES ('valid', 1, 'c', ?, ?)")
      .bind(NOW - DAY, NOW + 29 * DAY),
    db
      .prepare("INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, created_at, expires_at) VALUES ('expired', 1, 'c', ?, ?)")
      .bind(NOW - DAY, NOW - 3600),
  ]);
});

describe("nightly retention", () => {
  it("deletes only what is past its retention period", async () => {
    const deleted = await runRetention(db, NOW);

    expect(deleted).toEqual({
      bookings: 1,
      no_shows: 1,
      suspensions: 2,
      leagues: 1,
      club_events: 1,
      audit_log: 1,
      login_failures: 1,
      member_sessions: 1,
      admin_sessions: 1,
    });

    expect(await db.prepare("SELECT label FROM bookings").all()).toMatchObject({ results: [{ label: "recent" }] });
    expect(await db.prepare("SELECT reason FROM suspensions").all()).toMatchObject({ results: [{ reason: "active" }] });
    expect(await db.prepare("SELECT name FROM leagues").all()).toMatchObject({ results: [{ name: "recent" }] });
    expect(await count("no_shows")).toBe(1);
    expect(await count("club_events")).toBe(1);
    expect(await count("login_failures")).toBe(1);
    expect(await count("member_sessions")).toBe(1);
    expect(await count("admin_sessions")).toBe(0);
  });

  it("records each run in the audit log", async () => {
    const row = await db
      .prepare("SELECT admin_id, details FROM audit_log WHERE action = 'retention.run' ORDER BY id DESC LIMIT 1")
      .first();
    expect(row?.admin_id).toBeNull();
    expect(JSON.parse(String(row?.details)).deleted.bookings).toBe(1);
  });

  it("runs from the cron trigger", async () => {
    const controller = createScheduledController({ scheduledTime: NOW * 1000, cron: "0 8 * * *" });
    const ctx = createExecutionContext();
    const handler = /** @type {NonNullable<typeof worker.scheduled>} */ (worker.scheduled);
    await handler(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await count("audit_log")).toBeGreaterThanOrEqual(3); // 'recent' + two retention runs
  });
});
