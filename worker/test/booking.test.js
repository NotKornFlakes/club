// @ts-check
// Booking: the member rules (2 hours, 2 upcoming, 30 days, open hours, "I agree"), the
// 24-hour cancel rule, .ics download, and the events calendar.
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, clubTimeToUtc, clubToday, nextSlot } from "../src/time.js";
import { ORIGIN, db, get, loginMember, makeMember, nowSeconds, post } from "./helpers.js";

const H = 3600;
let court = 0;
let room = 0;
let retired = 0;
const today = clubToday(nowSeconds());
const inTwoDays = addDays(today, 2);

/** @param {string} name @param {string} opens @param {string} closes @param {number} [active] */
async function newResource(name, opens, closes, active = 1) {
  const now = nowSeconds();
  const id = (
    await db
      .prepare("INSERT INTO resources (name, active, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(name, active, now, now)
      .run()
  ).meta.last_row_id;
  await db.batch([0, 1, 2, 3, 4, 5, 6].map((d) => db.prepare("INSERT INTO opening_hours VALUES (?, ?, ?, ?)").bind(id, d, opens, closes)));
  return id;
}

beforeAll(async () => {
  court = await newResource("Court", "00:00", "24:00");
  room = await newResource("Room", "09:00", "17:00");
  retired = await newResource("Retired", "00:00", "24:00", 0);
});

/** @param {string} date @param {string} from @param {string} to @param {number} [resource] */
function slotBody(date, from, to, resource = court) {
  return { resource_id: resource, starts_at: clubTimeToUtc(date, from), ends_at: clubTimeToUtc(date, to), agree: true };
}

/** @param {Response} response */
async function codeOf(response) {
  return /** @type {{ error: string }} */ (await response.json()).error;
}

describe("booking", () => {
  it("books free slots, fills the grid, and says when it can be cancelled", async () => {
    const session = await loginMember(await makeMember());
    const body = slotBody(inTwoDays, "10:00", "11:30");
    const response = await session.post("/api/bookings", body);
    expect(response.status).toBe(201);
    const { booking } = await response.json();
    expect(booking).toMatchObject({ resource: "Court", starts_at: body.starts_at, ends_at: body.ends_at, can_cancel: true });
    expect(booking.cancel_until).toBe(body.starts_at - 24 * H);
    const slots = await db.prepare("SELECT COUNT(*) AS n FROM booking_slots WHERE booking_id = ?").bind(booking.id).first();
    expect(slots?.n).toBe(6);
  });

  it("requires ticking “I agree”", async () => {
    const session = await loginMember(await makeMember());
    for (const agree of [false, undefined, "yes"]) {
      const response = await session.post("/api/bookings", { ...slotBody(inTwoDays, "12:00", "13:00"), agree });
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe("must_agree");
    }
  });

  it("allows 2 hours and refuses longer", async () => {
    const session = await loginMember(await makeMember());
    expect((await session.post("/api/bookings", slotBody(inTwoDays, "14:00", "16:15"))).status).toBe(400);
    expect((await session.post("/api/bookings", slotBody(inTwoDays, "14:00", "16:00"))).status).toBe(201);
  });

  it("refuses times off the 15-minute grid, backwards, or already started", async () => {
    const session = await loginMember(await makeMember());
    const start = clubTimeToUtc(inTwoDays, "18:00");
    for (const [s, e] of [
      [start + 60, start + H],
      [start + H, start],
      [start, start],
    ]) {
      expect((await session.post("/api/bookings", { resource_id: court, starts_at: s, ends_at: e, agree: true })).status).toBe(400);
    }
    const past = nextSlot(nowSeconds()) - 900;
    const started = await session.post("/api/bookings", { resource_id: court, starts_at: past, ends_at: past + 900, agree: true });
    expect(await codeOf(started)).toBe("started");
  });

  it("allows the club date 30 days ahead and refuses day 31", async () => {
    const session = await loginMember(await makeMember());
    expect((await session.post("/api/bookings", slotBody(addDays(today, 30), "10:00", "10:15"))).status).toBe(201);
    const late = await session.post("/api/bookings", slotBody(addDays(today, 31), "00:00", "00:15"));
    expect(late.status).toBe(400);
    expect(await codeOf(late)).toBe("outside_window");
  });

  it("refuses times outside the opening hours, and retired or unknown places", async () => {
    const session = await loginMember(await makeMember());
    expect(await codeOf(await session.post("/api/bookings", slotBody(inTwoDays, "08:45", "09:30", room)))).toBe("closed");
    expect(await codeOf(await session.post("/api/bookings", slotBody(inTwoDays, "16:30", "17:15", room)))).toBe("closed");
    expect((await session.post("/api/bookings", slotBody(inTwoDays, "09:00", "10:00", retired))).status).toBe(404);
    expect((await session.post("/api/bookings", slotBody(inTwoDays, "09:00", "10:00", 999_999))).status).toBe(404);
  });

  it("refuses a taken slot in plain words", async () => {
    const a = await loginMember(await makeMember());
    const b = await loginMember(await makeMember());
    expect((await a.post("/api/bookings", slotBody(inTwoDays, "20:00", "21:00"))).status).toBe(201);
    const response = await b.post("/api/bookings", slotBody(inTwoDays, "20:45", "21:30"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "slot_taken",
      message: "Sorry, someone just booked that time. Please pick another.",
    });
  });

  it("allows 2 upcoming bookings, and a third once one is cancelled", async () => {
    const session = await loginMember(await makeMember());
    const day = addDays(today, 5);
    expect((await session.post("/api/bookings", slotBody(day, "06:00", "07:00"))).status).toBe(201);
    const second = await (await session.post("/api/bookings", slotBody(day, "07:00", "08:00"))).json();
    const third = await session.post("/api/bookings", slotBody(day, "08:00", "09:00"));
    expect(third.status).toBe(409);
    expect(await codeOf(third)).toBe("too_many_upcoming");
    expect((await session.post(`/api/bookings/${second.booking.id}/cancel`)).status).toBe(200);
    expect((await session.post("/api/bookings", slotBody(day, "08:00", "09:00"))).status).toBe(201);
  });

  it("refuses unknown fields and needs the CSRF token", async () => {
    const session = await loginMember(await makeMember());
    const body = slotBody(addDays(today, 6), "10:00", "11:00");
    expect((await session.post("/api/bookings", { ...body, kind: "admin" })).status).toBe(400);
    expect((await post("/api/bookings", body, { cookie: session.cookie })).status).toBe(403);
    expect((await post("/api/bookings", body)).status).toBe(401);
  });
});

describe("my bookings", () => {
  it("lists only my upcoming, active bookings, with whether each can be cancelled", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    const other = await loginMember(await makeMember());
    await other.post("/api/bookings", slotBody(addDays(today, 7), "10:00", "11:00"));
    await session.post("/api/bookings", slotBody(addDays(today, 7), "12:00", "13:00"));
    const soon = nextSlot(nowSeconds()) + 2 * H; // within 24 hours
    await db
      .prepare("INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at) VALUES (?, 'member', ?, ?, ?, ?)")
      .bind(court, member.id, soon, soon + H, nowSeconds())
      .run();
    const { bookings } = await (await session.get("/api/my-bookings")).json();
    expect(bookings).toHaveLength(2);
    expect(bookings.map((/** @type {{ can_cancel: boolean }} */ b) => b.can_cancel)).toEqual([false, true]);
  });
});

describe("cancelling", () => {
  it("frees the slots so someone else can book", async () => {
    const a = await loginMember(await makeMember());
    const b = await loginMember(await makeMember());
    const body = slotBody(addDays(today, 8), "10:00", "11:00");
    const { booking } = await (await a.post("/api/bookings", body)).json();
    expect((await b.post("/api/bookings", body)).status).toBe(409);
    expect((await a.post(`/api/bookings/${booking.id}/cancel`)).status).toBe(200);
    const row = await db.prepare("SELECT status, cancelled_by FROM bookings WHERE id = ?").bind(booking.id).first();
    expect(row).toEqual({ status: "cancelled", cancelled_by: "member" });
    expect((await b.post("/api/bookings", body)).status).toBe(201);
  });

  it("is refused within 24 hours of the start, in plain words", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    const soon = nextSlot(nowSeconds()) + 23 * H;
    const id = (
      await db
        .prepare("INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at) VALUES (?, 'member', ?, ?, ?, ?)")
        .bind(court, member.id, soon, soon + 900, nowSeconds())
        .run()
    ).meta.last_row_id;
    const response = await session.post(`/api/bookings/${id}/cancel`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "too_late",
      message: "Bookings can't be cancelled within 24 hours of the start. If you can't make it, please let management know.",
    });
    expect((await db.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first())?.status).toBe("active");
  });

  it("can't touch someone else's booking, or cancel twice", async () => {
    const a = await loginMember(await makeMember());
    const b = await loginMember(await makeMember());
    const { booking } = await (await a.post("/api/bookings", slotBody(addDays(today, 9), "10:00", "11:00"))).json();
    expect((await b.post(`/api/bookings/${booking.id}/cancel`)).status).toBe(404);
    expect((await a.post(`/api/bookings/${booking.id}/cancel`)).status).toBe(200);
    expect((await a.post(`/api/bookings/${booking.id}/cancel`)).status).toBe(404);
  });
});

describe("add to calendar (.ics)", () => {
  it("downloads my booking in UTC with a 1-hour reminder", async () => {
    const session = await loginMember(await makeMember());
    const body = slotBody(addDays(today, 10), "18:00", "19:30");
    const { booking } = await (await session.post("/api/bookings", body)).json();
    const response = await session.get(`/api/bookings/${booking.id}/ics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="booking-${booking.id}.ics"`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    const utc = (/** @type {number} */ t) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    expect(text).toContain(`DTSTART:${utc(body.starts_at)}\r\n`);
    expect(text).toContain(`DTEND:${utc(body.ends_at)}\r\n`);
    expect(text).toContain("SUMMARY:Court booking\r\n");
    expect(text).toContain("TRIGGER:-PT1H\r\n");
    expect(text).toContain(`UID:booking-${booking.id}@club.example.workers.dev\r\n`);
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
  });

  it("is only for my own active bookings", async () => {
    const a = await loginMember(await makeMember());
    const b = await loginMember(await makeMember());
    const { booking } = await (await a.post("/api/bookings", slotBody(addDays(today, 11), "18:00", "19:00"))).json();
    expect((await b.get(`/api/bookings/${booking.id}/ics`)).status).toBe(404);
    await a.post(`/api/bookings/${booking.id}/cancel`);
    expect((await a.get(`/api/bookings/${booking.id}/ics`)).status).toBe(404);
  });
});

describe("club events", () => {
  it("lists upcoming events only, view-only, for logged-in members", async () => {
    const now = nowSeconds();
    await db.batch([
      db.prepare("INSERT INTO admins (id, username, password_hash, totp_secret_enc, created_at, updated_at) VALUES (900, 'evadmin', 'x', 'x', ?, ?)").bind(now, now),
      db
        .prepare("INSERT INTO club_events (title, location, details, starts_at, ends_at, created_by_admin_id, created_at, updated_at) VALUES ('Past', 'Hall', NULL, ?, ?, 900, ?, ?)")
        .bind(now - 3 * H, now - 2 * H, now, now),
      db
        .prepare("INSERT INTO club_events (title, location, details, starts_at, ends_at, created_by_admin_id, created_at, updated_at) VALUES ('Dinner', 'Hall', 'Bring a dish', ?, ?, 900, ?, ?)")
        .bind(now + 48 * H, now + 50 * H, now, now),
    ]);
    const session = await loginMember(await makeMember());
    const { events } = await (await session.get("/api/events")).json();
    expect(events.map((/** @type {{ title: string }} */ e) => e.title)).toEqual(["Dinner"]);
    expect(events[0]).toMatchObject({ location: "Hall", details: "Bring a dish" });
    expect((await get("/api/events")).status).toBe(401);
    expect((await session.post("/api/events", {})).status).toBe(405);
  });
});

describe("the rules shown before booking", () => {
  it("match the Rules page word for word", async () => {
    const page = await (await exports.default.fetch(`${ORIGIN}/rules`)).text();
    const script = await (await exports.default.fetch(`${ORIGIN}/js/rules.js`)).text();
    const fromPage = [...page.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
    const fromScript = [...script.matchAll(/^ {2}"(.*)",$/gm)].map((m) => m[1]);
    expect(fromPage).toHaveLength(5);
    expect(fromScript).toEqual(fromPage);
  });
});
