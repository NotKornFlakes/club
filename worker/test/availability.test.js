// @ts-check
// The availability grid: 15-minute slots in open hours, "Taken" only (never who), a rolling
// 30-day window, and club time that stays right across clock changes.
import { beforeAll, describe, expect, it } from "vitest";
import { bookingWindow, daySlots, openRanges, withinOpenHours } from "../src/availability.js";
import { addDays, clubTimeToUtc, clubToday, weekdayOf } from "../src/time.js";
import { db, get, loginMember, makeMember, nowSeconds, unique } from "./helpers.js";

/** @type {import("./helpers.js").Session} */
let session;
let court = 0;
let room = 0;
let retired = 0;
const tomorrow = addDays(clubToday(nowSeconds()), 1);

/** @param {string} name @param {number} [active] @param {number} [sort] */
async function newResource(name, active = 1, sort = 0) {
  const now = nowSeconds();
  const result = await db
    .prepare("INSERT INTO resources (name, active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(name, active, sort, now, now)
    .run();
  return result.meta.last_row_id;
}

/** @param {number} resource @param {string} opens @param {string} closes @param {number[]} [days] */
async function setHours(resource, opens, closes, days = [0, 1, 2, 3, 4, 5, 6]) {
  await db.batch(
    days.map((weekday) =>
      db.prepare("INSERT INTO opening_hours VALUES (?, ?, ?, ?)").bind(resource, weekday, opens, closes),
    ),
  );
}

beforeAll(async () => {
  court = await newResource("Court", 1, 2);
  room = await newResource("A room", 1, 1);
  retired = await newResource("Old room", 0);
  await setHours(court, "07:00", "22:00");
  // The room is closed tomorrow, and has split hours on other days.
  const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekdayOf(tomorrow));
  await setHours(room, "09:00", "12:00", others);
  await setHours(room, "14:00", "16:00", others);
  await setHours(retired, "09:00", "17:00");
  session = await loginMember(await makeMember());
});

/** @param {number} resource @param {string} date */
async function dayOf(resource, date) {
  const response = await session.get(`/api/availability?resource_id=${resource}&date=${date}`);
  return { response, body: await response.json() };
}

describe("resources", () => {
  it("lists only active resources, in the admin's order, with the booking window", async () => {
    const response = await session.get("/api/resources");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resources).toEqual([
      { id: room, name: "A room" },
      { id: court, name: "Court" },
    ]);
    const window = bookingWindow(nowSeconds());
    expect(body).toMatchObject({ first_date: window.first, last_date: window.last });
  });

  it("need a login", async () => {
    expect((await get("/api/resources")).status).toBe(401);
    expect((await get(`/api/availability?resource_id=${court}&date=${tomorrow}`)).status).toBe(401);
  });
});

describe("the day grid", () => {
  it("has one 15-minute slot for every quarter hour the place is open", async () => {
    const { response, body } = await dayOf(court, tomorrow);
    expect(response.status).toBe(200);
    expect(body.open).toBe(true);
    expect(body.slots).toHaveLength(15 * 4);
    expect(body.slots[0]).toEqual({
      start: clubTimeToUtc(tomorrow, "07:00"),
      end: clubTimeToUtc(tomorrow, "07:15"),
      state: "free",
    });
    expect(body.slots.at(-1).end).toBe(clubTimeToUtc(tomorrow, "22:00"));
  });

  it("shows split hours and closed days", async () => {
    const dayAfter = addDays(tomorrow, 1);
    const split = await dayOf(room, dayAfter);
    expect(split.body.slots).toHaveLength(12 + 8);
    const closed = await dayOf(room, tomorrow);
    expect(closed.body).toMatchObject({ open: false, slots: [] });
  });

  it("shows booked slots only as taken, never who booked", async () => {
    const other = await makeMember({ name: "Secret Name" });
    const start = clubTimeToUtc(tomorrow, "18:00");
    await db
      .prepare("INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at) VALUES (?, 'member', ?, ?, ?, ?)")
      .bind(court, other.id, start, start + 3600, nowSeconds())
      .run();
    await db
      .prepare(
        "INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id) VALUES (?, 'admin', 'Private label', ?, ?, ?, NULL)",
      )
      .bind(court, start + 7200, start + 9000, nowSeconds())
      .run();
    const { response, body } = await dayOf(court, tomorrow);
    const taken = body.slots.filter((/** @type {{ state: string }} */ s) => s.state === "taken");
    expect(taken).toHaveLength(4 + 2);
    const text = JSON.stringify(body);
    for (const secret of [other.number, "Secret Name", "Private label", "member_id", "booking_id"]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(taken[0]).sort()).toEqual(["end", "start", "state"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks slots that have already started as past", async () => {
    const slots = await daySlots(db, court, clubToday(nowSeconds()), nowSeconds());
    for (const slot of slots) {
      expect(slot.state === "past").toBe(slot.start <= nowSeconds());
    }
  });
});

describe("the 30-day window", () => {
  it("allows today through the club date 30 days from today", async () => {
    const today = clubToday(nowSeconds());
    expect((await dayOf(court, today)).response.status).toBe(200);
    expect((await dayOf(court, addDays(today, 30))).response.status).toBe(200);
  });

  it("refuses yesterday and day 31, in plain words", async () => {
    const today = clubToday(nowSeconds());
    for (const date of [addDays(today, -1), addDays(today, 31)]) {
      const { response, body } = await dayOf(court, date);
      expect(response.status).toBe(400);
      expect(body.message).toBe("You can book up to 30 days ahead.");
    }
  });
});

describe("bad requests", () => {
  it("refuse unknown or retired resources and bad dates", async () => {
    expect((await dayOf(999_999, tomorrow)).response.status).toBe(404);
    expect((await dayOf(retired, tomorrow)).response.status).toBe(404);
    expect((await session.get(`/api/availability?resource_id=abc&date=${tomorrow}`)).status).toBe(404);
    expect((await session.get(`/api/availability?resource_id=${court}&date=2026-02-30`)).status).toBe(400);
    expect((await session.get(`/api/availability?resource_id=${court}`)).status).toBe(400);
  });
});

describe("clock changes", () => {
  it("keeps open hours in New York time on the spring change day", async () => {
    const resource = await newResource(`DST ${unique()}`);
    await setHours(resource, "07:00", "22:00");
    const slots = await daySlots(db, resource, "2027-03-14", 0);
    expect(slots).toHaveLength(60);
    expect(slots[0]?.start).toBe(Date.parse("2027-03-14T11:00:00Z") / 1000); // 7 a.m. EDT
    expect(slots.at(-1)?.end).toBe(Date.parse("2027-03-15T02:00:00Z") / 1000); // 10 p.m. EDT
  });

  it("keeps open hours in New York time on the autumn change day", async () => {
    const resource = await newResource(`DST ${unique()}`);
    await setHours(resource, "07:00", "22:00");
    const slots = await daySlots(db, resource, "2027-11-07", 0);
    expect(slots).toHaveLength(60);
    expect(slots[0]?.start).toBe(Date.parse("2027-11-07T12:00:00Z") / 1000); // 7 a.m. EST
  });
});

describe("open-hours check (used when booking)", () => {
  it("accepts a booking inside one opening range and refuses one across a gap", async () => {
    const date = addDays(tomorrow, 1);
    const ranges = await openRanges(db, room, date);
    expect(withinOpenHours(ranges, clubTimeToUtc(date, "10:00"), clubTimeToUtc(date, "12:00"))).toBe(true);
    expect(withinOpenHours(ranges, clubTimeToUtc(date, "11:00"), clubTimeToUtc(date, "14:30"))).toBe(false);
    expect(withinOpenHours(ranges, clubTimeToUtc(date, "08:45"), clubTimeToUtc(date, "09:30"))).toBe(false);
  });
});
