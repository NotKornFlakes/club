// @ts-check
// The database itself enforces the booking rules (docs/architecture.md, sections 6 and 7).
// These tests prove each rule against a real local D1.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const db = env.DB;
const NOW = 1_800_000_000 - (1_800_000_000 % 900); // a "now" on a 15-minute boundary
const H = 3600;
const DAY = 86_400;

let seq = 0;

/** @param {"active" | "disabled"} [status] @returns {Promise<number>} member id */
async function newMember(status = "active") {
  seq += 1;
  const result = await db
    .prepare("INSERT INTO members (member_number, status, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(`T${seq}`, status, NOW, NOW)
    .run();
  return result.meta.last_row_id;
}

/** @returns {Promise<number>} resource id */
async function newResource() {
  seq += 1;
  const result = await db
    .prepare("INSERT INTO resources (name, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(`Resource ${seq}`, NOW, NOW)
    .run();
  return result.meta.last_row_id;
}

/**
 * @param {number} memberId @param {number} resourceId @param {number} start @param {number} end
 * @param {number} [created] the Worker's "now"
 * @returns {Promise<number>} booking id
 */
async function bookMember(memberId, resourceId, start, end, created = NOW) {
  const result = await db
    .prepare(
      `INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
       VALUES (?, 'member', ?, ?, ?, ?)`,
    )
    .bind(resourceId, memberId, start, end, created)
    .run();
  return result.meta.last_row_id;
}

/**
 * @param {number} resourceId @param {number} start @param {number} end
 * @param {"admin" | "league"} [kind] @param {number | null} [leagueId]
 * @returns {Promise<number>} booking id
 */
async function bookAdmin(resourceId, start, end, kind = "admin", leagueId = null) {
  const result = await db
    .prepare(
      `INSERT INTO bookings (resource_id, kind, league_id, label, starts_at, ends_at, created_at, created_by_admin_id)
       VALUES (?, ?, ?, 'Closed', ?, ?, ?, 1)`,
    )
    .bind(resourceId, kind, leagueId, start, end, NOW)
    .run();
  return result.meta.last_row_id;
}

/** @param {number} bookingId @returns {Promise<number>} */
async function slotCount(bookingId) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM booking_slots WHERE booking_id = ?")
    .bind(bookingId)
    .first();
  return Number(row?.n);
}

/** @param {number} bookingId */
async function cancel(bookingId) {
  await db
    .prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'member' WHERE id = ?")
    .bind(NOW, bookingId)
    .run();
}

beforeAll(async () => {
  await db
    .prepare(
      `INSERT INTO admins (id, username, password_hash, totp_secret_enc, created_at, updated_at)
       VALUES (1, 'admin1', 'x', 'x', ?, ?)`,
    )
    .bind(NOW, NOW)
    .run();
});

describe("schema basics", () => {
  it("has enough 15-minute offsets for a 30-day booking", async () => {
    const row = await db.prepare("SELECT COUNT(*) AS n, MIN(n) AS lo, MAX(n) AS hi FROM slot_offsets").first();
    expect(row).toEqual({ n: 2880, lo: 0, hi: 2879 });
  });

  it("enforces foreign keys", async () => {
    await expect(bookAdmin(999_999, NOW + H, NOW + 2 * H)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("no double booking", () => {
  it("fills one slot per 15 minutes", async () => {
    const id = await bookMember(await newMember(), await newResource(), NOW + 2 * H, NOW + 4 * H);
    expect(await slotCount(id)).toBe(8);
  });

  it("refuses an overlapping booking", async () => {
    const court = await newResource();
    await bookMember(await newMember(), court, NOW + 2 * H, NOW + 4 * H);
    await expect(bookMember(await newMember(), court, NOW + 3 * H, NOW + 3 * H + 900)).rejects.toThrow(/slot_taken/);
  });

  it("allows the same time on a different resource", async () => {
    const member = await newMember();
    await bookMember(member, await newResource(), NOW + 2 * H, NOW + 3 * H);
    await expect(bookMember(await newMember(), await newResource(), NOW + 2 * H, NOW + 3 * H)).resolves.toBeTypeOf(
      "number",
    );
  });

  it("lets exactly one of two racing bookings win", async () => {
    const court = await newResource();
    const [a, b] = [await newMember(), await newMember()];
    const results = await Promise.allSettled([
      bookMember(a, court, NOW + 5 * H, NOW + 6 * H),
      bookMember(b, court, NOW + 5 * H + 900, NOW + 6 * H + 900),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("can't be bypassed with INSERT OR REPLACE or INSERT OR IGNORE", async () => {
    const court = await newResource();
    const original = await bookMember(await newMember(), court, NOW + 2 * H, NOW + 4 * H);
    const intruder = await newMember();
    for (const verb of ["INSERT OR REPLACE", "INSERT OR IGNORE"]) {
      await expect(
        db
          .prepare(
            `${verb} INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at)
             VALUES (?, 'member', ?, ?, ?, ?)`,
          )
          .bind(court, intruder, NOW + 2 * H, NOW + 2 * H + 900, NOW)
          .run(),
        verb,
      ).rejects.toThrow(/slot_taken/);
    }
    expect(await slotCount(original)).toBe(8);
    const stray = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE member_id = ?").bind(intruder).first();
    expect(stray?.n).toBe(0);
  });
});

describe("member booking rules", () => {
  it("caps a member booking at 2 hours", async () => {
    await expect(bookMember(await newMember(), await newResource(), NOW + H, NOW + 3 * H + 900)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("requires 15-minute boundaries", async () => {
    await expect(bookMember(await newMember(), await newResource(), NOW + H + 60, NOW + 2 * H)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("refuses a slot that has already started", async () => {
    await expect(bookMember(await newMember(), await newResource(), NOW, NOW + 900)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("leaves the booking limit to the club's settings (migration 0003): no count in the database", async () => {
    // The Worker applies each club's limit when it saves a booking (test/booking.test.js).
    const member = await newMember();
    const court = await newResource();
    for (let i = 0; i < 4; i += 1) await expect(bookMember(member, court, NOW + (1 + 2 * i) * H, NOW + (2 + 2 * i) * H)).resolves.toBeTypeOf("number");
    const trigger = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bookings_member_rules'").first();
    expect(String(trigger?.sql)).not.toContain("too_many_upcoming");
    expect(String(trigger?.sql)).toContain("member_suspended");
  });

  it("refuses suspended members until the suspension is lifted", async () => {
    const member = await newMember();
    const court = await newResource();
    await db
      .prepare(
        `INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at)
         VALUES (?, ?, ?, 'no-shows', 1, ?)`,
      )
      .bind(member, NOW - H, NOW + 180 * DAY, NOW)
      .run();
    await expect(bookMember(member, court, NOW + H, NOW + 2 * H)).rejects.toThrow(/member_suspended/);
    await db
      .prepare("UPDATE suspensions SET lifted_at = ?, lifted_by_admin_id = 1 WHERE member_id = ?")
      .bind(NOW, member)
      .run();
    await expect(bookMember(member, court, NOW + H, NOW + 2 * H)).resolves.toBeTypeOf("number");
  });

  it("requires a reason for a suspension", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO suspensions (member_id, starts_at, ends_at, reason, created_by_admin_id, created_at)
           VALUES (?, ?, ?, '   ', 1, ?)`,
        )
        .bind(await newMember(), NOW, NOW + H, NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses disabled members", async () => {
    await expect(bookMember(await newMember("disabled"), await newResource(), NOW + H, NOW + 2 * H)).rejects.toThrow(
      /member_not_active/,
    );
  });
});

describe("cancelling and changing bookings", () => {
  it("frees the slots on cancel, so someone else can book", async () => {
    const court = await newResource();
    const id = await bookMember(await newMember(), court, NOW + 2 * H, NOW + 4 * H);
    await cancel(id);
    expect(await slotCount(id)).toBe(0);
    await expect(bookMember(await newMember(), court, NOW + 3 * H, NOW + 3 * H + 900)).resolves.toBeTypeOf("number");
  });

  it("can't un-cancel a booking", async () => {
    const id = await bookMember(await newMember(), await newResource(), NOW + H, NOW + 2 * H);
    await cancel(id);
    await expect(
      db
        .prepare("UPDATE bookings SET status = 'active', cancelled_at = NULL, cancelled_by = NULL WHERE id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow(/booking_immutable/);
  });

  it("can't move or resize a booking", async () => {
    const id = await bookMember(await newMember(), await newResource(), NOW + H, NOW + 2 * H);
    await expect(
      db.prepare("UPDATE bookings SET starts_at = starts_at + 900 WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/booking_immutable/);
  });

  it("requires saying who cancelled", async () => {
    const id = await bookMember(await newMember(), await newResource(), NOW + H, NOW + 2 * H);
    await expect(
      db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(NOW, id).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("removes the slots when a booking is deleted", async () => {
    const id = await bookMember(await newMember(), await newResource(), NOW + H, NOW + 2 * H);
    await db.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
    expect(await slotCount(id)).toBe(0);
  });
});

describe("admin bookings and leagues", () => {
  it("allows a 30-day admin closure", async () => {
    const id = await bookAdmin(await newResource(), NOW + 100 * DAY, NOW + 130 * DAY);
    expect(await slotCount(id)).toBe(2880);
  });

  it("refuses an admin booking over 30 days", async () => {
    await expect(bookAdmin(await newResource(), NOW + 200 * DAY, NOW + 230 * DAY + 900)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("requires a league for a league booking", async () => {
    await expect(bookAdmin(await newResource(), NOW + H, NOW + 2 * H, "league", null)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe("opening hours", () => {
  /** @param {string} opens @param {string} closes @param {number} weekday */
  async function addHours(opens, closes, weekday) {
    const resource = await newResource();
    await db.prepare("INSERT INTO opening_hours VALUES (?, ?, ?, ?)").bind(resource, weekday, opens, closes).run();
  }

  it("accepts a quarter-hour range up to midnight", async () => {
    await expect(addHours("09:00", "24:00", 1)).resolves.toBeUndefined();
  });

  it.each([
    ["09:10", "17:00", "not on a quarter hour"],
    ["09:00", "24:15", "past midnight"],
    ["17:00", "09:00", "backwards"],
  ])("refuses %s-%s (%s)", async (opens, closes) => {
    await expect(addHours(opens, closes, 2)).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("audit log", () => {
  it("can be added to and pruned, but never edited", async () => {
    await db
      .prepare("INSERT INTO audit_log (at, admin_id, action, details) VALUES (?, 1, 'test', ?)")
      .bind(NOW, JSON.stringify({ a: 1 }))
      .run();
    await expect(db.prepare("UPDATE audit_log SET action = 'changed'").run()).rejects.toThrow(
      /audit_log_append_only/,
    );
    await expect(db.prepare("DELETE FROM audit_log WHERE action = 'test'").run()).resolves.toBeTruthy();
  });

  it("only accepts valid JSON details", async () => {
    await expect(
      db.prepare("INSERT INTO audit_log (at, action, details) VALUES (?, 'x', 'not json')").bind(NOW).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
