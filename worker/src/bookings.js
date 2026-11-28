// @ts-check
// Booking rules shared by member and admin code, and the database's refusals in plain words.

import { CLUB } from "./club.js";
import { HttpError } from "./http.js";

// These come from the club's settings file. The database also refuses anything over its own
// ceilings (2 hours, 2 upcoming bookings), whatever a club's file says.

/** Members can cancel only this long (or more) before the start. Admins can always cancel. */
export const CANCEL_CUTOFF_SECONDS = CLUB.booking.cancel_cutoff_hours * 3600;
/** The longest member booking. */
export const MAX_MEMBER_SECONDS = CLUB.booking.max_length_minutes * 60;
/** A member can have at most this many upcoming bookings (each counts until it ends). */
export const MAX_UPCOMING = CLUB.booking.max_upcoming;

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
      `You already have ${CLUB.phrases.max_upcoming}. You can book again when one has finished or been cancelled.`,
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
