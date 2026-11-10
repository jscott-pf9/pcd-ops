import { describe, expect, it } from "vitest";
import { covers, parseNames } from "./tls";

describe("tls helpers", () => {
  it("matches names, addresses and one-label wildcards", () => {
    expect(covers(["ops.example.com", "10.0.0.5"], "10.0.0.5")).toBe(true);
    expect(covers(["*.example.com"], "Ops.Example.com")).toBe(true);
    expect(covers(["*.example.com"], "a.b.example.com")).toBe(false);
    expect(covers(["*.example.com"], "example.com")).toBe(false);
    expect(covers(["ops.example.com"], "10.0.0.5")).toBe(false);
  });

  it("reads names one per line or comma separated", () => {
    expect(parseNames(" Ops.example.com\n10.0.0.5, 10.0.0.5\n\n")).toEqual(["ops.example.com", "10.0.0.5"]);
  });
});
