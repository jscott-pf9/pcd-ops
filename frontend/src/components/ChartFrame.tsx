import { type ReactNode, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, X } from "lucide-react";
import { canCopyImage, chartPng, type ChartSummary, copyImage, pngName, saveImage } from "./chartImage";

type Props = {
  title: string;
  /** The latest values, labelled, shown right of the title. */
  values?: ReactNode;
  /** The item, for the image's title and file name: "vjailbreak-01". */
  name?: string;
  /** The range in words, for the image's title: "last 7 days". */
  caption?: string;
  /** What the chart is of and over when: "VM vjailbreak-01 · Tenant service · …". */
  subtitle?: string;
  /** Per series: latest, min, average, p95 and max over the range. */
  summary?: ChartSummary[];
  /** Draws the chart at a height; `big` in the pop-out. */
  chart: (height: number, big: boolean) => ReactNode;
  height?: number;
};

/** A chart with its title, its latest values, and buttons to open it larger (with the
 *  range's statistics) and to copy it as an image (saved instead where the browser doesn't
 *  allow copying images). */
export default function ChartFrame({ height = 170, ...p }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={{ border: "1px solid var(--gray-100)", borderRadius: 8, padding: "8px 10px 4px" }}>
      <Header {...p} target={ref} onExpand={() => setOpen(true)} />
      <div ref={ref}>{p.chart(height, false)}</div>
      {open && <PopOut {...p} onClose={() => setOpen(false)} />}
    </div>
  );
}

function Header({ title, values, name, caption, subtitle, summary, target, big, onExpand, onClose }: Omit<Props, "chart" | "height"> & {
  target: React.RefObject<HTMLDivElement>; big?: boolean; onExpand?: () => void; onClose?: () => void;
}) {
  const [done, setDone] = useState<"" | "ok" | "failed">("");
  const copyable = canCopyImage();
  const label = [name, title, caption].filter(Boolean).join(" · ");
  const copy = async () => {
    if (!target.current) return;
    try {
      const png = chartPng(target.current, { title: label, subtitle, summary });
      if (copyable) await copyImage(png);
      else saveImage(await png, pngName(label));
      setDone("ok");
    } catch {
      setDone("failed");
    }
    setTimeout(() => setDone(""), 1500);
  };
  const Icon = done === "ok" ? Check : copyable ? Copy : Download;
  const what = copyable ? "Copy as image" : "Save as PNG (copying images needs HTTPS)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
      <span style={{ fontSize: big ? 14 : 12, fontWeight: 600, color: "var(--gray-700)" }}>
        {big && name ? `${name} · ${title}` : title}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 10, fontSize: 11, alignItems: "baseline", flexWrap: "wrap",
        justifyContent: "flex-end" }}>{values}</span>
      <span style={{ display: "flex", gap: 2 }}>
        <IconButton title={done === "failed" ? "Couldn't make the image" : what} onClick={copy}
          color={done === "ok" ? "var(--green)" : done === "failed" ? "var(--red)" : undefined}><Icon size={13} /></IconButton>
        {onExpand && <IconButton title="Open larger, with min, average and max" onClick={onExpand}><Maximize2 size={13} /></IconButton>}
        {onClose && <IconButton title="Close (Esc)" onClick={onClose}><X size={15} /></IconButton>}
      </span>
    </div>
  );
}

function IconButton({ title, onClick, color, children }: {
  title: string; onClick: () => void; color?: string; children: ReactNode;
}) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      style={{ background: "none", border: "none", padding: 3, cursor: "pointer", lineHeight: 0, borderRadius: 4,
        color: color ?? "var(--gray-400)" }}>
      {children}
    </button>
  );
}

function PopOut({ onClose, ...p }: Omit<Props, "height"> & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const rows = p.summary?.length ?? 0;
  const height = Math.max(200, Math.round(Math.min(window.innerHeight * 0.85, 960)) - 90 - (rows ? 40 + rows * 30 : 0));
  return (
    <div role="dialog" aria-label={p.title} onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000, display: "flex",
        alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div className="card" style={{ width: "min(1400px, 100%)", maxHeight: "100%", overflowY: "auto", padding: "12px 14px 10px" }}>
        <Header {...p} target={ref} big onClose={onClose} />
        {p.subtitle && <div className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>{p.subtitle}</div>}
        <div ref={ref}>{p.chart(height, true)}</div>
        {!!rows && <SummaryTable rows={p.summary!} />}
      </div>
    </div>
  );
}

function SummaryTable({ rows }: { rows: ChartSummary[] }) {
  const num = { textAlign: "right" as const, whiteSpace: "nowrap" as const };
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table style={{ fontSize: 12 }}>
        <thead>
          <tr><th>Series</th><th style={num}>Now</th><th style={num}>Min</th><th style={num}>Average</th>
            <th style={num} title="95th percentile: 1 point in 20 was higher">p95</th><th style={num}>Max</th><th>Max at</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td style={{ whiteSpace: "nowrap" }}>
                <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: r.color, marginRight: 6 }} />
                {r.label}
              </td>
              <td style={num}>{r.now}</td><td style={num}>{r.min}</td><td style={{ ...num, fontWeight: 600 }}>{r.avg}</td>
              <td style={num}>{r.p95}</td><td style={num}>{r.max}</td>
              <td className="text-muted" style={{ whiteSpace: "nowrap" }}>{r.maxAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
