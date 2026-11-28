// @ts-check
// Checks a club's page text (clubs/<club>/pages/*.html) before it goes into a page. Only a
// short list of plain tags and attributes is allowed: no scripts, styles, embeds, forms,
// comments or event handlers. Links may only go to this site, https:// pages, mailto: or
// tel:, and images only to the club's own photos. Pure, so the content script and the
// tests can use it too.

/** Tag → the attributes it may have. @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const ALLOWED = Object.freeze({
  h2: [],
  h3: [],
  p: ["class"],
  ul: ["class"],
  ol: [],
  li: [],
  a: ["href", "class"],
  strong: [],
  em: [],
  br: [],
  div: ["class"],
  figure: ["class"],
  figcaption: [],
  blockquote: [],
  img: ["src", "alt", "class"],
});

/** The pages whose text comes from the club's folder (clubs/<club>/pages/<name>.html). */
export const CONTENT_PAGES = Object.freeze(["home", "athletics", "bowling", "banquets", "history"]);

/** Where the club's photos are served from. */
export const PHOTO_PATH = "/club-photos/";

/** A photo file name: lowercase, digits and dashes, .jpg or .png. */
export const PHOTO_FILE = /^[a-z0-9][a-z0-9-]{0,80}\.(jpg|png)$/;

export class ContentError extends Error {}

/** @param {string} href */
function safeHref(href) {
  if (href.startsWith("/") && !href.startsWith("//")) return /^[A-Za-z0-9/_.?=&#-]*$/.test(href);
  if (href.startsWith("mailto:")) return /^mailto:[^\s<>"']+@[^\s<>"']+$/.test(href);
  if (href.startsWith("tel:")) return /^tel:[0-9+\-]+$/.test(href);
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Throws ContentError unless `html` uses only the allowed tags and attributes.
 * @param {string} html @param {string} name for messages @param {ReadonlySet<string>} photos the photo files that exist
 * @returns {string} the same html
 */
export function checkFragment(html, name, photos) {
  const fail = (/** @type {string} */ why) => new ContentError(`Club content "${name}": ${why}`);
  if (html.length > 50_000) throw fail("is too long");
  if (/<!--|<!|<\?/.test(html)) throw fail("has a comment or a <! / <? tag; only plain tags are allowed");
  const rest = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*\/?>/g, (_, close, rawTag, attrText) => {
    const tag = String(rawTag).toLowerCase();
    if (!Object.hasOwn(ALLOWED, tag)) throw fail(`<${tag}> isn't allowed`);
    if (close && attrText.trim() !== "") throw fail(`</${tag}> can't have attributes`);
    const allowed = ALLOWED[tag] ?? [];
    for (const m of String(attrText).matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      const attr = String(m[1]).toLowerCase();
      const value = String(m[2]);
      if (!allowed.includes(attr)) throw fail(`<${tag} ${attr}> isn't allowed`);
      if (attr === "class" && !/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(value)) throw fail(`class="${value}" isn't a plain class name`);
      if (attr === "href" && !safeHref(value)) throw fail(`link "${value}" must go to this site, https://, mailto: or tel:`);
      if (attr === "src") {
        const file = value.startsWith(PHOTO_PATH) ? value.slice(PHOTO_PATH.length) : "";
        if (!PHOTO_FILE.test(file) || !photos.has(file)) throw fail(`image "${value}" must be one of the club's photos (${PHOTO_PATH}...)`);
      }
    }
    // alt="" is right for a decorative image (for example on a link card that has its own text).
    if (tag === "img" && !/\balt="/.test(String(attrText))) throw fail("every image needs an alt attribute");
    return "";
  });
  if (/[<>]/.test(rest)) throw fail("has a < or > that isn't part of an allowed tag");
  return html;
}

/**
 * @typedef {{ src: string, alt: string, caption: string }} Photo
 * @typedef {{
 *   source: "drafts" | "placeholders",
 *   crest: string | null,
 *   hero: { src: string, alt: string } | null,
 *   pages: Readonly<Record<string, string>>,
 *   photos: ReadonlyArray<Photo>,
 * }} ClubContent
 */

/**
 * Checks the content file the content script made (worker/src/generated/club-content.json).
 * @param {unknown} raw @returns {Readonly<ClubContent>}
 */
export function parseContent(raw) {
  const fail = (/** @type {string} */ why) => new ContentError(`Club content: ${why}`);
  if (typeof raw !== "object" || raw === null) throw fail("is missing. Run npm run content.");
  const c = /** @type {Record<string, any>} */ (raw);
  if (c.source !== "drafts" && c.source !== "placeholders") throw fail("has no source");
  const photos = Array.isArray(c.photos) ? c.photos : [];
  const files = new Set(
    [...photos.map((p) => String(p?.src ?? "")), String(c.hero?.src ?? ""), String(c.crest ?? "")]
      .filter((src) => src.startsWith(PHOTO_PATH))
      .map((src) => src.slice(PHOTO_PATH.length)),
  );
  for (const file of files) if (!PHOTO_FILE.test(file)) throw fail(`bad photo file ${file}`);
  /** @type {Record<string, string>} */
  const pages = {};
  for (const name of CONTENT_PAGES) {
    if (typeof c.pages?.[name] !== "string") throw fail(`page "${name}" is missing`);
    pages[name] = checkFragment(c.pages[name], name, files);
  }
  /** @param {unknown} p */
  const photo = (p) => {
    const item = /** @type {Record<string, unknown>} */ (p);
    if (typeof item?.src !== "string" || !item.src.startsWith(PHOTO_PATH) || typeof item.alt !== "string" || item.alt === "") {
      throw fail("every photo needs a src and alt text");
    }
    return Object.freeze({ src: item.src, alt: item.alt, caption: typeof item.caption === "string" ? item.caption : "" });
  };
  return Object.freeze({
    source: c.source,
    crest: typeof c.crest === "string" ? c.crest : null,
    hero: c.hero ? Object.freeze({ src: String(c.hero.src), alt: String(c.hero.alt) }) : null,
    pages: Object.freeze(pages),
    photos: Object.freeze(photos.map(photo)),
  });
}
