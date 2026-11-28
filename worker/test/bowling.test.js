// @ts-check
// Bowling lanes: a member books 1-2 lanes in one booking; admins book all lanes at once,
// one-off or as a league season, which This Week shows as one program block.
import { beforeAll, describe, expect, it } from "vitest";
import { insertMemberBooking } from "../src/bookings.js";
import { CLUB } from "../src/club.js";
import { addDays, clubTimeToUtc, clubToday, weekdayOf } from "../src/time.js";
import { db, get, loginAdmin, loginMember, makeAdmin, makeMember, nowSeconds } from "./helpers.js";

const today = clubToday(nowSeconds());
const day = addDays(today, 3);
/** @type {number[]} */
const lanes = [];
/** @type {number} */
let gym;
/** @type {number[]} */
const rooms = [];
/** @type {import("./helpers.js").Session} */
let admin;

/** @param {string} name @param {string} area @param {number} sort */
async function addResource(name, area, sort) {
  const row = await db
    .prepare("INSERT INTO resources (name, area, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, 0) RETURNING id")
    .bind(name, area, sort)
    .first();
  const id = Number(row?.id);
  await db.batch(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
      db.prepare("INSERT INTO opening_hours (resource_id, weekday, opens_local, closes_local) VALUES (?, ?, '08:00', '23:00')").bind(id, weekday),
    ),
  );
  return id;
}

/** @param {string} from @param {string} to @param {string} [date] */
const times = (from, to, date = day) => ({ starts_at: clubTimeToUtc(date, from), ends_at: clubTimeToUtc(date, to) });

/** @param {number} id */
const rowsOf = async (id) =>
  (await db.prepare("SELECT id, resource_id, group_id, status FROM bookings WHERE id = ?1 OR group_id = ?1 ORDER BY id").bind(id).all()).results;

beforeAll(async () => {
  for (let n = 1; n <= 8; n += 1) lanes.push(await addResource(`Lane ${n}`, "bowling", n));
  gym = await addResource("Gym", "gym", 20);
  rooms.push(await addResource("Room A", "rooms", 30), await addResource("Room B", "rooms", 31));
  admin = await loginAdmin(await makeAdmin());
});

describe("Pastime's bowling lanes", () => {
  it("are a lanes area: up to 2 lanes in one member booking", () => {
    expect(CLUB.areas.find((a) => a.id === "bowling")?.lanes).toEqual({ max_per_booking: 2 });
    expect(CLUB.areas.find((a) => a.id === "gym")?.lanes).toBeNull();
  });
});

describe("a member booking two lanes", () => {
  it("books both as one booking: one entry, both lanes taken, one calendar event", async () => {
    const session = await loginMember(await makeMember());
    const made = await session.post("/api/bookings", { resource_ids: [lanes[2], lanes[3]], ...times("18:00", "19:00"), agree: true });
    expect(made.status).toBe(201);
    const { booking } = await made.json();
    expect(booking.resource).toBe("Lane 3 and Lane 4");

    const rows = await rowsOf(booking.id);
    expect(rows.map((r) => r.resource_id)).toEqual([lanes[2], lanes[3]]);
    expect(rows[1]?.group_id).toBe(booking.id);

    const mine = (await (await session.get("/api/my-bookings")).json()).bookings;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: booking.id, resource: "Lane 3 and Lane 4" });

    const week = await (await get(`/api/week?area=bowling&from=${day}`)).json();
    const d = week.days.find((/** @type {any} */ x) => x.date === day);
    const i = d.starts.indexOf(clubTimeToUtc(day, "18:00"));
    expect([lanes[1], lanes[2], lanes[3]].map((id) => d.slots[String(id)].slice(i, i + 4))).toEqual(["ffff", "tttt", "tttt"]);

    const ics = await (await session.get(`/api/bookings/${booking.id}/ics`)).text();
    expect(ics).toContain("SUMMARY:Lane 3 and Lane 4 booking");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("cancels both lanes together", async () => {
    const session = await loginMember(await makeMember());
    const { booking } = await (await session.post("/api/bookings", { resource_ids: [lanes[4], lanes[5]], ...times("15:00", "16:00"), agree: true })).json();
    expect((await session.post(`/api/bookings/${booking.id}/cancel`)).status).toBe(200);
    expect((await rowsOf(booking.id)).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    const slots = await db.prepare("SELECT COUNT(*) AS n FROM booking_slots WHERE booking_id IN (SELECT id FROM bookings WHERE id = ?1 OR group_id = ?1)").bind(booking.id).first();
    expect(slots?.n).toBe(0);
  });

  it("is all or nothing: if one lane is taken, neither is booked", async () => {
    const first = await loginMember(await makeMember());
    expect((await first.post("/api/bookings", { resource_id: lanes[7], ...times("12:00", "13:00"), agree: true })).status).toBe(201);
    const second = await makeMember();
    const session = await loginMember(second);
    const clash = await session.post("/api/bookings", { resource_ids: [lanes[6], lanes[7]], ...times("12:00", "13:00"), agree: true });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toBe("slot_taken");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE member_id = ?").bind(second.id).first())?.n).toBe(0);
  });

  it("can't take more than 2 lanes: the whole alley is a party request", async () => {
    const session = await loginMember(await makeMember());
    const three = await session.post("/api/bookings", { resource_ids: [lanes[0], lanes[1], lanes[2]], ...times("09:00", "10:00"), agree: true });
    expect(three.status).toBe(400);
    const body = await three.json();
    expect(body.error).toBe("too_many_lanes");
    expect(body.message).toContain("party");
    const all = await session.post("/api/bookings", { resource_ids: lanes, ...times("09:00", "10:00"), agree: true });
    expect(all.status).toBe(400);
  });

  it("only books lanes together: not a lane with the gym, nor two rooms", async () => {
    const session = await loginMember(await makeMember());
    for (const ids of [[lanes[0], gym], [rooms[0], rooms[1]]]) {
      const response = await session.post("/api/bookings", { resource_ids: ids, ...times("10:00", "11:00"), agree: true });
      expect(response.status, String(ids)).toBe(400);
    }
    for (const bad of [{ resource_ids: [] }, { resource_ids: [lanes[0], lanes[0]] }, { resource_ids: ["1"] }, { resource_id: lanes[0], resource_ids: [lanes[1]] }]) {
      expect((await session.post("/api/bookings", { ...bad, ...times("10:00", "11:00"), agree: true })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("counts once against the club's booking limit", async () => {
    const member = await makeMember();
    const at = (/** @type {string} */ from, /** @type {string} */ to, d = addDays(today, 5)) => ({ start: clubTimeToUtc(d, from), end: clubTimeToUtc(d, to) });
    const upcoming = /** @type {const} */ ({ kind: "upcoming", max: 2 });
    const book = (/** @type {any} */ limit, /** @type {number[]} */ ids, /** @type {{ start: number, end: number }} */ t) =>
      insertMemberBooking(db, limit, { resourceIds: ids, memberId: member.id, ...t, now: nowSeconds() });
    await book(upcoming, [lanes[0], lanes[1]], at("08:00", "09:00"));
    await book(upcoming, [lanes[0], lanes[1]], at("10:00", "11:00"));
    await expect(book(upcoming, [lanes[0]], at("12:00", "13:00"))).rejects.toMatchObject({ code: "too_many_upcoming" });

    const other = await makeMember();
    const hours = /** @type {const} */ ({ kind: "hours_per_week", hours: 2 });
    const bookHours = (/** @type {number[]} */ ids, /** @type {{ start: number, end: number }} */ t) =>
      insertMemberBooking(db, hours, { resourceIds: ids, memberId: other.id, ...t, now: nowSeconds() });
    await bookHours([lanes[2], lanes[3]], at("14:00", "15:00")); // 1 hour, on 2 lanes
    await bookHours([lanes[2]], at("16:00", "17:00")); // 2 hours in all
    await expect(bookHours([lanes[2]], at("18:00", "18:15"))).rejects.toMatchObject({ code: "over_hours_limit" });
  });
});

describe("admins booking all lanes", () => {
  it("books every lane in one action, as one booking, and cancels it as one", async () => {
    const made = await admin.post("/api/admin/bookings", {
      resource_id: lanes[0],
      start_date: addDays(today, 6),
      start_time: "13:00",
      end_date: addDays(today, 6),
      end_time: "15:00",
      label: "Birthday party",
      whole_area: true,
    });
    expect(made.status).toBe(201);
    const { id, resources } = await made.json();
    expect(resources).toBe(8);
    const rows = await rowsOf(id);
    expect(rows.map((r) => r.resource_id)).toEqual(lanes);
    const audit = await db.prepare("SELECT details FROM audit_log WHERE action = 'booking.admin_create' ORDER BY id DESC LIMIT 1").first();
    expect(JSON.parse(String(audit?.details))).toMatchObject({ whole_area: "bowling", resources: 8 });

    // A member can't book any lane then; admin cancel frees all 8.
    const session = await loginMember(await makeMember());
    expect((await session.post("/api/bookings", { resource_id: lanes[4], ...times("13:00", "14:00", addDays(today, 6)), agree: true })).status).toBe(409);
    expect((await admin.post(`/api/admin/bookings/${rows[3]?.id}/cancel`)).status).toBe(200);
    expect((await rowsOf(id)).every((r) => r.status === "cancelled")).toBe(true);
  });

  it("refuses the whole lot if any lane is already booked then", async () => {
    const session = await loginMember(await makeMember());
    const date = addDays(today, 7);
    expect((await session.post("/api/bookings", { resource_id: lanes[5], ...times("13:00", "14:00", date), agree: true })).status).toBe(201);
    const before = (await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'admin'").first())?.n;
    const clash = await admin.post("/api/admin/bookings", {
      resource_id: lanes[0],
      start_date: date,
      start_time: "13:00",
      end_date: date,
      end_time: "15:00",
      whole_area: true,
    });
    expect(clash.status).toBe(409);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'admin'").first())?.n).toBe(before);
  });

  it("runs a league season on all lanes, shown on This Week as one block", async () => {
    const date = addDays(today, 9);
    // One date of the season already has a member on one lane: that whole date is skipped.
    const clashDate = addDays(date, 7);
    const session = await loginMember(await makeMember());
    expect((await session.post("/api/bookings", { resource_id: lanes[2], ...times("20:00", "21:00", clashDate), agree: true })).status).toBe(201);

    const made = await admin.post("/api/admin/leagues", {
      name: "Friday League",
      resource_id: lanes[0],
      weekday: weekdayOf(date),
      starts_local: "19:00",
      ends_local: "22:00",
      first_date: date,
      last_date: addDays(date, 14),
      public: true,
      whole_area: true,
    });
    expect(made.status).toBe(201);
    const result = await made.json();
    expect(result.booked).toEqual([date, addDays(date, 14)]);
    expect(result.skipped.map((/** @type {{ date: string }} */ s) => s.date)).toEqual([clashDate]);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE league_id = ?").bind(result.league_id).first();
    expect(count?.n).toBe(2 * 8);

    const { leagues } = await (await admin.get("/api/admin/leagues")).json();
    expect(leagues.find((/** @type {any} */ l) => l.name === "Friday League")).toMatchObject({ resource: "All Bowling lanes", whole_area: true, public: true });

    const week = await (await get(`/api/week?area=bowling&from=${date}`)).json();
    const d = week.days.find((/** @type {any} */ x) => x.date === date);
    const i = d.starts.indexOf(clubTimeToUtc(date, "19:00"));
    const letter = String.fromCharCode(65 + week.programs.indexOf("Friday League"));
    for (const id of lanes) expect(d.slots[String(id)].slice(i, i + 12)).toBe(letter.repeat(12));
  });
});
