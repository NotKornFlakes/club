// @ts-check
// The club's page text: only plain tags get through (club-content-check.js).
import { describe, expect, it } from "vitest";
import { CONTENT_PAGES, ContentError, checkFragment, parseContent } from "../src/club-content-check.js";
import { CONTENT } from "../src/club-content.js";

const photos = new Set(["bowling-lanes.jpg"]);
/** @param {string} html */
const ok = (html) => expect(checkFragment(html, "test", photos)).toBe(html);
/** @param {string} html */
const refused = (html) => expect(() => checkFragment(html, "test", photos), html).toThrow(ContentError);

describe("club page text", () => {
  it("allows headings, paragraphs, lists, links, cards and the club's photos", () => {
    ok('<h2>Bowling</h2><p class="lead">Eight <strong>lanes</strong>, <em>open</em> Fridays.<br>Call us.</p>');
    ok('<ul><li><a href="/book?area=bowling">Book</a></li><li><a href="https://x.com/club">X</a></li></ul>');
    ok('<a href="mailto:club@example.org">Email</a> <a href="tel:315-555-0100">Call</a>');
    ok('<div class="photo-grid"><figure><img src="/club-photos/bowling-lanes.jpg" alt="Lanes"><figcaption>Lanes</figcaption></figure></div>');
    ok('<a class="card" href="/bowling"><img class="card-photo" src="/club-photos/bowling-lanes.jpg" alt=""><h3>Bowling</h3></a>');
    ok("<p>Bar &amp; Banquets</p>");
  });

  it("refuses scripts, styles, embeds, forms, comments and event handlers", () => {
    refused("<script>alert(1)</script>");
    refused("<p style=\"color:red\">x</p>");
    refused('<p onclick="alert(1)">x</p>');
    refused('<iframe src="https://example.org"></iframe>');
    refused('<form action="/x"><input name="a"></form>');
    refused("<!-- hidden -->");
    refused("<svg><script>alert(1)</script></svg>");
    refused("<p>1 < 2</p>");
    refused("<p class=\"bad;class\">x</p>");
    refused("<p id=\"x\">x</p>");
  });

  it("refuses unsafe links and images that aren't the club's own photos", () => {
    refused('<a href="javascript:alert(1)">x</a>');
    refused('<a href="http://example.org">x</a>');
    refused('<a href="//evil.example/x">x</a>');
    refused('<a href="https://user:pass@example.org">x</a>');
    refused('<img src="https://example.org/a.jpg" alt="x">');
    refused('<img src="/club-photos/missing.jpg" alt="x">');
    refused('<img src="/club-photos/bowling-lanes.jpg">');
  });

  it("checks the whole content file, and what the Worker loaded passes", () => {
    expect(() => parseContent(null)).toThrow(ContentError);
    expect(() => parseContent({ source: "drafts", pages: {}, photos: [] })).toThrow(/page "home" is missing/);
    expect(Object.keys(CONTENT.pages).sort()).toEqual([...CONTENT_PAGES].sort());
    expect(["drafts", "placeholders"]).toContain(CONTENT.source);
  });
});
