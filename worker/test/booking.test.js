// @ts-check
// Booking: the member rules (2 hours, 2 upcoming, 30 days, open hours, "I agree"), the
// 24-hour cancel rule, .ics download, and the events calendar.
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { escapeText } from "../src/club-pages.js";
import { CLUB } from "../src/club.js";
import { insertMemberBooking } from "../src/bookings.js";
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

  it("has no limit on upcoming bookings at Pastime (its settings say none)", async () => {
    expect(CLUB.booking.limit).toEqual({ kind: "none" });
    const session = await loginMember(await makeMember());
    const day = addDays(today, 5);
    for (const [from, to] of [["06:00", "07:00"], ["07:00", "08:00"], ["08:00", "09:00"], ["09:00", "10:00"], ["10:00", "12:00"]]) {
      expect((await session.post("/api/bookings", slotBody(day, from, to))).status, from).toBe(201);
    }
    expect((await (await session.get("/api/my-bookings")).json()).bookings).toHaveLength(5);
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
  it("match the Rules page word for word, both from the club's settings file", async () => {
    const page = await (await exports.default.fetch(`${ORIGIN}/rules`)).text();
    const list = page.slice(page.indexOf('<ul class="rules">'), page.indexOf("</ul>", page.indexOf('<ul class="rules">')));
    const fromPage = [...list.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
    expect(fromPage).toHaveLength(5);
    expect(fromPage).toEqual(CLUB.rules.map(escapeText));

    const script = await (await exports.default.fetch(`${ORIGIN}/js/club.js`)).text();
    const settings = JSON.parse(script.slice(script.indexOf("{"), script.lastIndexOf("}") + 1));
    expect(settings.rules).toEqual(CLUB.rules);
    // The confirmation step lists exactly those.
    expect(await (await exports.default.fetch(`${ORIGIN}/js/week.js`)).text()).toContain("CLUB.rules.map(");
  });
});

describe("the kinds of booking limit a club can choose", () => {
  const DAY = 86_400;
  // Day 1 starts on a whole day well ahead, at 00:00 UTC (the arithmetic doesn't need club time).
  const base = Math.ceil(nowSeconds() / DAY) * DAY + DAY;
  /** @param {number} day @param {number} hour */
  const at = (day, hour) => base + day * DAY + hour * H;
  /** @type {number} */
  let room;
  /** @type {number} */
  let other;
  beforeAll(async () => {
    room = await newResource("Limit room", "00:00", "24:00");
    other = await newResource("Other room", "00:00", "24:00");
  });

  /** @param {import("../src/club-config.js").Limit} limit @param {number} memberId @param {number} start @param {number} end */
  const book = (limit, memberId, start, end, resourceId = room) =>
    insertMemberBooking(db, limit, { resourceId, memberId, start, end, now: nowSeconds() });
  /** @param {number} id */
  const cancel = (id) =>
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'member' WHERE id = ?").bind(nowSeconds(), id).run();

  it("upcoming: at most that many bookings that haven't ended; a cancelled one frees a place", async () => {
    const limit = /** @type {const} */ ({ kind: "upcoming", max: 2 });
    const member = await makeMember();
    const first = await book(limit, member.id, at(1, 10), at(1, 11));
    await book(limit, member.id, at(1, 12), at(1, 13));
    await expect(book(limit, member.id, at(1, 14), at(1, 15))).rejects.toMatchObject({
      code: "too_many_upcoming",
      message: "You already have 2 upcoming bookings. You can book again when one has finished or been cancelled.",
    });
    await cancel(first);
    await expect(book(limit, member.id, at(1, 14), at(1, 15))).resolves.toBeTypeOf("number");
  });

  it("hours per week: at most that many hours in any 7 days in a row", async () => {
    const limit = /** @type {const} */ ({ kind: "hours_per_week", hours: 3 });
    const member = await makeMember();
    await book(limit, member.id, at(1, 10), at(1, 12)); // 2 hours
    const b = await book(limit, member.id, at(3, 10), at(3, 11)); // 3 hours in 7 days
    // Any more within 7 days of those is refused...
    await expect(book(limit, member.id, at(5, 10), at(5, 10.25))).rejects.toMatchObject({ code: "over_hours_limit" });
    await expect(book(limit, member.id, at(8, 9), at(8, 10))).rejects.toMatchObject({
      code: "over_hours_limit",
      message: "That would be more than 3 hours of bookings in 7 days in a row. Please pick a shorter time or another day.",
    });
    // ...but the 7 days roll on: day 8 at 10:00 is 7 days after day 1's 10:00 start.
    await expect(book(limit, member.id, at(8, 10), at(8, 11))).resolves.toBeTypeOf("number");
    await expect(book(limit, member.id, at(11, 10), at(11, 12))).resolves.toBeTypeOf("number");
    // A cancelled booking no longer counts: 15 minutes on day 2 goes over (day 1 + day 3 + it)
    // until day 3's booking is cancelled.
    await expect(book(limit, member.id, at(2, 10), at(2, 10.25))).rejects.toMatchObject({ code: "over_hours_limit" });
    await cancel(b);
    await expect(book(limit, member.id, at(2, 10), at(2, 10.25))).resolves.toBeTypeOf("number");
    // Day 5 still can't: the 7 days from day 5 hold day 8's hour and day 11's two.
    await expect(book(limit, member.id, at(5, 10), at(5, 10.25))).rejects.toMatchObject({ code: "over_hours_limit" });
  });

  it("none: no count or hours limit", async () => {
    const member = await makeMember();
    for (let hour = 0; hour < 20; hour += 2) await expect(book({ kind: "none" }, member.id, at(14, hour), at(14, hour + 2))).resolves.toBeTypeOf("number");
  });

  it("admin bookings and leagues never count against a member", async () => {
    const admin = await db.prepare("INSERT INTO admins (username, password_hash, totp_secret_enc, created_at, updated_at) VALUES ('limit-admin', 'x', 'x', 0, 0) RETURNING id").first();
    await db
      .prepare("INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id) VALUES (?, 'admin', 'Big event', ?, ?, ?, ?)")
      .bind(other, at(20, 0), at(20, 23), nowSeconds(), admin?.id)
      .run();
    const member = await makeMember();
    await expect(book({ kind: "upcoming", max: 1 }, member.id, at(20, 10), at(20, 11))).resolves.toBeTypeOf("number");
    await expect(book({ kind: "hours_per_week", hours: 1 }, (await makeMember()).id, at(20, 12), at(20, 13))).resolves.toBeTypeOf("number");
  });
});
