// @ts-check
// Puts the club into what the browser gets, as it's served (HTMLRewriter):
//   - every public and member page: the site header (crest, name, menu) and footer
//     (address, phone, email, links), the page title, and club text marked data-club="...",
//   - the content pages: the club's own text and photos (clubs/<club>/pages, checked against
//     an allowed list of tags in club-content-check.js),
//   - /club.css: the club's colors; /js/club.js: the settings the page scripts need.
// Text always goes in escaped. Nothing here is secret: see club-config.js.

import { publicClub } from "./club-config.js";
import { CONTENT } from "./club-content.js";
import { CLUB } from "./club.js";
import { DEMO_BANNER } from "./demo.js";

/** The site menu, in order. */
export const NAV = Object.freeze([
  ["/", "Home"],
  ["/week", "This Week"],
  ["/book", "Book"],
  ["/bowling", "Bowling"],
  ["/athletics", "Athletics"],
  ["/banquets", "Bar & Banquets"],
  ["/history", "History"],
  ["/photos", "Photos"],
  ["/contact", "Contact"],
]);

/** What a page can ask for with data-club="key". @type {Readonly<Record<string, string>>} */
export const CLUB_TEXT = Object.freeze({
  name: CLUB.name,
  motto: CLUB.motto,
  since: CLUB.since,
  address: CLUB.contact.address,
  phone: CLUB.contact.phone,
  email: CLUB.contact.email,
  ...CLUB.phrases,
});

/** @type {Readonly<Record<string, string>>} */
const ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" });

/** Text made safe to sit between tags. @param {string} text */
export function escapeText(text) {
  return text.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);
}

/** Text made safe inside a double-quoted attribute. @param {string} text */
export function escapeAttr(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** "315-471-7929" → "tel:3154717929". @param {string} phone */
const telHref = (phone) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

/** The crest (or the club's first letter, if there's no crest yet). @param {string} className */
function crest(className) {
  return CONTENT.crest
    ? `<img class="${className}" src="${escapeAttr(CONTENT.crest)}" alt="" width="64" height="64">`
    : `<span class="${className} crest-letter" aria-hidden="true">${escapeText(CLUB.name.slice(0, 1))}</span>`;
}

/** The menu item for a page: /book/... counts as Book. @param {string} page */
function current(page) {
  if (page === "/") return "/";
  return NAV.find(([href]) => href !== "/" && (page === href || page.startsWith(`${href}/`)))?.[0] ?? "";
}

/** @param {string} page the page path, e.g. "/week" */
export function siteHeader(page) {
  const active = current(page);
  const items = NAV.map(
    ([href, label]) => `<li><a href="${href}"${href === active ? ' aria-current="page"' : ""}>${escapeText(label)}</a></li>`,
  ).join("");
  const members = page === "/app" ? ' aria-current="page"' : "";
  return [
    `<div class="site-header-inner">`,
    `<a class="brand" href="/">${crest("crest")}<span class="brand-text"><span class="brand-name">${escapeText(CLUB.name)}</span>`,
    `<span class="brand-motto">${escapeText(CLUB.motto)}</span></span></a>`,
    `<a class="members-link" href="/app"${members}>Members</a>`,
    `<button type="button" class="menu-button" aria-expanded="false" aria-controls="site-nav">Menu</button>`,
    `</div>`,
    `<nav id="site-nav" class="site-nav" aria-label="Main"><ul>${items}<li class="nav-members"><a href="/app"${members}>Members</a></li></ul></nav>`,
  ].join("");
}

/** The club's address, phone, email and links, for the footer and the Contact page. */
export function contactHtml() {
  const c = CLUB.contact;
  const links = c.links.map((l) => `<li><a href="${escapeAttr(l.url)}" rel="noopener">${escapeText(l.label)}</a></li>`).join("");
  return [
    `<address class="contact">`,
    `<p class="contact-address">${escapeText(c.address)}<br><a href="${escapeAttr(c.map)}" rel="noopener">Map (OpenStreetMap)</a></p>`,
    `<p><a href="${escapeAttr(telHref(c.phone))}">${escapeText(c.phone)}</a></p>`,
    `<p><a href="mailto:${escapeAttr(c.email)}">${escapeText(c.email)}</a></p>`,
    `</address>`,
    `<ul class="social-links" aria-label="${escapeAttr(CLUB.name)} elsewhere">${links}</ul>`,
  ].join("");
}

export function siteFooter() {
  return [
    `<div class="site-footer-inner">`,
    `<div class="footer-club">${crest("crest footer-crest")}<div><p class="footer-name">${escapeText(CLUB.name)}</p>`,
    `<p class="footer-motto">${escapeText(CLUB.since)} · ${escapeText(CLUB.motto)}</p></div></div>`,
    `<div class="footer-contact">${contactHtml()}</div>`,
    `<p class="footer-small"><a href="/rules">Booking rules</a> · <a href="/login">Member login</a> · <a href="/contact">Contact</a></p>`,
    `</div>`,
  ].join("");
}

/** The Photos page's gallery. */
function galleryHtml() {
  if (CONTENT.photos.length === 0) {
    return `<li class="gallery-empty">Photos are coming soon, once the club has chosen them.</li>`;
  }
  return CONTENT.photos
    .map(
      (p) =>
        `<li><figure><img src="${escapeAttr(p.src)}" alt="${escapeAttr(p.alt)}" loading="lazy">` +
        (p.caption ? `<figcaption>${escapeText(p.caption)}</figcaption>` : "") +
        `</figure></li>`,
    )
    .join("");
}

/**
 * Fills in a page: header, footer, title, club text and content. Other responses pass
 * through unchanged.
 *   <header data-site-header></header>          → crest, name, motto, menu
 *   <footer data-site-footer></footer>          → contact details
 *   <title data-club-title>Book a time</title>  → "Book a time – <club name>"
 *   <span data-club="cancel_cutoff"></span>     → "24 hours"
 *   <div data-club-content="history"></div>     → the club's history page text
 *   <div data-club-hero>                        → the hero photo, if the club has one
 *   <div data-club-crest>                       → the crest
 *   <ul data-club-photos></ul>                  → the gallery
 *   <div data-club-contact></div>               → address, map link, phone, email, links
 *   <ul data-club-rules></ul>                   → one <li> per booking rule
 * On a demo site, the demo banner goes at the top of the page body.
 * @param {Response} response @param {string} page the page path, e.g. "/week"
 * @param {{ demo?: boolean }} [options]
 * @returns {Response}
 */
export function fillClubPage(response, page, options = {}) {
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.startsWith("text/html")) return response;
  /** @param {Element} el @param {string} html */
  const fill = (el, html) => el.setInnerContent(html, { html: true });
  const filled = response.body
    ? new HTMLRewriter()
        .on("body", {
          element(el) {
            if (options.demo) el.prepend(`<p class="demo-banner">${escapeText(DEMO_BANNER)}</p>`, { html: true });
          },
        })
        .on("title[data-club-title]", {
          element(el) {
            el.removeAttribute("data-club-title");
            el.append(` – ${CLUB.name}`);
          },
        })
        .on("header[data-site-header]", {
          element(el) {
            el.removeAttribute("data-site-header");
            el.setAttribute("class", "site-header");
            fill(el, siteHeader(page));
          },
        })
        .on("footer[data-site-footer]", {
          element(el) {
            el.removeAttribute("data-site-footer");
            el.setAttribute("class", "site-footer");
            fill(el, siteFooter());
          },
        })
        .on("[data-club]", {
          element(el) {
            const key = el.getAttribute("data-club") ?? "";
            // An unknown key stays in the page, where a test finds it.
            if (!Object.hasOwn(CLUB_TEXT, key)) return;
            el.setInnerContent(CLUB_TEXT[key] ?? "");
            el.removeAttribute("data-club");
          },
        })
        .on("[data-club-content]", {
          element(el) {
            const key = el.getAttribute("data-club-content") ?? "";
            if (!Object.hasOwn(CONTENT.pages, key)) return;
            el.removeAttribute("data-club-content");
            fill(el, CONTENT.pages[key] ?? "");
          },
        })
        .on("[data-club-hero]", {
          element(el) {
            el.removeAttribute("data-club-hero");
            if (CONTENT.hero) {
              el.prepend(`<img class="hero-photo" src="${escapeAttr(CONTENT.hero.src)}" alt="${escapeAttr(CONTENT.hero.alt)}">`, { html: true });
            } else {
              el.setAttribute("class", `${el.getAttribute("class") ?? ""} hero-plain`.trim());
            }
          },
        })
        .on("[data-club-crest]", {
          element(el) {
            el.removeAttribute("data-club-crest");
            fill(el, crest("hero-crest"));
          },
        })
        .on("ul[data-club-photos]", {
          element(el) {
            el.removeAttribute("data-club-photos");
            fill(el, galleryHtml());
          },
        })
        .on("[data-club-contact]", {
          element(el) {
            el.removeAttribute("data-club-contact");
            fill(el, contactHtml());
          },
        })
        .on("ul[data-club-rules]", {
          element(el) {
            el.removeAttribute("data-club-rules");
            fill(el, CLUB.rules.map((rule) => `<li>${escapeText(rule)}</li>`).join(""));
          },
        })
        .transform(response)
    : response;
  // The stored file's validators don't describe the filled page, so drop them: a browser
  // must never keep an old copy after the club's settings change.
  const out = new Response(filled.body, filled);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  return out;
}

/** Always fetched fresh (revalidated), like the pages. */
const FILE_CACHE = "no-cache";

/** /club.css: the club's colors, on top of styles.css. */
export function clubStylesheet() {
  const { brand, light, dark } = CLUB.colors;
  const css = [
    "/* This club's colors, from its settings file (clubs/<club>/club.json). */",
    ":root {",
    `  --brand-bg: ${brand.background};`,
    `  --brand-text: ${brand.text};`,
    `  --brand-highlight: ${brand.highlight};`,
    `  --accent: ${light.accent};`,
    `  --accent-text: ${light.accent_text};`,
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    `    --accent: ${dark.accent};`,
    `    --accent-text: ${dark.accent_text};`,
    "  }",
    "}",
    "",
  ].join("\n");
  return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": FILE_CACHE } });
}

/** /js/club.js: `export const CLUB = {...}` for the page scripts. */
export function clubScript() {
  const body = `// This club's settings, from its settings file (clubs/<club>/club.json).\nexport const CLUB = ${JSON.stringify(publicClub(CLUB))};\n`;
  return new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": FILE_CACHE } });
}
