import { apiFetch } from "./client";
import type { Point } from "../components/Metric";

/** Where host and VM metrics come from: PCD Ops' own store, or PCD's Grafana (14 days). */
export type MetricsSource = "local" | "pcd";

export const SOURCE_LABEL: Record<MetricsSource, string> = {
  local: "PCD Ops metrics store",
  pcd:   "PCD Grafana (14 days)",
};

export const RANGES = ["24h", "7d", "30d", "90d", "1y", "2y"] as const;
export type Range = typeof RANGES[number];
const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365, "2y": 730 };

/** The ranges a source keeps data for (always at least 24h). */
export function rangesWithin(retentionDays: number | null | undefined): Range[] {
  const keep = RANGES.filter(r => RANGE_DAYS[r] <= (retentionDays ?? 1));
  return keep.length ? keep : ["24h"];
}

/** Latest values for one hypervisor, merged into /inventory/hypervisors as `metrics`. */
export interface HostMetrics {
  cpu_pct?: number; cpu_cores?: number;
  mem_pct?: number; mem_total_bytes?: number; mem_used_bytes?: number;
  disk_pct?: number; disk_total_bytes?: number; disk_used_bytes?: number;
  disk_read_bps?: number; disk_write_bps?: number;
  net_rx_bps?: number; net_tx_bps?: number;
  exporters?: { node?: boolean; libvirt?: boolean };
  age_s?: number;
  stale?: boolean;
}

export interface History {
  source: MetricsSource; range: Range; days: number; step: string;
  series: Record<string, Point[]>;
}

export const getHostHistory = (id: string, range: Range) =>
  apiFetch<History>(`/metrics/hosts/${encodeURIComponent(id)}?range=${range}`);

export const getVmHistory = (id: string, range: Range) =>
  apiFetch<History>(`/metrics/vms/${encodeURIComponent(id)}?range=${range}`);

/** Capacity history of one Cinder backend (PCD Ops' metrics store only). */
export const getStorageHistory = (backend: string, range: Range) =>
  apiFetch<History>(`/metrics/storage/${encodeURIComponent(backend)}?range=${range}`);

export interface LocalTarget {
  job: "node" | "libvirt"; hypervisor: string; hypervisor_id: string; url: string;
  health: "up" | "down" | "unknown"; last_error: string | null; last_scrape: string | null;
}

export interface MetricsStatus {
  source: MetricsSource | null;
  retention_days: number | null;
  local: {
    available: boolean; enabled: boolean; running: boolean;
    retention_days: number; scrape_interval: string; keep_all_series: boolean;
    targets: LocalTarget[];
    disk: { used_bytes: number; free_bytes: number; total_bytes: number };
    series?: number;
    collecting_since?: number; bytes_per_day?: number; projected_bytes?: number;
    /** Set when applying a setting needed a restart that failed. */
    restart_error: string | null;
  };
}

export const getMetricsStatus = () => apiFetch<MetricsStatus>("/metrics/status");
