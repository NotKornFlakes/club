// @ts-check
// The member login page.
import { setUpLoginForm } from "./login-form.js";

setUpLoginForm({
  loginPath: "/api/login",
  fields: ["member_number", "pin"],
  onSuccess: () => location.assign("/app"),
});
