// @ts-check
// Shared browser code: API calls (with the CSRF token), building page elements safely
// (textContent only, never HTML), and club-time formatting (the club's time zone).
// /js/club.js is made by the Worker from the club's settings file.

import { CLUB } from "./club.js";

export { CLUB };
export const CLUB_TIME_ZONE = CLUB.time_zone;

/** An API error with the server's plain-words message. */
export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} data */
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** Where this page gets its CSRF token: "/api/me" (members) or "/api/admin/me" (admins). */
let mePath = "/api/me";
/** @type {Promise<Record<string, any>> | null} */
let mePromise = null;

/** @param {string} path */
export function useSession(path) {
  mePath = path;
  mePromise = null;
}

/** The logged-in member or admin (cached). @returns {Promise<Record<string, any>>} */
export function me() {
  if (!mePromise) mePromise = api(mePath);
  return mePromise;
}

/** Forget the cached /me answer (after a change it reports). */
export function refreshMe() {
  mePromise = null;
  return me();
}

/**
 * Calls our API. Changes are sent as JSON with the session's CSRF token.
 * @param {string} path
 * @param {{ method?: "GET" | "POST", body?: unknown, csrf?: boolean }} [options]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}) {
  const method = options.method ?? "GET";
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    if (options.csrf !== false) headers["X-CSRF-Token"] = String((await me()).csrf_token ?? "");
  }
  const response = await fetch(path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Not JSON: leave data empty.
  }
  if (!response.ok) {
    const info = /** @type {Record<string, unknown>} */ (data);
    if (response.status === 401 && info.error === "not_logged_in") {
      location.assign(mePath.startsWith("/api/admin") ? "/admin/login" : "/login");
    }
    throw new ApiError(
      response.status,
      String(info.error ?? "error"),
      String(info.message ?? "Something went wrong. Please try again."),
      info,
    );
  }
  return data;
}

/**
 * Builds an element. Text is always set with textContent, so data can never become HTML.
 * @param {string} tag
 * @param {Record<string, string | number | boolean | ((event: Event) => void) | undefined>} [props]
 * @param {Array<Node | string | null | undefined | false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "className") node.className = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {string} id @returns {HTMLElement} */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

/**
 * Shows a message in a status area (screen readers announce it).
 * @param {HTMLElement} box @param {string} text @param {"error" | "ok" | "info"} [kind]
 */
export function say(box, text, kind = "error") {
  box.textContent = text;
  box.className = `message message-${kind}`;
  box.hidden = text === "";
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CLUB_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: CLUB_TIME_ZONE, hour: "numeric", minute: "2-digit" });

/** "Friday, November 27" @param {number} unix */
export function formatDate(unix) {
  return dateFormat.format(new Date(unix * 1000));
}

/** "6:30 PM" @param {number} unix */
export function formatTime(unix) {
  return timeFormat.format(new Date(unix * 1000));
}

/** "Friday, November 27, 6:30 PM to 7:30 PM" @param {number} start @param {number} end */
export function formatRange(start, end) {
  return `${formatDate(start)}, ${formatTime(start)} to ${formatTime(end)}`;
}

// A club date has no time of day, so it's shown as that date in UTC: right in every time zone.
const clubDateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

/** A club date "2026-11-27" as "Friday, November 27". @param {string} date */
export function formatClubDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return clubDateFormat.format(new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 12)));
}

/** Wires every "Log out" button on the page. */
export function wireLogout() {
  for (const button of document.querySelectorAll("[data-logout]")) {
    button.addEventListener("click", async () => {
      const isAdmin = mePath.startsWith("/api/admin");
      try {
        await api(isAdmin ? "/api/admin/logout" : "/api/logout", { method: "POST" });
      } finally {
        location.assign(isAdmin ? "/admin/login" : "/");
      }
    });
  }
}
