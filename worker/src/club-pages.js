// @ts-check
// Puts the club's settings into what the browser gets, as it's served:
//   - pages: elements marked data-club="..." get the club's text (HTMLRewriter),
//   - /club.css: the club's colors,
//   - /js/club.js: the settings the page scripts need.
// Text always goes in escaped, never as HTML. Nothing here is secret: see club-config.js.

import { publicClub } from "./club-config.js";
import { CLUB } from "./club.js";

/** What a page can ask for with data-club="key". @type {Readonly<Record<string, string>>} */
export const CLUB_TEXT = Object.freeze({
  name: CLUB.name,
  intro: CLUB.intro,
  address: CLUB.address,
  contact: CLUB.contact,
  ...CLUB.phrases,
});

/** @type {Readonly<Record<string, string>>} */
const TEXT_ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;" });

/** Text made safe to sit between tags (not inside an attribute). @param {string} text */
export function escapeText(text) {
  return text.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c] ?? c);
}

/**
 * Fills in a page's club text. Other responses pass through unchanged.
 *   <title data-club-title>Book a time</title>  → "Book a time – <club name>"
 *   <span data-club="cancel_cutoff"></span>     → "24 hours"
 *   <a data-club-website>                       → href = the club's own website
 *   <ul data-club-rules></ul>                   → one <li> per booking rule
 * @param {Response} response
 * @returns {Response}
 */
export function fillClubPage(response) {
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.startsWith("text/html")) return response;
  const filled = response.body
    ? new HTMLRewriter()
        .on("title[data-club-title]", {
          element(el) {
            el.removeAttribute("data-club-title");
            el.append(` – ${CLUB.name}`);
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
        .on("a[data-club-website]", {
          element(el) {
            el.setAttribute("href", CLUB.website);
            el.removeAttribute("data-club-website");
          },
        })
        .on("ul[data-club-rules]", {
          element(el) {
            el.setInnerContent(CLUB.rules.map((rule) => `<li>${escapeText(rule)}</li>`).join(""), { html: true });
            el.removeAttribute("data-club-rules");
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

/** /club.css: the club's accent colors, on top of styles.css. */
export function clubStylesheet() {
  const { light, dark } = CLUB.colors;
  const css = [
    "/* This club's colors, from its settings file (clubs/<club>/club.json). */",
    ":root {",
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
