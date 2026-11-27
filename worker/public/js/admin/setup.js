// @ts-check
// First-time admin setup: setup token, then an authenticator key, username and password.
import { ApiError, api, byId, say } from "../common.js";

const message = byId("message");
const tokenForm = /** @type {HTMLFormElement} */ (byId("token-form"));
const adminForm = /** @type {HTMLFormElement} */ (byId("admin-form"));
/** @param {string} id */
const value = (id) => /** @type {HTMLInputElement} */ (byId(id)).value.trim();
let secret = "";

/** @param {unknown} error */
function fail(error) {
  say(message, error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
  message.focus();
}

tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  say(message, "");
  try {
    const result = await api("/api/admin/setup/start", { method: "POST", body: { setup_token: value("setup-token") }, csrf: false });
    secret = result.totp_secret;
    byId("secret").textContent = secret.replace(/(.{4})/g, "$1 ").trim();
    byId("otpauth-link").setAttribute("href", result.otpauth_uri);
    tokenForm.hidden = true;
    adminForm.hidden = false;
    byId("username").focus();
  } catch (error) {
    fail(error);
  }
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  say(message, "");
  try {
    await api("/api/admin/setup", {
      method: "POST",
      csrf: false,
      body: {
        setup_token: value("setup-token"),
        username: value("username"),
        password: /** @type {HTMLInputElement} */ (byId("password")).value,
        totp_secret: secret,
        totp_code: value("totp-code"),
      },
    });
    adminForm.hidden = true;
    byId("done").hidden = false;
  } catch (error) {
    fail(error);
  }
});
