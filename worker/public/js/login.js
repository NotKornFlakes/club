// @ts-check
// The member login page. After logging in, members go to My bookings, or back to the page
// that sent them here (?next=/week or /book). Only these pages: never another site.
import { setUpLoginForm } from "./login-form.js";

const NEXT = new Set(["/app", "/book", "/week"]);
const next = new URLSearchParams(location.search).get("next") ?? "";

setUpLoginForm({
  loginPath: "/api/login",
  fields: ["member_number", "pin"],
  onSuccess: () => location.assign(NEXT.has(next) ? next : "/app"),
});
