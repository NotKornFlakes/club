// @ts-check
// The club's settings file (clubs/pastime/club.json): what Pastime's says, what any club's
// file is allowed to say, and that every page, stylesheet and script gets its values.
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import raw from "../../clubs/pastime/club.json" with { type: "json" };
import { CEILINGS, DEFAULT_MAX_ADMINS, ClubConfigError, parseClub, publicClub } from "../src/club-config.js";
import { CLUB } from "../src/club.js";
import { CSP } from "../src/headers.js";
import { ORIGIN, db, get, loginAdmin, loginMember, makeAdmin, makeMember } from "./helpers.js";

/** A copy of Pastime's file with some settings changed. @param {(club: any) => void} change */
function variant(change) {
  const copy = structuredClone(raw);
  change(copy);
  return copy;
}

/** @param {(club: any) => void} change */
const refused = (change) => expect(() => parseClub(variant(change))).toThrow(ClubConfigError);

describe("Pastime's settings", () => {
  it("name the club, its rooms and placeholder hours, and one admin", () => {
    expect(CLUB.name).toBe("Pastime Athletic Club");
    expect(CLUB.address).toContain("Syracuse, NY");
    expect(CLUB.time_zone).toBe("America/New_York");
    expect(CLUB.max_admins).toBe(1);
    expect(CLUB.starting_resources).toEqual(["Gymnasium", "President's Room", "Century Room", "Lounge"]);
    expect(CLUB.starting_hours).toEqual({ opens: "09:00", closes: "22:00" });
  });

  it("keep the brief's booking limits", () => {
    expect(CLUB.booking).toEqual({
      max_length_minutes: 120,
      max_upcoming: 2,
      days_ahead: 30,
      cancel_cutoff_hours: 24,
      suspension_months: 6,
      missed_bookings_limit: 3,
    });
  });

  it("fill the rules from those limits, giving the brief's wording exactly", () => {
    expect(CLUB.rules).toEqual([
      "Bookings can be cancelled up to 24 hours before the start time. Within 24 hours, they can't be cancelled.",
      "If you can't make your booking, please let management know.",
      "Missed bookings are tracked by management. Members who miss 3 bookings may lose booking privileges for 6 months.",
      "Please book only the time you'll use, so other members get a turn.",
      "Your member number and PIN are for you only. Don't share them.",
    ]);
    // The numbers come from the limits, not the text.
    expect(raw.rules.join(" ")).not.toMatch(/\d/);
  });

  it("use a neutral placeholder theme and no logo", () => {
    expect(CLUB.colors.light.accent).toBe("#4a5560");
    expect(CLUB.colors.dark.accent).toBe("#b4bec8");
    expect(Object.keys(raw)).not.toContain("logo");
  });
});

describe("another club's settings", () => {
  it("change the wording everywhere it's built", () => {
    const club = parseClub(
      variant((c) => {
        c.booking = { max_length_minutes: 90, max_upcoming: 1, days_ahead: 14, cancel_cutoff_hours: 1, suspension_months: 1, missed_bookings_limit: 1 };
        c.time_zone = "America/Los_Angeles";
        c.rules = ["Cancel {cancel_cutoff} ahead; book {days_ahead} ahead, {max_length} at most, {max_upcoming} at a time."];
      }),
    );
    expect(club.phrases).toMatchObject({
      max_length: "90 minutes",
      max_upcoming: "1 upcoming booking",
      days_ahead: "14 days",
      cancel_cutoff: "1 hour",
      suspension_length: "1 month",
      missed_bookings: "1 booking",
      admin_limit: "1 admin",
      time_zone_city: "Los Angeles",
    });
    expect(club.rules).toEqual(["Cancel 1 hour ahead; book 14 days ahead, 90 minutes at most, 1 upcoming booking at a time."]);
  });

  it("get the default of two admins when they don't say", () => {
    const club = parseClub(variant((c) => delete c.max_admins));
    expect(club.max_admins).toBe(DEFAULT_MAX_ADMINS);
    expect(DEFAULT_MAX_ADMINS).toBe(2);
    expect(club.phrases.admin_limit).toBe("2 admins");
  });

  it("can't go over the limits the database enforces", () => {
    expect(CEILINGS).toEqual({ max_length_minutes: 120, max_upcoming: 2 });
    refused((c) => (c.booking.max_length_minutes = 135));
    refused((c) => (c.booking.max_upcoming = 3));
    refused((c) => (c.booking.max_length_minutes = 50)); // not whole 15-minute blocks
  });

  it("can't add settings that aren't on the list, like a throttle value", () => {
    refused((c) => (c.alarm_long_failures = 100));
    refused((c) => (c.booking.ip_failures_per_hour = 10));
    refused((c) => (c.colors.light.background = "#000000"));
    refused((c) => delete c.rules);
  });

  it("refuse other mistakes, naming the setting", () => {
    refused((c) => (c.time_zone = "Syracuse"));
    refused((c) => (c.website = "http://example.org"));
    refused((c) => (c.website = "https://user:pass@example.org"));
    refused((c) => (c.colors.dark.accent = "blue"));
    refused((c) => (c.rules = ["Book {nonsense} ahead."]));
    refused((c) => (c.rules = ["A stray { brace."]));
    refused((c) => (c.starting_resources = ["Gym", "Gym"]));
    refused((c) => (c.starting_hours = { opens: "22:00", closes: "09:00" }));
    refused((c) => (c.starting_hours = { opens: "09:10", closes: "22:00" }));
    refused((c) => (c.name = ""));
    expect(() => parseClub(variant((c) => (c.booking.days_ahead = 0)))).toThrow(/booking\.days_ahead/);
  });

  it("send the browser only public settings", () => {
    expect(Object.keys(publicClub(CLUB)).sort()).toEqual(
      ["booking", "name", "phrases", "rules", "starting_hours", "starting_resources", "time_zone"].sort(),
    );
  });
});

describe("pages, stylesheet and script", () => {
  /** @type {Record<string, string>} */
  const pages = {};

  beforeAll(async () => {
    const member = await loginMember(await makeMember());
    const admin = await loginAdmin(await makeAdmin());
    const list = [
      ...["/", "/rules", "/login", "/no-such-page", "/admin/login", "/admin/setup"].map((p) => [p, null]),
      ...["/app", "/book", "/events"].map((p) => [p, member]),
      ...["/admin/", "/admin/members", "/admin/schedule", "/admin/leagues", "/admin/resources", "/admin/events", "/admin/audit"].map((p) => [p, admin]),
    ];
    for (const [path, session] of list) {
      const s = /** @type {import("./helpers.js").Session | null} */ (session);
      pages[String(path)] = await (await get(String(path), s ? { cookie: s.cookie } : {})).text();
    }
  });

  it("every page has the club's name in its title, its colours, and nothing left to fill", () => {
    expect(Object.keys(pages)).toHaveLength(16);
    for (const [path, html] of Object.entries(pages)) {
      expect(html, path).toMatch(/<title>[^<]+ – Pastime Athletic Club<\/title>/);
      expect(html, path).toContain('<link rel="stylesheet" href="/club.css">');
      expect(html, path).not.toMatch(/data-club|\[Club name\]/);
    }
  });

  it("the home page shows the club, its contact details and a link to its main website", () => {
    const home = pages["/"] ?? "";
    expect(home).toContain("<h1>Pastime Athletic Club</h1>");
    expect(home).toContain(CLUB.intro);
    expect(home).toContain(CLUB.address);
    expect(home).toContain(CLUB.contact);
    expect(home).toContain('<a href="https://pastimeathleticclub.org">');
  });

  it("the limits on the pages come from the settings", () => {
    /** A page's words, without tags or line breaks. @param {string} path */
    const words = (path) => (pages[path] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(words("/book")).toContain("You can book up to 30 days ahead, in 15-minute blocks, for up to 2 hours.");
    expect(words("/app")).toContain("You can have up to 2 upcoming bookings. Bookings can be cancelled up to 24 hours before they start.");
    expect(words("/app")).toContain("Members who miss 3 bookings may lose booking privileges for 6 months.");
    expect(words("/admin/setup")).toContain("At most 1 admin.");
    expect(words("/admin/resources")).toContain("Opening hours are in club time (New York).");
  });

  it("/club.css holds the club's colours, with the security headers", async () => {
    const response = await get("/club.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
    const css = await response.text();
    expect(css).toContain(`--accent: ${CLUB.colors.light.accent};`);
    expect(css).toContain(`--accent: ${CLUB.colors.dark.accent};`);
  });

  it("/js/club.js is a module with the public settings", async () => {
    const response = await get("/js/club.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/javascript");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const script = await response.text();
    const settings = JSON.parse(script.slice(script.indexOf("{"), script.lastIndexOf("}") + 1));
    expect(settings).toEqual(JSON.parse(JSON.stringify(publicClub(CLUB))));
  });

  it("a filled page has no stored-file validator, so a browser can't keep an old copy", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/rules`, { headers: { "If-None-Match": "*" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeNull();
    expect(await response.text()).toContain(CLUB.rules[0]);
  });
});

describe("the club's starting list of courts and rooms", () => {
  it("can be added once, while there are none, and is logged", async () => {
    expect((await db.prepare("SELECT COUNT(*) AS n FROM resources").first())?.n).toBe(0);
    const admin = await loginAdmin(await makeAdmin());
    const added = await admin.post("/api/admin/resources/starting-list");
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ added: 4 });

    const { resources } = await (await admin.get("/api/admin/resources")).json();
    expect(resources.map((/** @type {{ name: string }} */ r) => r.name)).toEqual([...CLUB.starting_resources]);
    for (const room of resources) {
      expect(room.hours).toEqual([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "09:00", closes: "22:00" })));
    }
    const log = await db.prepare("SELECT details FROM audit_log WHERE action = 'resource.starting_list'").first();
    expect(JSON.parse(String(log?.details)).resources).toEqual([...CLUB.starting_resources]);

    const again = await admin.post("/api/admin/resources/starting-list");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("not_empty");
  });

  it("needs an admin", async () => {
    const member = await loginMember(await makeMember());
    expect((await member.post("/api/admin/resources/starting-list")).status).toBe(401);
  });
});
