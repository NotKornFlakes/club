// @ts-check
// Admin: courts and rooms (name, order, retire) and weekly opening hours, and, while there
// are none, the club's starting list from its settings file.
import { ApiError, CLUB, api, byId, el, say } from "../common.js";
import { showError, showOk, start } from "./admin.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "09:00-12:00, 14:00-20:00" → ranges. @param {string} text @param {number} weekday */
function parseHours(text, weekday) {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const m = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(part);
      if (!m) throw new Error(`${DAYS[weekday]}: write hours like 09:00-17:00`);
      const pad = (/** @type {string} */ t) => t.padStart(5, "0");
      return { weekday, opens: pad(m[1] ?? ""), closes: pad(m[2] ?? "") };
    });
}

/** @param {any} r */
function resourceCard(r) {
  const nameId = `name-${r.id}`;
  const orderId = `order-${r.id}`;
  const activeId = `active-${r.id}`;
  const dayInputs = DAYS.map((day, weekday) => {
    const value = r.hours.filter((/** @type {{ weekday: number }} */ h) => h.weekday === weekday).map((/** @type {{ opens: string, closes: string }} */ h) => `${h.opens}-${h.closes}`).join(", ");
    return { weekday, input: /** @type {HTMLInputElement} */ (el("input", { id: `h-${r.id}-${weekday}`, value, placeholder: "Closed" })), day };
  });
  const save = async () => {
    try {
      const name = /** @type {HTMLInputElement} */ (byId(nameId)).value.trim();
      const order = Number(/** @type {HTMLInputElement} */ (byId(orderId)).value || 0);
      const active = /** @type {HTMLInputElement} */ (byId(activeId)).checked;
      const hours = dayInputs.flatMap((d) => parseHours(d.input.value, d.weekday));
      await api(`/api/admin/resources/${r.id}/update`, { method: "POST", body: { name, active, sort_order: order } });
      await api(`/api/admin/resources/${r.id}/hours`, { method: "POST", body: { hours } });
      showOk(`${name} saved.`);
      await load();
    } catch (error) {
      // A typing mistake in the hours box is explained here; anything else by the server.
      if (error instanceof ApiError) showError(error);
      else say(byId("message"), error instanceof Error ? error.message : "Please check the hours.");
      byId("message").focus();
    }
  };
  return el("article", { className: "card" }, [
    el("h2", { text: r.active ? r.name : `${r.name} (retired: members can't see it)` }),
    el("label", { for: nameId, text: "Name" }),
    el("input", { id: nameId, value: r.name, maxlength: 60 }),
    el("label", { for: orderId, text: "Order in lists (lower comes first)" }),
    el("input", { id: orderId, type: "number", value: r.sort_order, min: -1000, max: 1000 }),
    el("div", { className: "agree" }, [el("input", { type: "checkbox", id: activeId, checked: r.active }), el("label", { for: activeId, text: "Members can book it" })]),
    el("h3", { text: "Opening hours" }),
    ...dayInputs.flatMap((d) => [el("label", { for: d.input.id, text: d.day }), d.input]),
    el("button", { type: "button", className: "button", text: "Save", onclick: save }),
  ]);
}

async function load() {
  const { resources } = await api("/api/admin/resources");
  byId("starting-list").hidden = resources.length > 0;
  byId("resources").replaceChildren(...resources.map(resourceCard));
}

byId("starting-names").textContent = CLUB.starting_resources.join(", ");
byId("starting-hours").textContent = `${CLUB.starting_hours.opens} to ${CLUB.starting_hours.closes}`;
byId("starting-button").addEventListener("click", async () => {
  try {
    const { added } = await api("/api/admin/resources/starting-list", { method: "POST" });
    showOk(`${added} courts and rooms added. Check their opening hours below.`);
    await load();
  } catch (error) {
    showError(error);
  }
});

byId("new-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = /** @type {HTMLInputElement} */ (byId("new-name")).value.trim();
    await api("/api/admin/resources", { method: "POST", body: { name } });
    showOk(`${name} added. Now set its opening hours.`);
    /** @type {HTMLFormElement} */ (byId("new-form")).reset();
    await load();
  } catch (error) {
    showError(error);
  }
});

try {
  await start();
  await load();
} catch (error) {
  showError(error);
}
