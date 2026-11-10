import { describe, expect, it } from "vitest";
import { formatBytes, formatNumber, formatPct, formatRate, pctColor } from "./format";
import { rangesWithin } from "../api/metrics";
import { noDataReason } from "../api/client";

describe("formatBytes / formatRate / formatPct", () => {
  it("scales by 1024 and keeps one decimal below 100", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(256 * 1024 ** 3)).toBe("256 GB");
    expect(formatBytes(3.2e12)).toBe("2.9 TB");
  });
  it("shows a dash without a value", () => {
    for (const v of [null, undefined, NaN, Infinity]) {
      expect(formatBytes(v)).toBe("—");
      expect(formatRate(v)).toBe("—");
      expect(formatPct(v)).toBe("—");
    }
  });
  it("counts and rates keep small values instead of rounding them to zero", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1234.4)).toBe("1234");
    expect(formatNumber(12.34)).toBe("12.3");
    expect(formatNumber(0.1234)).toBe("0.12");
    expect(formatNumber(0.0033333)).toBe("0.0033");
    expect(formatNumber(0.00002)).toBe("0.00002");
    expect(formatNumber(null)).toBe("—");
  });
  it("rates and percentages", () => {
    expect(formatRate(12.5 * 1024 ** 2)).toBe("12.5 MB/s");
    expect(formatPct(42.345)).toBe("42.3%");
  });
});

describe("pctColor", () => {
  it("is grey without a value, red at high, yellow under low", () => {
    expect(pctColor(null, 20, 80)).toBe("var(--gray-300)");
    expect(pctColor(80, 20, 80)).toBe("var(--red)");
    expect(pctColor(10, 20, 80)).toBe("var(--yellow)");
    expect(pctColor(50, 20, 80)).toBe("var(--green)");
  });
});

describe("rangesWithin", () => {
  it("offers only the ranges the source keeps", () => {
    expect(rangesWithin(14)).toEqual(["24h", "7d"]);
    expect(rangesWithin(90)).toEqual(["24h", "7d", "30d", "90d"]);
    expect(rangesWithin(730)).toEqual(["24h", "7d", "30d", "90d", "1y", "2y"]);
    expect(rangesWithin(null)).toEqual(["24h"]);
  });
});

describe("noDataReason", () => {
  it("reads the no_data detail, with the last failure if any", () => {
    const err = new Error('503 Service Unavailable: {"detail":{"code":"no_data","key":"k","error":"boom"}}');
    expect(noDataReason(err)).toEqual({ failed: "boom" });
    expect(noDataReason(new Error('503 x: {"detail":{"code":"no_data","key":"k"}}'))).toEqual({ failed: null });
  });
  it("is null for other errors", () => {
    expect(noDataReason(null)).toBeNull();
    expect(noDataReason(new Error("500 Internal Server Error: oops"))).toBeNull();
    expect(noDataReason(new Error('400 x: {"detail":"bad"}'))).toBeNull();
  });
});
