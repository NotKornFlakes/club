// @ts-check
// The club's settings file (clubs/pastime/club.json): what Pastime's says, what any club's
// file is allowed to say, and that every page, stylesheet and script gets its values.
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import raw from "../../clubs/pastime/club.json" with { type: "json" };
import { CEILINGS, DEFAULT_MAX_ADMINS, ClubConfigError, parseClub, publicClub } from "../src/club-config.js";
import { CONTENT } from "../src/club-content.js";
import { NAV, escapeText } from "../src/club-pages.js";
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
  it("name the club, its contact details, areas, courts, lanes and rooms, and one admin", () => {
    expect(CLUB.name).toBe("Pastime Athletic Club");
    expect(CLUB.motto).toBe("Health · Wellness · Charity · Sport");
    expect(CLUB.since).toBe("Since 1892");
    expect(CLUB.contact).toMatchObject({
      address: "1314 N Salina St, Syracuse, NY 13208",
      phone: "315-471-7929",
      email: "pastimeathleticclub@gmail.com",
    });
    expect(CLUB.contact.links.map((l) => l.label)).toEqual(["Facebook", "X"]);
    expect(CLUB.contact.map).toMatch(/^https:\/\/www\.openstreetmap\.org\//);
    expect(CLUB.time_zone).toBe("America/New_York");
    expect(CLUB.max_admins).toBe(1);
    expect(CLUB.areas.map((a) => a.id)).toEqual(["gym", "bowling", "rooms"]);
    const names = (/** @type {string} */ area) => CLUB.starting_resources.filter((r) => r.area === area).map((r) => r.name);
    expect(names("gym")).toEqual(["Gymnasium"]);
    expect(names("bowling")).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Lane ${n}`));
    expect(names("rooms")).toEqual(["President's Room", "Century Room", "Lounge"]);
    expect(CLUB.starting_hours).toEqual({ opens: "08:00", closes: "22:00" });
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

  it("use the club's navy and gold", () => {
    expect(CLUB.colors.brand).toEqual({ background: "#1b2a4a", text: "#ffffff", highlight: "#e0b84a" });
    expect(CLUB.colors.light.accent).toBe("#1b2a4a");
    expect(CLUB.colors.dark.accent).toBe("#e3bd55");
  });

  it("never link to the old Weebly site", () => {
    expect(JSON.stringify(raw)).not.toMatch(/weebly|blogspot|calendar\.google|https:\/\/pastimeathleticclub\.org/i);
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

  it("refuse bad redirects", () => {
    refused((c) => (c.redirects = { "/about.html": "https://example.org" }));
    refused((c) => (c.redirects = { "/about.html": "//evil.example" }));
    refused((c) => (c.redirects = { "/api/week": "/" }));
    refused((c) => (c.redirects = { "about.html": "/" }));
    expect(parseClub(variant((c) => delete c.redirects)).redirects).toEqual({});
  });

  it("refuse bad contact details, areas and resources", () => {
    refused((c) => (c.contact.email = "not an email"));
    refused((c) => (c.contact.phone = "call us"));
    refused((c) => (c.contact.map = "http://example.org/map"));
    refused((c) => (c.contact.links = [{ label: "Site", url: "javascript:alert(1)" }]));
    refused((c) => (c.areas = [{ id: "Gym!", name: "Gym" }]));
    refused((c) => (c.areas = [{ id: "gym", name: "Gym" }, { id: "gym", name: "Again" }]));
    refused((c) => (c.starting_resources = [{ name: "Court", area: "nowhere" }]));
    refused((c) => (c.colors.brand.highlight = "gold"));
    refused((c) => (c.founded = 92));
  });

  it("send the browser only public settings", () => {
    expect(Object.keys(publicClub(CLUB)).sort()).toEqual(
      ["areas", "booking", "name", "phrases", "rules", "starting_hours", "starting_resources", "time_zone"].sort(),
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
      ...["/", "/week", "/bowling", "/athletics", "/banquets", "/history", "/photos", "/contact"].map((p) => [p, null]),
      ...["/rules", "/login", "/no-such-page", "/admin/login", "/admin/setup"].map((p) => [p, null]),
      ...["/app", "/book", "/events"].map((p) => [p, member]),
      ...["/admin/", "/admin/members", "/admin/schedule", "/admin/leagues", "/admin/resources", "/admin/events", "/admin/audit"].map((p) => [p, admin]),
    ];
    for (const [path, session] of list) {
      const s = /** @type {import("./helpers.js").Session | null} */ (session);
      pages[String(path)] = await (await get(String(path), s ? { cookie: s.cookie } : {})).text();
    }
  });

  it("every page has the club's name in its title, its colours, and nothing left to fill", () => {
    expect(Object.keys(pages)).toHaveLength(23);
    for (const [path, html] of Object.entries(pages)) {
      expect(html, path).toMatch(/<title>[^<]+ – Pastime Athletic Club<\/title>/);
      expect(html, path).toContain('<link rel="stylesheet" href="/club.css">');
      expect(html, path).not.toMatch(/data-club|\[Club name\]/);
    }
  });

  it("the home page shows the club's name, motto and year, and the way to This Week and Book", () => {
    const home = pages["/"] ?? "";
    expect(home).toContain('<h1 id="club-name">Pastime Athletic Club</h1>');
    expect(home).toContain(">Since 1892<");
    expect(home).toContain(">Health · Wellness · Charity · Sport<");
    expect(home).toMatch(/<a class="button button-gold" href="\/week">/);
    expect(home).toContain('href="/book"');
  });

  it("every public and member page has the site menu and the club's contact details", () => {
    const site = Object.entries(pages).filter(([path]) => !path.startsWith("/admin"));
    expect(site).toHaveLength(14);
    for (const [path, html] of site) {
      for (const [href, label] of NAV) {
        expect(html, path).toContain(`<a href="${href}"`);
        expect(html, path).toContain(`>${escapeText(label)}</a>`);
      }
      expect(html, path).toContain('<nav id="site-nav" class="site-nav" aria-label="Main">');
      expect(html, path).toContain("1314 N Salina St, Syracuse, NY 13208");
      expect(html, path).toContain('<a href="tel:3154717929">315-471-7929</a>');
      expect(html, path).toContain('<a href="mailto:pastimeathleticclub@gmail.com">pastimeathleticclub@gmail.com</a>');
      expect(html, path).toContain('<a href="https://facebook.com/pastimeac" rel="noopener">Facebook</a>');
      expect(html, path).toContain('<a href="https://x.com/PastimeAC1892" rel="noopener">X</a>');
      expect(html, path).not.toMatch(/weebly|blogspot|calendar\.google/i);
    }
  });

  it("marks the current page in the menu", () => {
    expect(pages["/week"]).toContain('<a href="/week" aria-current="page">This Week</a>');
    expect(pages["/book"]).toContain('<a href="/book" aria-current="page">Book</a>');
    expect(pages["/banquets"]).toContain('<a href="/banquets" aria-current="page">Bar &amp; Banquets</a>');
    expect(pages["/"]).toContain('<a href="/" aria-current="page">Home</a>');
    expect((pages["/history"] ?? "").match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("the Contact page has the map link, phone and email as big links", () => {
    const contact = pages["/contact"] ?? "";
    expect(contact).toContain('<main id="main" class="wide contact-page">');
    expect(contact).toContain(`<a href="${CLUB.contact.map}" rel="noopener">Map (OpenStreetMap)</a>`);
    expect(contact.match(/href="tel:3154717929"/g)?.length).toBe(2); // page and footer
  });

  it("the content pages show the club's text (drafts locally, placeholders in CI)", () => {
    for (const [path, key] of [["/athletics", "athletics"], ["/bowling", "bowling"], ["/banquets", "banquets"], ["/history", "history"], ["/", "home"]]) {
      expect(pages[path], path).toContain(CONTENT.pages[key] ?? "missing");
    }
    const photos = pages["/photos"] ?? "";
    if (CONTENT.photos.length === 0) expect(photos).toContain("Photos are coming soon");
    else for (const p of CONTENT.photos) expect(photos).toContain(`src="${p.src}"`);
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
    expect(await added.json()).toEqual({ added: 12 });

    const { resources } = await (await admin.get("/api/admin/resources")).json();
    expect(resources.map((/** @type {{ name: string, area: string }} */ r) => ({ name: r.name, area: r.area }))).toEqual(
      CLUB.starting_resources.map((r) => ({ name: r.name, area: r.area })),
    );
    for (const room of resources) {
      expect(room.hours).toEqual([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })));
    }
    const log = await db.prepare("SELECT details FROM audit_log WHERE action = 'resource.starting_list'").first();
    expect(JSON.parse(String(log?.details)).resources).toEqual(CLUB.starting_resources.map((r) => r.name));

    const again = await admin.post("/api/admin/resources/starting-list");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("not_empty");
  });

  it("needs an admin", async () => {
    const member = await loginMember(await makeMember());
    expect((await member.post("/api/admin/resources/starting-list")).status).toBe(401);
  });
});
