// @ts-check
// npm run content (also runs before dev, test, typecheck and build): gathers the club's page
// text and photos into worker/src/generated/club-content.json and worker/public/club-photos/.
// Both outputs are gitignored.
//
// Which club: the one worker/src/club.js imports. For each page it uses
//   clubs/<club>/drafts/pages/<page>.html   if present (LOCAL DEMO ONLY, gitignored), else
//   clubs/<club>/pages/<page>.html          (committed placeholders),
// and the same for photos.json and the photo files. Drafts are the club's own text and
// photos from its old site: never commit them until the club gives permission.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { CONTENT_PAGES, PHOTO_FILE, PHOTO_PATH, checkFragment, parseContent } from "../src/club-content-check.js";

const worker = new URL("..", import.meta.url);
const clubImport = readFileSync(new URL("src/club.js", worker), "utf8").match(/clubs\/([a-z0-9-]+)\/club\.json/);
if (!clubImport) throw new Error("worker/src/club.js doesn't import clubs/<club>/club.json");
const clubDir = new URL(`../clubs/${clubImport[1]}/`, worker);
const drafts = new URL("drafts/", clubDir);
// CLUB_CONTENT=placeholders npm run content: use the committed placeholders even when drafts
// are on this computer (to see the site exactly as CI and the live site build it).
const useDrafts = process.env.CLUB_CONTENT !== "placeholders" && existsSync(new URL("photos.json", drafts));
const base = useDrafts ? drafts : clubDir;

/** @param {URL} dir @param {string} name */
const pick = (dir, name) => (existsSync(new URL(name, drafts)) && useDrafts ? new URL(name, drafts) : new URL(name, dir));

const manifest = JSON.parse(readFileSync(new URL("photos.json", base), "utf8"));
const photoDir = new URL("photos/", base);
const available = new Set(existsSync(photoDir) ? readdirSync(photoDir).filter((f) => PHOTO_FILE.test(f)) : []);

/** @param {unknown} file @param {string} what */
function photoFile(file, what) {
  if (typeof file !== "string" || !PHOTO_FILE.test(file) || !available.has(file)) {
    throw new Error(`Club content: ${what} "${String(file)}" isn't in ${photoDir.pathname}`);
  }
  return file;
}

const used = new Set();
const photos = (Array.isArray(manifest.photos) ? manifest.photos : []).map((/** @type {any} */ p, /** @type {number} */ i) => {
  const file = photoFile(p.file, `photos[${i}]`);
  used.add(file);
  return { src: PHOTO_PATH + file, alt: String(p.alt ?? ""), caption: String(p.caption ?? "") };
});
const crest = manifest.crest ? PHOTO_PATH + photoFile(manifest.crest, "crest") : null;
if (crest) used.add(crest.slice(PHOTO_PATH.length));
const hero = manifest.hero ? { src: PHOTO_PATH + photoFile(manifest.hero.file, "hero"), alt: String(manifest.hero.alt ?? "") } : null;
if (hero) used.add(hero.src.slice(PHOTO_PATH.length));

/** @type {Record<string, string>} */
const pages = {};
for (const name of CONTENT_PAGES) {
  const html = readFileSync(pick(clubDir, `pages/${name}.html`), "utf8").trim();
  for (const m of html.matchAll(/src="\/club-photos\/([^"]+)"/g)) used.add(photoFile(m[1], `image in ${name}.html`));
  pages[name] = checkFragment(html, name, available);
}

const content = { source: useDrafts ? "drafts" : "placeholders", crest, hero, pages, photos };
parseContent(content); // the Worker checks it the same way when it starts

const out = new URL("public/club-photos/", worker);
rmSync(out, { recursive: true, force: true });
if (used.size > 0) {
  mkdirSync(out, { recursive: true });
  for (const file of used) copyFileSync(new URL(file, photoDir), new URL(file, out));
}
mkdirSync(new URL("src/generated/", worker), { recursive: true });
writeFileSync(new URL("src/generated/club-content.json", worker), `${JSON.stringify(content, null, 2)}\n`);
console.log(
  useDrafts
    ? `Club content: DRAFTS from clubs/${clubImport[1]}/drafts/ (local demo only, never commit), ${used.size} photos.`
    : `Club content: placeholders from clubs/${clubImport[1]}/ (${process.env.CLUB_CONTENT === "placeholders" ? "CLUB_CONTENT=placeholders" : "no drafts on this computer"}).`,
);
