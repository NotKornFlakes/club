// @ts-check
// The login throttle settings (THROTTLE_SETTINGS): the per-IP limit and the club-wide
// alarm's limits, hold time and delay. Their values are private: they come from a
// sensitive Terraform variable on the live site and from .dev.vars locally. If they're
// missing or malformed, logins refuse rather than guess (docs/architecture.md, section 5).

import { ConfigError } from "./crypto.js";

/**
 * @typedef {{
 *   ip_failures_per_hour: number,
 *   alarm_short_minutes: number,
 *   alarm_short_failures: number,
 *   alarm_long_failures: number,
 *   alarm_hold_minutes: number,
 *   alarm_delay_ms: number,
 * }} ThrottleSettings
 */

/** Every key that must be present. The long window is always 24 hours. */
export const THROTTLE_KEYS = Object.freeze([
  "ip_failures_per_hour",
  "alarm_short_minutes",
  "alarm_short_failures",
  "alarm_long_failures",
  "alarm_hold_minutes",
  "alarm_delay_ms",
]);

/** @type {Map<string, ThrottleSettings>} */
const cache = new Map();

/**
 * Parses and checks THROTTLE_SETTINGS. The error never includes the values.
 * @param {unknown} raw
 * @returns {ThrottleSettings}
 */
export function throttleSettings(raw) {
  if (typeof raw !== "string" || raw === "") throw new ConfigError("THROTTLE_SETTINGS is missing");
  const cached = cache.get(raw);
  if (cached) return cached;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("THROTTLE_SETTINGS is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("THROTTLE_SETTINGS must be a JSON object");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== THROTTLE_KEYS.length || !THROTTLE_KEYS.every((key) => keys.includes(key))) {
    throw new ConfigError("THROTTLE_SETTINGS must have exactly the expected keys");
  }
  for (const key of THROTTLE_KEYS) {
    const value = parsed[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`THROTTLE_SETTINGS.${key} must be a positive whole number`);
  }
  const settings = /** @type {ThrottleSettings} */ (Object.freeze(parsed));
  cache.set(raw, settings);
  return settings;
}
