import { type ReactNode, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, X } from "lucide-react";
import { canCopyImage, chartPng, copyImage, type LegendItem, pngName, saveImage } from "./chartImage";

type Props = {
  title: string;
  /** Current values, shown right of the title. */
  values?: ReactNode;
  /** What and when, for the copied image's title: "vjailbreak-01", "last 7 days". */
  name?: string; caption?: string;
  /** The series, for the copied image's legend. */
  legend?: LegendItem[];
  /** Draws the chart at a height; `big` in the pop-out. */
  chart: (height: number, big: boolean) => ReactNode;
  height?: number;
};

/** A chart with its title, its current values, and buttons to open it larger and to copy it
 *  as an image (save it instead where the browser doesn't allow copying images). */
export default function ChartFrame({ title, values, name, caption, legend, chart, height = 170 }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={{ border: "1px solid var(--gray-100)", borderRadius: 8, padding: "8px 10px 4px" }}>
      <Header title={title} values={values} label={[name, title, caption].filter(Boolean).join(" · ")} target={ref}
        legend={legend} onExpand={() => setOpen(true)} />
      <div ref={ref}>{chart(height, false)}</div>
      {open && <PopOut {...{ title, values, name, caption, legend, chart }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function Header({ title, values, label, target, legend, onExpand, onClose }: {
  title: string; values?: ReactNode; label: string; target: React.RefObject<HTMLDivElement>; legend?: LegendItem[];
  onExpand?: () => void; onClose?: () => void;
}) {
  const [done, setDone] = useState<"" | "ok" | "failed">("");
  const copyable = canCopyImage();
  const copy = async () => {
    if (!target.current) return;
    try {
      const png = chartPng(target.current, label, legend);
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
      <span style={{ fontSize: onClose ? 14 : 12, fontWeight: 600, color: "var(--gray-700)" }}>{title}</span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 10, fontSize: 11, alignItems: "baseline" }}>{values}</span>
      <span style={{ display: "flex", gap: 2 }}>
        <IconButton title={done === "failed" ? "Couldn't make the image" : what} onClick={copy}
          color={done === "ok" ? "var(--green)" : done === "failed" ? "var(--red)" : undefined}><Icon size={13} /></IconButton>
        {onExpand && <IconButton title="Open larger" onClick={onExpand}><Maximize2 size={13} /></IconButton>}
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

function PopOut({ title, values, name, caption, legend, chart, onClose }: Omit<Props, "height"> & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const height = Math.max(220, Math.round(Math.min(window.innerHeight * 0.8, 900)) - 70);
  return (
    <div role="dialog" aria-label={title} onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000, display: "flex",
        alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div className="card" style={{ width: "min(1400px, 100%)", padding: "12px 14px 8px" }}>
        <Header title={name ? `${name} · ${title}` : title} values={values}
          label={[name, title, caption].filter(Boolean).join(" · ")} target={ref} legend={legend} onClose={onClose} />
        {caption && <div className="text-muted" style={{ fontSize: 11, marginBottom: 6 }}>{caption}</div>}
        <div ref={ref}>{chart(height, true)}</div>
      </div>
    </div>
  );
}
