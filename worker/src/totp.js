// @ts-check
// Time-based one-time codes for admin login (RFC 6238: HMAC-SHA1, 30 seconds, 6 digits),
// the kind every authenticator app understands.

import { randomBytes } from "./crypto.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD = 30;

/** @param {Uint8Array} bytes @returns {string} RFC 4648 base32, no padding */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * @param {string} text base32, spaces and padding allowed, any case
 * @returns {Uint8Array<ArrayBuffer> | null} null if it isn't valid base32
 */
export function base32Decode(text) {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (clean === "" || !/^[A-Z2-7]+$/.test(clean)) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new authenticator secret: 20 random bytes (160 bits), as base32. */
export function newTotpSecret() {
  return base32Encode(randomBytes(20));
}

/** @param {number} unixSeconds */
export function totpStep(unixSeconds) {
  return Math.floor(unixSeconds / TOTP_PERIOD);
}

/**
 * The code for one 30-second step.
 * @param {Uint8Array<ArrayBuffer>} secret @param {number} step @param {number} [digits]
 * @returns {Promise<string>}
 */
export async function totpCode(secret, step, digits = 6) {
  const counter = new Uint8Array(8);
  let rest = step;
  for (let i = 7; i >= 0; i -= 1) {
    counter[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Checks a code, allowing one step of clock drift either way. A step at or before
 * `lastStep` is refused, so a code can't be used twice.
 * @param {string} secretBase32 @param {string} code @param {number} now Unix seconds @param {number} lastStep
 * @returns {Promise<number | null>} the matching step, or null
 */
export async function verifyTotp(secretBase32, code, now, lastStep) {
  const secret = base32Decode(secretBase32);
  if (!secret || !/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    if ((await totpCode(secret, step)) === code) return step;
  }
  return null;
}

/**
 * The link an authenticator app can open to add the key (no QR code, so no library).
 * @param {string} secretBase32 @param {string} account @param {string} issuer
 */
export function otpauthUri(secretBase32, account, issuer) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query}`;
}
