// @ts-check
// Admin: the audit log, newest first, 50 at a time.
import { api, byId, el } from "../common.js";
import { showError, start, when } from "./admin.js";

/** @type {number | null} */
let oldest = null;

/** Short, readable details. @param {Record<string, unknown>} details */
function detailText(details) {
  return Object.entries(details)
    .map(([key, value]) => {
      const shown = typeof value === "number" && value > 1_000_000_000 && /_at$|until$/.test(key) ? when(value) : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key.replace(/_/g, " ")}: ${shown}`;
    })
    .join("; ");
}

async function loadMore() {
  try {
    const page = await api(`/api/admin/audit${oldest ? `?before=${oldest}` : ""}`);
    for (const e of page.entries) {
      byId("rows").append(
        el("tr", {}, [el("td", { text: when(e.at) }), el("td", { text: e.who }), el("td", { text: `${e.action}${e.target ? ` (${e.target})` : ""}` }), el("td", { text: detailText(e.details) })]),
      );
      oldest = e.id;
    }
    byId("more").hidden = !page.more;
  } catch (error) {
    showError(error);
  }
}

byId("more").addEventListener("click", loadMore);
try {
  await start();
  await loadMore();
} catch (error) {
  showError(error);
}
