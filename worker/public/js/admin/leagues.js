// @ts-check
// Admin: league seasons. Create one (clashing dates are skipped and listed), see clash
// lists, renew when a season ends, or cancel (frees its future dates).
import { api, byId, el, formatClubDate } from "../common.js";
import { addDays, clubToday, showError, showOk, start, wholeAreaChoice } from "./admin.js";

/** @param {string} id */
const value = (id) => /** @type {HTMLInputElement} */ (byId(id)).value.trim();
let maxLastDate = "";

/** @param {string} title @param {{ booked: string[], skipped: Array<{ date: string, booked_by: string }> }} result */
function showResult(title, result) {
  const box = byId("result");
  box.replaceChildren(
    el("h2", { text: title }),
    el("p", { text: `${result.booked.length} date(s) booked.` }),
    result.skipped.length
      ? el("div", {}, [
          el("p", { className: "message message-info", text: `${result.skipped.length} date(s) skipped because they clash with an existing booking:` }),
          el("ul", {}, result.skipped.map((s) => el("li", { text: `${formatClubDate(s.date)}: ${s.booked_by}` }))),
        ])
      : el("p", { text: "No clashes." }),
  );
  box.hidden = false;
  box.scrollIntoView();
}

/** @param {number} id @param {string} name */
async function showSkips(id, name) {
  try {
    const { skipped } = await api(`/api/admin/leagues/${id}/skips`);
    showResult(`${name}: skipped dates`, { booked: [], skipped });
    byId("result").querySelector("p")?.remove();
  } catch (error) {
    showError(error);
  }
}

async function load() {
  const data = await api("/api/admin/leagues");
  maxLastDate = data.max_last_date;
  /** @type {HTMLInputElement} */ (byId("last")).max = maxLastDate;
  const cards = data.leagues.map((/** @type {any} */ l) => {
    const state = l.cancelled ? "Cancelled" : l.ended ? "Season ended" : "Running";
    const actions = el("div", { className: "actions" }, [
      l.skipped ? el("button", { type: "button", className: "button button-secondary", text: `See ${l.skipped} skipped date(s)`, onclick: () => showSkips(l.id, l.name) }) : null,
    ]);
    if (!l.cancelled && !l.renewed) {
      const renewDate = el("input", { type: "date", id: `renew-${l.id}`, max: maxLastDate, value: maxLastDate });
      actions.append(
        el("label", { for: `renew-${l.id}`, text: "Renew: new season's last date" }),
        renewDate,
        el("button", {
          type: "button",
          className: "button",
          text: "Renew season",
          onclick: async () => {
            try {
              const result = await api(`/api/admin/leagues/${l.id}/renew`, { method: "POST", body: { last_date: /** @type {HTMLInputElement} */ (renewDate).value } });
              showResult(`${l.name}: next season created`, result);
              await load();
            } catch (error) {
              showError(error);
            }
          },
        }),
      );
    }
    if (!l.cancelled && !l.ended) {
      actions.append(
        el("button", {
          type: "button",
          className: "button button-danger",
          text: "Cancel league",
          onclick: async () => {
            if (!window.confirm(`Cancel ${l.name}? All its future dates are freed for members.`)) return;
            try {
              const r = await api(`/api/admin/leagues/${l.id}/cancel`, { method: "POST" });
              showOk(`League cancelled. ${r.cancelled_dates} future date(s) freed.`);
              await load();
            } catch (error) {
              showError(error);
            }
          },
        }),
      );
    }
    return el("article", { className: "card" }, [
      el("h3", { text: l.public ? `${l.name} (program: shown on This Week)` : l.name }),
      el("p", { text: `${l.resource}, every ${l.weekday}, ${l.starts_local}–${l.ends_local}` }),
      el("p", { text: `${formatClubDate(l.first_date)} to ${formatClubDate(l.last_date)}. ${state}${l.renewed ? " (renewed)" : ""}. ${l.booked} date(s) booked.` }),
      actions,
    ]);
  });
  byId("leagues").replaceChildren(...(cards.length ? cards : [el("p", { text: "No leagues yet." })]));
}

byId("league-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/admin/leagues", {
      method: "POST",
      body: {
        name: value("name"),
        resource_id: Number(value("resource")),
        weekday: Number(value("weekday")),
        starts_local: value("starts"),
        ends_local: value("ends"),
        first_date: value("first"),
        last_date: value("last"),
        public: /** @type {HTMLInputElement} */ (byId("public")).checked,
        whole_area: /** @type {HTMLInputElement} */ (byId("whole-area")).checked,
      },
    });
    showResult(`${value("name")}: season created`, result);
    await load();
  } catch (error) {
    showError(error);
  }
});

try {
  await start();
  const { resources } = await api("/api/admin/resources");
  byId("resource").replaceChildren(...resources.filter((/** @type {{ active: boolean }} */ r) => r.active).map((/** @type {{ id: number, name: string }} */ r) => el("option", { value: r.id, text: r.name })));
  /** @type {Map<number, string>} */
  const areaOf = new Map(resources.map((/** @type {{ id: number, area: string }} */ r) => [Number(r.id), String(r.area)]));
  const select = /** @type {HTMLSelectElement} */ (byId("resource"));
  const wording = "Every one of the {area} (a whole-alley league)";
  wholeAreaChoice(select, areaOf, wording);
  select.addEventListener("change", () => wholeAreaChoice(select, areaOf, wording));
  const first = /** @type {HTMLInputElement} */ (byId("first"));
  first.value = addDays(clubToday(), 1);
  first.min = clubToday();
  await load();
  /** @type {HTMLInputElement} */ (byId("last")).value = maxLastDate;
} catch (error) {
  showError(error);
}
