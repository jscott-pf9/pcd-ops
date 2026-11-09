// Right-sizing: recommendation types, class and fit labels, and formatting for the list and
// the per-VM drill-down.

export type Classification = "memory-pressure" | "cpu-pressure" | "overprovisioned" | "right-sized" | "idle" | "no-data";
export type FitStatus = "fits" | "same_host" | "no_room" | "unknown";

export interface Flavor {
  id?: string; name: string; vcpus: number; ram_mb: number; disk_gb?: number; ephemeral_gb?: number;
  /** Current flavor only: boots from a local disk, so a resize can't shrink it. */
  image_backed?: boolean;
}
export interface Fit { status: FitStatus; hosts: string[]; reason: string }
/** A flavor shaped for the VM when the catalog has no good match; not created yet. */
export interface CustomFlavor extends Flavor { swap_mb: number; extra_specs: Record<string, string>; reason: string }
export interface Point { ts: number; v: number }
/** avg, 95th percentile and peak over the window (hourly averages); hours_high_pct is the
 *  share of hours at or above the pressure threshold. */
export interface Stat { avg?: number | null; p95?: number | null; peak?: number | null; hours_high_pct?: number | null }

export interface Rec {
  server_id: string;
  server_name: string;
  server_status: string;
  project_id: string;
  tenant_name: string | null;
  hypervisor?: string | null;
  hypervisor_id?: string | null;
  current_flavor: Flavor;
  suggested_flavor: Flavor | null;
  custom_flavor?: CustomFlavor | null;
  /** Whether a host in its cluster has room for the suggested flavor now. */
  fit?: Fit;
  classification: Classification;
  risk: "high" | "medium" | "low" | "unknown";
  cpu_avg_pct: number | null;
  mem_avg_pct: number | null;
  io_avg_iops: number | null;
  cpu_series: Point[];
  mem_series: Point[];
  io_series: Point[];
  stats?: { cpu?: Stat; mem?: Stat; io?: Stat };
  window_days?: number;
  source?: string;
  /** Where RAM came from: "local" is what the guest uses; "pcd" (PCD's Grafana) counts its
   *  disk cache as used, so it isn't called memory pressure on its own. */
  mem_source?: string | null;
  mem_window_days?: number;
  analysis: string | null;
}

export interface Projection { avg: number | null; p95: number | null; peak: number | null }
export interface Projected { cpu: Projection; mem: Projection; warnings: string[] }

export interface HostRoom {
  id: string; hostname: string; current: boolean;
  cpu_free: number | null; mem_free_mb: number | null; fits: boolean; why: string | null;
}

export interface Detail extends Rec {
  collected_at: string | null;
  reasons: string[];
  basis: { direction: "up" | "down"; vcpus: number; ram_mb: number; rule: string } | null;
  projected: Projected | null;
  alternatives: { flavor: Flavor; projected: Projected; fit: Fit }[];
  custom: (CustomFlavor & { projected: Projected; fit: Fit }) | null;
  hosts: HostRoom[];
  thresholds: { cpu_low: number; cpu_high: number; mem_low: number; mem_high: number; risk_high: number; busy_warn: number };
}

export const CC: Record<Classification, { label: string; color: string; bg: string; desc: string }> = {
  "memory-pressure": { label: "Memory Pressure", color: "var(--red)",        bg: "var(--red-light)",    desc: "RAM near capacity — risk of OOM" },
  "cpu-pressure":    { label: "CPU Pressure",    color: "#B45309",           bg: "#FEF3C7",             desc: "Hitting CPU ceiling — consider upsizing" },
  "overprovisioned": { label: "Overprovisioned", color: "var(--yellow)",     bg: "var(--yellow-light)", desc: "Low CPU & RAM — candidate for downsizing" },
  "right-sized":     { label: "Right-Sized",     color: "var(--green)",      bg: "var(--green-light)",  desc: "CPU & RAM within expected range" },
  "idle":            { label: "Idle",             color: "var(--gray-500)",   bg: "var(--gray-100)",     desc: "No measurable CPU, RAM, or disk activity" },
  "no-data":         { label: "No Metrics",       color: "var(--gray-400)",   bg: "var(--gray-50)",      desc: "VM offline or not scraped" },
};

export const FIT: Record<FitStatus, { label: string; color: string }> = {
  fits:      { label: "fits",            color: "var(--green)" },
  same_host: { label: "same host only",  color: "var(--yellow)" },
  no_room:   { label: "no room",         color: "var(--red)" },
  unknown:   { label: "fit unknown",     color: "var(--gray-400)" },
};

export const CLASSES: Classification[] = ["memory-pressure", "cpu-pressure", "overprovisioned", "right-sized", "idle", "no-data"];

/** 8192 → "8 GB", 1536 → "1.5 GB". */
export function ramText(mb: number | null | undefined): string {
  if (mb == null) return "—";
  const gb = mb / 1024;
  return `${Number.isInteger(gb) || gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/** "4 vCPUs · 8 GB". */
export function flavorText(f: Pick<Flavor, "vcpus" | "ram_mb">): string {
  return `${f.vcpus} vCPU${f.vcpus === 1 ? "" : "s"} · ${ramText(f.ram_mb)}`;
}

/** Up when the suggestion is bigger in either resource. */
export function isUpsize(cur: Flavor, sug: Flavor): boolean {
  return sug.vcpus > cur.vcpus || sug.ram_mb > cur.ram_mb;
}

/** A % for a table: one decimal under 10, none above; over 100 % reads "100 %+". */
export function pctText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v > 100) return "100%+";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

/** Colour for a projected %: red at or above `warn`, yellow from the pressure threshold. */
export function projColor(v: number | null | undefined, high: number, warn: number): string {
  if (v == null) return "var(--gray-400)";
  if (v >= warn) return "var(--red)";
  if (v >= high) return "#B45309";
  return "var(--gray-900)";
}

/** "the last 30 days" for the window a run looked at. */
export function windowText(days: number | null | undefined): string {
  return days ? `the last ${days} day${days === 1 ? "" : "s"}` : "the window";
}

// ── The list ──────────────────────────────────────────────────────────────────

/** The classes that need action, worst first; the list's default order follows CLASS_RANK. */
export const ATTENTION: Classification[] = ["memory-pressure", "cpu-pressure", "overprovisioned"];
export const CLASS_RANK: Record<Classification, number> = {
  "memory-pressure": 0, "cpu-pressure": 1, "overprovisioned": 2, "idle": 3, "right-sized": 4, "no-data": 5,
};

export interface ListFilter { cls: string; tenant: string; q: string }

/** Recommendations matching the class tab ("all", "attention" or a class), the tenant and the
 *  search (VM name, flavor, suggested flavor or host), worst class first, then by name. */
export function filterRecs(recs: Rec[], f: ListFilter): Rec[] {
  const q = f.q.trim().toLowerCase();
  return recs
    .filter(r => f.cls === "all" || (f.cls === "attention" ? ATTENTION.includes(r.classification) : r.classification === f.cls))
    .filter(r => !f.tenant || r.project_id === f.tenant)
    .filter(r => !q || [r.server_name, r.current_flavor?.name, r.suggested_flavor?.name, r.hypervisor]
      .some(v => (v ?? "").toLowerCase().includes(q)))
    .sort((a, b) => CLASS_RANK[a.classification] - CLASS_RANK[b.classification]
      || a.server_name.localeCompare(b.server_name, undefined, { numeric: true }));
}
