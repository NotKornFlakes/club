// @ts-check
// The week view (GET /api/week): public and read-only. It shows free, taken, closed and
// past times and the names of programs (public leagues) for one area of the club. It never
// shows who booked, admin labels or the names of private leagues.
import { beforeAll, describe, expect, it } from "vitest";
import { bookingWindow } from "../src/availability.js";
import { CLUB } from "../src/club.js";
import { addDays, clubTimeToUtc, clubToday, weekdayOf } from "../src/time.js";
import { VIEW_DAYS_AHEAD, WEEK_DAYS } from "../src/week.js";
import { db, get, loginAdmin, loginMember, makeAdmin, makeMember, nowSeconds } from "./helpers.js";

const today = clubToday(nowSeconds());
const tomorrow = addDays(today, 1);
const dayAfter = addDays(today, 2);

/** @type {Record<string, number>} */
const ids = {};
/** @type {import("./helpers.js").Session} */
let admin;
/** @type {{ id: number, number: string, pin: string }} */
let member;

/** @param {string} name @param {string} area @param {number} sort @param {[string, string]} hours */
async function addResource(name, area, sort, hours = ["08:00", "22:00"]) {
  const row = await db
    .prepare("INSERT INTO resources (name, area, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, 0) RETURNING id")
    .bind(name, area, sort)
    .first();
  const id = Number(row?.id);
  await db.batch(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
      db.prepare("INSERT INTO opening_hours (resource_id, weekday, opens_local, closes_local) VALUES (?, ?, ?, ?)").bind(id, weekday, hours[0], hours[1]),
    ),
  );
  ids[name] = id;
}

/** @param {string} query */
async function week(query = "") {
  const response = await get(`/api/week${query}`);
  return { response, body: /** @type {any} */ (response.status === 200 ? await response.clone().json() : null) };
}

/** The state character at a club date and time. @param {any} view @param {string} resource @param {string} date @param {string} at */
function stateAt(view, resource, date, at) {
  const day = view.days.find((/** @type {any} */ d) => d.date === date);
  const index = day.starts.indexOf(clubTimeToUtc(date, at));
  return day.slots[String(ids[resource])][index];
}

beforeAll(async () => {
  await addResource("Main gym", "gym", 1);
  await addResource("Lane A", "bowling", 2);
  await addResource("Lane B", "bowling", 3);
  await addResource("Lane C", "bowling", 4, ["12:00", "20:00"]);
  await addResource("Back room", "rooms", 5);
  await addResource("Old room", "rooms", 6);
  await db.prepare("UPDATE resources SET active = 0 WHERE id = ?").bind(ids["Old room"]).run();

  const adminRow = await makeAdmin();
  admin = await loginAdmin(adminRow);
  const season = { resource_id: ids["Main gym"], weekday: weekdayOf(tomorrow), first_date: today, last_date: addDays(today, 27) };
  expect((await admin.post("/api/admin/leagues", { ...season, name: "Pickleball", starts_local: "11:00", ends_local: "13:00", public: true })).status).toBe(201);
  expect((await admin.post("/api/admin/leagues", { ...season, name: "Secret league", starts_local: "18:00", ends_local: "20:00" })).status).toBe(201);
  await db
    .prepare(
      "INSERT INTO bookings (resource_id, kind, label, starts_at, ends_at, created_at, created_by_admin_id) VALUES (?, 'admin', 'Private label', ?, ?, ?, ?)",
    )
    .bind(ids["Lane A"], clubTimeToUtc(tomorrow, "09:00"), clubTimeToUtc(tomorrow, "10:00"), nowSeconds(), adminRow.id)
    .run();

  member = await makeMember({ number: "M-777", name: "Jane Doe" });
  const session = await loginMember(member);
  const booked = await session.post("/api/bookings", {
    resource_id: ids["Main gym"],
    starts_at: clubTimeToUtc(dayAfter, "14:00"),
    ends_at: clubTimeToUtc(dayAfter, "15:00"),
    agree: true,
  });
  expect(booked.status).toBe(201);
});

describe("the week view", () => {
  it("is open without a login and starts today, in the first area, for seven days", async () => {
    const { response, body } = await week();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.area.id).toBe(CLUB.areas[0]?.id);
    expect(body.areas.map((/** @type {any} */ a) => a.id)).toEqual(CLUB.areas.map((a) => a.id));
    expect(body.from).toBe(today);
    expect(body.prev).toBeNull();
    expect(body.next).toBe(addDays(today, WEEK_DAYS));
    expect(body.days.map((/** @type {any} */ d) => d.date)).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => addDays(today, n)));
    expect(body.grid).toEqual({ start: "08:00", end: "22:00", slot_minutes: 15 });
    for (const day of body.days) {
      expect(day.starts).toHaveLength(56);
      expect(day.starts[0]).toBe(clubTimeToUtc(day.date, "08:00"));
      expect(day.slots[String(ids["Main gym"])]).toHaveLength(56);
    }
  });

  it("names programs, and shows everything else as only Taken", async () => {
    const { body } = await week("?area=gym");
    expect(body.programs).toEqual(["Pickleball"]);
    expect(stateAt(body, "Main gym", tomorrow, "11:00")).toBe("A");
    expect(stateAt(body, "Main gym", tomorrow, "12:45")).toBe("A");
    expect(stateAt(body, "Main gym", tomorrow, "13:00")).toBe("f");
    expect(stateAt(body, "Main gym", tomorrow, "18:00")).toBe("t"); // the private league
    expect(stateAt(body, "Main gym", dayAfter, "14:00")).toBe("t"); // the member's booking
    expect(stateAt(body, "Main gym", dayAfter, "15:00")).toBe("f");
  });

  it("never shows who booked, admin labels or private league names", async () => {
    for (const area of CLUB.areas.map((a) => a.id)) {
      const text = await (await get(`/api/week?area=${area}`)).text();
      for (const secret of ["M-777", "Jane Doe", "Private label", "Secret league", "member_id", "\"label\":", "display_name"]) {
        expect(text, `${area}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it("shows closed hours, started slots and times further ahead than members can book", async () => {
    const { body } = await week("?area=bowling");
    expect(stateAt(body, "Lane C", tomorrow, "08:00")).toBe("x");
    expect(stateAt(body, "Lane C", tomorrow, "12:00")).toBe("f");
    expect(stateAt(body, "Lane C", tomorrow, "20:00")).toBe("x");
    expect(stateAt(body, "Lane A", tomorrow, "09:00")).toBe("t"); // the admin booking
    const first = body.days[0];
    for (const [i, start] of first.starts.entries()) {
      if (start <= body.now) expect(["o", "x", "t"]).toContain(first.slots[String(ids["Lane A"])][i]);
    }

    const last = bookingWindow(nowSeconds()).last;
    const later = await week(`?area=bowling&from=${addDays(last, -2)}`);
    for (const day of later.body.days) {
      const lane = day.slots[String(ids["Lane B"])];
      if (day.date > last) expect(lane).toMatch(/^l+$/);
      else expect(lane).toContain("f");
    }
  });

  it("lists the active courts, lanes or rooms of the chosen area, in order", async () => {
    expect((await week("?area=bowling")).body.resources.map((/** @type {any} */ r) => r.name)).toEqual(["Lane A", "Lane B", "Lane C"]);
    const rooms = (await week("?area=rooms")).body;
    expect(rooms.resources.map((/** @type {any} */ r) => r.name)).toEqual(["Back room"]);
    expect(Object.keys(rooms.days[0].slots)).toEqual([String(ids["Back room"])]);
  });

  it("moves a week at a time, and an out-of-range date shows the nearest week", async () => {
    const next = (await week(`?from=${addDays(today, 7)}`)).body;
    expect(next.prev).toBe(today);
    expect(next.next).toBe(addDays(today, 14));
    expect((await week("?from=2000-01-01")).body.from).toBe(today);
    const far = (await week("?from=2999-01-01")).body;
    expect(far.from).toBe(addDays(today, VIEW_DAYS_AHEAD - WEEK_DAYS));
    expect(far.next).toBeNull();
  });

  it("refuses an unknown area or a bad date", async () => {
    expect((await week("?area=pool")).response.status).toBe(400);
    expect((await week("?from=tomorrow")).response.status).toBe(400);
    expect((await week("?from=2026-02-30")).response.status).toBe(400);
  });

  it("can't be changed: it only answers GET", async () => {
    const session = await loginMember(await makeMember());
    expect((await session.post("/api/week", {})).status).toBe(405);
  });

  it("a member can book a free lane straight from its data, and it then shows as taken", async () => {
    const session = await loginMember(await makeMember());
    const before = (await week("?area=bowling")).body;
    const day = before.days.find((/** @type {any} */ d) => d.date === tomorrow);
    const lane = day.slots[String(ids["Lane B"])];
    const i = lane.indexOf("ffff");
    expect(i).toBeGreaterThanOrEqual(0);
    const booked = await session.post("/api/bookings", {
      resource_id: ids["Lane B"],
      starts_at: day.starts[i],
      ends_at: day.starts[i] + 3600,
      agree: true,
    });
    expect(booked.status).toBe(201);
    const after = (await week("?area=bowling")).body.days.find((/** @type {any} */ d) => d.date === tomorrow);
    expect(after.slots[String(ids["Lane B"])].slice(i, i + 4)).toBe("tttt");
    expect(after.slots[String(ids["Lane A"])].slice(i, i + 4)).toBe(day.slots[String(ids["Lane A"])].slice(i, i + 4));
  });
});

describe("pages and old addresses", () => {
  it("This Week is public; Book needs a member login", async () => {
    const page = await get("/week");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<section id="week" class="week" data-mode="week"');
    expect(html).toContain('<script type="module" src="/js/week.js"></script>');
    expect(html).toContain('href="/login?next=/week"');
    expect((await get("/book")).status).toBe(302);
  });

  it("the old site's page addresses redirect to the new pages", async () => {
    for (const [old, now] of [
      ["/about.html", "/history"],
      ["/club-history.html", "/history"],
      ["/bar-restaurant-and-banquets.html", "/banquets"],
      ["/map.html", "/contact"],
      ["/calendar.html", "/week"],
      ["/pastimer-news.html", "/"],
    ]) {
      const response = await get(String(old));
      expect(response.status, old).toBe(301);
      expect(new URL(String(response.headers.get("Location"))).pathname, old).toBe(now);
    }
  });
});

describe("admin: areas and programs", () => {
  it("puts a new court or room in an area, and refuses an unknown area", async () => {
    const made = await admin.post("/api/admin/resources", { name: "Lane D", area: "bowling" });
    expect(made.status).toBe(201);
    expect((await admin.post("/api/admin/resources", { name: "Pool", area: "pool" })).status).toBe(400);
    const { resources } = await (await admin.get("/api/admin/resources")).json();
    expect(resources.find((/** @type {any} */ r) => r.name === "Lane D").area).toBe("bowling");
    // An update without an area keeps it.
    const id = resources.find((/** @type {any} */ r) => r.name === "Lane D").id;
    expect((await admin.post(`/api/admin/resources/${id}/update`, { name: "Lane D", active: true, sort_order: 9 })).status).toBe(200);
    const again = (await (await admin.get("/api/admin/resources")).json()).resources.find((/** @type {any} */ r) => r.id === id);
    expect(again.area).toBe("bowling");
  });

  it("lists which leagues are programs", async () => {
    const { leagues } = await (await admin.get("/api/admin/leagues")).json();
    const byName = Object.fromEntries(leagues.map((/** @type {any} */ l) => [l.name, l.public]));
    expect(byName).toEqual({ Pickleball: true, "Secret league": false });
  });
});

describe("logging in from the week view", () => {
  it("returns only to this site's own booking pages", async () => {
    const script = await (await get("/js/login.js")).text();
    expect(script).toContain('const NEXT = new Set(["/app", "/book", "/week"]);');
    expect(script).toContain('location.assign(NEXT.has(next) ? next : "/app")');
  });
});
