// @ts-check
// Admin: a day's schedule for one court or room, with who booked each slot; one-off admin
// bookings; cancelling any booking (even within 24 hours).
import { api, byId, el, formatClubDate, formatRange, formatTime } from "../common.js";
import { clubToday, showError, showOk, start, wholeAreaChoice } from "./admin.js";

const resourceSelect = /** @type {HTMLSelectElement} */ (byId("resource"));
const dateInput = /** @type {HTMLInputElement} */ (byId("date"));
/** @param {string} id */
const value = (id) => /** @type {HTMLInputElement} */ (byId(id)).value.trim();
/** @type {Map<number, string>} */
const areaOf = new Map();

async function load() {
  try {
    const params = new URLSearchParams({ resource_id: resourceSelect.value, date: dateInput.value });
    const day = await api(`/api/admin/schedule?${params}`);
    byId("day-title").textContent = `${day.resource.name}, ${formatClubDate(day.date)}`;
    const cards = day.bookings.map((/** @type {{ id: number, booked_by: string, starts_at: number, ends_at: number }} */ b) =>
      el("article", { className: "card" }, [
        el("p", { className: "summary", text: b.booked_by }),
        el("p", { text: formatRange(b.starts_at, b.ends_at) }),
        el("button", {
          type: "button",
          className: "button button-danger",
          text: "Cancel this booking",
          onclick: async () => {
            if (!window.confirm(`Cancel this booking?\n\n${b.booked_by}\n${formatRange(b.starts_at, b.ends_at)}\n\nThe member isn't told automatically.`)) return;
            try {
              await api(`/api/admin/bookings/${b.id}/cancel`, { method: "POST" });
              showOk("Booking cancelled.");
              await load();
            } catch (error) {
              showError(error);
            }
          },
        }),
      ]),
    );
    byId("bookings").replaceChildren(...(cards.length ? cards : [el("p", { text: "No bookings on this day." })]));
    const rows = day.slots.map((/** @type {{ start: number, state: string, booked_by: string | null }} */ s) =>
      el("tr", { className: s.booked_by ? "row-taken" : "" }, [el("td", { text: formatTime(s.start) }), el("td", { text: s.booked_by ?? (s.state === "past" ? "–" : "Free") })]),
    );
    byId("slot-rows").replaceChildren(...(rows.length ? rows : [el("tr", {}, [el("td", { colspan: 2, text: "Closed on this day." })])]));
  } catch (error) {
    showError(error);
  }
}

byId("booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/bookings", {
      method: "POST",
      body: {
        resource_id: Number(resourceSelect.value),
        label: value("label"),
        start_date: value("start-date"),
        start_time: value("start-time"),
        end_date: value("end-date"),
        end_time: value("end-time"),
        whole_area: /** @type {HTMLInputElement} */ (byId("whole-area")).checked,
      },
    });
    showOk("Booking added.");
    dateInput.value = value("start-date");
    await load();
  } catch (error) {
    showError(error);
  }
});

try {
  await start();
  const { resources } = await api("/api/admin/resources");
  resourceSelect.replaceChildren(...resources.map((/** @type {{ id: number, name: string, active: boolean }} */ r) => el("option", { value: r.id, text: r.active ? r.name : `${r.name} (retired)` })));
  for (const r of resources) areaOf.set(Number(r.id), String(r.area));
  const wording = "Book all {area} at once (one booking)";
  wholeAreaChoice(resourceSelect, areaOf, wording);
  resourceSelect.addEventListener("change", () => wholeAreaChoice(resourceSelect, areaOf, wording));
  dateInput.value = clubToday();
  for (const id of ["start-date", "end-date"]) /** @type {HTMLInputElement} */ (byId(id)).value = clubToday();
  resourceSelect.addEventListener("change", load);
  dateInput.addEventListener("change", load);
  await load();
} catch (error) {
  showError(error);
}
