// @ts-check
// The week view, on This Week (/week, anyone) and Book (/book, members).
//
// Seven days across, times down, one row per hour (four 15-minute slots). Wide screens show
// all seven days; phones show one day at a time, swiped sideways, with day tabs on top.
// Programs are colored blocks with their names; other bookings say only "Taken". Logged
// out, it's view only, with a "Log in to book" button. Logged in, tapping a free time opens
// the booking sheet: start (15-minute steps), length (up to the club's maximum), the rules,
// "I agree", Book. The server checks everything again; the database stops double bookings.
//
// Everything is built with el() and textContent, never HTML from data. Positions are set
// through element.style (CSSOM), which the strict CSP allows.

import { ApiError, CLUB, api, byId, el, formatDate, formatTime, say, sessionOrNull, wireLogout } from "./common.js";

const root = byId("week");
const sheet = /** @type {HTMLDialogElement} */ (byId("sheet"));
const message = byId("message");
const mode = root.dataset.mode === "book" ? "book" : "week";
const SLOT = 900;
const MAX_SLOTS = Math.floor(CLUB.booking.max_length_minutes / 15);
const CUTOFF = CLUB.booking.cancel_cutoff_hours * 3600;
const PALETTE = 6;

/**
 * @typedef {{ date: string, weekday: number, starts: number[], slots: Record<string, string> }} Day
 * @typedef {{
 *   area: { id: string, name: string, any_label: string | null }, areas: Array<{ id: string, name: string }>,
 *   resources: Array<{ id: number, name: string }>, from: string, today: string, now: number,
 *   prev: string | null, next: string | null, last_book_date: string,
 *   grid: { start: string, end: string, slot_minutes: number } | null, programs: string[], days: Day[],
 * }} Week
 */

const state = {
  area: CLUB.areas[0]?.id ?? "",
  from: "",
  /** "any" or a resource id */
  resource: "any",
  /** @type {Week | null} */
  data: null,
  /** @type {Record<string, any> | null} */
  member: null,
  day: 0,
};

const dateParts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

/** "2026-11-29" → a Date at noon UTC, for formatting the calendar date. @param {string} date */
const noon = (date) => new Date(`${date}T12:00:00Z`);

/** @param {string} date */
function shortParts(date) {
  const parts = Object.fromEntries(dateParts.formatToParts(noon(date)).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday ?? "", month: parts.month ?? "", day: parts.day ?? "" };
}

/** "8 AM" for the hour that starts a row. @param {number} minutes */
function hourLabel(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
}

/** A stable color for a program name (the same every week, as far as possible). @param {string} name */
function hashColor(name) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) % 9973;
  return hash % PALETTE;
}

/** Program name → color, so no two programs in the same week share one. @param {string[]} names */
function programColors(names) {
  /** @type {Map<string, number>} */
  const colors = new Map();
  const used = new Set();
  for (const name of names) {
    let color = hashColor(name);
    for (let tries = 0; used.has(color) && tries < PALETTE; tries += 1) color = (color + 1) % PALETTE;
    used.add(color);
    colors.set(name, color);
  }
  return colors;
}

/** Can this person book right now? */
const canBook = () => Boolean(state.member) && !state.member?.suspension;

/** The resources the selected lane/room choice covers. @param {Week} week */
function candidates(week) {
  if (state.resource !== "any") {
    const one = week.resources.find((r) => String(r.id) === state.resource);
    if (one) return [one];
  }
  return week.resources;
}

/**
 * One state string for the day: the chosen resource's, or for "any", the best of all of
 * them (free if any one is free).
 * @param {Week} week @param {Day} day
 */
function dayStates(week, day) {
  const strings = candidates(week).map((r) => day.slots[String(r.id)] ?? "");
  if (strings.length === 1) return strings[0] ?? "";
  const length = day.starts.length;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const chars = strings.map((s) => s[i] ?? "x");
    const pick = ["f", "l"].find((c) => chars.includes(c)) ?? chars.find((c) => c >= "A" && c <= "Z") ?? ["t", "o"].find((c) => chars.includes(c)) ?? "x";
    out += pick;
  }
  return out;
}

/** Runs of the same state: [{ char, start, end }] in slot indexes. @param {string} states */
function runsOf(states) {
  const runs = [];
  for (let i = 0; i < states.length; ) {
    let j = i;
    while (j < states.length && states[j] === states[i]) j += 1;
    runs.push({ char: states[i] ?? "x", start: i, end: j });
    i = j;
  }
  return runs;
}

/** Consecutive free slots from `start` for one resource. @param {string} states @param {number} start */
function freeLength(states, start) {
  let n = 0;
  while (states[start + n] === "f") n += 1;
  return n;
}

/** @param {HTMLElement} node @param {number} start @param {number} end */
function place(node, start, end) {
  node.style.gridRow = `${start + 1} / ${end + 1}`;
  return node;
}

/** @param {number} unix */
const time = (unix) => formatTime(unix);

/**
 * One day's column of blocks.
 * @param {Week} week @param {Day} day @param {number} index @param {Map<string, number>} colors
 */
function dayColumn(week, day, index, colors) {
  const states = dayStates(week, day);
  const parts = shortParts(day.date);
  const label = longDate.format(noon(day.date));
  const body = el("div", { className: "day-body" });
  const end = (/** @type {number} */ i) => day.starts[i] ?? (day.starts[i - 1] ?? 0) + SLOT;

  for (const run of runsOf(states)) {
    const span = `${time(day.starts[run.start] ?? 0)} to ${time(end(run.end))}`;
    if (run.char === "x") {
      body.append(place(el("div", { className: "block block-closed", "aria-hidden": "true" }), run.start, run.end));
    } else if (run.char === "o") {
      body.append(place(el("div", { className: "block block-taken block-past", "aria-hidden": "true" }, [run.end - run.start > 1 ? "Earlier" : ""]), run.start, run.end));
    } else if (run.char === "t") {
      body.append(place(el("div", { className: "block block-taken", "aria-label": `Taken, ${span}` }, ["Taken"]), run.start, run.end));
    } else if (run.char === "l") {
      body.append(
        place(el("div", { className: "block block-later", "aria-label": `Open, not yet bookable, ${span}` }, ["Open"]), run.start, run.end),
      );
    } else if (run.char === "f" && !canBook()) {
      // View only: one block for the whole free stretch.
      body.append(place(el("div", { className: "block block-free", "aria-label": `Free, ${span}` }, [run.end - run.start > 1 ? "Free" : ""]), run.start, run.end));
    } else if (run.char === "f") {
      // One button per hour, so each hour is a big enough tap target.
      for (let s = run.start; s < run.end; ) {
        const stop = Math.min(run.end, (Math.floor(s / 4) + 1) * 4);
        const blockSpan = `${time(day.starts[s] ?? 0)} to ${time(end(stop))}`;
        const from = s;
        const button = el(
          "button",
          {
            type: "button",
            className: "block block-free",
            "aria-label": `Free, ${label}, ${blockSpan}. Book this time.`,
            onclick: () => openSheet(index, from),
          },
          [el("span", { className: "block-plus", "aria-hidden": "true", text: "+" }), stop - s > 1 ? "Free" : ""],
        );
        body.append(place(button, s, stop));
        s = stop;
      }
    } else {
      const name = week.programs[run.char.charCodeAt(0) - 65] ?? "Program";
      const past = end(run.end) <= week.now;
      const block = el("div", { className: `block block-program program-${colors.get(name) ?? 0}${past ? " block-past" : ""}` }, [
        name,
        run.end - run.start > 1 ? el("span", { className: "block-time", text: span }) : null,
      ]);
      block.setAttribute("aria-label", `${name}, ${span}`);
      body.append(place(block, run.start, run.end));
    }
  }

  return el("div", { className: `day${day.date === week.today ? " day-today" : ""}`, id: `day-${index}`, role: "group", "aria-label": label }, [
    el("div", { className: "day-head", "aria-hidden": "true" }, [el("strong", { text: `${parts.weekday} ${parts.day}` }), parts.month]),
    body,
  ]);
}

/** @param {Week} week */
function rangeLabel(week) {
  const first = shortParts(week.days[0]?.date ?? week.from);
  const last = shortParts(week.days.at(-1)?.date ?? week.from);
  return `${first.month} ${first.day} – ${last.month === first.month ? "" : `${last.month} `}${last.day}`;
}

function render() {
  const week = state.data;
  if (!week) return;

  const areaButtons = el(
    "div",
    { className: "segmented", role: "group", "aria-label": "Area" },
    week.areas.map((a) =>
      el("button", {
        type: "button",
        text: a.name,
        "aria-pressed": String(a.id === week.area.id),
        onclick: () => {
          if (a.id === state.area) return;
          state.area = a.id;
          state.resource = "any";
          load();
        },
      }),
    ),
  );

  /** @type {HTMLElement | null} */
  let picker = null;
  if (week.resources.length > 1) {
    const select = /** @type {HTMLSelectElement} */ (el("select", { id: "resource-pick" }));
    const anyLabel = week.area.any_label ?? `Any ${week.area.name.toLowerCase()}`;
    select.append(el("option", { value: "any", text: week.area.any_label ? anyLabel : `All ${week.area.name.toLowerCase()}` }));
    for (const r of week.resources) select.append(el("option", { value: String(r.id), text: r.name }));
    select.value = week.resources.some((r) => String(r.id) === state.resource) ? state.resource : "any";
    select.addEventListener("change", () => {
      state.resource = select.value;
      writeUrl();
      render();
    });
    picker = el("div", { className: "week-pick" }, [el("label", { for: "resource-pick", text: week.area.any_label ? "Lane" : "Room" }), select]);
  }

  const nav = el("div", { className: "week-nav" }, [
    el("button", {
      type: "button",
      className: "button button-secondary",
      text: "◀",
      "aria-label": "Previous week",
      disabled: !week.prev,
      onclick: () => week.prev && ((state.from = week.prev), load()),
    }),
    el("h2", { text: rangeLabel(week), "aria-live": "polite" }),
    el("button", {
      type: "button",
      className: "button button-secondary",
      text: "▶",
      "aria-label": "Next week",
      disabled: !week.next || (mode === "book" && week.next > week.last_book_date),
      onclick: () => week.next && ((state.from = week.next), load()),
    }),
  ]);

  const legend = el("ul", { className: "legend", "aria-label": "Key" }, [
    el("li", {}, [el("span", { className: "swatch swatch-free" }), canBook() ? "Free: tap to book" : "Free"]),
    el("li", {}, [el("span", { className: "swatch swatch-taken" }), "Taken"]),
    el("li", {}, [el("span", { className: "swatch swatch-program" }), "Program"]),
    el("li", {}, [el("span", { className: "swatch swatch-closed" }), "Closed"]),
  ]);

  const toolbar = el("div", { className: "week-toolbar" }, [areaButtons, picker, nav, legend]);

  if (!week.grid || week.resources.length === 0) {
    root.replaceChildren(toolbar, el("p", { className: "week-empty", text: `${week.area.name}: no opening hours yet.` }));
    return;
  }

  const startMinutes = Number(week.grid.start.slice(0, 2)) * 60 + Number(week.grid.start.slice(3));
  const rows = week.days[0]?.starts.length ?? 0;
  // The first cell lines up with the day headings; then one label per hour.
  const times = el("div", { className: "week-times", "aria-hidden": "true" }, [el("div", {})]);
  for (let r = 0; r < rows; r += 4) times.append(el("span", { text: hourLabel(startMinutes + r * 15) }));

  const colors = programColors(week.programs);
  const days = el("div", { className: "week-days" }, week.days.map((d, i) => dayColumn(week, d, i, colors)));
  const grid = el("div", { className: "week-grid" }, [times, days]);
  grid.style.setProperty("--rows", String(rows));

  const tabs = el(
    "ul",
    { className: "day-tabs", "aria-label": "Days" },
    week.days.map((d, i) => {
      const p = shortParts(d.date);
      return el("li", {}, [
        el(
          "button",
          {
            type: "button",
            "aria-current": i === state.day ? "true" : "false",
            "aria-controls": `day-${i}`,
            "aria-label": longDate.format(noon(d.date)),
            onclick: () => showDay(days, i, true),
          },
          [p.weekday, el("strong", { text: p.day })],
        ),
      ]);
    }),
  );

  root.replaceChildren(toolbar, tabs, grid);
  days.addEventListener(
    "scroll",
    () => {
      const i = Math.round(days.scrollLeft / Math.max(1, days.clientWidth));
      if (i !== state.day) markTab(tabs, i);
    },
    { passive: true },
  );
  showDay(days, state.day, false);
}

/** @param {HTMLElement} tabs @param {number} i */
function markTab(tabs, i) {
  state.day = i;
  tabs.querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-current", n === i ? "true" : "false"));
}

/** Scrolls the phone view to one day. @param {HTMLElement} days @param {number} i @param {boolean} smooth */
function showDay(days, i, smooth) {
  state.day = Math.max(0, Math.min(6, i));
  days.scrollTo({ left: state.day * days.clientWidth, behavior: smooth ? "smooth" : "auto" });
  const tabs = root.querySelector(".day-tabs");
  if (tabs instanceof HTMLElement) markTab(tabs, state.day);
}

// Keep the same day in view when the window changes size (a phone turned sideways).
window.addEventListener("resize", () => {
  const days = root.querySelector(".week-days");
  if (days instanceof HTMLElement) showDay(days, state.day, false);
});

// ---------- The booking sheet ----------

/** Closes the sheet and reloads the week (the times may have changed). */
function closeSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener("close", () => {
  sheet.replaceChildren();
  load();
});
// A tap on the dimmed background closes the sheet too.
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});

/** @param {string} title @param {Node[]} body */
function sheetFrame(title, body) {
  sheet.replaceChildren(
    el("div", { className: "sheet-head" }, [
      el("h2", { id: "sheet-title", text: title }),
      el("button", { type: "button", className: "sheet-close", text: "×", "aria-label": "Close", onclick: closeSheet }),
    ]),
    el("div", { className: "sheet-body" }, body),
  );
}

/** @param {number} dayIndex @param {number} tapped slot index */
function openSheet(dayIndex, tapped) {
  const week = state.data;
  const day = week?.days[dayIndex];
  if (!week || !day) return;
  const choices = candidates(week);
  const perResource = choices.map((r) => ({ resource: r, states: day.slots[String(r.id)] ?? "" }));
  const best = (/** @type {number} */ s) => Math.min(MAX_SLOTS, Math.max(0, ...perResource.map((p) => freeLength(p.states, s))));

  // Start times: every quarter hour in the free stretch around the tapped hour.
  const aggregate = dayStates(week, day);
  let first = tapped;
  while (first > 0 && aggregate[first - 1] === "f") first -= 1;
  let last = tapped;
  while (aggregate[last + 1] === "f") last += 1;
  const starts = [];
  for (let s = first; s <= last; s += 1) if (best(s) > 0) starts.push(s);
  if (starts.length === 0) return;

  const startSelect = /** @type {HTMLSelectElement} */ (el("select", { id: "sheet-start" }));
  for (const s of starts) startSelect.append(el("option", { value: String(s), text: time(day.starts[s] ?? 0) }));
  startSelect.value = String(starts.includes(tapped) ? tapped : starts[0]);

  const lengthSelect = /** @type {HTMLSelectElement} */ (el("select", { id: "sheet-length" }));
  const laneNote = el("p", { className: "help", "aria-live": "polite" });
  const cancelNote = el("p", { className: "message message-info" });
  const error = el("p", { className: "message", role: "alert", tabindex: "-1", hidden: true });

  /** The resource that's free for the whole chosen time (the first, for "any"). */
  const chosen = () => {
    const s = Number(startSelect.value);
    const n = Number(lengthSelect.value);
    return perResource.find((p) => freeLength(p.states, s) >= n)?.resource ?? null;
  };

  const refresh = () => {
    const s = Number(startSelect.value);
    const keep = Number(lengthSelect.value) || 4;
    const max = best(s);
    lengthSelect.replaceChildren();
    for (let n = 1; n <= max; n += 1) {
      const minutes = n * 15;
      const text = minutes < 60 ? `${minutes} minutes` : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
      lengthSelect.append(el("option", { value: String(n), text: `${text} (until ${time((day.starts[s] ?? 0) + n * SLOT)})` }));
    }
    lengthSelect.value = String(Math.min(keep, max));
    const r = chosen();
    laneNote.textContent = choices.length > 1 && r ? `You'll get ${r.name}.` : "";
    const startAt = day.starts[s] ?? 0;
    const deadline = startAt - CUTOFF;
    cancelNote.textContent =
      deadline > Date.now() / 1000
        ? `You can cancel until ${formatDate(deadline)}, ${formatTime(deadline)} (${CLUB.phrases.cancel_cutoff} before it starts). After that, it can't be cancelled.`
        : `This starts within ${CLUB.phrases.cancel_cutoff}, so it can't be cancelled once you book it.`;
  };
  startSelect.addEventListener("change", refresh);
  lengthSelect.addEventListener("change", refresh);

  const agree = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", id: "sheet-agree" }));
  const book = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", className: "button button-wide", text: "Book" }));

  const form = el("form", { novalidate: true }, [
    el("p", { className: "summary", text: longDate.format(noon(day.date)) }),
    el("label", { for: "sheet-start", text: "Start time" }),
    startSelect,
    el("label", { for: "sheet-length", text: "How long" }),
    lengthSelect,
    laneNote,
    cancelNote,
    el("h3", { text: "Booking rules" }),
    el("ul", { className: "rules" }, CLUB.rules.map((rule) => el("li", { text: rule }))),
    el("div", { className: "agree" }, [agree, el("label", { for: "sheet-agree", text: "I agree to the booking rules" })]),
    error,
    book,
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!agree.checked) {
      say(error, "Please tick “I agree to the booking rules” to book.");
      error.focus();
      return;
    }
    const resource = chosen();
    if (!resource) {
      say(error, "That time isn't free any more. Please pick another.");
      return;
    }
    const s = Number(startSelect.value);
    const startsAt = day.starts[s] ?? 0;
    const endsAt = startsAt + Number(lengthSelect.value) * SLOT;
    book.disabled = true;
    try {
      const { booking } = await api("/api/bookings", {
        method: "POST",
        body: { resource_id: resource.id, starts_at: startsAt, ends_at: endsAt, agree: true },
      });
      showBooked(booking);
    } catch (err) {
      book.disabled = false;
      say(error, err instanceof ApiError ? err.message : "Couldn't book. Please try again.");
      error.focus();
    }
  });

  const what = choices.length === 1 ? (choices[0]?.name ?? "") : week.area.any_label ? "a lane" : week.area.name.toLowerCase();
  sheetFrame(`Book ${what}`, [form]);
  refresh();
  sheet.showModal();
  startSelect.focus();
}

/** @param {{ id: number, resource: string, starts_at: number, ends_at: number }} booking */
function showBooked(booking) {
  sheetFrame("Booked", [
    el("p", { className: "message message-ok", role: "status" }, [
      el("strong", { text: booking.resource }),
      `: ${formatDate(booking.starts_at)}, ${formatTime(booking.starts_at)} to ${formatTime(booking.ends_at)}.`,
    ]),
    el("p", {}, [el("a", { className: "button", href: `/api/bookings/${booking.id}/ics`, text: "Add to calendar" })]),
    el("p", {}, [el("a", { href: "/app", text: "See my bookings" })]),
    el("button", { type: "button", className: "button button-wide button-secondary", text: "Done", onclick: closeSheet }),
  ]);
}

// ---------- Loading ----------

function writeUrl() {
  const params = new URLSearchParams({ area: state.area, from: state.from });
  if (state.resource !== "any") params.set("resource", state.resource);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

async function load() {
  try {
    const query = new URLSearchParams({ area: state.area });
    if (state.from) query.set("from", state.from);
    state.data = /** @type {Week} */ (await api(`/api/week?${query}`));
    state.area = state.data.area.id;
    state.from = state.data.from;
    if (!state.data.resources.some((r) => String(r.id) === state.resource)) state.resource = "any";
    writeUrl();
    render();
  } catch (error) {
    say(message, error instanceof ApiError ? error.message : "Couldn't load the week. Please try again.");
  }
}

async function start() {
  const params = new URLSearchParams(location.search);
  const area = params.get("area");
  if (area && CLUB.areas.some((a) => a.id === area)) state.area = area;
  const from = params.get("from");
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) state.from = from;
  state.resource = params.get("resource") ?? "any";

  state.member = await sessionOrNull();
  if (state.member?.suspension) say(byId("suspended"), state.member.suspension.message);
  if (!state.member) byId("login-note").hidden = false;
  if (state.member) wireLogout();
  await load();
}

start();
