// @ts-check
// Admin tools: members (add, CSV import, PIN reset, disable, lockout), no-shows and
// suspensions, resources and hours, events, the schedule (who booked), admin bookings,
// leagues with clash lists, and the audit log.
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, addMonths, clubTimeToUtc, clubToday, nextSlot, weekdayOf } from "../src/time.js";
import { db, loginAdmin, loginMember, makeAdmin, makeMember, newIp, nowSeconds, post } from "./helpers.js";

/** @type {import("./helpers.js").Session} */
let admin;
let court = 0;
const today = clubToday(nowSeconds());

beforeAll(async () => {
  admin = await loginAdmin(await makeAdmin());
  const created = await (await admin.post("/api/admin/resources", { name: "Court", sort_order: 1 })).json();
  court = created.id;
  const all = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" }));
  expect((await admin.post(`/api/admin/resources/${court}/hours`, { hours: all })).status).toBe(200);
});

/** @param {string} pin @param {string} number */
const memberLogin = (number, pin) => post("/api/login", { member_number: number, pin }, { ip: newIp() });

/** @param {string} action */
async function lastAudit(action) {
  return db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1").bind(action).first();
}

describe("members", () => {
  it("adding one returns a new 6-digit PIN once, which works; the log never has it", async () => {
    const response = await admin.post("/api/admin/members", { member_number: "A-100", display_name: "Pat Example" });
    expect(response.status).toBe(201);
    const { created } = await response.json();
    expect(created[0]).toMatchObject({ member_number: "A-100", display_name: "Pat Example" });
    expect(created[0].pin).toMatch(/^\d{6}$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await memberLogin("A-100", created[0].pin)).status).toBe(200);
    const log = await lastAudit("member.create");
    expect(String(log?.details)).not.toContain(created[0].pin);
    expect((await admin.post("/api/admin/members", { member_number: "A-100" })).status).toBe(409);
  });

  it("imports up to 25 at a time, skipping duplicates and bad numbers", async () => {
    await makeMember({ number: "B-1" });
    const response = await admin.post("/api/admin/members/import", {
      members: [
        { member_number: "B-1" },
        { member_number: "B-2", display_name: "Two" },
        { member_number: "B-3" },
        { member_number: "B-3" },
        { member_number: "not valid!" },
      ],
    });
    const body = await response.json();
    expect(body.created.map((/** @type {{ member_number: string }} */ c) => c.member_number)).toEqual(["B-2", "B-3"]);
    expect(body.skipped.map((/** @type {{ member_number: string }} */ s) => s.member_number).sort()).toEqual(["B-1", "B-3", "not valid!"]);
    expect((await memberLogin("B-2", body.created[0].pin)).status).toBe(200);
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ member_number: `C-${i}` }));
    expect((await admin.post("/api/admin/members/import", { members: tooMany })).status).toBe(400);
  });

  it("resetting a PIN logs the member out everywhere, and only the new PIN works", async () => {
    const member = await makeMember({ pin: "111111" });
    const session = await loginMember(member);
    const { created } = await (await admin.post(`/api/admin/members/${member.id}/reset-pin`)).json();
    expect((await session.get("/api/me")).status).toBe(401);
    expect((await memberLogin(member.number, "111111")).status).toBe(401);
    expect((await memberLogin(member.number, created[0].pin)).status).toBe(200);
    expect(String((await lastAudit("member.reset_pin"))?.details)).not.toContain(created[0].pin);
  });

  it("disabling logs the member out and stops logins; enabling brings them back", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    expect((await admin.post(`/api/admin/members/${member.id}/disable`)).status).toBe(200);
    expect((await session.get("/api/me")).status).toBe(401);
    expect((await memberLogin(member.number, member.pin)).status).toBe(401);
    expect((await admin.post(`/api/admin/members/${member.id}/enable`)).status).toBe(200);
    expect((await memberLogin(member.number, member.pin)).status).toBe(200);
  });

  it("can clear a lockout", async () => {
    const member = await makeMember();
    for (let i = 0; i < 5; i += 1) await memberLogin(member.number, "000000");
    expect((await memberLogin(member.number, member.pin)).status).toBe(423);
    expect((await admin.post(`/api/admin/members/${member.id}/clear-lockout`)).status).toBe(200);
    expect((await memberLogin(member.number, member.pin)).status).toBe(200);
  });

  it("searches by number or name, and shows status, lockouts, suspensions and no-shows", async () => {
    await makeMember({ number: "SEARCH-1", name: "Findable Person" });
    const byName = await (await admin.get("/api/admin/members?q=findable")).json();
    expect(byName.members).toHaveLength(1);
    expect(byName.members[0]).toMatchObject({ member_number: "SEARCH-1", status: "active", has_pin: true, no_shows: 0 });
    // "%" is matched literally, not as a wildcard.
    expect((await (await admin.get("/api/admin/members?q=%25")).json()).members).toHaveLength(0);
  });
});

describe("no-shows and suspensions from the admin page", () => {
  it("records a no-show with a note the member never sees, and removes it", async () => {
    const member = await makeMember();
    const added = await admin.post(`/api/admin/members/${member.id}/no-shows`, { on_date: addDays(today, -2), note: "Called, no answer" });
    expect(added.status).toBe(201);
    const detail = await (await admin.get(`/api/admin/members/${member.id}`)).json();
    expect(detail.no_shows[0]).toMatchObject({ on_date: addDays(today, -2), note: "Called, no answer" });
    const me = await (await (await loginMember(member)).get("/api/me")).json();
    expect(me.no_shows).toEqual([addDays(today, -2)]);
    expect(JSON.stringify(me)).not.toContain("Called");
    expect((await admin.post(`/api/admin/no-shows/${detail.no_shows[0].id}/delete`)).status).toBe(200);
  });

  it("suspends (cancelling upcoming bookings, listed back) and lifts early", async () => {
    const member = await makeMember();
    const session = await loginMember(member);
    const start = clubTimeToUtc(addDays(today, 3), "10:00");
    await session.post("/api/bookings", { resource_id: court, starts_at: start, ends_at: start + 3600, agree: true });
    const detail = await (await admin.get(`/api/admin/members/${member.id}`)).json();
    expect(detail.default_suspension_until).toBe(addMonths(today, 6));
    const suspended = await admin.post(`/api/admin/members/${member.id}/suspend`, { until_date: detail.default_suspension_until, reason: "3 no-shows" });
    expect(suspended.status).toBe(201);
    expect((await suspended.json()).cancelled).toHaveLength(1);
    expect((await admin.post(`/api/admin/members/${member.id}/suspend`, { until_date: addDays(today, 5), reason: "" })).status).toBe(400);
    const after = await (await admin.get(`/api/admin/members/${member.id}`)).json();
    expect(after.active_suspension.until_date).toBe(addMonths(today, 6));
    expect((await admin.post(`/api/admin/suspensions/${after.active_suspension.id}/lift`)).status).toBe(200);
    expect((await (await admin.get(`/api/admin/members/${member.id}`)).json()).active_suspension).toBeNull();
  });
});

describe("resources and hours", () => {
  it("creates, renames, retires (hidden from members) and refuses duplicate names", async () => {
    const { id } = await (await admin.post("/api/admin/resources", { name: "Room X" })).json();
    expect((await admin.post("/api/admin/resources", { name: "Room X" })).status).toBe(409);
    expect((await admin.post(`/api/admin/resources/${id}/update`, { name: "Room Y", active: false, sort_order: 5 })).status).toBe(200);
    const member = await loginMember(await makeMember());
    const names = (await (await member.get("/api/resources")).json()).resources.map((/** @type {{ name: string }} */ r) => r.name);
    expect(names).not.toContain("Room Y");
    const all = (await (await admin.get("/api/admin/resources")).json()).resources;
    expect(all.find((/** @type {{ id: number }} */ r) => r.id === id)).toMatchObject({ name: "Room Y", active: false });
  });

  it("validates hours: quarter hours, closing after opening, no overlaps; split hours allowed", async () => {
    const { id } = await (await admin.post("/api/admin/resources", { name: "Room Z" })).json();
    const set = (/** @type {unknown[]} */ hours) => admin.post(`/api/admin/resources/${id}/hours`, { hours });
    expect((await set([{ weekday: 1, opens: "09:10", closes: "12:00" }])).status).toBe(400);
    expect((await set([{ weekday: 1, opens: "12:00", closes: "09:00" }])).status).toBe(400);
    expect((await set([{ weekday: 1, opens: "09:00", closes: "12:00" }, { weekday: 1, opens: "11:00", closes: "14:00" }])).status).toBe(400);
    expect((await set([{ weekday: 1, opens: "09:00", closes: "12:00" }, { weekday: 1, opens: "14:00", closes: "24:00" }])).status).toBe(200);
    const room = (await (await admin.get("/api/admin/resources")).json()).resources.find((/** @type {{ id: number }} */ r) => r.id === id);
    expect(room.hours).toEqual([
      { weekday: 1, opens: "09:00", closes: "12:00" },
      { weekday: 1, opens: "14:00", closes: "24:00" },
    ]);
    expect(await lastAudit("resource.hours")).toBeTruthy();
  });
});

describe("club events", () => {
  it("creates, edits and deletes events that members can see", async () => {
    const event = { title: "Gala", location: "Town Hall", details: "Dress up", start_date: addDays(today, 4), start_time: "19:00", end_date: addDays(today, 4), end_time: "23:30" };
    const { id } = await (await admin.post("/api/admin/events", event)).json();
    expect((await admin.post("/api/admin/events", { ...event, end_time: "18:00" })).status).toBe(400);
    expect((await admin.post(`/api/admin/events/${id}/update`, { ...event, title: "Winter Gala" })).status).toBe(200);
    const member = await loginMember(await makeMember());
    const titles = (await (await member.get("/api/events")).json()).events.map((/** @type {{ title: string }} */ e) => e.title);
    expect(titles).toContain("Winter Gala");
    expect((await admin.post(`/api/admin/events/${id}/delete`)).status).toBe(200);
    expect((await admin.post(`/api/admin/events/${id}/delete`)).status).toBe(404);
  });
});

describe("schedule and admin bookings", () => {
  it("shows the admin who booked each slot, while members still see only Taken", async () => {
    const member = await makeMember({ name: "Sam Booker" });
    const session = await loginMember(member);
    const day = addDays(today, 6);
    const start = clubTimeToUtc(day, "18:00");
    await session.post("/api/bookings", { resource_id: court, starts_at: start, ends_at: start + 1800, agree: true });
    const view = await (await admin.get(`/api/admin/schedule?resource_id=${court}&date=${day}`)).json();
    const slot = view.slots.find((/** @type {{ start: number }} */ s) => s.start === start);
    expect(slot).toMatchObject({ state: "taken", booked_by: `Member ${member.number} (Sam Booker)` });
    const memberView = await (await session.get(`/api/availability?resource_id=${court}&date=${day}`)).text();
    expect(memberView).not.toContain("Sam Booker");
  });

  it("places one-off bookings beyond 30 days and outside hours, refuses clashes and over 30 days", async () => {
    const far = addDays(today, 90);
    const ok = await admin.post("/api/admin/bookings", { resource_id: court, start_date: far, start_time: "05:00", end_date: far, end_time: "23:00", label: "Tournament" });
    expect(ok.status).toBe(201);
    const clash = await admin.post("/api/admin/bookings", { resource_id: court, start_date: far, start_time: "10:00", end_date: far, end_time: "11:00" });
    expect(clash.status).toBe(409);
    const tooLong = await admin.post("/api/admin/bookings", { resource_id: court, start_date: addDays(today, 100), start_time: "00:00", end_date: addDays(today, 131), end_time: "00:15" });
    expect((await tooLong.json()).error).toBe("too_long");
  });

  it("cancels any booking at any time, even within 24 hours, and logs it", async () => {
    const member = await makeMember();
    const soon = nextSlot(nowSeconds()) + 3600;
    const id = (
      await db
        .prepare("INSERT INTO bookings (resource_id, kind, member_id, starts_at, ends_at, created_at) VALUES (?, 'member', ?, ?, ?, ?)")
        .bind(court, member.id, soon, soon + 900, nowSeconds())
        .run()
    ).meta.last_row_id;
    expect((await admin.post(`/api/admin/bookings/${id}/cancel`)).status).toBe(200);
    const row = await db.prepare("SELECT status, cancelled_by FROM bookings WHERE id = ?").bind(id).first();
    expect(row).toEqual({ status: "cancelled", cancelled_by: "admin" });
    expect(String((await lastAudit("booking.cancel"))?.target)).toBe(`booking:${id}`);
  });
});

describe("leagues", () => {
  const weekday = weekdayOf(addDays(today, 8));
  const first = addDays(today, 1);
  const last = addDays(today, 7 * 6);

  it("books every free date and lists the clashes, with who booked them", async () => {
    const member = await makeMember({ name: "Clash Person" });
    const clashDay = addDays(today, 15);
    expect(weekdayOf(clashDay)).toBe(weekday);
    const start = clubTimeToUtc(clashDay, "19:00");
    await (await loginMember(member)).post("/api/bookings", { resource_id: court, starts_at: start, ends_at: start + 1800, agree: true });

    const response = await admin.post("/api/admin/leagues", {
      name: "Tuesday League", resource_id: court, weekday, starts_local: "18:30", ends_local: "20:30", first_date: first, last_date: last,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.skipped).toEqual([{ date: clashDay, booked_by: `Member ${member.number} (Clash Person)` }]);
    expect(body.booked).toHaveLength(5);
    const skips = await (await admin.get(`/api/admin/leagues/${body.league_id}/skips`)).json();
    expect(skips.skipped).toHaveLength(1);
    const list = await (await admin.get("/api/admin/leagues")).json();
    expect(list.leagues[0]).toMatchObject({ name: "Tuesday League", booked: 5, skipped: 1, cancelled: false });
  });

  it("refuses a season ending more than 12 months out", async () => {
    const response = await admin.post("/api/admin/leagues", {
      name: "Too long", resource_id: court, weekday, starts_local: "07:00", ends_local: "08:00", first_date: first, last_date: addDays(addMonths(today, 12), 1),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("too_long");
  });

  it("renews into a linked next season, once, and cancelling frees future dates", async () => {
    const created = await (
      await admin.post("/api/admin/leagues", {
        name: "Morning League", resource_id: court, weekday, starts_local: "07:00", ends_local: "08:00", first_date: first, last_date: addDays(today, 14),
      })
    ).json();
    const renewed = await admin.post(`/api/admin/leagues/${created.league_id}/renew`, { last_date: addDays(today, 60) });
    expect(renewed.status).toBe(201);
    const next = await renewed.json();
    const row = await db.prepare("SELECT renewed_from, first_date FROM leagues WHERE id = ?").bind(next.league_id).first();
    expect(row?.renewed_from).toBe(created.league_id);
    expect(String(row?.first_date) > addDays(today, 14)).toBe(true);
    expect((await admin.post(`/api/admin/leagues/${created.league_id}/renew`, { last_date: addDays(today, 60) })).status).toBe(409);

    const cancelled = await (await admin.post(`/api/admin/leagues/${next.league_id}/cancel`)).json();
    expect(cancelled.cancelled_dates).toBe(next.booked.length);
    const active = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE league_id = ? AND status = 'active'").bind(next.league_id).first();
    expect(active?.n).toBe(0);
  });
});

describe("audit log", () => {
  it("lists every admin action newest first, with who did it, 50 at a time", async () => {
    const page = await (await admin.get("/api/admin/audit")).json();
    expect(page.entries.length).toBeGreaterThan(10);
    expect(page.entries[0].id).toBeGreaterThan(page.entries[1].id);
    const actions = new Set(page.entries.map((/** @type {{ action: string }} */ e) => e.action));
    for (const action of ["league.cancel", "league.renew", "booking.cancel"]) expect(actions).toContain(action);
    expect(page.entries.every((/** @type {{ who: string }} */ e) => typeof e.who === "string")).toBe(true);
    if (page.more) {
      const older = await (await admin.get(`/api/admin/audit?before=${page.entries.at(-1).id}`)).json();
      expect(older.entries[0].id).toBeLessThan(page.entries.at(-1).id);
    }
  });
});

describe("CSRF on admin changes", () => {
  it("refuses changes without the admin's CSRF token or from another site", async () => {
    expect((await post("/api/admin/members", { member_number: "Z-1" }, { cookie: admin.cookie })).status).toBe(403);
    expect((await post("/api/admin/members", { member_number: "Z-1" }, { cookie: admin.cookie, csrf: admin.csrf, origin: "https://evil.example" })).status).toBe(403);
  });
});
