import { describe, expect, it } from "vitest";
import { countsText, filterRows, hostRows, type Host, ratioText, STATUS, windowText } from "./model";

const alloc = (physical: number, allocated: number, ratio = 2) => ({
  physical, reserved: 0, ratio, capacity: physical * ratio, allocated,
  effective_ratio: allocated / physical, alloc_pct: (100 * allocated) / (physical * ratio),
  headroom: physical * ratio - allocated,
});

const host: Host = {
  id: "h1", hostname: "one", aggregates: ["lab", "gpu"], vms: 4,
  cpu: alloc(16, 30), memory: { ...alloc(65536, 32768, 1), reserved: 512 },
  load: { cpu_pct: 20, mem_pct: 55, cpu_wait_pct: 0.4, swap_in_pps: 3, cpu_wait_worst: { id: "v", name: "vm", pct: 2 } },
  cpu_verdict: { status: "room", reason: "could go up", suggested_ratio: 4 },
  mem_verdict: { status: "ok", reason: null },
};

describe("overcommit model", () => {
  it("flattens a host for each view, memory in GB", () => {
    const [cpu] = hostRows([host], "cpu");
    expect(cpu).toMatchObject({ aggregates: "lab, gpu", ratio: 2, allocated: 30, load: 20, pressure: 0.4,
      status: "room", suggested: 4, worst: { name: "vm" } });
    expect(cpu.rank).toBe(Object.keys(STATUS.cpu).indexOf("room"));
    const [mem] = hostRows([host], "memory");
    expect(mem).toMatchObject({ physical: 64, reserved: 0.5, allocated: 32, load: 55, pressure: 3,
      worst: null, suggested: null, status: "ok" });
  });

  it("handles hosts Placement doesn't know", () => {
    const [r] = hostRows([{ ...host, cpu: null, cpu_verdict: { status: "unknown", reason: "x", suggested_ratio: null } }], "cpu");
    expect(r).toMatchObject({ ratio: null, physical: null, alloc_pct: null, status: "unknown" });
  });

  it("filters by status, sorts worst first by rank", () => {
    const rows = hostRows([host, { ...host, id: "h2", cpu_verdict: { status: "contended", reason: "", suggested_ratio: null } }], "cpu");
    expect(filterRows(rows, "contended").map(r => r.id)).toEqual(["h2"]);
    expect(filterRows(rows, "")).toHaveLength(2);
    expect(rows[1].rank).toBeLessThan(rows[0].rank);
  });

  it("formats ratios, counts and windows", () => {
    expect(ratioText({ ratio: 2 })).toBe("2:1");
    expect(ratioText({ ratio: null, ratios: [1.5, 4] })).toBe("1.5–4:1");
    expect(ratioText(null)).toBe("—");
    expect(countsText({ ok: 3, contended: 1, near_full: 2 }, "cpu")).toBe("1 contended · 2 nearly full");
    expect(countsText({ ok: 3 }, "memory")).toBe("All OK");
    expect([windowText(168), windowText(24), windowText(36), windowText(1)]).toEqual(["7 days", "1 day", "36 hours", "1 hour"]);
  });
});
