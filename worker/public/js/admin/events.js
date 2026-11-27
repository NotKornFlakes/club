// @ts-check
// Admin: club events. Add, edit, delete.
import { CLUB_TIME_ZONE, api, byId, el, formatRange } from "../common.js";
import { showError, showOk, start } from "./admin.js";

/** @type {number | null} */
let editing = null;
const ids = ["title", "location", "details", "start-date", "start-time", "end-date", "end-time"];
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (byId(id));

/** Club date and time for a moment. @param {number} unix */
function clubDateTime(unix) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(unix * 1000))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function stopEditing() {
  editing = null;
  /** @type {HTMLFormElement} */ (byId("event-form")).reset();
  byId("form-title").textContent = "Add an event";
  byId("save-event").textContent = "Add event";
  byId("cancel-edit").hidden = true;
}

/** @param {any} e */
function edit(e) {
  editing = e.id;
  const s = clubDateTime(e.starts_at);
  const f = clubDateTime(e.ends_at);
  input("title").value = e.title;
  input("location").value = e.location;
  input("details").value = e.details ?? "";
  input("start-date").value = s.date;
  input("start-time").value = s.time;
  input("end-date").value = f.date;
  input("end-time").value = f.time;
  byId("form-title").textContent = `Edit: ${e.title}`;
  byId("save-event").textContent = "Save changes";
  byId("cancel-edit").hidden = false;
  byId("event-form").scrollIntoView();
}

async function load() {
  const { events } = await api("/api/admin/events");
  const cards = events.map((/** @type {any} */ e) =>
    el("article", { className: "card" }, [
      el("h2", { text: e.title }),
      el("p", { text: `${formatRange(e.starts_at, e.ends_at)}. ${e.location}` }),
      e.details ? el("p", { className: "details", text: e.details }) : null,
      el("div", { className: "actions" }, [
        el("button", { type: "button", className: "button button-secondary", text: "Edit", onclick: () => edit(e) }),
        el("button", {
          type: "button",
          className: "button button-danger",
          text: "Delete",
          onclick: async () => {
            if (!window.confirm(`Delete "${e.title}"?`)) return;
            try {
              await api(`/api/admin/events/${e.id}/delete`, { method: "POST" });
              showOk("Event deleted.");
              await load();
            } catch (error) {
              showError(error);
            }
          },
        }),
      ]),
    ]),
  );
  byId("events").replaceChildren(...(cards.length ? cards : [el("p", { text: "No upcoming events." })]));
}

byId("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  /** @type {Record<string, string>} */
  const body = {};
  for (const id of ids) body[id.replace("-", "_")] = input(id).value.trim();
  try {
    await api(editing ? `/api/admin/events/${editing}/update` : "/api/admin/events", { method: "POST", body });
    showOk(editing ? "Event saved." : "Event added.");
    stopEditing();
    await load();
  } catch (error) {
    showError(error);
  }
});
byId("cancel-edit").addEventListener("click", stopEditing);

try {
  await start();
  await load();
} catch (error) {
  showError(error);
}
