// @ts-check
// The Book page: pick a court or room, a day, a start time and a length, agree to the
// rules, and book. Taken slots say only "Taken"; the server never sends who booked.
import { ApiError, api, byId, el, formatClubDate, formatDate, formatRange, formatTime, say, wireLogout } from "./common.js";
import { RULES } from "./rules.js";

wireLogout();

const message = byId("message");
const resourcesBox = byId("resources");
const dateInput = /** @type {HTMLInputElement} */ (byId("date"));
const slotsList = byId("slots");

/** @type {{ resourceId: number | null, date: string, first: string, last: string, slots: Array<{ start: number, end: number, state: string }> }} */
const state = { resourceId: null, date: "", first: "", last: "", slots: [] };

/** @param {string} date @param {number} days */
function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** Remembers the choice in the address, so a reload keeps it. */
function rememberChoice() {
  const params = new URLSearchParams({ resource: String(state.resourceId ?? ""), date: state.date });
  history.replaceState(null, "", `/book?${params}`);
}

/** @param {{ start: number, end: number, state: string }} slot */
function slotItem(slot) {
  const time = formatTime(slot.start);
  if (slot.state === "free") {
    const button = el("button", { type: "button", className: "slot-button", onclick: () => chooseStart(slot.start) }, [
      el("span", { className: "slot-time", text: time }),
      el("span", { text: "Free" }),
    ]);
    button.setAttribute("aria-label", `${time}, free. Book from ${time}.`);
    return el("li", { className: "slot slot-free" }, [button]);
  }
  const label = slot.state === "taken" ? "Taken" : "Past";
  return el("li", { className: `slot slot-${slot.state}` }, [el("span", { className: "slot-time", text: time }), el("span", { text: label })]);
}

async function loadDay() {
  if (!state.resourceId || !state.date) return;
  rememberChoice();
  byId("day-label").textContent = formatClubDate(state.date);
  dateInput.value = state.date;
  /** @type {HTMLButtonElement} */ (byId("prev-day")).disabled = state.date <= state.first;
  /** @type {HTMLButtonElement} */ (byId("next-day")).disabled = state.date >= state.last;
  slotsList.replaceChildren(el("li", { className: "slot-note", text: "Loading…" }));
  say(message, "");
  try {
    const params = new URLSearchParams({ resource_id: String(state.resourceId), date: state.date });
    const day = await api(`/api/availability?${params}`);
    state.slots = day.slots;
    if (!day.open) {
      slotsList.replaceChildren(el("li", { className: "slot-note", text: "Closed on this day. Please pick another day." }));
      return;
    }
    slotsList.replaceChildren(...day.slots.map(slotItem));
    if (!day.slots.some((/** @type {{ state: string }} */ s) => s.state === "free")) {
      slotsList.append(el("li", { className: "slot-note", text: "Nothing free on this day. Please pick another day." }));
    }
  } catch (error) {
    slotsList.replaceChildren();
    say(message, error instanceof ApiError ? error.message : "Couldn't load the times. Please try again.");
  }
}

/** The booking lengths possible from a start: free slots in a row, up to 2 hours. @param {number} start */
function lengthsFrom(start) {
  const free = new Set(state.slots.filter((s) => s.state === "free").map((s) => s.start));
  const ends = [];
  for (let end = start + 900; end <= start + 7200 && free.has(end - 900); end += 900) ends.push(end);
  return ends;
}

/** @param {number} seconds */
function lengthLabel(seconds) {
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours > 1 ? "s" : ""}${rest ? ` ${rest} minutes` : ""}`;
}

/** @param {"pick" | "confirm" | "done"} name */
function showSection(name) {
  for (const id of ["pick", "confirm", "done"]) byId(id).hidden = id !== name;
  window.scrollTo(0, 0);
  const heading = byId(name).querySelector("h1, h2");
  if (heading instanceof HTMLElement) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

/** Step 4: how long, the rules, "I agree", and Book. @param {number} start */
function chooseStart(start) {
  const ends = lengthsFrom(start);
  const resourceName = document.querySelector(`label[for="resource-${state.resourceId}"]`)?.textContent ?? "";
  let end = ends[ends.length >= 4 ? 3 : ends.length - 1] ?? start + 900; // default 1 hour where possible

  const summary = el("p", { className: "summary" });
  const cancelNote = el("p", { className: "message message-info" });
  const refresh = () => {
    summary.textContent = `${resourceName}: ${formatRange(start, end)}`;
    const deadline = start - 24 * 3600;
    cancelNote.textContent =
      deadline > Date.now() / 1000
        ? `You can cancel this booking until ${formatDate(deadline)}, ${formatTime(deadline)} (24 hours before it starts). After that, it can't be cancelled.`
        : "This booking starts within 24 hours, so it can't be cancelled once you book it.";
  };

  const lengths = el("fieldset", { className: "choices" }, [el("legend", { text: "How long?" })]);
  for (const option of ends) {
    const id = `length-${option}`;
    const input = el("input", { type: "radio", name: "length", id, value: option, checked: option === end });
    input.addEventListener("change", () => {
      end = option;
      refresh();
    });
    lengths.append(
      el("div", { className: "choice" }, [input, el("label", { for: id, text: `${lengthLabel(option - start)} (until ${formatTime(option)})` })]),
    );
  }

  const agree = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", id: "agree", required: true }));
  const error = el("p", { className: "message", role: "alert", tabindex: "-1", hidden: true });
  const bookButton = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", className: "button button-wide", text: "Book it" }));
  const form = el("form", { novalidate: true }, [
    lengths,
    el("h3", { text: "Booking Rules" }),
    el("ul", { className: "rules" }, RULES.map((rule) => el("li", { text: rule }))),
    el("div", { className: "agree" }, [agree, el("label", { for: "agree", text: "I agree to the booking rules" })]),
    error,
    bookButton,
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!agree.checked) {
      say(error, "Please tick \u201cI agree to the booking rules\u201d to book.");
      error.focus();
      return;
    }
    bookButton.disabled = true;
    bookButton.textContent = "Booking…";
    try {
      const { booking } = await api("/api/bookings", {
        method: "POST",
        body: { resource_id: state.resourceId, starts_at: start, ends_at: end, agree: true },
      });
      showDone(booking);
    } catch (err) {
      say(error, err instanceof ApiError ? err.message : "Couldn't book. Check your connection and try again.");
      error.focus();
    } finally {
      bookButton.disabled = false;
      bookButton.textContent = "Book it";
    }
  });

  refresh();
  byId("confirm").replaceChildren(
    el("h2", { id: "confirm-title", text: "Check your booking" }),
    summary,
    cancelNote,
    form,
    el("button", { type: "button", className: "button button-secondary button-wide", text: "◀ Choose a different time", onclick: back }),
  );
  showSection("confirm");
}

/** @param {{ id: number, resource: string, starts_at: number, ends_at: number }} booking */
function showDone(booking) {
  byId("done").replaceChildren(
    el("h2", { id: "done-title", text: "Booked!" }),
    el("p", { className: "summary", text: `${booking.resource}: ${formatRange(booking.starts_at, booking.ends_at)}` }),
    el("p", { text: "Add it to your phone's calendar to get a reminder 1 hour before." }),
    el("a", { className: "button button-wide", href: `/api/bookings/${booking.id}/ics`, download: `booking-${booking.id}.ics`, text: "Add to calendar" }),
    el("a", { className: "button button-secondary button-wide", href: "/app", text: "See my bookings" }),
  );
  showSection("done");
}

function back() {
  showSection("pick");
  loadDay();
}

/** @param {number} days */
function moveDay(days) {
  const next = addDays(state.date, days);
  if (next < state.first || next > state.last) return;
  state.date = next;
  loadDay();
}

async function start() {
  try {
    const data = await api("/api/resources");
    state.first = data.first_date;
    state.last = data.last_date;
    dateInput.min = data.first_date;
    dateInput.max = data.last_date;
    const params = new URLSearchParams(location.search);
    const wantedDate = params.get("date") ?? "";
    state.date = wantedDate >= data.first_date && wantedDate <= data.last_date ? wantedDate : data.first_date;
    const wantedResource = Number(params.get("resource"));

    if (data.resources.length === 0) {
      resourcesBox.append(el("p", { text: "Nothing can be booked right now." }));
      return;
    }
    for (const [i, resource] of data.resources.entries()) {
      const id = `resource-${resource.id}`;
      const checked = resource.id === wantedResource || (i === 0 && !data.resources.some((/** @type {{ id: number }} */ r) => r.id === wantedResource));
      const input = el("input", { type: "radio", name: "resource", id, value: resource.id, checked });
      input.addEventListener("change", () => {
        state.resourceId = resource.id;
        loadDay();
      });
      if (checked) state.resourceId = resource.id;
      resourcesBox.append(el("div", { className: "choice" }, [input, el("label", { for: id, text: resource.name })]));
    }

    dateInput.addEventListener("change", () => {
      if (dateInput.value >= state.first && dateInput.value <= state.last) {
        state.date = dateInput.value;
        loadDay();
      } else {
        say(message, "You can book up to 30 days ahead.");
      }
    });
    byId("prev-day").addEventListener("click", () => moveDay(-1));
    byId("next-day").addEventListener("click", () => moveDay(1));
    await loadDay();
  } catch (error) {
    say(message, error instanceof ApiError ? error.message : "Couldn't load the page. Please reload it.");
  }
}

await start();
