import { describe, expect, it } from "vitest";
import { ageDays, ageText, CATEGORIES, filterItems, frees, freesText, moneyText, monthly, NO_PRICES, noteFor, priced } from "./model";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const F = { tenant: "", minAge: 0, q: "", system: false };

describe("reclamation model", () => {
  it("covers every backend category once, in four groups", () => {
    expect(CATEGORIES).toHaveLength(11);
    expect(new Set(CATEGORIES.map(c => c.key)).size).toBe(11);
    expect(CATEGORIES.filter(c => c.warning).map(c => c.key)).toEqual(["orphaned_vms"]);
    // report only: idle VMs (running), orphaned VMs and tenants
    expect(CATEGORIES.filter(c => !c.deletePath).map(c => c.key))
      .toEqual(["idle_servers", "orphaned_vms", "empty_tenants"]);
  });

  it("gives every category its own workbook sheet name", () => {
    const names = CATEGORIES.map(c => c.sheet);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(n => n.length <= 31 && !/[\\/?*[\]:]/.test(n))).toBe(true);
  });

  it("ages treat zone-less backend times as UTC", () => {
    expect(ageDays("2026-11-01T12:00:00", NOW)).toBe(5);
    expect(ageDays("2026-11-01T12:00:00Z", NOW)).toBe(5);
    expect(ageDays("2026-11-06T11:00:00.123456", NOW)).toBe(0);
    expect(ageDays(null, NOW)).toBeNull();
    expect([ageText(0), ageText(1), ageText(9)]).toEqual(["today", "1 day", "9 days"]);
  });

  it("filters by tenant, age, text, and hides system tenants unless asked", () => {
    const items = [
      { id: "a", name: "web", project_id: "p1", since: "2026-10-01T00:00:00" },
      { id: "b", name: "db", project_id: "p2", since: "2026-11-06T00:00:00", fixed_ips: ["10.0.0.9"] },
    ];
    expect(filterItems("stopped_servers", items, { ...F, tenant: "p1" }, NOW).map(i => i.id)).toEqual(["a"]);
    expect(filterItems("stopped_servers", items, { ...F, minAge: 30 }, NOW).map(i => i.id)).toEqual(["a"]);
    expect(filterItems("orphaned_ports", items, { ...F, q: "10.0.0.9" }, NOW).map(i => i.id)).toEqual(["b"]);
    const tenants = [{ id: "s", name: "service", system: true }, { id: "t", name: "t", system: false }];
    expect(filterItems("empty_tenants", tenants, F, NOW).map(i => i.id)).toEqual(["t"]);
    expect(filterItems("empty_tenants", tenants, { ...F, system: true }, NOW)).toHaveLength(2);
    expect(filterItems("empty_tenants", tenants, { ...F, tenant: "s", system: true }, NOW).map(i => i.id)).toEqual(["s"]);
  });

  it("totals what each category frees", () => {
    expect(frees("stopped_servers", [{ vcpus: 2, ram_mb: 4096, attached_disk_gb: 20 }]))
      .toEqual({ vcpus: 2, ram_gb: 4, volume_gb: 20, image_gb: 0, ips: 0 });
    expect(frees("orphaned_ports", [{ fixed_ips: ["a", "b"] }, { fixed_ips: [] }]).ips).toBe(2);
    expect(frees("orphaned_vms", [{ vcpus: 8 }]).vcpus).toBe(0);
    expect(freesText(frees("unused_images", [{ size_gb: 1.25 }]))).toBe("1.3 GB images");
    expect(freesText(frees("empty_tenants", [{}]))).toBe("—");
  });

  it("picks the note a category depends on", () => {
    expect(noteFor("idle_servers", { idle: "needs 14 days" })).toBe("needs 14 days");
    expect(noteFor("orphaned_vms", { libvirt: "needs the store" })).toBe("needs the store");
    expect(noteFor("unused_routers", { unused_routers: "not checked" })).toBe("not checked");
    expect(noteFor("unused_images", {})).toBeNull();
  });

  it("prices what reclaiming saves a month", () => {
    const p = { ...NO_PRICES, currency: "€", vcpu: 10, ram_gb: 2.5, volume_gb: 0.1, ip: 3 };
    expect(priced(NO_PRICES)).toBe(false);
    expect(priced(p)).toBe(true);
    const f = frees("stopped_servers", [{ vcpus: 4, ram_mb: 8192, attached_disk_gb: 100 }]);
    expect(monthly(f, p)).toBe(40 + 20 + 10);
    expect(monthly(frees("unused_floating_ips", [{}, {}]), p)).toBe(6);
    expect(moneyText(70, p)).toBe("€70.00/month");
    expect(moneyText(1234.4, p)).toBe("€1,234/month");
    expect(moneyText(0, p)).toBe("—");
  });
});
