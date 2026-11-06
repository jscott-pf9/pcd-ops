import { describe, expect, it } from "vitest";
import { DRIFT_KINDS, fieldText, isDriftKind, parseAt, valueText } from "./model";

describe("config change model", () => {
  it("covers the backend's kinds and links the ones Inventory has", () => {
    expect(DRIFT_KINDS.map(k => k.id)).toEqual(["flavors", "security_groups", "aggregates", "hosts", "quotas"]);
    expect(DRIFT_KINDS.filter(k => !k.inventory).map(k => k.id)).toEqual(["quotas"]);
    expect([isDriftKind("hosts"), isDriftKind("routers"), isDriftKind(null)]).toEqual([true, false, false]);
  });

  it("reads each kind of field change", () => {
    expect(fieldText({ field: "vcpus", op: "changed", before: 4, after: 8 })).toBe("vcpus: 4 → 8");
    expect(fieldText({ field: "rules.ingress IPv4 tcp 22 from 0.0.0.0/0", op: "added", before: null, after: "" }))
      .toBe("+ rules.ingress IPv4 tcp 22 from 0.0.0.0/0");
    expect(fieldText({ field: "metadata.zone", op: "removed", before: "a", after: null })).toBe("− metadata.zone (was a)");
    expect(fieldText({ field: "os_version", op: "changed", before: null, after: "Ubuntu 24.04" })).toBe("os_version: — → Ubuntu 24.04");
    expect([valueText(""), valueText(false), valueText({ a: 1 })]).toEqual(["(blank)", "false", '{"a":1}']);
  });

  it("treats zone-less times as UTC", () => {
    expect(parseAt("2026-11-06T21:00:00").toISOString()).toBe("2026-11-06T21:00:00.000Z");
    expect(parseAt("2026-11-06T21:00:00+00:00").toISOString()).toBe("2026-11-06T21:00:00.000Z");
  });
});
