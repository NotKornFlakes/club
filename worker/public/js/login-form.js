// @ts-check
// Shared by the member and admin login pages: sends the form as JSON, shows plain-words
// errors, and shows Cloudflare Turnstile only while the club-wide alarm is on.

import { ApiError, api, byId, say } from "./common.js";

/** @type {string | null} */
let turnstileToken = null;
let turnstileShown = false;

/**
 * Loads Turnstile and draws the check. Only called while the alarm is on; the page's
 * CSP allows challenges.cloudflare.com only then.
 * @param {string} siteKey
 */
function showTurnstile(siteKey) {
  if (turnstileShown) {
    /** @type {any} */ (window).turnstile?.reset();
    turnstileToken = null;
    return;
  }
  turnstileShown = true;
  const box = byId("turnstile");
  box.hidden = false;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.addEventListener("load", () => {
    /** @type {any} */ (window).turnstile.render(box, {
      sitekey: siteKey,
      callback: (/** @type {string} */ token) => {
        turnstileToken = token;
      },
      "expired-callback": () => {
        turnstileToken = null;
      },
    });
  });
  document.head.append(script);
}

/**
 * @param {{ loginPath: string, fields: string[], onSuccess: () => void }} options
 */
export async function setUpLoginForm({ loginPath, fields, onSuccess }) {
  const form = /** @type {HTMLFormElement} */ (byId("login-form"));
  const message = byId("message");
  const button = /** @type {HTMLButtonElement} */ (form.querySelector("button[type=submit]"));

  try {
    const status = await api("/api/login-status");
    if (status.alarm && status.turnstile_site_key) {
      byId("alarm-note").hidden = false;
      showTurnstile(status.turnstile_site_key);
    }
  } catch {
    // The form still works; the server enforces everything.
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    say(message, "");
    /** @type {Record<string, string>} */
    const body = {};
    for (const name of fields) {
      const input = /** @type {HTMLInputElement} */ (form.elements.namedItem(name));
      body[name] = input.value.trim();
    }
    if (turnstileToken) body.turnstile_token = turnstileToken;
    button.disabled = true;
    button.textContent = "Logging in…";
    try {
      await api(loginPath, { method: "POST", body, csrf: false });
      onSuccess();
    } catch (error) {
      const text = error instanceof ApiError ? error.message : "Couldn't reach the club site. Check your connection and try again.";
      say(message, text);
      if (error instanceof ApiError && typeof error.data.turnstile_site_key === "string") {
        byId("alarm-note").hidden = false;
        showTurnstile(error.data.turnstile_site_key);
      }
      const pin = /** @type {HTMLInputElement | null} */ (form.querySelector("input[type=password]"));
      if (pin) pin.value = "";
      message.focus();
    } finally {
      button.disabled = false;
      button.textContent = "Log in";
    }
  });
}
