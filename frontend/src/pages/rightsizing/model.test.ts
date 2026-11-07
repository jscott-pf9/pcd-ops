import { describe, expect, it } from "vitest";
import { flavorText, isUpsize, pctText, projColor, ramText, windowText } from "./model";

describe("right-sizing model", () => {
  it("formats sizes", () => {
    expect(ramText(8192)).toBe("8 GB");
    expect(ramText(1536)).toBe("1.5 GB");
    expect(ramText(null)).toBe("—");
    expect(flavorText({ vcpus: 1, ram_mb: 2048 })).toBe("1 vCPU · 2 GB");
    expect(flavorText({ vcpus: 4, ram_mb: 8192 })).toBe("4 vCPUs · 8 GB");
  });

  it("reads percentages, capping projections over 100", () => {
    expect(pctText(4.25)).toBe("4.3%");
    expect(pctText(42.6)).toBe("43%");
    expect(pctText(240)).toBe("100%+");
    expect(pctText(undefined)).toBe("—");
  });

  it("colours projected use and tells up from down", () => {
    expect(projColor(95, 80, 90)).toBe("var(--red)");
    expect(projColor(85, 80, 90)).toBe("#B45309");
    expect(projColor(40, 80, 90)).toBe("var(--gray-900)");
    const cur = { name: "m", vcpus: 4, ram_mb: 8192 };
    expect(isUpsize(cur, { name: "l", vcpus: 4, ram_mb: 16384 })).toBe(true);
    expect(isUpsize(cur, { name: "s", vcpus: 2, ram_mb: 8192 })).toBe(false);
    expect(windowText(30)).toBe("the last 30 days");
  });
});
