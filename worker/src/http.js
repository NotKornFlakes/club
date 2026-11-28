// @ts-check
// Small helpers for building responses and reading requests.

/**
 * A JSON response.
 * @param {unknown} data
 * @param {number} [status]
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
export function json(data, status = 200, headers = {}) {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  for (const [name, value] of new Headers(headers)) response.headers.append(name, value);
  return response;
}

/**
 * 405 for a method this path doesn't accept.
 * @param {string} allow e.g. "GET, HEAD"
 * @returns {Response}
 */
export function methodNotAllowed(allow) {
  const response = json({ error: "method_not_allowed", message: "That isn't allowed here." }, 405);
  response.headers.set("Allow", allow);
  return response;
}

/** A redirect to one of our own paths. @param {string} path @param {URL} base */
export function redirect(path, base) {
  return new Response(null, { status: 302, headers: { Location: new URL(path, base).toString() } });
}

/**
 * An error a handler throws to answer with a status and a plain-words message.
 * `code` is a stable machine name for the page's code and the tests.
 */
export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toResponse() {
    return json({ error: this.code, message: this.message, ...this.extra }, this.status);
  }
}

/** Largest request body we read (bytes). The CSV import sends ~25 members per request. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads a JSON object body, refusing anything else.
 * @param {Request} request
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(request) {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "That request is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "That request is too large.");
  let body;
  try {
    body = JSON.parse(text === "" ? "{}" : text);
  } catch {
    throw new HttpError(400, "bad_json", "Something went wrong sending that. Please try again.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "Something went wrong sending that. Please try again.");
  }
  return body;
}

/**
 * One cookie's value from the request, or null.
 * @param {Request} request @param {string} name
 */
export function getCookie(request, name) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** The visitor's IP as Cloudflare reports it. @param {Request} request */
export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
