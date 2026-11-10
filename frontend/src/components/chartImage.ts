// A chart as a PNG: for copying to the clipboard, or saving where the browser doesn't allow
// clipboard images (any page not on HTTPS or localhost, such as an appliance on plain HTTP).

/** The style properties an SVG chart needs to look the same outside the page. */
const PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity",
  "stop-color", "stop-opacity", "font-family", "font-size", "font-weight", "text-anchor",
  "dominant-baseline", "visibility", "display",
];

type Styled = { style: { setProperty(name: string, value: string): void } };

/** Copy each source element's computed styles onto the matching clone element: CSS variables
 *  and stylesheets don't travel with a serialized SVG, resolved values do. */
export function copyStyles<S, D extends Styled>(src: S[], dst: D[],
                                               computed: (el: S) => { getPropertyValue(p: string): string }) {
  src.forEach((el, i) => {
    const cs = computed(el), to = dst[i];
    if (!to) return;
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) to.style.setProperty(p, v);
    }
  });
}

/** "vjailbreak-01 · CPU · last 7 days" → "vjailbreak-01-cpu-last-7-days.png". */
export function pngName(title: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "chart"}.png`;
}

/** One series' statistics over the chart's range, already formatted. */
export interface ChartSummary {
  label: string; color: string; now: string; min: string; avg: string; p95: string; max: string; maxAt: string;
}

const COLS: [string, keyof ChartSummary][] = [
  ["Now", "now"], ["Min", "min"], ["Average", "avg"], ["p95", "p95"], ["Max", "max"], ["Max at", "maxAt"],
];

/** The first chart SVG in `container`, drawn at 2× on white: the title, a subtitle (what and
 *  when), the chart, and a table of each series' statistics. */
export async function chartPng(container: HTMLElement, { title, subtitle, summary = [] }: {
  title: string; subtitle?: string; summary?: ChartSummary[];
}): Promise<Blob> {
  const svg = container.querySelector<SVGSVGElement>("svg.recharts-surface");
  if (!svg) throw new Error("No chart to copy");
  const box = svg.getBoundingClientRect();
  // At least 640 wide so the table fits; a small chart is scaled up a little (sharp, it's SVG)
  // and centred
  const pad = 14, scale = 2, rowH = 20;
  const w = Math.max(box.width + pad * 2, 640);
  const zoom = Math.min(1.25, (w - pad * 2) / box.width);
  const width = box.width * zoom, height = box.height * zoom, left = (w - width) / 2;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  copyStyles([svg, ...svg.querySelectorAll("*")], [clone, ...clone.querySelectorAll<SVGElement>("*")],
    el => getComputedStyle(el));
  // Not the hover cursor where the mouse happened to be
  clone.querySelectorAll(".recharts-tooltip-cursor, .recharts-active-dot").forEach(el => el.remove());
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const font = getComputedStyle(document.body).fontFamily;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `400 11px ${font}`;
    const sub = subtitle ? wrap(subtitle, w - pad * 2, t => ctx.measureText(t).width) : [];
    const head = 30 + sub.length * 15 + (sub.length ? 4 : 0);
    const table = summary.length ? 14 + rowH * (summary.length + 1) : 0;
    canvas.width = w * scale;
    canvas.height = (head + height + table + pad) * scale;
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, head + height + table + pad);
    ctx.fillStyle = "#1f2937";
    ctx.font = `600 13px ${font}`;
    ctx.fillText(title, pad, 21);
    ctx.fillStyle = "#6b7280";
    ctx.font = `400 11px ${font}`;
    sub.forEach((line, i) => ctx.fillText(line, pad, 39 + i * 15));
    ctx.drawImage(img, left, head, width, height);
    if (summary.length) {
      // Series name, then the figures right-aligned in equal columns
      const top = head + height + 14, nameW = 140, colW = (w - pad * 2 - nameW) / COLS.length;
      ctx.font = `600 10px ${font}`;
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "right";
      COLS.forEach(([h], i) => ctx.fillText(h.toUpperCase(), pad + nameW + colW * (i + 1) - 4, top + 12));
      summary.forEach((r, n) => {
        const y = top + rowH * (n + 1) + 12;
        ctx.textAlign = "left";
        ctx.fillStyle = resolveColor(r.color, container);
        ctx.fillRect(pad, y - 8, 9, 9);
        ctx.fillStyle = "#1f2937";
        ctx.font = `400 11px ${font}`;
        ctx.fillText(r.label, pad + 14, y, nameW - 18);
        ctx.textAlign = "right";
        COLS.forEach(([, k], i) => {
          ctx.font = `${k === "avg" ? 600 : 400} 11px ${font}`;
          ctx.fillStyle = k === "maxAt" ? "#6b7280" : "#1f2937";
          ctx.fillText(r[k], pad + nameW + colW * (i + 1) - 4, y, colW - 6);
        });
      });
    }
    return await new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error("Couldn't draw the chart"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `text` ("a · b · c") in lines no wider than `max`, breaking between its parts. */
export function wrap(text: string, max: number, measure: (t: string) => number): string[] {
  const lines: string[] = [];
  for (const part of text.split(" · ")) {
    const last = lines[lines.length - 1];
    if (last != null && measure(`${last} · ${part}`) <= max) lines[lines.length - 1] = `${last} · ${part}`;
    else lines.push(part);
  }
  return lines;
}

/** A CSS colour as the page resolves it ("var(--blue-primary)" → "rgb(0, 137, 199)"). */
function resolveColor(color: string, within: HTMLElement): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  within.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/** Browsers allow writing images to the clipboard only in a secure context (HTTPS or
 *  localhost). */
export function canCopyImage(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "ClipboardItem" in window && !!navigator.clipboard?.write;
}

/** Pass the image as a promise: the clipboard write then starts within the click, which
 *  browsers require, while the image is still being drawn. */
export async function copyImage(blob: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function saveImage(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
