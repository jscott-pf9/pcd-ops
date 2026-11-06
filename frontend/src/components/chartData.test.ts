import { describe, expect, it } from "vitest";
import { mergeSeries, timeTick } from "./chartData";

describe("mergeSeries", () => {
  it("joins series by timestamp, oldest first, leaving gaps empty", () => {
    expect(mergeSeries({
      rx: [{ ts: 120, v: 2 }, { ts: 60, v: 1 }],
      tx: [{ ts: 60, v: 5 }, { ts: 180, v: 7 }],
      none: undefined,
    })).toEqual([{ ts: 60, rx: 1, tx: 5 }, { ts: 120, rx: 2 }, { ts: 180, tx: 7 }]);
  });
  it("is empty without points", () => {
    expect(mergeSeries({})).toEqual([]);
  });
});

describe("timeTick", () => {
  const ts = Date.UTC(2026, 10, 5, 14, 30) / 1000;
  it("shows times within a day and dates beyond", () => {
    expect(timeTick(1)(ts)).toMatch(/\d{1,2}:\d{2}/);
    expect(timeTick(7)(ts)).not.toMatch(/:\d{2}/);
    expect(timeTick(30)(ts)).toMatch(/\d/);
  });
});
