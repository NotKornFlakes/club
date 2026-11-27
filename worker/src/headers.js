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
 * @param {{ noStore?: boolean }} [options] noStore: forbid caching (API answers, private pages)
 * @returns {Response}
 */
export function withSecurityHeaders(response, options = {}) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  if (options.noStore) {
    out.headers.set("Cache-Control", "no-store");
  }
  return out;
}
