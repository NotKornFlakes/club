// @ts-check
// Admin dashboard: the login alarm (status and history) and the admin list.
import { api, byId, el, formatTime } from "../common.js";
import { showError, showOk, start, when } from "./admin.js";

async function loadAdmins() {
  const { admins } = await api("/api/admin/admins");
  byId("admins").replaceChildren(
    el("ul", {}, admins.map((/** @type {{ id: number, username: string, status: string, locked_until: number | null, is_me: boolean }} */ a) =>
      el("li", {}, [
        `${a.username}${a.is_me ? " (you)" : ""}${a.locked_until ? `, locked until ${formatTime(a.locked_until)}` : ""} `,
        a.locked_until && !a.is_me
          ? el("button", { type: "button", className: "link-button", text: "Clear lockout", onclick: () => clearLockout(a.id) })
          : null,
        a.is_me ? null : el("button", { type: "button", className: "link-button", text: "Reset login", onclick: () => reset(a.id, a.username) }),
      ]),
    )),
  );
}

/** @param {number} id */
async function clearLockout(id) {
  try {
    await api(`/api/admin/admins/${id}/clear-lockout`, { method: "POST" });
    showOk("Lockout cleared.");
    await loadAdmins();
  } catch (error) {
    showError(error);
  }
}

/** @param {number} id @param {string} username */
async function reset(id, username) {
  if (!window.confirm(`Reset ${username}'s login? They'll be logged out and need the new password and authenticator key you'll see next.`)) return;
  try {
    const r = await api(`/api/admin/admins/${id}/reset`, { method: "POST" });
    const box = byId("admin-reset");
    box.replaceChildren(
      el("h3", { text: `New login for ${r.username}` }),
      el("p", { className: "message message-error", text: "Shown only once. Give these to them in person or by phone, not by email." }),
      el("p", {}, ["Temporary password: ", el("code", { className: "secret", text: r.password })]),
      el("p", {}, ["Authenticator key: ", el("code", { className: "secret", text: r.totp_secret })]),
      el("p", {}, [el("a", { href: r.otpauth_uri, text: "Authenticator link (open on their phone)" })]),
    );
    box.hidden = false;
  } catch (error) {
    showError(error);
  }
}

/** @param {boolean} on */
async function setAlarm(on) {
  if (on && !window.confirm("Turn the login alarm on? Every login will need the Turnstile check and be slowed for a while.")) return;
  try {
    await api("/api/admin/alarm", { method: "POST", body: { on } });
    location.reload();
  } catch (error) {
    showError(error);
  }
}
byId("alarm-on").addEventListener("click", () => setAlarm(true));
byId("alarm-off").addEventListener("click", () => setAlarm(false));

try {
  const admin = await start();
  byId(admin.alarm.on ? "alarm-on" : "alarm-off").hidden = true;
  byId("username").textContent = admin.username;
  byId("alarm-status").textContent = admin.alarm.on
    ? `ON until ${formatTime(admin.alarm.until)}. Failed logins have spiked, so every login is slowed and needs the Turnstile check. It switches off by itself.`
    : "Off. Logins are working normally.";
  byId("alarm-status").className = admin.alarm.on ? "message message-error" : "message message-ok";
  byId("failures").textContent = `Failed logins: ${admin.failed_logins.last_hour} in the last hour, ${admin.failed_logins.last_day} in the last 24 hours.`;
  const history = admin.alarm_history.map((/** @type {{ at: number, window: string }} */ h) =>
    el("li", { text: `${when(h.at)} (${h.window === "short" ? "a burst of failures" : h.window === "long" ? "many failures over a day" : "turned on by an admin"})` }),
  );
  byId("alarm-history").replaceChildren(...(history.length ? history : [el("li", { text: "None." })]));
  await loadAdmins();
} catch (error) {
  showError(error);
}
