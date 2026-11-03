import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorDetail } from "../api/client";
import { type History, type Range, getHostHistory, getMetricsStatus, getVmHistory, rangesWithin, SOURCE_LABEL } from "../api/metrics";
import { formatPct, formatRate, pctColor } from "./format";
import { Metric, type Point } from "./Metric";

type Row = { key: string; label: string; format: (v: number) => string; pct?: boolean; color?: string };

const HOST_ROWS: Row[] = [
  { key: "cpu_pct",        label: "CPU",          format: formatPct, pct: true },
  { key: "mem_pct",        label: "Memory",       format: formatPct, pct: true },
  { key: "disk_pct",       label: "Disk space",   format: formatPct, pct: true },
  { key: "disk_read_bps",  label: "Disk read",    format: formatRate, color: "var(--purple)" },
  { key: "disk_write_bps", label: "Disk write",   format: formatRate, color: "var(--purple)" },
  { key: "net_rx_bps",     label: "Network in",   format: formatRate, color: "var(--blue-primary)" },
  { key: "net_tx_bps",     label: "Network out",  format: formatRate, color: "var(--blue-primary)" },
];

const VM_ROWS: Row[] = [
  { key: "cpu_pct",         label: "CPU",          format: formatPct, pct: true },
  { key: "mem_pct",         label: "Memory",       format: formatPct, pct: true },
  { key: "cpu_wait_pct",    label: "CPU wait (steal)", format: formatPct, color: "var(--yellow)" },
  { key: "disk_iops",       label: "Disk IOPS",    format: v => v.toFixed(1), color: "var(--purple)" },
  { key: "disk_latency_ms", label: "Disk latency", format: v => `${v.toFixed(2)} ms`, color: "var(--purple)" },
  { key: "net_rx_bps",      label: "Network in",   format: formatRate, color: "var(--blue-primary)" },
  { key: "net_tx_bps",      label: "Network out",  format: formatRate, color: "var(--blue-primary)" },
];

const last = (s: Point[] | undefined) => (s && s.length ? s[s.length - 1].v : null);

/** History for one hypervisor or VM with a range picker, for the Inventory drawers. Fetched
 *  only while shown. */
export default function MetricsHistory({ kind, id }: { kind: "host" | "vm"; id: string }) {
  const [range, setRange] = useState<Range>("24h");
  const { data: status } = useQuery({ queryKey: ["metrics", "status"], queryFn: getMetricsStatus, staleTime: 60_000 });
  const { data, error, isLoading } = useQuery<History>({
    queryKey: ["metrics", kind, id, range],
    queryFn: () => (kind === "host" ? getHostHistory(id, range) : getVmHistory(id, range)),
    retry: false,
  });
  const rows = (kind === "host" ? HOST_ROWS : VM_ROWS).filter(r => !data || r.key in data.series);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, margin: "6px 0 10px", flexWrap: "wrap" }}>
        {rangesWithin(status?.retention_days).map(r => (
          <button key={r} type="button" onClick={() => setRange(r)}
            className={`btn btn-sm ${r === range ? "btn-primary" : "btn-secondary"}`}
            style={{ padding: "1px 8px", fontSize: 11 }}>{r}</button>
        ))}
      </div>
      {isLoading && <p className="text-muted" style={{ fontSize: 12 }}>Loading…</p>}
      {error && <p className="text-muted" style={{ fontSize: 12 }}>{errorDetailText(error)}</p>}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map(r => {
            const series = data.series[r.key] ?? [];
            const v = last(series);
            return (
              <Metric key={r.key} label={r.label} avg={v} series={series} format={r.format}
                color={r.pct ? pctColor(v, 0, 85) : (r.color ?? "var(--gray-600)")}
                low={r.pct ? 0 : undefined} />
            );
          })}
          <div className="text-muted" style={{ fontSize: 11 }}>
            {SOURCE_LABEL[data.source]} · last {data.days === 1 ? "24 hours" : `${data.days} days`}
          </div>
        </div>
      )}
    </div>
  );
}

/** The API's 503 for "no metrics yet" carries its reason in detail.error. */
function errorDetailText(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err);
  try {
    const detail = JSON.parse(msg.slice(msg.indexOf("{"))).detail;
    if (detail?.error) return detail.error;
  } catch {
    // not JSON
  }
  return errorDetail(err);
}
