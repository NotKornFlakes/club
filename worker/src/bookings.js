// @ts-check
// Booking rules shared by member and admin code, and the database's refusals in plain words.

import { HttpError } from "./http.js";

/** Members can cancel only this long (or more) before the start. Admins can always cancel. */
export const CANCEL_CUTOFF_SECONDS = 24 * 3600;
/** A member booking is at most 2 hours. */
export const MAX_MEMBER_SECONDS = 2 * 3600;
/** A member can have at most this many upcoming bookings (each counts until it ends). */
export const MAX_UPCOMING = 2;

/**
 * Turns a database refusal (from a trigger or constraint) into a plain-words answer.
 * Anything unexpected is rethrown.
 * @param {unknown} error
 * @returns {never}
 */
export function bookingRefusal(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("slot_taken")) {
    throw new HttpError(409, "slot_taken", "Sorry, someone just booked that time. Please pick another.");
  }
  if (text.includes("too_many_upcoming")) {
    throw new HttpError(
      409,
      "too_many_upcoming",
      "You already have 2 upcoming bookings. You can book again when one has finished or been cancelled.",
    );
  }
  if (text.includes("member_suspended")) {
    throw new HttpError(403, "suspended", "Your booking access is suspended. Contact management.");
  }
  if (text.includes("member_not_active")) {
    throw new HttpError(403, "not_active", "Your account can't make bookings. Contact management.");
  }
  throw error;
}
