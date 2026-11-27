// @ts-check
// Every kind of response must carry the security headers.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { CSP, SECURITY_HEADERS } from "../src/headers.js";

const ORIGIN = "https://club.example.workers.dev";

/** @param {Response} response */
function expectSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

describe("security headers", () => {
  it("uses the strict CSP from the design", () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
        "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it("are on the home page", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await response.text()).toContain("Member login");
    expectSecurityHeaders(response);
  });

  it("are on the rules page, which has the brief's wording", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/rules`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Bookings can be cancelled up to 24 hours before the start time.");
    expect(body).toContain("Your member number and PIN are for you only. Don't share them.");
    expectSecurityHeaders(response);
  });

  it("are on the stylesheet", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/styles.css`);
    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });

  it("are on a missing page, which gets the 404 page", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/no-such-page`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
    expectSecurityHeaders(response);
  });

  it("are on API answers, which are never cached", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectSecurityHeaders(response);
  });

  it("are on unknown API paths", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectSecurityHeaders(response);
  });

  it("are on refused methods", async () => {
    for (const path of ["/", "/api/health"]) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`, { method: "POST" });
      expect(response.status, path).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expectSecurityHeaders(response);
    }
  });

  it("are on server errors, which reveal nothing", async () => {
    const brokenEnv = {
      ...env,
      ASSETS: /** @type {Fetcher} */ (
        /** @type {unknown} */ ({
          fetch: () => {
            throw new Error("boom");
          },
        })
      ),
    };
    const ctx = createExecutionContext();
    const handler = /** @type {NonNullable<typeof worker.fetch>} */ (worker.fetch);
    const response = await handler(new Request(`${ORIGIN}/`), brokenEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectSecurityHeaders(response);
  });
});
