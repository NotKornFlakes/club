// @ts-check
// The admin login page: username, password and authenticator code.
import { setUpLoginForm } from "../login-form.js";

setUpLoginForm({
  loginPath: "/api/admin/login",
  fields: ["username", "password", "totp_code"],
  onSuccess: () => location.assign("/admin/"),
});
