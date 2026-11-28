// @ts-check
// Shared by every admin page: the admin session, logout, and the login-alarm banner.
import { ApiError, CLUB, CLUB_TIME_ZONE, byId, formatDate, formatTime, me, say, useSession, wireLogout } from "../common.js";

useSession("/api/admin/me");
wireLogout();

/** Today's club date (club time), as YYYY-MM-DD. */
export function clubToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_TIME_ZONE }).format(new Date());
}

/** @param {string} date @param {number} days */
export function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** "Fri, Nov 27, 6:30 PM" @param {number} unix */
export function when(unix) {
  return `${formatDate(unix)}, ${formatTime(unix)}`;
}

/** Shows an error from a failed call in the page's message box. @param {unknown} error */
export function showError(error) {
  const box = byId("message");
  say(box, error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
  box.focus();
}

/** @param {string} text */
export function showOk(text) {
  const box = byId("message");
  say(box, text, "ok");
  box.focus();
}

/** Loads the admin; shows the alarm banner on every page while the alarm is on. */
export async function start() {
  const admin = await me();
  const banner = document.getElementById("alarm-banner");
  if (banner && admin.alarm.on) {
    banner.textContent = `Login alarm is ON until ${formatTime(admin.alarm.until)}: failed logins have spiked, so logins are slowed and need the Turnstile check. See the dashboard.`;
    banner.hidden = false;
  }
  return admin;
}

/**
 * Shows "all lanes" only for a court/room in a lanes area (the bowling alley).
 * @param {HTMLSelectElement} select @param {Map<number, string>} areaOf @param {string} wording
 */
export function wholeAreaChoice(select, areaOf, wording) {
  const area = CLUB.areas.find((a) => a.id === areaOf.get(Number(select.value)));
  byId("whole-area-row").hidden = !area?.lanes;
  if (area) byId("whole-area-label").textContent = wording.replace("{area}", area.name);
  if (!area?.lanes) /** @type {HTMLInputElement} */ (byId("whole-area")).checked = false;
}
