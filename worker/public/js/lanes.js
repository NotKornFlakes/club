// @ts-check
// The week view's logic for lanes (an area with "lanes" in the club's settings, like the
// bowling alley): free lanes counted per hour, and how long a booking on several lanes can
// run. No page code here, so the tests can check it directly.
//
// Each lane's day is a string, one character per 15-minute slot (see src/week.js):
//   f free · l open, not bookable yet · t taken · x closed · o already started · A-Z a program

/**
 * @typedef {{ kind: "count", free: number, partly: number, total: number }
 *   | { kind: "program", program: string }
 *   | { kind: "full" } | { kind: "closed" } | { kind: "past" } | { kind: "later" }} HourCell
 * @typedef {{ start: number, end: number, cell: HourCell }} Span slot indexes [start, end)
 */

/**
 * What one hour (slots hour*4 to hour*4+3) looks like across the lanes.
 * @param {string[]} lanes @param {number} hour
 * @returns {HourCell}
 */
export function hourCell(lanes, hour) {
  const from = hour * 4;
  const quarters = lanes.map((lane) => lane.slice(from, from + 4));
  const first = quarters[0]?.[0] ?? "x";
  // The same program on every lane for the whole hour: "Friday League — all lanes".
  if (/[A-Z]/.test(first) && quarters.every((q) => q.length > 0 && [...q].every((c) => c === first))) {
    return { kind: "program", program: first };
  }
  // Free all hour, not counting minutes that are already over or outside opening hours
  // (the current hour, or an hour the lanes open or close in).
  const free = quarters.filter((q) => q.includes("f") && /^[fox]+$/.test(q)).length;
  const some = quarters.filter((q) => q.includes("f")).length;
  if (some > 0) return { kind: "count", free, partly: some - free, total: lanes.length };
  const all = quarters.join("");
  if (all.includes("l")) return { kind: "later" };
  if (/^x*$/.test(all)) return { kind: "closed" };
  if (/^[xo]*$/.test(all)) return { kind: "past" };
  return { kind: "full" };
}

/**
 * The day as cells for the week view: one per hour for counts, and neighbouring hours
 * merged when they're the same program, all full, closed, past or not yet bookable.
 * @param {string[]} lanes @param {number} slots slots in the day's grid
 * @returns {Span[]}
 */
export function dayCells(lanes, slots) {
  /** @type {Span[]} */
  const spans = [];
  for (let hour = 0; hour * 4 < slots; hour += 1) {
    const cell = hourCell(lanes, hour);
    const last = spans.at(-1);
    const end = Math.min(slots, hour * 4 + 4);
    if (last && cell.kind !== "count" && JSON.stringify(last.cell) === JSON.stringify(cell)) last.end = end;
    else spans.push({ start: hour * 4, end, cell });
  }
  return spans;
}

/**
 * How full a counted hour is, 0 (empty) to 3 (nearly full), for its shading.
 * @param {number} free lanes free all hour @param {number} total
 */
export function fullness(free, total) {
  const ratio = total === 0 ? 0 : free / total;
  return ratio >= 0.75 ? 0 : ratio >= 0.5 ? 1 : ratio > 0 ? 2 : 3;
}

/** Free 15-minute slots in a row from `start` on one lane. @param {string} lane @param {number} start */
export function freeRun(lane, start) {
  let n = 0;
  while (lane[start + n] === "f") n += 1;
  return n;
}

/**
 * The longest booking, in slots, starting at `start` on all of these lanes, up to `max`.
 * @param {string[]} lanes @param {number} start @param {number} max
 */
export function longest(lanes, start, max) {
  return Math.min(max, ...lanes.map((lane) => freeRun(lane, start)));
}

/**
 * A member's lane choice after tapping a free cell: a different time starts over; the same
 * time adds or removes that lane, up to `max` lanes.
 * @param {{ start: number, lanes: number[] }} selection
 * @param {number} lane @param {number} start @param {number} max
 * @returns {{ start: number, lanes: number[], refused: boolean }}
 */
export function toggleLane(selection, lane, start, max) {
  if (selection.start !== start) return { start, lanes: [lane], refused: false };
  if (selection.lanes.includes(lane)) {
    const lanes = selection.lanes.filter((l) => l !== lane);
    return { start: lanes.length ? start : -1, lanes, refused: false };
  }
  if (selection.lanes.length >= max) return { ...selection, refused: true };
  return { start, lanes: [...selection.lanes, lane], refused: false };
}
