import { describe, expect, it } from "vitest";
import { dayTicks, mergeSeries, seriesStats, stepText, timeTick } from "./chartData";

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

describe("dayTicks", () => {
  const midnight = (y: number, m: number, d: number) => new Date(y, m, d).getTime() / 1000;
  it("puts one tick on each local midnight inside the range", () => {
    const from = midnight(2026, 10, 2) + 5 * 3600, to = midnight(2026, 10, 9) + 13 * 3600;
    const t = dayTicks(from, to);
    expect(t).toHaveLength(7);
    expect(t[0]).toBe(midnight(2026, 10, 3));
    expect(t[6]).toBe(midnight(2026, 10, 9));
  });
  it("thins a long range to at most `max` ticks", () => {
    const t = dayTicks(midnight(2026, 0, 1), midnight(2026, 2, 31) + 1, 14);
    expect(t.length).toBeLessThanOrEqual(14);
    expect(t.length).toBeGreaterThan(10);
  });
});

describe("seriesStats", () => {
  it("summarises a series over the range", () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ ts: 1000 + i * 60, v: i + 1 }));   // 1..20
    const s = seriesStats(pts)!;
    expect(s).toMatchObject({ last: 20, min: 1, max: 20, maxTs: 1000 + 19 * 60, avg: 10.5, p95: 19 });
    expect(seriesStats([])).toBeNull();
    expect(seriesStats([{ ts: 1, v: NaN }, { ts: 2, v: 3 }])).toMatchObject({ min: 3, max: 3, last: 3 });
  });
});

describe("stepText", () => {
  it("reads a query step in words", () => {
    expect(stepText("4032s")).toBe("1.1 h");
    expect(stepText("300s")).toBe("5 min");
    expect(stepText("60s")).toBe("1 min");
    expect(stepText("1h")).toBe("1 h");
    expect(stepText("5400s")).toBe("1.5 h");
    expect(stepText("odd")).toBe("odd");
  });
});
