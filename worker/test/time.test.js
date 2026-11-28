// @ts-check
// Club time (America/New_York) stays right across daylight saving changes.
import { describe, expect, it } from "vitest";
import {
  addDays,
  clubParts,
  clubTimeToUtc,
  clubToday,
  daysBetween,
  isClubDate,
  isClubTime,
  isQuarterHour,
  nextSlot,
  weekdayOf,
} from "../src/time.js";

/** @param {string} iso */
const unix = (iso) => Date.parse(iso) / 1000;

describe("club time to UTC", () => {
  it("uses EST in winter and EDT in summer", () => {
    expect(clubTimeToUtc("2026-01-15", "18:00")).toBe(unix("2026-01-15T23:00:00Z"));
    expect(clubTimeToUtc("2026-07-15", "18:00")).toBe(unix("2026-07-15T22:00:00Z"));
  });

  it("is right on both sides of the spring change (2026-03-08)", () => {
    expect(clubTimeToUtc("2026-03-08", "01:00")).toBe(unix("2026-03-08T06:00:00Z"));
    expect(clubTimeToUtc("2026-03-08", "03:00")).toBe(unix("2026-03-08T07:00:00Z"));
    expect(clubTimeToUtc("2026-03-08", "18:00")).toBe(unix("2026-03-08T22:00:00Z"));
  });

  it("is right on both sides of the autumn change (2026-11-01)", () => {
    expect(clubTimeToUtc("2026-11-01", "00:30")).toBe(unix("2026-11-01T04:30:00Z"));
    expect(clubTimeToUtc("2026-11-01", "01:30")).toBe(unix("2026-11-01T05:30:00Z")); // first 1:30
    expect(clubTimeToUtc("2026-11-01", "03:00")).toBe(unix("2026-11-01T08:00:00Z"));
    expect(clubTimeToUtc("2026-11-01", "18:00")).toBe(unix("2026-11-01T23:00:00Z"));
  });

  it("treats 24:00 as midnight at the end of the date", () => {
    expect(clubTimeToUtc("2026-07-15", "24:00")).toBe(clubTimeToUtc("2026-07-16", "00:00"));
  });

  it("refuses impossible dates and times", () => {
    expect(() => clubTimeToUtc("2026-02-30", "10:00")).toThrow(RangeError);
    expect(() => clubTimeToUtc("2026-07-15", "24:30")).toThrow(RangeError);
  });
});

describe("UTC to club time", () => {
  it("gives the club date, time and weekday", () => {
    expect(clubParts(unix("2026-07-15T03:30:00Z"))).toMatchObject({ date: "2026-07-14", time: "23:30", weekday: 2 });
    expect(clubParts(unix("2026-01-01T05:00:00Z"))).toMatchObject({ date: "2026-01-01", time: "00:00", weekday: 4 });
    expect(clubToday(unix("2026-11-27T04:59:00Z"))).toBe("2026-11-26");
  });

  it("round-trips every quarter hour of a normal day", () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      expect(clubParts(clubTimeToUtc("2026-06-10", time)).time).toBe(time);
    }
  });
});

describe("dates and checks", () => {
  it("adds days across months, years and clock changes", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(daysBetween("2026-11-27", "2026-12-27")).toBe(30);
    expect(weekdayOf("2026-11-27")).toBe(5);
  });

  it("validates formats", () => {
    expect(isClubDate("2028-02-29")).toBe(true);
    expect(isClubDate("2027-02-29")).toBe(false);
    expect(isClubDate("2026-1-01")).toBe(false);
    expect(isClubTime("24:00")).toBe(true);
    expect(isClubTime("24:15")).toBe(false);
    expect(isQuarterHour("09:45")).toBe(true);
    expect(isQuarterHour("09:40")).toBe(false);
  });

  it("rounds up to the next 15-minute slot", () => {
    expect(nextSlot(900)).toBe(900);
    expect(nextSlot(901)).toBe(1800);
  });
});
