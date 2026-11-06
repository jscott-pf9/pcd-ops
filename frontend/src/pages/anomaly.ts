// Anomaly findings (backend: services/anomaly.py): how values and durations read.
import { formatPct, formatRate } from "../components/format";

export type Unit = "pct" | "bps" | "iops" | "ms" | "pps";

export function fmtValue(v: number, unit: Unit): string {
  if (unit === "pct") return formatPct(v);
  if (unit === "bps") return formatRate(v);
  if (unit === "ms") return `${v.toFixed(1)} ms`;
  if (unit === "pps") return `${Math.round(v)} pages/s`;
  return `${Math.round(v)}`;
}

/** How long a finding has lasted: "under an hour", "5 h", "3 days" (zone-less times are UTC). */
export function sinceText(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const ms = now - Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  const h = Math.floor(ms / 3_600_000);
  return h < 1 ? "under an hour" : h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}
