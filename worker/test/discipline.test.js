// @ts-check
// No-shows and suspensions (honor system): what the member sees, and what suspending does.
import { beforeAll, describe, expect, it } from "vitest";
import {
  activeSuspension,
  defaultSuspensionUntil,
  deleteNoShow,
  liftSuspension,
  recordNoShow,
  suspendMember,
  suspensionEndsAt,
} from "../src/discipline.js";
import { addDays, addMonths, clubTimeToUtc, clubToday, nextSlot } from "../src/time.js";
import { db, loginMember, makeAdmin, makeMember, nowSeconds } from "./helpers.js";

const H = 3600;
let court = 0;
let adminId = 0;
const today = clubToday(nowSeconds());

beforeAll(async () => {
  const now = nowSeconds();
  court = (
    await db.prepare("INSERT INTO resources (name, created_at, updated_at) VALUES ('Court', ?, ?)").bind(now, now).run()
  ).meta.last_row_id;
  await db.batch([0, 1, 2, 3, 4, 5, 6].map((d) => db.prepare("INSERT INTO opening_hours VALUES (?, ?, '00:00', '24:00')").bind(court, d)));
  adminId = (await makeAdmin()).id;
});

/** @param {string} date @param {string} from @param {string} to */
const slot = (date, from, to) => ({
  resource_id: court,
  starts_at: clubTimeToUtc(date, from),
  ends_at: clubTimeToUtc(date, to),
  agree: true,
});

/** @param {string} action */
async function auditCount(action) {
  return Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").bind(action).first())?.n);
}

describe("no-shows", () => {
  it("members see their own dates for the last 12 months, never the notes", async () => {
    const member = await makeMember();
    const now = nowSeconds();
    await recordNoShow(db, { memberId: member.id, onDate: addDays(today, -3), note: "Private note", adminId, now });
    await recordNoShow(db, { memberId: member.id, onDate: addDays(today, -100), note: null, adminId, now });
    // An old one past 12 months (written directly; the admin form refuses it).
    await db
      .prepare("INSERT INTO no_shows (member_id, on_date, recorded_by_admin_id, recorded_at) VALUES (?, ?, ?, ?)")
      .bind(member.id, addDays(today, -400), adminId, now)
      .run();
    const session = await loginMember(member);
    const me = await (await session.get("/api/me")).json();
    expect(me.no_shows).toEqual([addDays(today, -3), addDays(today, -100)]);
    expect(JSON.stringify(me)).not.toContain("Private note");
  });

  it("other members' no-shows are never shown", async () => {
    const a = await makeMember();
    const b = await makeMember();
    await recordNoShow(db, { memberId: a.id, onDate: addDays(today, -1), note: null, adminId, now: nowSeconds() });
    expect((await (await (await loginMember(b)).get("/api/me")).json()).no_shows).toEqual([]);
  });

  it("are logged in the audit log, and can be removed if recorded by mistake", async () => {
    const member = await makeMember();
    const before = await auditCount("no_show.record");
    const id = await recordNoShow(db, { memberId: member.id, onDate: today, note: null, adminId, now: nowSeconds() });
    expect(await auditCount("no_show.record")).toBe(before + 1);
    await deleteNoShow(db, { id, adminId, now: nowSeconds() });
    expect(await auditCount("no_show.delete")).toBeGreaterThan(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM no_shows WHERE id = ?").bind(id).first())?.n).toBe(0);
  });

  it("refuse future dates and dates over 12 months ago", async () => {
    const member = await makeMember();
    const now = nowSeconds();
    await expect(recordNoShow(db, { memberId: member.id, onDate: addDays(today, 1), note: null, adminId, now })).rejects.toThrow(
      /future/,
    );
    await expect(recordNoShow(db, { memberId: member.id, onDate: addDays(today, -366), note: null, adminId, now })).rejects.toThrow(
      /12 months/,
    );
  });
});

describe("suspending a member", () => {
  it("cancels their upcoming bookings, frees the slots, and logs each one", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    const other = await loginMember(await makeMember());
    const day = addDays(today, 4);
    // A booking already under way is left alone (it still counts toward the 2-booking cap).
    const running = nextSlot(nowSeconds()) - 900;
    await db
      .prepare("INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at) VALUES (?, 'member', ?, ?, ?, ?)")
      .bind(court, member.id, running, running + 2 * H, running - 60)
      .run();
    const b1 = (await (await session.post("/api/bookings", slot(day, "10:00", "11:00"))).json()).booking;

    const result = await suspendMember(db, {
      memberId: member.id,
      untilDate: addMonths(today, 6),
      reason: "Missed 3 bookings",
      adminId,
      now: nowSeconds(),
    });
    expect(result.cancelled.map((b) => b.id)).toEqual([b1.id]);

    const rows = await db.prepare("SELECT id, status, cancelled_by FROM bookings WHERE member_id = ? ORDER BY starts_at").bind(member.id).all();
    expect(rows.results.map((r) => [r.status, r.cancelled_by])).toEqual([
      ["active", null],
      ["cancelled", "suspension"],
    ]);

    // The slots are free again.
    expect((await other.post("/api/bookings", slot(day, "10:00", "11:00"))).status).toBe(201);

    const suspendLog = await db
      .prepare("SELECT target, details FROM audit_log WHERE action = 'member.suspend' AND target = ?")
      .bind(`member:${member.number}`)
      .first();
    const details = JSON.parse(String(suspendLog?.details));
    expect(details).toMatchObject({ until: addMonths(today, 6), reason: "Missed 3 bookings" });
    expect(details.cancelled_bookings).toEqual([b1.id]);
    for (const id of [b1.id]) {
      const entry = await db.prepare("SELECT details FROM audit_log WHERE action = 'booking.cancel' AND target = ?").bind(`booking:${id}`).first();
      expect(JSON.parse(String(entry?.details))).toMatchObject({ reason: "suspension", member: `member:${member.number}` });
    }
  });

  it("lets them log in and look, but not book, and tells them until when", async () => {
    const member = await makeMember();
    const until = addMonths(today, 6);
    await suspendMember(db, { memberId: member.id, untilDate: until, reason: "No-shows", adminId, now: nowSeconds() });
    const session = await loginMember(member);
    const me = await (await session.get("/api/me")).json();
    expect(me.suspension.until_date).toBe(until);
    expect(me.suspension.message).toMatch(/^Your booking access is suspended until [A-Z][a-z]+ \d{1,2}, \d{4}\. Contact management\.$/);
    expect(JSON.stringify(me)).not.toContain("No-shows"); // the reason is admin-only

    expect((await session.get(`/api/availability?resource_id=${court}&date=${addDays(today, 1)}`)).status).toBe(200);
    const refused = await session.post("/api/bookings", slot(addDays(today, 3), "15:00", "16:00"));
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe(me.suspension.message);
  });

  it("runs through the end of the 'until' club date, then ends by itself", async () => {
    const member = await makeMember();
    const until = addDays(today, 10);
    const { suspensionId } = await suspendMember(db, { memberId: member.id, untilDate: until, reason: "x", adminId, now: nowSeconds() });
    const end = suspensionEndsAt(until);
    expect(end).toBe(clubTimeToUtc(addDays(until, 1), "00:00"));
    expect(await activeSuspension(db, member.id, end - 1)).not.toBeNull();
    expect(await activeSuspension(db, member.id, end)).toBeNull();
    await db
      .prepare("UPDATE suspensions SET starts_at = ?, ends_at = ? WHERE id = ?")
      .bind(nowSeconds() - 100, nowSeconds() - 1, suspensionId)
      .run();
    const session = await loginMember(member);
    expect((await (await session.get("/api/me")).json()).suspension).toBeNull();
    expect((await session.post("/api/bookings", slot(addDays(today, 3), "17:00", "18:00"))).status).toBe(201);
  });

  it("can be lifted early, which is logged, and then they can book", async () => {
    const member = await makeMember();
    const { suspensionId } = await suspendMember(db, {
      memberId: member.id,
      untilDate: addMonths(today, 6),
      reason: "x",
      adminId,
      now: nowSeconds(),
    });
    const before = await auditCount("member.unsuspend");
    await liftSuspension(db, { suspensionId, adminId, now: nowSeconds() });
    expect(await auditCount("member.unsuspend")).toBe(before + 1);
    const session = await loginMember(member);
    expect((await session.post("/api/bookings", slot(addDays(today, 3), "19:00", "20:00"))).status).toBe(201);
    await expect(liftSuspension(db, { suspensionId, adminId, now: nowSeconds() })).rejects.toThrow(/already ended/);
  });

  it("allows only one active suspension at a time", async () => {
    const member = await makeMember();
    const input = { memberId: member.id, untilDate: addMonths(today, 6), reason: "x", adminId, now: nowSeconds() };
    await suspendMember(db, input);
    await expect(suspendMember(db, input)).rejects.toThrow(/already suspended/);
  });

  it("requires a reason and an end date that isn't in the past", async () => {
    const member = await makeMember();
    await expect(
      suspendMember(db, { memberId: member.id, untilDate: addDays(today, -1), reason: "x", adminId, now: nowSeconds() }),
    ).rejects.toThrow(/past/);
    await expect(
      suspendMember(db, { memberId: member.id, untilDate: addMonths(today, 6), reason: "   ", adminId, now: nowSeconds() }),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect(await activeSuspension(db, member.id, nowSeconds())).toBeNull();
  });

  it("defaults to 6 months", () => {
    expect(defaultSuspensionUntil(nowSeconds())).toBe(addMonths(today, 6));
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });
});
