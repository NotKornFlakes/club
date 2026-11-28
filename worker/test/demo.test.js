// @ts-check
// Demo sites (DEMO_MODE "on"): lighter hashing, a banner on every page, not listed by
// search engines. Off by default, and off unless the setting is exactly "on".
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { escapeText } from "../src/club-pages.js";
import { DEMO_PBKDF2_ITERATIONS, PBKDF2_ITERATIONS, hashSecret, pepperKeys } from "../src/crypto.js";
import { DEMO_BANNER } from "../src/demo.js";
import worker from "../src/index.js";
import { ORIGIN, db, loginAdmin, makeAdmin, makeMember, newIp, resetThrottle } from "./helpers.js";

const DEMO = { DEMO_MODE: "on" };

/**
 * Calls the Worker directly with DEMO_MODE changed.
 * @param {string} path @param {Partial<Env>} changes @param {RequestInit} [init]
 */
async function call(path, changes, init = {}) {
  const ctx = createExecutionContext();
  const handler = /** @type {NonNullable<typeof worker.fetch>} */ (worker.fetch);
  const request = /** @type {Request<unknown, IncomingRequestCfProperties>} */ (new Request(`${ORIGIN}${path}`, init));
  const response = await handler(request, /** @type {Env} */ ({ ...env, ...changes }), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** @param {string} number @param {string} pin */
function memberLogin(number, pin) {
  return {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": newIp() },
    body: JSON.stringify({ member_number: number, pin }),
  };
}

/** A member whose PIN was hashed with these rounds. @param {number} rounds */
async function memberHashedWith(rounds) {
  const member = await makeMember({ pin: "246810" });
  const hash = await hashSecret(member.pin, await pepperKeys(env.PEPPER), rounds);
  await db.prepare("UPDATE members SET pin_hash = ? WHERE id = ?").bind(hash, member.id).run();
  return member;
}

beforeEach(resetThrottle);

describe("demo mode is off unless DEMO_MODE is exactly \"on\"", () => {
  it("is off in this repo's settings", () => {
    expect(env.DEMO_MODE).toBe("off");
  });

  for (const value of ["off", "", "ON", "true", "1"]) {
    it(`shows no banner and allows listing when DEMO_MODE is ${JSON.stringify(value)}`, async () => {
      const response = await call("/", { DEMO_MODE: value });
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Robots-Tag")).toBeNull();
      expect(await response.text()).not.toContain("demo-banner");
    });
  }
});

describe("a demo site", () => {
  it("shows the banner at the top of public, login and admin pages", async () => {
    for (const path of ["/", "/week", "/bowling", "/login", "/admin/login"]) {
      const response = await call(path, DEMO);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain(`<p class="demo-banner">${escapeText(DEMO_BANNER)}</p>`);
      expect(html.indexOf("demo-banner"), path).toBeLessThan(html.indexOf("skip-link"));
    }
  });

  it("asks search engines not to list pages, files or API answers", async () => {
    for (const path of ["/", "/styles.css", "/api/health", "/no-such-page"]) {
      const response = await call(path, DEMO);
      expect(response.headers.get("X-Robots-Tag"), path).toBe("noindex, nofollow");
    }
  });

  it("logs in a member whose PIN was hashed with the demo's rounds", async () => {
    const member = await memberHashedWith(DEMO_PBKDF2_ITERATIONS);
    expect((await call("/api/login", DEMO, memberLogin(member.number, member.pin))).status).toBe(200);
    expect((await call("/api/login", DEMO, memberLogin(member.number, "135790"))).status).toBe(401);
  });

  it("never accepts demo hashes on a full-strength site, or full-strength ones on a demo", async () => {
    const demoMember = await memberHashedWith(DEMO_PBKDF2_ITERATIONS);
    expect((await call("/api/login", {}, memberLogin(demoMember.number, demoMember.pin))).status).toBe(401);
    const fullMember = await memberHashedWith(PBKDF2_ITERATIONS);
    expect((await call("/api/login", DEMO, memberLogin(fullMember.number, fullMember.pin))).status).toBe(401);
  });

  it("gives new and reset PINs the demo's rounds", async () => {
    const admin = await loginAdmin(await makeAdmin());
    const headers = { Origin: ORIGIN, "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf };
    const numbers = Array.from({ length: 25 }, (_, i) => `DEMO${Date.now() % 100000}-${i}`);
    const imported = await call("/api/admin/members/import", DEMO, {
      method: "POST",
      headers,
      body: JSON.stringify({ members: numbers.map((n) => ({ member_number: n })) }),
    });
    expect(imported.status).toBe(200);
    const { created } = /** @type {{ created: Array<{ member_number: string, pin: string }> }} */ (await imported.json());
    expect(created).toHaveLength(25);
    const { results } = await db
      .prepare("SELECT id, pin_hash FROM members WHERE member_number IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(numbers))
      .all();
    expect(results.map((r) => String(r.pin_hash).split("$")[1])).toEqual(Array(25).fill("1000"));

    const first = created[0];
    if (!first) throw new Error("no member");
    expect((await call("/api/login", DEMO, memberLogin(first.member_number, first.pin))).status).toBe(200);

    const id = Number(results[0]?.id);
    const reset = await call(`/api/admin/members/${id}/reset-pin`, DEMO, { method: "POST", headers, body: "{}" });
    expect(reset.status).toBe(200);
    const row = await db.prepare("SELECT pin_hash FROM members WHERE id = ?").bind(id).first();
    expect(String(row?.pin_hash).split("$")[1]).toBe("1000");
  });
});
