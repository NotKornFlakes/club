// @ts-check
// Shared test helpers: make members and admins, log in, and call the API the way the
// site's own pages do (same Origin, JSON body, session cookie, CSRF token).
import { env, exports } from "cloudflare:workers";
import { encryptText, hashSecret, pepperKeys } from "../src/crypto.js";

export const ORIGIN = "https://club.example.workers.dev";
export const db = env.DB;

let seq = 0;
/** A unique value per call, for member numbers, names and IPs. */
export function unique() {
  seq += 1;
  return seq;
}

/** A unique test IP (TEST-NET-2). */
export function newIp() {
  const n = unique();
  return `198.51.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

/** @returns {number} */
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * @param {{ number?: string, pin?: string, status?: "active" | "disabled", name?: string | null }} [options]
 * @returns {Promise<{ id: number, number: string, pin: string }>}
 */
export async function makeMember(options = {}) {
  const number = options.number ?? `T${unique()}`;
  const pin = options.pin ?? "123456";
  const now = nowSeconds();
  const keys = await pepperKeys(env.PEPPER);
  const result = await db
    .prepare(
      `INSERT INTO members (member_number, display_name, pin_hash, status, pin_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(number, options.name ?? null, await hashSecret(pin, keys), options.status ?? "active", now, now, now)
    .run();
  return { id: result.meta.last_row_id, number, pin };
}

/**
 * @param {{ username?: string, password?: string, totpSecret?: string }} [options]
 * @returns {Promise<{ id: number, username: string, password: string, totpSecret: string }>}
 */
export async function makeAdmin(options = {}) {
  const username = options.username ?? `admin${unique()}`;
  const password = options.password ?? "correct horse battery staple";
  const totpSecret = options.totpSecret ?? "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const now = nowSeconds();
  const keys = await pepperKeys(env.PEPPER);
  const result = await db
    .prepare(
      `INSERT INTO admins (username, password_hash, totp_secret_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(username, await hashSecret(password, keys), await encryptText(totpSecret, keys), now, now)
    .run();
  return { id: result.meta.last_row_id, username, password, totpSecret };
}

/**
 * @typedef {{ cookie?: string, csrf?: string, origin?: string | null, ip?: string, contentType?: string | null, raw?: string }} CallOptions
 */

/**
 * A POST like the site's pages make.
 * @param {string} path @param {unknown} body @param {CallOptions} [options]
 */
export function post(path, body = {}, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { "CF-Connecting-IP": options.ip ?? "203.0.113.1" };
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers["X-CSRF-Token"] = options.csrf;
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

/** @param {string} path @param {CallOptions} [options] */
export function get(path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { "CF-Connecting-IP": options.ip ?? "203.0.113.1" };
  if (options.cookie) headers.Cookie = options.cookie;
  return exports.default.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });
}

/** "name=value" from a Set-Cookie header. @param {Response} response */
export function cookieFrom(response) {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0] ?? "";
}

/**
 * @typedef {{ cookie: string, csrf: string, post: (path: string, body?: unknown) => Promise<Response>, get: (path: string) => Promise<Response> }} Session
 */

/**
 * Logs a member in and returns helpers that send their cookie and CSRF token.
 * @param {{ number: string, pin: string }} member @param {string} [ip]
 * @returns {Promise<Session>}
 */
export async function loginMember(member, ip = newIp()) {
  const response = await post("/api/login", { member_number: member.number, pin: member.pin }, { ip });
  if (response.status !== 200) throw new Error(`login failed: ${response.status} ${await response.text()}`);
  const cookie = cookieFrom(response);
  const me = /** @type {{ csrf_token: string }} */ (await (await get("/api/me", { cookie })).json());
  return {
    cookie,
    csrf: me.csrf_token,
    post: (path, body = {}) => post(path, body, { cookie, csrf: me.csrf_token, ip }),
    get: (path) => get(path, { cookie, ip }),
  };
}

/** Removes login failures and the alarm, so one test's failures don't affect the next. */
export async function resetThrottle() {
  await db.batch([db.prepare("DELETE FROM login_failures"), db.prepare("DELETE FROM system_state")]);
}

/**
 * The current authenticator code for a test admin.
 * @param {string} secretBase32 @param {number} [offsetSteps]
 */
export async function totpNow(secretBase32, offsetSteps = 0) {
  const { base32Decode, totpCode, totpStep } = await import("../src/totp.js");
  const secret = base32Decode(secretBase32);
  if (!secret) throw new Error("bad secret");
  return totpCode(secret, totpStep(nowSeconds()) + offsetSteps);
}

/**
 * Logs an admin in (password + current code) and returns helpers that send their cookie
 * and CSRF token. Each call first clears the "last code used" so tests can log in again.
 * @param {{ id: number, username: string, password: string, totpSecret: string }} admin @param {string} [ip]
 * @returns {Promise<Session>}
 */
export async function loginAdmin(admin, ip = newIp()) {
  await db.prepare("UPDATE admins SET totp_last_step = 0 WHERE id = ?").bind(admin.id).run();
  const response = await post(
    "/api/admin/login",
    { username: admin.username, password: admin.password, totp_code: await totpNow(admin.totpSecret) },
    { ip },
  );
  if (response.status !== 200) throw new Error(`admin login failed: ${response.status} ${await response.text()}`);
  const cookie = cookieFrom(response);
  const me = /** @type {{ csrf_token: string }} */ (await (await get("/api/admin/me", { cookie })).json());
  return {
    cookie,
    csrf: me.csrf_token,
    post: (path, body = {}) => post(path, body, { cookie, csrf: me.csrf_token, ip }),
    get: (path) => get(path, { cookie, ip }),
  };
}
