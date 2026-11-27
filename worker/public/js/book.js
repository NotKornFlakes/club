// @ts-check
// The Book page: pick a court or room, a day, and see the 15-minute grid.
// Taken slots say only "Taken"; the server never sends who booked.
import { ApiError, api, byId, el, formatClubDate, formatTime, say, wireLogout } from "./common.js";

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
    return el("li", { className: "slot slot-free" }, [el("span", { className: "slot-time", text: time }), el("span", { text: "Free" })]);
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
