// @ts-check
// Admin: members. Search, open a member (no-shows, suspension, PIN reset, disable, lockout),
// add one, import a CSV in chunks of 25, and print the PIN sheet. New PINs live only in
// this page's memory until it closes; the server never keeps them in plain text.
import { api, byId, el, formatClubDate, formatRange, formatTime } from "../common.js";
import { clubToday, showError, showOk, start } from "./admin.js";

const CHUNK = 25;
/** @type {Array<{ member_number: string, display_name: string | null, pin: string }>} */
let sheet = [];

// ---------- PIN sheet ----------

function warnBeforeLeaving(/** @type {BeforeUnloadEvent} */ event) {
  event.preventDefault();
}

/** @param {Array<{ member_number: string, display_name: string | null, pin: string }>} created */
function addToSheet(created) {
  if (created.length === 0) return;
  sheet = [...sheet, ...created];
  byId("pin-rows").replaceChildren(
    ...sheet.map((m) => el("tr", {}, [el("td", { text: m.member_number }), el("td", { text: m.display_name ?? "" }), el("td", { className: "pin", text: m.pin })])),
  );
  byId("pin-sheet").hidden = false;
  window.addEventListener("beforeunload", warnBeforeLeaving);
  byId("pin-sheet").scrollIntoView();
}

byId("print-pins").addEventListener("click", () => window.print());
byId("close-pins").addEventListener("click", () => {
  if (!window.confirm("Have you printed the sheet? The PINs will be gone from this page.")) return;
  sheet = [];
  byId("pin-rows").replaceChildren();
  byId("pin-sheet").hidden = true;
  window.removeEventListener("beforeunload", warnBeforeLeaving);
});

// ---------- List and search ----------

/** @param {{ status: string, locked_until: number | null, suspended_until: string | null, has_pin: boolean }} m */
function statusText(m) {
  const parts = [m.status === "active" ? "Active" : "Disabled"];
  if (!m.has_pin) parts.push("no PIN yet");
  if (m.locked_until) parts.push(`locked until ${formatTime(m.locked_until)}`);
  if (m.suspended_until) parts.push(`suspended until ${formatClubDate(m.suspended_until)}`);
  return parts.join(", ");
}

async function search() {
  const q = /** @type {HTMLInputElement} */ (byId("q")).value.trim();
  try {
    const { members } = await api(`/api/admin/members?${new URLSearchParams({ q })}`);
    const rows = members.map((/** @type {any} */ m) =>
      el("tr", {}, [
        el("td", { text: m.member_number }),
        el("td", { text: m.display_name ?? "" }),
        el("td", { text: statusText(m) }),
        el("td", { text: String(m.no_shows) }),
        el("td", {}, [el("button", { type: "button", className: "link-button", text: "Open", onclick: () => openMember(m.id) })]),
      ]),
    );
    byId("member-rows").replaceChildren(...(rows.length ? rows : [el("tr", {}, [el("td", { colspan: 5, text: "No members found." })])]));
  } catch (error) {
    showError(error);
  }
}

byId("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});

// ---------- One member ----------

/** @param {string} path @param {unknown} [body] @param {string} [done] */
async function act(path, body, done) {
  try {
    const result = await api(path, { method: "POST", body: body ?? {} });
    if (done) showOk(done);
    return result;
  } catch (error) {
    showError(error);
    return null;
  }
}

/** A small labelled form inside the detail panel. @param {string} title @param {HTMLElement[]} fields @param {string} button @param {() => Promise<void>} onSubmit */
function miniForm(title, fields, button, onSubmit) {
  const form = el("form", { className: "mini-form", novalidate: true }, [el("h3", { text: title }), ...fields, el("button", { type: "submit", className: "button", text: button })]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await onSubmit();
  });
  return form;
}

/** @param {string} id @param {string} label @param {Record<string, string | number | boolean>} [attrs] */
function field(id, label, attrs = {}) {
  return [el("label", { for: id, text: label }), el("input", { id, ...attrs })];
}

/** @param {string} id */
const inputValue = (id) => /** @type {HTMLInputElement} */ (byId(id)).value.trim();

/** @param {number} id */
async function openMember(id) {
  let data;
  try {
    data = await api(`/api/admin/members/${id}`);
  } catch (error) {
    showError(error);
    return;
  }
  const m = data.member;
  const box = byId("detail");
  const reload = async () => {
    await openMember(id);
    await search();
  };

  const header = [
    el("h2", { text: `Member ${m.member_number}` }),
    el("p", { text: `Name (admin-only): ${m.display_name ?? "none"}. Status: ${m.status === "active" ? "active" : "disabled"}.` }),
    m.locked_until ? el("p", { className: "message message-info", text: `Locked after wrong PINs until ${formatTime(m.locked_until)}.` }) : null,
    data.active_suspension
      ? el("p", { className: "message message-error", text: `Suspended until ${formatClubDate(data.active_suspension.until_date)}. Reason: ${data.active_suspension.reason}` })
      : null,
  ];

  const buttons = el("div", { className: "actions" }, [
    el("button", {
      type: "button",
      className: "button",
      text: "Reset PIN",
      onclick: async () => {
        if (!window.confirm(`Make a new PIN for ${m.member_number}? Their old PIN stops working and they're logged out everywhere.`)) return;
        const result = await act(`/api/admin/members/${id}/reset-pin`);
        if (result) addToSheet(result.created);
      },
    }),
    m.locked_until
      ? el("button", { type: "button", className: "button button-secondary", text: "Clear lockout", onclick: async () => (await act(`/api/admin/members/${id}/clear-lockout`, {}, "Lockout cleared.")) && reload() })
      : null,
    m.status === "active"
      ? el("button", {
          type: "button",
          className: "button button-danger",
          text: "Disable member",
          onclick: async () => {
            if (!window.confirm(`Disable ${m.member_number}? They're logged out everywhere and can't log in until enabled again.`)) return;
            if (await act(`/api/admin/members/${id}/disable`, {}, "Member disabled.")) await reload();
          },
        })
      : el("button", { type: "button", className: "button", text: "Enable member", onclick: async () => (await act(`/api/admin/members/${id}/enable`, {}, "Member enabled.")) && reload() }),
  ]);

  const rename = miniForm("Name", field("d-name", "Name (optional)", { value: m.display_name ?? "", maxlength: 100 }), "Save name", async () => {
    if (await act(`/api/admin/members/${id}/update`, { display_name: inputValue("d-name") }, "Name saved.")) await reload();
  });

  const noShowList = el("ul", {}, data.no_shows.map((/** @type {{ id: number, on_date: string, note: string | null }} */ n) =>
    el("li", {}, [
      `${formatClubDate(n.on_date)}${n.note ? `: ${n.note}` : ""} `,
      el("button", {
        type: "button",
        className: "link-button",
        text: "Remove",
        onclick: async () => {
          if (window.confirm("Remove this no-show? Only do this if it was recorded by mistake.")) {
            if (await act(`/api/admin/no-shows/${n.id}/delete`, {}, "No-show removed.")) await reload();
          }
        },
      }),
    ]),
  ));
  const noShowForm = miniForm(
    "Record a no-show",
    [...field("ns-date", "Date of the missed booking", { type: "date", value: clubToday(), max: clubToday() }), ...field("ns-note", "Note (only admins see it)", { maxlength: 500 })],
    "Record no-show",
    async () => {
      if (await act(`/api/admin/members/${id}/no-shows`, { on_date: inputValue("ns-date"), note: inputValue("ns-note") }, "No-show recorded.")) await reload();
    },
  );

  const suspension = data.active_suspension
    ? el("div", {}, [
        el("h3", { text: "Suspension" }),
        el("button", {
          type: "button",
          className: "button",
          text: "Lift suspension now",
          onclick: async () => {
            if (window.confirm("Lift this suspension? The member can book again straight away.")) {
              if (await act(`/api/admin/suspensions/${data.active_suspension.id}/lift`, {}, "Suspension lifted.")) await reload();
            }
          },
        }),
      ])
    : miniForm(
        "Suspend from booking",
        [
          ...field("s-until", "Suspended until (through the end of this day)", { type: "date", value: data.default_suspension_until, min: clubToday() }),
          ...field("s-reason", "Reason (required, kept in the audit log)", { maxlength: 500, required: true }),
          el("p", { className: "help", text: "This cancels the member's upcoming bookings. They can still log in and look." }),
        ],
        "Suspend member",
        async () => {
          if (!window.confirm(`Suspend ${m.member_number} and cancel their upcoming bookings?`)) return;
          const result = await act(`/api/admin/members/${id}/suspend`, { until_date: inputValue("s-until"), reason: inputValue("s-reason") });
          if (result) {
            showOk(`Suspended. ${result.cancelled.length} upcoming booking(s) cancelled.`);
            await reload();
          }
        },
      );

  const bookings = el("ul", {}, data.upcoming_bookings.map((/** @type {{ resource: string, starts_at: number, ends_at: number }} */ b) => el("li", { text: `${b.resource}: ${formatRange(b.starts_at, b.ends_at)}` })));

  box.replaceChildren(
    ...header.filter((n) => n !== null),
    buttons,
    el("h3", { text: "Upcoming bookings" }),
    data.upcoming_bookings.length ? bookings : el("p", { text: "None." }),
    el("h3", { text: "No-shows (last 12 months)" }),
    data.no_shows.length ? noShowList : el("p", { text: "None." }),
    noShowForm,
    suspension,
    rename,
    el("button", { type: "button", className: "button button-secondary", text: "Close", onclick: () => (box.hidden = true) }),
  );
  box.hidden = false;
  box.scrollIntoView();
}

// ---------- Add and import ----------

byId("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await act("/api/admin/members", { member_number: inputValue("add-number"), display_name: inputValue("add-name") });
  if (result) {
    /** @type {HTMLFormElement} */ (byId("add-form")).reset();
    addToSheet(result.created);
    await search();
  }
});

/**
 * Splits CSV text into rows of cells (handles quoted cells with commas and "" escapes).
 * @param {string} text @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted && char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += char;
      }
    }
    cells.push(cell.trim());
    rows.push(cells);
  }
  return rows;
}

byId("csv-file").addEventListener("change", async (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  const file = input.files?.[0];
  if (!file) return;
  const progress = byId("import-progress");
  let rows = parseCsv(await file.text());
  const first = rows[0]?.[0] ?? "";
  if (!/^[A-Za-z0-9-]{1,20}$/.test(first) || /member/i.test(first)) rows = rows.slice(1); // a header line
  const members = rows.map((r) => ({ member_number: r[0] ?? "", display_name: r[1] ?? "" }));
  if (members.length === 0) {
    progress.textContent = "That file has no members in it.";
    return;
  }
  if (!window.confirm(`Import ${members.length} members and make a PIN for each?`)) return;
  /** @type {Array<{ member_number: string, reason: string }>} */
  const skipped = [];
  let done = 0;
  for (let i = 0; i < members.length; i += CHUNK) {
    progress.textContent = `Importing… ${done} of ${members.length}`;
    try {
      const result = await api("/api/admin/members/import", { method: "POST", body: { members: members.slice(i, i + CHUNK) } });
      addToSheet(result.created);
      skipped.push(...result.skipped);
    } catch (error) {
      showError(error);
      break;
    }
    done = Math.min(i + CHUNK, members.length);
  }
  progress.textContent = `Imported ${sheet.length} new member(s).${skipped.length ? ` Skipped: ${skipped.map((s) => `${s.member_number} (${s.reason})`).join("; ")}.` : ""}`;
  input.value = "";
  await search();
});

try {
  await start();
  await search();
} catch (error) {
  showError(error);
}
