import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorDetail } from "../api/client";
import {
  type History, type Range, getClusterHistory, getHostHistory, getMetricsStatus, getStorageHistory,
  getVmHistory, getVolumeHistory, rangesWithin, SOURCE_LABEL,
} from "../api/metrics";
import { mergeSeries, seriesStats, stepText, timeLabel } from "./chartData";
import { formatBytes, formatPct, formatRate } from "./format";
import ChartFrame from "./ChartFrame";
import TimeChart, { type SeriesDef } from "./TimeChart";

/** `unit` follows a value in the header and statistics when `format` has none (IOPS, VMs). */
type ChartDef = { title: string; series: SeriesDef[]; format: (v: number) => string; unit?: string; max?: number };
export type MetricsKind = "host" | "vm" | "storage" | "cluster" | "volume";

const BLUE = "var(--blue-primary)", GREEN = "var(--green)", PURPLE = "var(--purple)",
  YELLOW = "var(--yellow)", GRAY = "var(--gray-400)";
const ms = (v: number) => `${v.toFixed(v < 10 ? 2 : 0)} ms`;
const iops = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 1 : 0));
const count = (v: number) => String(Math.round(v));

const HOST_CHARTS: ChartDef[] = [
  { title: "CPU",        series: [{ key: "cpu_pct",  label: "CPU",    color: BLUE }],  format: formatPct, max: 100 },
  { title: "Memory",     series: [{ key: "mem_pct",  label: "Memory", color: GREEN }], format: formatPct, max: 100 },
  { title: "Disk space", series: [{ key: "disk_pct", label: "Used",   color: PURPLE }], format: formatPct, max: 100 },
  { title: "Disk I/O",   series: [{ key: "disk_read_bps", label: "Read", color: PURPLE },
                                  { key: "disk_write_bps", label: "Write", color: YELLOW }], format: formatRate },
  { title: "Network",    series: [{ key: "net_rx_bps", label: "In", color: BLUE },
                                  { key: "net_tx_bps", label: "Out", color: GREEN }], format: formatRate },
];

const CHARTS: Record<MetricsKind, ChartDef[]> = {
  host: HOST_CHARTS,
  vm: [
    { title: "CPU",          series: [{ key: "cpu_pct", label: "CPU", color: BLUE },
                                      { key: "cpu_wait_pct", label: "Wait (steal)", color: YELLOW }], format: formatPct, max: 100 },
    { title: "Memory",       series: [{ key: "mem_pct", label: "Memory", color: GREEN }], format: formatPct, max: 100 },
    { title: "Disk IOPS",    series: [{ key: "disk_iops", label: "IOPS", color: PURPLE }], format: iops, unit: " IOPS" },
    { title: "Disk latency", series: [{ key: "disk_latency_ms", label: "Latency", color: YELLOW }], format: ms },
    { title: "Network",      series: [{ key: "net_rx_bps", label: "In", color: BLUE },
                                      { key: "net_tx_bps", label: "Out", color: GREEN }], format: formatRate },
  ],
  storage: [
    { title: "Capacity", series: [{ key: "total_bytes", label: "Capacity", color: GRAY },
                                  { key: "used_bytes", label: "Used", color: BLUE },
                                  { key: "provisioned_bytes", label: "Provisioned", color: PURPLE }],
      format: formatBytes },
    { title: "Throughput (attached volumes)", series: [{ key: "read_bps", label: "Read", color: PURPLE },
                                                       { key: "write_bps", label: "Write", color: YELLOW }], format: formatRate },
    { title: "IOPS", series: [{ key: "iops", label: "IOPS", color: BLUE }], format: iops, unit: " IOPS" },
    { title: "Latency", series: [{ key: "latency_ms", label: "Latency", color: YELLOW }], format: ms },
  ],
  cluster: [
    ...HOST_CHARTS,
    { title: "Allocation", series: [{ key: "vcpu_alloc_pct", label: "vCPUs", color: BLUE },
                                    { key: "mem_alloc_pct", label: "RAM", color: GREEN }], format: formatPct, max: 100 },
    { title: "VMs", series: [{ key: "vms", label: "VMs", color: PURPLE }], format: count, unit: " VMs" },
  ],
  volume: [
    { title: "Throughput", series: [{ key: "read_bps", label: "Read", color: PURPLE },
                                    { key: "write_bps", label: "Write", color: YELLOW }], format: formatRate },
    { title: "IOPS", series: [{ key: "read_iops", label: "Read", color: PURPLE },
                              { key: "write_iops", label: "Write", color: YELLOW }], format: iops, unit: " IOPS" },
    { title: "Latency", series: [{ key: "latency_ms", label: "Latency", color: YELLOW }], format: ms },
    { title: "Space", series: [{ key: "capacity_bytes", label: "Size", color: GRAY },
                               { key: "allocated_bytes", label: "Allocated", color: BLUE }], format: formatBytes },
  ],
};

const FETCH: Record<MetricsKind, (id: string, r: Range) => Promise<History>> = {
  host: getHostHistory, vm: getVmHistory, storage: getStorageHistory, cluster: getClusterHistory,
  volume: getVolumeHistory,
};

/** History charts for one hypervisor, VM or storage backend, with a range picker. Hovering
 *  any chart moves the cursor on all of them to the same time. Each opens larger, with each
 *  series' min, average, p95 and max over the range, and copies as an image. `context` says
 *  what it is ([["VM", name], ["Tenant", …], ["Host", …]]); the first value names it. */
export default function MetricsCharts({ kind, id, context = [], initialRange = "24h" }: {
  kind: MetricsKind; id: string; context?: [string, string | null | undefined][]; initialRange?: Range;
}) {
  const [range, setRange] = useState<Range>(initialRange);
  const syncId = `m${useId().replace(/[^a-z0-9]/gi, "")}`;
  const { data: status } = useQuery({ queryKey: ["metrics", "status"], queryFn: getMetricsStatus, staleTime: 60_000 });
  const { data, error, isLoading } = useQuery<History>({
    queryKey: ["metrics", kind, id, range],
    queryFn: () => FETCH[kind](id, range),
    retry: false,
  });
  // Storage and volume history only come from PCD Ops' own store
  const localOnly = kind === "storage" || kind === "volume";
  const retention = localOnly ? status?.local.retention_days : status?.retention_days;
  const charts = CHARTS[kind]
    .map(c => ({ ...c, series: c.series.filter(s => !data || (data.series[s.key]?.length ?? 0) > 0) }))
    .filter(c => c.series.length > 0);
  const known = context.filter(([, v]) => v) as [string, string][];
  const name = known[0]?.[1];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {rangesWithin(retention).map(r => (
          <button key={r} type="button" onClick={() => setRange(r)}
            className={`btn btn-sm ${r === range ? "btn-primary" : "btn-secondary"}`}
            style={{ padding: "2px 10px", fontSize: 11 }}>{r}</button>
        ))}
        {data && (
          <span className="text-muted" style={{ fontSize: 11, marginLeft: 8 }}>
            {SOURCE_LABEL[data.source]} · last {data.days === 1 ? "24 hours" : `${data.days} days`}
          </span>
        )}
      </div>
      {isLoading && <p className="text-muted" style={{ fontSize: 12 }}>Loading…</p>}
      {error && <p className="text-muted" style={{ fontSize: 12 }}>{errorDetailText(error)}</p>}
      {data && charts.length === 0 && (
        <p className="text-muted" style={{ fontSize: 12 }}>No data in this range yet.</p>
      )}
      {data && (
        <div style={{ display: "grid", gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))" }}>
          {charts.map(c => {
            const rows = mergeSeries(Object.fromEntries(c.series.map(s => [s.key, data.series[s.key]])));
            const show = (v: number) => `${c.format(v)}${c.unit ?? ""}`;
            const stats = c.series.map(sd => ({ sd, st: seriesStats(data.series[sd.key]) }));
            const span = rows.length ? `${timeLabel(rows[0].ts)} – ${timeLabel(rows[rows.length - 1].ts)}` : "";
            return (
              <ChartFrame key={c.title} title={c.title} name={name}
                caption={`last ${data.days === 1 ? "24 hours" : `${data.days} days`}`}
                subtitle={[...known.map(([k, v]) => `${k} ${v}`), span, `a point every ${stepText(data.step)}`, SOURCE_LABEL[data.source]]
                  .filter(Boolean).join(" · ")}
                summary={stats.filter(x => x.st).map(({ sd, st }) => ({
                  label: sd.label, color: sd.color, now: show(st!.last), min: show(st!.min), avg: show(st!.avg),
                  p95: show(st!.p95), max: show(st!.max), maxAt: timeLabel(st!.maxTs),
                }))}
                values={stats.some(x => x.st) && (
                  <span title="The latest sample; open the chart for min, average and max">
                    <span style={{ color: "var(--gray-400)" }}>now </span>
                    {stats.map(({ sd, st }, i) => st && (
                      <span key={sd.key} style={{ color: "var(--gray-500)", marginLeft: i ? 8 : 0 }}>
                        {c.series.length > 1 && `${sd.label} `}
                        <strong style={{ color: sd.color }}>{show(st.last)}</strong>
                      </span>
                    ))}
                  </span>
                )}
                chart={(height, big) => (
                  <TimeChart data={rows} series={c.series} format={c.format} days={data.days}
                    syncId={big ? `${syncId}big` : syncId} max={c.max} height={height} />
                )} />
            );
          })}
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
