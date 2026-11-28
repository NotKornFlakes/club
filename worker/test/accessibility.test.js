// @ts-check
// Accessibility basics on every page (large text, works on phones, screen readers), and
// colour contrast (WCAG 2.2 AA) for the site's colours in light and dark mode.
// A full axe-core audit of every page was also run by hand for the hardening PR.
import { beforeAll, describe, expect, it } from "vitest";
import { get, loginAdmin, loginMember, makeAdmin, makeMember } from "./helpers.js";

/** @type {Record<string, string>} */
const pages = {};

beforeAll(async () => {
  const member = await loginMember(await makeMember());
  const admin = await loginAdmin(await makeAdmin());
  const list = [
    ["/", null],
    ...["/week", "/bowling", "/athletics", "/banquets", "/history", "/photos", "/contact"].map((p) => [p, null]),
    ["/rules", null],
    ["/login", null],
    ["/no-such-page", null],
    ["/admin/login", null],
    ["/admin/setup", null],
    ["/app", member],
    ["/book", member],
    ["/events", member],
    ...["/admin/", "/admin/members", "/admin/schedule", "/admin/leagues", "/admin/resources", "/admin/events", "/admin/audit"].map((p) => [p, admin]),
  ];
  for (const [path, session] of list) {
    const s = /** @type {import("./helpers.js").Session | null} */ (session);
    pages[String(path)] = await (await get(String(path), s ? { cookie: s.cookie } : {})).text();
  }
});

describe("every page", () => {
  it("declares English, scales on phones, and has a title and exactly one main heading", () => {
    for (const [path, html] of Object.entries(pages)) {
      expect(html, path).toContain('<html lang="en">');
      expect(html, path).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(html, path).toMatch(/<title>[^<]+<\/title>/);
      expect(html.match(/<h1[ >]/g)?.length, path).toBe(1);
      expect(html, path).not.toMatch(/user-scalable=no|maximum-scale/);
    }
  });

  it("has a skip link to the main content", () => {
    for (const [path, html] of Object.entries(pages)) {
      expect(html, path).toContain('<a class="skip-link" href="#main">Skip to main content</a>');
      expect(html, path).toMatch(/<main id="main"[ >]/);
    }
  });

  it("gives every form field a label", () => {
    for (const [path, html] of Object.entries(pages)) {
      const ids = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
      const unlabelled = [...html.matchAll(/<(?:input|select|textarea)\b(?![^>]*\bid=)[^>]*>/g)];
      expect(unlabelled, path).toEqual([]);
      for (const id of ids) expect(html, `${path} #${id}`).toContain(`for="${id}"`);
    }
  });

  it("names every navigation area and lets screen readers hear messages", () => {
    for (const [path, html] of Object.entries(pages)) {
      for (const nav of html.match(/<nav\b[^>]*>/g) ?? []) expect(nav, path).toMatch(/aria-label="/);
      if (html.includes('id="message"')) expect(html, path).toMatch(/id="message"[^>]*role="alert"|role="alert"[^>]*id="message"/);
    }
  });
});

// ---------- Colour contrast ----------

/** @param {string} hex @returns {number} relative luminance (WCAG) */
function luminance(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** @param {string} a @param {string} b */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** @param {string} block */
function variables(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => [m[1], m[2]]));
}

describe("colour contrast (WCAG AA)", () => {
  /** @type {Record<string, Record<string, string>>} */
  const schemes = {};

  beforeAll(async () => {
    /** The light and dark colour variables in one stylesheet. @param {string} css */
    const read = (css) => {
      const light = variables(css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root"))));
      const darkStart = css.indexOf("prefers-color-scheme: dark");
      const dark = variables(css.slice(darkStart, css.indexOf("}", css.indexOf(":root", darkStart))));
      return { light, dark };
    };
    // The site's colours, with the club's own colours (/club.css, loaded after) on top.
    const site = read(await (await get("/styles.css")).text());
    const club = read(await (await get("/club.css")).text());
    expect(Object.keys(club.light).sort()).toEqual(["accent", "accent-text", "brand-bg", "brand-highlight", "brand-text"]);
    schemes.light = { ...site.light, ...club.light };
    schemes.dark = { ...site.light, ...site.dark, ...club.light, ...club.dark };
  });

  // [text colour, background colour, minimum ratio] — 4.5 for text, 3 for borders and controls.
  const pairs = [
    ["text", "bg", 4.5],
    ["muted", "bg", 4.5],
    ["accent", "bg", 4.5],
    ["accent-text", "accent", 4.5],
    ["accent-text", "danger", 4.5],
    ["text", "danger-bg", 4.5],
    ["text", "ok-bg", 4.5],
    ["text", "info-bg", 4.5],
    ["text", "free", 4.5],
    ["muted", "taken", 4.5],
    ["accent", "info-bg", 4.5],
    ["border", "bg", 3],
    ["accent", "bg", 3],
    // The club's header and footer, cards and week view.
    ["brand-text", "brand-bg", 4.5],
    ["brand-highlight", "brand-bg", 4.5],
    ["text", "surface", 4.5],
    ["muted", "surface", 4.5],
    ["accent", "surface", 4.5],
    ...["gold", "blue", "green", "rose", "lilac", "teal"].map((c) => ["program-text", `program-${c}`, 4.5]),
  ];

  it.each(["light", "dark"])("passes in %s mode", (scheme) => {
    const colours = schemes[scheme] ?? {};
    for (const [fg, bg, min] of pairs) {
      const a = colours[String(fg)];
      const b = colours[String(bg)];
      expect(a, `--${fg}`).toBeDefined();
      expect(b, `--${bg}`).toBeDefined();
      expect(contrast(String(a), String(b)), `${scheme}: --${fg} on --${bg}`).toBeGreaterThanOrEqual(Number(min));
    }
  });

  it("uses large text and big tap targets", async () => {
    const css = await (await get("/styles.css")).text();
    expect(css).toMatch(/body \{[^}]*font-size: 1\.125rem/); // 18px
    expect(css).toMatch(/\.button \{[^}]*min-height: 3rem/); // 48px
    expect(css).toMatch(/input,\s*select,\s*textarea \{[^}]*min-height: 3rem/);
  });
});
