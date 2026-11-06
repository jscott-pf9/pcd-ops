import { describe, expect, it } from "vitest";
import { fmtValue, sinceText } from "./anomaly";

describe("anomaly formatting", () => {
  it("formats each unit", () => {
    expect([fmtValue(42.34, "pct"), fmtValue(1536, "bps"), fmtValue(7.25, "ms"), fmtValue(12.4, "pps"), fmtValue(51.6, "iops")])
      .toEqual(["42.3%", "1.5 KB/s", "7.3 ms", "12 pages/s", "52"]);
  });

  it("says how long a finding has lasted", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(sinceText("2026-11-06T11:30:00", now)).toBe("under an hour");
    expect(sinceText("2026-11-06T07:00:00", now)).toBe("5 h");
    expect(sinceText("2026-11-03T12:00:00Z", now)).toBe("3 days");
    expect(sinceText(null, now)).toBe("—");
  });
});
