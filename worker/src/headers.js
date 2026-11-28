// @ts-check
// Security headers for every response the Worker sends: pages, API answers,
// redirects and errors. See docs/architecture.md, section 5 "Headers".

/** Strict CSP: only our own files, no inline scripts or styles, no framing. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The login pages' CSP while the club-wide alarm is on: the same, plus Cloudflare
 * Turnstile's script and challenge frame. Never used otherwise.
 */
export const CSP_WITH_TURNSTILE = CSP.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com").concat(
  "; frame-src https://challenges.cloudflare.com",
);

/** @type {Readonly<Record<string, string>>} */
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
});

/**
 * Returns a copy of `response` with the security headers set.
 * Responses from fetch() have read-only headers, so we always copy.
 *
 * @param {Response} response
 * @param {{ noStore?: boolean, turnstile?: boolean, demo?: boolean }} [options] noStore: forbid caching
 *   (API answers, private pages); turnstile: allow Turnstile in the CSP (login pages while the
 *   alarm is on); demo: ask search engines not to list or follow anything (demo sites)
 * @returns {Response}
 */
export function withSecurityHeaders(response, options = {}) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  if (options.turnstile) {
    out.headers.set("Content-Security-Policy", CSP_WITH_TURNSTILE);
  }
  if (options.noStore) {
    out.headers.set("Cache-Control", "no-store");
  }
  if (options.demo) {
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return out;
}
