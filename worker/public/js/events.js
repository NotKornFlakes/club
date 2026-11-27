// @ts-check
// Club events (view only).
import { ApiError, api, byId, el, formatDate, formatTime, say, wireLogout } from "./common.js";

wireLogout();
const box = byId("events");

/** @param {number} start @param {number} end */
function when(start, end) {
  const sameDay = formatDate(start) === formatDate(end);
  return sameDay
    ? `${formatDate(start)}, ${formatTime(start)} to ${formatTime(end)}`
    : `${formatDate(start)}, ${formatTime(start)} to ${formatDate(end)}, ${formatTime(end)}`;
}

try {
  const { events } = await api("/api/events");
  if (events.length === 0) {
    box.replaceChildren(el("p", { text: "No upcoming events." }));
  } else {
    box.replaceChildren(
      ...events.map((/** @type {{ title: string, location: string, details: string | null, starts_at: number, ends_at: number }} */ e) =>
        el("article", { className: "card" }, [
          el("h2", { text: e.title }),
          el("p", { className: "summary", text: when(e.starts_at, e.ends_at) }),
          el("p", { text: `Where: ${e.location}` }),
          e.details ? el("p", { className: "details", text: e.details }) : null,
        ]),
      ),
    );
  }
} catch (error) {
  box.replaceChildren();
  say(byId("message"), error instanceof ApiError ? error.message : "Couldn't load the events. Please reload the page.");
}
