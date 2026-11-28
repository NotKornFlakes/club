// @ts-check
// The week view's lane logic (public/js/lanes.js): free lanes per hour, merged blocks, and
// choosing up to the club's number of lanes for one booking.
import { describe, expect, it } from "vitest";
import { dayCells, freeRun, fullness, hourCell, longest, toggleLane } from "../public/js/lanes.js";

/** 8 lanes, given as one 4-character hour each. @param {string[]} hours */
const lanes = (hours) => hours;

describe("free lanes per hour", () => {
  it("counts lanes free for the whole hour, and those free for part of it", () => {
    expect(hourCell(lanes(["ffff", "ffff", "ffff", "ffff", "ffff", "tttt", "tttt", "tttt"]), 0)).toEqual({ kind: "count", free: 5, partly: 0, total: 8 });
    expect(hourCell(lanes(["ffff", "fftt", "tttt", "tttt"]), 0)).toEqual({ kind: "count", free: 1, partly: 1, total: 4 });
    expect(hourCell(lanes(["fftt", "tttt"]), 0)).toEqual({ kind: "count", free: 0, partly: 1, total: 2 });
  });

  it("shows a program on every lane as one block, not a count", () => {
    expect(hourCell(Array(8).fill("AAAA"), 0)).toEqual({ kind: "program", program: "A" });
    // On only some lanes, it's just taken lanes in the count.
    expect(hourCell(["AAAA", "AAAA", "ffff"], 0)).toEqual({ kind: "count", free: 1, partly: 0, total: 3 });
    // Two different programs: not "all lanes".
    expect(hourCell(["AAAA", "BBBB"], 0)).toEqual({ kind: "full" });
  });

  it("counts a lane as free for the rest of an hour that has started, or that it opens in", () => {
    expect(hourCell(["oooff", "ooftt"].map((l) => l.slice(0, 4)), 0)).toEqual({ kind: "count", free: 1, partly: 1, total: 2 });
    expect(hourCell(["xxff", "xxff"], 0)).toEqual({ kind: "count", free: 2, partly: 0, total: 2 });
  });

  it("knows full, closed, started and not-yet-bookable hours", () => {
    expect(hourCell(["tttt", "AAtt"], 0)).toEqual({ kind: "full" });
    expect(hourCell(["xxxx", "xxxx"], 0)).toEqual({ kind: "closed" });
    expect(hourCell(["oooo", "ooxx"], 0)).toEqual({ kind: "past" });
    expect(hourCell(["llll", "tttt"], 0)).toEqual({ kind: "later" });
  });

  it("looks at the right hour of the day", () => {
    const day = ["xxxxffff", "xxxxtttt"];
    expect(hourCell(day, 0)).toEqual({ kind: "closed" });
    expect(hourCell(day, 1)).toEqual({ kind: "count", free: 1, partly: 0, total: 2 });
  });

  it("merges neighbouring hours of the same program, but keeps a count cell per hour", () => {
    const day = Array(8).fill("xxxxffffffffAAAAAAAAAAAA");
    expect(dayCells(day, 24)).toEqual([
      { start: 0, end: 4, cell: { kind: "closed" } },
      { start: 4, end: 8, cell: { kind: "count", free: 8, partly: 0, total: 8 } },
      { start: 8, end: 12, cell: { kind: "count", free: 8, partly: 0, total: 8 } },
      { start: 12, end: 24, cell: { kind: "program", program: "A" } },
    ]);
  });

  it("shades darker as lanes fill up", () => {
    expect([8, 6, 5, 4, 2, 1, 0].map((free) => fullness(free, 8))).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
});

describe("booking several lanes", () => {
  it("finds how long a booking can run on all the chosen lanes", () => {
    expect(freeRun("ffftf", 0)).toBe(3);
    expect(freeRun("ffftf", 3)).toBe(0);
    expect(longest(["ffffffff", "fffttt"], 0, 8)).toBe(3);
    expect(longest(["ffffffffffff"], 0, 8)).toBe(8); // never longer than the club's maximum
  });

  it("chooses up to the club's number of lanes at one start time", () => {
    let pick = toggleLane({ start: -1, lanes: [] }, 3, 10, 2);
    expect(pick).toEqual({ start: 10, lanes: [3], refused: false });
    pick = toggleLane(pick, 4, 10, 2);
    expect(pick).toEqual({ start: 10, lanes: [3, 4], refused: false });
    // A third lane is refused (the whole alley is a party request).
    expect(toggleLane(pick, 5, 10, 2)).toEqual({ start: 10, lanes: [3, 4], refused: true });
    // Tapping a chosen lane again removes it; another time starts over.
    expect(toggleLane(pick, 3, 10, 2)).toEqual({ start: 10, lanes: [4], refused: false });
    expect(toggleLane(pick, 5, 12, 2)).toEqual({ start: 12, lanes: [5], refused: false });
    expect(toggleLane({ start: 10, lanes: [4] }, 4, 10, 2)).toEqual({ start: -1, lanes: [], refused: false });
  });
});
