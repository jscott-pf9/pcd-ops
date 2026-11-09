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

export type LegendItem = { label: string; color: string };

/** The first chart SVG in `container`, drawn at 2× on white with `title` above it and, for
 *  more than one series, a legend. */
export async function chartPng(container: HTMLElement, title: string, legend: LegendItem[] = []): Promise<Blob> {
  const svg = container.querySelector<SVGSVGElement>("svg.recharts-surface");
  if (!svg) throw new Error("No chart to copy");
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  copyStyles([svg, ...svg.querySelectorAll("*")], [clone, ...clone.querySelectorAll<SVGElement>("*")],
    el => getComputedStyle(el));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const pad = 14, head = 30, scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = (width + pad * 2) * scale;
    canvas.height = (height + head + pad) * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width + pad * 2, height + head + pad);
    ctx.fillStyle = "#1f2937";
    ctx.font = `600 13px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(title, pad, 21);
    if (legend.length > 1) {
      ctx.font = `400 11px ${getComputedStyle(document.body).fontFamily}`;
      let x = width + pad;
      for (const item of [...legend].reverse()) {
        x -= ctx.measureText(item.label).width;
        ctx.fillStyle = "#4b5563";
        ctx.fillText(item.label, x, 20);
        x -= 14;
        ctx.fillStyle = resolveColor(item.color, container);
        ctx.fillRect(x, 12, 9, 9);
        x -= 12;
      }
    }
    ctx.drawImage(img, pad, head, width, height);
    return await new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error("Couldn't draw the chart"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
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
