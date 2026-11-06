import { describe, expect, it } from "vitest";
import { EXPORTS, toCsv } from "./exports";
import { cpuName, flatten, fmtSize, ramGb, SERVER_GROUP_STATUS } from "./format";
import { detailPath, KINDS, TAB_ORDER } from "./kinds";
import { summary } from "./summaries";

const ctx = { tenant: (id?: string | null) => (id === "p1" ? "acme" : id ?? "—") };

describe("format", () => {
  it("sizes", () => {
    expect(fmtSize(512)).toBe("512 GB");
    expect(fmtSize(7416.46)).toBe("7.2 TB");
    expect(fmtSize(78.19)).toBe("78.2 GB");
    expect(fmtSize(null)).toBe("—");
  });
  it("prefers installed RAM and doesn't repeat the vendor", () => {
    expect(ramGb({ memory_mb_installed: 65536, memory_mb_total: 60888 })).toBe(64);
    expect(ramGb({ memory_mb_total: 60888 })).toBe(59);
    expect(cpuName({ cpu_vendor: "AMD", cpu_model: "AMD Ryzen 7 5700U" })).toBe("AMD Ryzen 7 5700U");
    expect(cpuName({ cpu_vendor: "AMD", cpu_model: "EPYC-Rome-v5" })).toBe("AMD EPYC-Rome-v5");
  });
  it("labels every server group status", () => {
    for (const s of ["ok", "violated", "not_satisfied", "empty"]) expect(SERVER_GROUP_STATUS[s].label).toBeTruthy();
  });
});

describe("kinds", () => {
  it("has a tab, an export and a detail path for every kind", () => {
    expect(TAB_ORDER.sort()).toEqual(Object.keys(KINDS).sort());
    for (const k of TAB_ORDER) expect(EXPORTS[k].length).toBeGreaterThan(0);
    expect(detailPath("storage_backends", "my nas")).toBe("/inventory/storage_backends/my%20nas");
  });
});

describe("hover card summaries", () => {
  it("covers every kind without throwing on sparse rows", () => {
    for (const k of TAB_ORDER) expect(summary(k, {}, ctx).length).toBeGreaterThan(2);
  });
  it("shows a backend's use and a server group's placement", () => {
    const b = summary("storage_backends", { protocol: "NFS", total_gb: 1000, used_gb: 600, used_pct: 60,
      free_gb: 400, provisioned_gb: 80, effective_gb: 20000, provisioned_pct: 0.4, volumes: 2,
      hosts: ["hyp01", "hyp02"], shared: true, types: ["nas"] }, ctx);
    expect(Object.fromEntries(b).Used).toBe("600 GB of 1000 GB (60%)");
    expect(Object.fromEntries(b).Hosts).toBe("hyp01, hyp02 (shared)");
    const g = summary("server_groups", { policy: "anti-affinity", status: "violated",
      detail: "More than 1 per host on hyp01 (2)", members: [{}, {}], hosts: ["hyp01"], project_id: "p1" }, ctx);
    expect(Object.fromEntries(g).Placement).toBe("Violated: More than 1 per host on hyp01 (2)");
    expect(Object.fromEntries(g).Tenant).toBe("acme");
  });
});

describe("exports", () => {
  it("quotes CSV cells", () => {
    expect(toCsv(["a", "b"], [['x "y"', null]])).toBe('"a","b"\n"x ""y""",""');
  });
  it("rows match headers for every sheet", () => {
    const sample: Record<string, any> = {
      storage_backends: { name: "nas", pools: [{ name: "h@nas#nas" }], hosts: [], types: [] },
      security_groups: { name: "sg", rules: [{ direction: "ingress" }] },
    };
    for (const k of TAB_ORDER) {
      for (const sheet of EXPORTS[k]) {
        for (const row of sheet.rows([sample[k] ?? {}], ctx)) expect(row.length).toBe(sheet.headers.length);
      }
    }
  });
});

describe("flatten", () => {
  it("turns nested API properties into paths", () => {
    expect(flatten({ name: "x", flavor: { extra_specs: { "hw:cpu_policy": "dedicated" } },
                     tags: ["a", "b"], addresses: { net: [{ addr: "10.0.0.1" }] }, none: null })).toEqual([
      ["name", "x"], ["flavor.extra_specs.hw:cpu_policy", "dedicated"], ["tags", "a, b"],
      ["addresses.net[0].addr", "10.0.0.1"],
    ]);
  });
});

describe("snapshots", () => {
  it("are named as such in the hover card", () => {
    const facts = Object.fromEntries(summary("images", { kind: "snapshot", snapshot_type: "instance" }, ctx));
    expect(facts.Type).toBe("Snapshot (instance)");
  });
});
