// @ts-check
// Cryptography helpers, built only on Web Crypto (crypto.subtle), which both the
// Workers runtime and Node have. Design: docs/architecture.md, section 5.

import { isDemo } from "./demo.js";

const encoder = new TextEncoder();

/** The Workers runtime's hard cap for PBKDF2 (github.com/cloudflare/workerd, limit-enforcer.h). */
export const PBKDF2_ITERATIONS = 100_000;

/**
 * Demo sites only (DEMO_MODE "on", made-up members): light enough for the Workers Free
 * plan's 10 ms of CPU per request, even for 25 new PINs at once. Never for real members.
 */
export const DEMO_PBKDF2_ITERATIONS = 1_000;
const SALT_BYTES = 16;

/**
 * The rounds for this site: full strength unless DEMO_MODE is exactly "on". Checks accept
 * only hashes made with this same count, so a demo's hashes never work on a full-strength
 * site, and the other way round.
 * @param {{ DEMO_MODE?: unknown }} env
 * @returns {number}
 */
export function hashRounds(env) {
  return isDemo(env) ? DEMO_PBKDF2_ITERATIONS : PBKDF2_ITERATIONS;
}

/** @param {number} rounds */
function checkRounds(rounds) {
  if (rounds !== PBKDF2_ITERATIONS && rounds !== DEMO_PBKDF2_ITERATIONS) throw new RangeError("unexpected hash rounds");
}

/** PEPPER and IP_HASH_KEY must be at least this long (README: `openssl rand -base64 32`). */
export const MIN_SECRET_KEY_LENGTH = 32;

/** A Worker setting or secret is missing or malformed. Logins refuse rather than guess. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------- Encoding ----------

/** @param {Uint8Array} bytes @returns {string} */
export function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** @param {string} base64 @returns {Uint8Array<ArrayBuffer>} */
export function fromBase64(base64) {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

/** @param {Uint8Array} bytes @returns {string} URL-safe base64 without padding */
export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {Uint8Array} bytes @returns {string} */
export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------- Randomness and plain hashes ----------

/** @param {number} length @returns {Uint8Array<ArrayBuffer>} */
export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A random token for cookies and CSRF (32 bytes = 256 bits). @param {number} [length] */
export function randomToken(length = 32) {
  return toBase64Url(randomBytes(length));
}

/** @param {string} text @returns {Promise<string>} SHA-256 as hex */
export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/**
 * Constant-time comparison of two byte strings.
 * @param {Uint8Array<ArrayBuffer>} a @param {Uint8Array<ArrayBuffer>} b
 */
export function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Constant-time comparison of two strings. @param {string} a @param {string} b */
export function textEqual(a, b) {
  return bytesEqual(new Uint8Array(encoder.encode(a)), new Uint8Array(encoder.encode(b)));
}

// ---------- Keys derived from PEPPER ----------

/** @typedef {{ pinKey: CryptoKey, totpKey: CryptoKey }} PepperKeys */

/** @type {Map<string, Promise<PepperKeys>>} */
const pepperCache = new Map();

/**
 * The two keys derived from PEPPER with HKDF: the pin key (mixed into every PIN and
 * admin password before hashing) and the TOTP key (encrypts authenticator secrets).
 * @param {unknown} pepper the PEPPER secret
 * @returns {Promise<PepperKeys>}
 */
export function pepperKeys(pepper) {
  if (typeof pepper !== "string" || pepper.length < MIN_SECRET_KEY_LENGTH) {
    return Promise.reject(new ConfigError("PEPPER is missing or too short"));
  }
  let keys = pepperCache.get(pepper);
  if (!keys) {
    keys = derivePepperKeys(pepper);
    pepperCache.set(pepper, keys);
  }
  return keys;
}

/** @param {string} pepper @returns {Promise<PepperKeys>} */
async function derivePepperKeys(pepper) {
  const master = await crypto.subtle.importKey("raw", encoder.encode(pepper), "HKDF", false, ["deriveKey"]);
  const salt = encoder.encode("club-booking/v1");
  const pinKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("pin-key") },
    master,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const totpKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("totp-key") },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { pinKey, totpKey };
}

// ---------- PINs and admin passwords ----------

/**
 * PBKDF2-SHA256 over HMAC(pin key, secret): the pepper is applied before hashing.
 * @param {CryptoKey} pinKey @param {string} secret @param {Uint8Array<ArrayBuffer>} salt @param {number} iterations
 */
async function pepperedPbkdf2(pinKey, secret, salt, iterations) {
  const peppered = await crypto.subtle.sign("HMAC", pinKey, encoder.encode(secret));
  const material = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return new Uint8Array(bits);
}

/**
 * Hashes a PIN or admin password for storage.
 * @param {string} secret @param {PepperKeys} keys @param {number} rounds from hashRounds(env)
 * @returns {Promise<string>} `pbkdf2-sha256$<rounds>$<salt>$<hash>`
 */
export async function hashSecret(secret, keys, rounds) {
  checkRounds(rounds);
  const salt = randomBytes(SALT_BYTES);
  const hash = await pepperedPbkdf2(keys.pinKey, secret, salt, rounds);
  return `pbkdf2-sha256$${rounds}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Checks a PIN or password against a stored hash, in constant time. A hash made with a
 * different number of rounds, or not readable, never matches. It's still hashed the same
 * way, so the answer always takes as long.
 * @param {string} secret @param {string} stored @param {PepperKeys} keys @param {number} rounds from hashRounds(env)
 */
export async function verifySecret(secret, stored, keys, rounds) {
  checkRounds(rounds);
  const parts = stored.split("$");
  let usable = parts.length === 4 && parts[0] === "pbkdf2-sha256" && parts[1] === String(rounds);
  /** @type {Uint8Array<ArrayBuffer>} */
  let salt = new Uint8Array(SALT_BYTES);
  /** @type {Uint8Array<ArrayBuffer>} */
  let expected = new Uint8Array(32);
  if (usable) {
    try {
      salt = fromBase64(parts[2] ?? "");
      expected = fromBase64(parts[3] ?? "");
    } catch {
      usable = false;
    }
  }
  const actual = await pepperedPbkdf2(keys.pinKey, secret, salt, rounds);
  return bytesEqual(actual, expected) && usable;
}

/**
 * Spends the same time as a real check, then returns false. Used for unknown member
 * numbers and usernames, so timing gives nothing away.
 * @param {string} secret @param {PepperKeys} keys @param {number} rounds from hashRounds(env)
 */
export async function verifyDummy(secret, keys, rounds) {
  await verifySecret(secret, "", keys, rounds);
  return false;
}

/**
 * A new 6-digit PIN. Rejection sampling keeps every PIN equally likely.
 * @returns {string}
 */
export function newPin() {
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? limit;
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}

// ---------- Encrypting authenticator (TOTP) secrets ----------

/** @param {string} plain @param {PepperKeys} keys @returns {Promise<string>} `v1$<iv>$<ciphertext>` */
export async function encryptText(plain, keys) {
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.totpKey, encoder.encode(plain));
  return `v1$${toBase64(iv)}$${toBase64(new Uint8Array(sealed))}`;
}

/** @param {string} stored @param {PepperKeys} keys @returns {Promise<string>} */
export async function decryptText(stored, keys) {
  const [version, iv, sealed] = stored.split("$");
  if (version !== "v1" || !iv || !sealed) throw new Error("Unknown encrypted format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, keys.totpKey, fromBase64(sealed));
  return new TextDecoder().decode(plain);
}

// ---------- IP addresses (stored only as HMACs) ----------

/**
 * The 8 groups of an IPv6 address, or null if it isn't one.
 * @param {string} address @returns {string[] | null}
 */
function ipv6Groups(address) {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  /** @param {string} part */
  const split = (part) => (part === "" ? [] : part.split(":"));
  const head = split(halves[0] ?? "");
  const tail = halves.length === 2 ? split(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16).toString(16));
}

/**
 * What we count per IP: IPv4 as is, IPv6 cut to its /64 (one attacker usually holds a whole /64).
 * @param {string} ip @returns {string}
 */
export function ipGroup(ip) {
  const address = ip.trim().toLowerCase().split("%")[0] ?? "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!address.includes(":")) return address;
  const groups = ipv6Groups(address);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
}

/** @type {Map<string, Promise<CryptoKey>>} */
const ipKeyCache = new Map();

/**
 * HMAC-SHA256(IP_HASH_KEY, IP or IPv6 /64), as hex. Never the raw IP, never a plain hash.
 * @param {string} ip @param {unknown} ipHashKey the IP_HASH_KEY secret
 */
export async function hashIp(ip, ipHashKey) {
  if (typeof ipHashKey !== "string" || ipHashKey.length < MIN_SECRET_KEY_LENGTH) {
    throw new ConfigError("IP_HASH_KEY is missing or too short");
  }
  let key = ipKeyCache.get(ipHashKey);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(ipHashKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    ipKeyCache.set(ipHashKey, key);
  }
  const mac = await crypto.subtle.sign("HMAC", await key, encoder.encode(ipGroup(ip)));
  return toHex(new Uint8Array(mac));
}
