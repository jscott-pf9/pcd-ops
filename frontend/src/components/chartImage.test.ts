import { describe, expect, it } from "vitest";
import { copyStyles, pngName, wrap } from "./chartImage";

describe("chart image", () => {
  it("copies resolved styles onto the clone, skipping empty ones", () => {
    const resolved: Record<string, Record<string, string>> = {
      svg: { "font-family": "Inter" },
      path: { stroke: "rgb(0, 137, 199)", fill: "url(\"#fill-m1-cpu\")", opacity: "" },
    };
    const set = () => { const props: Record<string, string> = {}; return { props, style: { setProperty: (p: string, v: string) => { props[p] = v; } } }; };
    const dst = [set(), set()];
    copyStyles(["svg", "path"], dst, el => ({ getPropertyValue: p => resolved[el][p] ?? "" }));
    expect(dst[0].props).toEqual({ "font-family": "Inter" });
    expect(dst[1].props).toEqual({ stroke: "rgb(0, 137, 199)", fill: "url(\"#fill-m1-cpu\")" });
  });

  it("names the file after the title", () => {
    expect(pngName("vjailbreak-01 · CPU · last 7 days")).toBe("vjailbreak-01-cpu-last-7-days.png");
    expect(pngName("··")).toBe("chart.png");
  });

  it("wraps the subtitle between its parts", () => {
    const measure = (t: string) => t.length;
    expect(wrap("VM web · Tenant a · Host h1", 20, measure)).toEqual(["VM web · Tenant a", "Host h1"]);
    expect(wrap("a-very-long-single-part", 5, measure)).toEqual(["a-very-long-single-part"]);
  });
});
