// @ts-check
// Which pages are public and which need a login. The pages themselves hold no data
// (that comes from /api, which checks the login on every call); this sends logged-out
// visitors to the right login page instead of showing them an empty screen.

/** Public pages: home, rules, the login pages, and the 404 page. */
const PUBLIC_PAGES = new Set(["/", "/rules", "/login", "/404", "/admin/login", "/admin/setup"]);
/** Pages that need a member login. */
const MEMBER_PAGES = new Set(["/app", "/book", "/events"]);
/** Login pages: their CSP allows Turnstile while the alarm is on. */
export const LOGIN_PAGES = new Set(["/login", "/admin/login"]);

/**
 * "/book.html", "/book/" and "/book" are the same page.
 * @param {string} pathname
 */
export function pagePath(pathname) {
  return pathname.replace(/\.html$/, "").replace(/\/index$/, "").replace(/\/+$/, "") || "/";
}

/**
 * @param {string} pathname
 * @returns {"public" | "member" | "admin" | "file"}
 */
export function pageAccess(pathname) {
  // Stylesheets and scripts are public; they hold no data.
  if (/\.[A-Za-z0-9]+$/.test(pathname) && !pathname.endsWith(".html")) return "file";
  const page = pagePath(pathname);
  if (PUBLIC_PAGES.has(page)) return "public";
  if (page === "/admin" || page.startsWith("/admin/")) return "admin";
  if (MEMBER_PAGES.has(page)) return "member";
  return "public"; // anything else is a missing page: the 404 page
}
