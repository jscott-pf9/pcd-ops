import { describe, expect, it } from "vitest";
import { type Classification, filterRecs, flavorText, isUpsize, pctText, projColor, ramText, type Rec, windowText } from "./model";

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

describe("right-sizing list", () => {
  const rec = (server_name: string, classification: Classification, project_id = "p1", extra: Partial<Rec> = {}) =>
    ({ server_id: server_name, server_name, classification, project_id, current_flavor: { name: "m1.large", vcpus: 4, ram_mb: 8192 },
       suggested_flavor: null, hypervisor: "hyp1", ...extra }) as Rec;
  const recs = [rec("web-10", "right-sized"), rec("web-2", "idle", "p2"), rec("db", "memory-pressure"),
                rec("cache", "overprovisioned", "p2", { hypervisor: "hyp9" })];

  it("puts the worst class first, then names in natural order", () => {
    expect(filterRecs(recs, { cls: "all", tenant: "", q: "" }).map(r => r.server_name))
      .toEqual(["db", "cache", "web-2", "web-10"]);
  });

  it("filters by class tab, tenant and search", () => {
    expect(filterRecs(recs, { cls: "attention", tenant: "", q: "" }).map(r => r.server_name)).toEqual(["db", "cache"]);
    expect(filterRecs(recs, { cls: "idle", tenant: "", q: "" }).map(r => r.server_name)).toEqual(["web-2"]);
    expect(filterRecs(recs, { cls: "all", tenant: "p2", q: "" }).map(r => r.server_name)).toEqual(["cache", "web-2"]);
    expect(filterRecs(recs, { cls: "all", tenant: "", q: "HYP9" }).map(r => r.server_name)).toEqual(["cache"]);
    expect(filterRecs(recs, { cls: "all", tenant: "", q: "m1.large" })).toHaveLength(4);
  });
});
