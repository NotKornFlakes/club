// @ts-check
// Small helpers for building responses.

/**
 * A JSON response.
 * @param {unknown} data
 * @param {number} [status]
 * @returns {Response}
 */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 405 for a method this path doesn't accept.
 * @param {string} allow e.g. "GET, HEAD"
 * @returns {Response}
 */
export function methodNotAllowed(allow) {
  const response = json({ error: "method_not_allowed" }, 405);
  response.headers.set("Allow", allow);
  return response;
}
