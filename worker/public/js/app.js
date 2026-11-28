// @ts-check
// "My bookings": the member's upcoming bookings, with cancel (24-hour rule) and
// "Add to calendar".
import { ApiError, CLUB, api, byId, el, formatClubDate, formatDate, formatRange, formatTime, me, say, wireLogout } from "./common.js";

wireLogout();
const message = byId("message");
const list = byId("bookings");

/** @param {{ id: number, resource: string, starts_at: number, ends_at: number, can_cancel: boolean, cancel_until: number }} booking */
function bookingCard(booking) {
  const actions = el("div", { className: "actions" }, [
    el("a", { className: "button button-secondary", href: `/api/bookings/${booking.id}/ics`, download: `booking-${booking.id}.ics`, text: "Add to calendar" }),
  ]);
  if (booking.can_cancel) {
    actions.append(
      el("button", {
        type: "button",
        className: "button button-danger",
        text: "Cancel booking",
        onclick: () => cancel(booking),
      }),
    );
  }
  return el("article", { className: "card" }, [
    el("h3", { text: booking.resource }),
    el("p", { className: "summary", text: formatRange(booking.starts_at, booking.ends_at) }),
    booking.can_cancel
      ? el("p", { className: "help", text: `You can cancel until ${formatDate(booking.cancel_until)}, ${formatTime(booking.cancel_until)}.` })
      : el("p", { className: "help", text: `It's less than ${CLUB.phrases.cancel_cutoff} away, so it can't be cancelled. If you can't make it, please let management know.` }),
    actions,
  ]);
}

/** @param {{ id: number, resource: string, starts_at: number, ends_at: number }} booking */
async function cancel(booking) {
  const ok = window.confirm(`Cancel your booking?\n\n${booking.resource}\n${formatRange(booking.starts_at, booking.ends_at)}`);
  if (!ok) return;
  try {
    await api(`/api/bookings/${booking.id}/cancel`, { method: "POST" });
    say(message, "Your booking is cancelled.", "ok");
  } catch (error) {
    say(message, error instanceof ApiError ? error.message : "Couldn't cancel. Please try again.");
  }
  message.focus();
  await loadBookings();
}

async function loadBookings() {
  try {
    const { bookings } = await api("/api/my-bookings");
    if (bookings.length === 0) {
      list.replaceChildren(el("p", { text: "You have no upcoming bookings." }));
      return;
    }
    list.replaceChildren(...bookings.map(bookingCard));
  } catch (error) {
    list.replaceChildren();
    say(message, error instanceof ApiError ? error.message : "Couldn't load your bookings. Please reload the page.");
  }
}

/** @param {string[]} dates YYYY-MM-DD, newest first */
function showNoShows(dates) {
  const box = byId("no-shows");
  if (dates.length === 0) {
    box.textContent = "None in the last 12 months.";
    return;
  }
  const count = dates.length === 1 ? "1 in the last 12 months" : `${dates.length} in the last 12 months`;
  box.replaceChildren(el("strong", { text: count }), el("ul", {}, dates.map((d) => el("li", { text: formatClubDate(d) }))));
}

try {
  const member = await me();
  byId("member-number").textContent = member.member_number;
  if (member.suspension) {
    say(byId("suspended"), member.suspension.message);
    byId("book-link").hidden = true;
  }
  showNoShows(member.no_shows);
} catch (error) {
  say(message, error instanceof ApiError ? error.message : "Couldn't load your details. Please reload the page.");
}
await loadBookings();
