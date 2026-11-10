// Overcommit: the backend's host and cluster rows (backend/app/services/overcommit.py) as flat
// rows for one resource, CPU or memory, so the tables can sort them.

export type View = "cpu" | "memory";

export interface Alloc {
  physical: number; reserved: number; ratio: number | null; ratios?: number[];
  capacity: number; allocated: number; effective_ratio: number | null;
  alloc_pct: number | null; headroom: number;
}

export interface HostLoad {
  cpu_pct?: number; mem_pct?: number; swap_in_pps?: number; cpu_wait_pct?: number | null;
  cpu_wait_worst?: { id: string; name: string; pct: number } | null;
}

export interface Host {
  id: string; hostname: string; aggregates: string[]; state?: string; vms?: number;
  cpu: Alloc | null; memory: Alloc | null; load: HostLoad;
  cpu_verdict: { status: string; reason: string | null; suggested_ratio: number | null };
  mem_verdict: { status: string; reason: string | null };
}

export interface Cluster {
  id: number; name: string; kind?: string; hosts: number;
  cpu: Alloc | null; memory: Alloc | null;
  load: { cpu_pct: number | null; mem_pct: number | null; cpu_wait_pct: number | null };
  cpu_status: string; mem_status: string;
  cpu_counts: Record<string, number>; mem_counts: Record<string, number>;
}

export interface Data {
  hosts: Host[]; clusters: Cluster[];
  totals: { cpu: Alloc | null; memory: Alloc | null; cpu_counts: Record<string, number>; mem_counts: Record<string, number> };
  load: { source: string | null; hours: number; note: string | null };
  thresholds: Record<string, number>;
}

/** Each status: its label, badge, and what it means. Worst first, as the backend orders them. */
export const STATUS: Record<View, Record<string, { label: string; badge: string; help: string }>> = {
  cpu: {
    contended: { label: "Contended", badge: "badge-error", help: "More vCPUs than host CPUs in use, and VMs wait for CPU or the host is busy" },
    busy: { label: "Busy", badge: "badge-warn", help: "Busy, but not overcommitted: the ratio isn't the cause" },
    near_full: { label: "Nearly full", badge: "badge-warn", help: "Most of what the ratio allows is allocated" },
    room: { label: "Room to raise", badge: "badge-info", help: "Nearly full by the ratio, but load is low: the ratio could go up" },
    ok: { label: "OK", badge: "badge-ok", help: "" },
    unknown: { label: "No data", badge: "badge-neutral", help: "Placement has no inventory for this host" },
  },
  memory: {
    pressure: { label: "Pressure", badge: "badge-error", help: "Swapping, or more memory allocated than the host has and usage is high" },
    high: { label: "High usage", badge: "badge-warn", help: "Usage is high, without overcommit" },
    near_full: { label: "Nearly full", badge: "badge-warn", help: "Most of what the ratio allows is allocated" },
    ok: { label: "OK", badge: "badge-ok", help: "" },
    unknown: { label: "No data", badge: "badge-neutral", help: "Placement has no inventory for this host" },
  },
};

export interface Row {
  id: string; hostname: string; aggregates: string; vms: number | null;
  ratio: number | null; physical: number | null; reserved: number | null; allocated: number | null;
  capacity: number | null; effective: number | null; alloc_pct: number | null;
  /** Host CPU % or memory used %, p95. */
  load: number | null;
  /** CPU wait % (CPU) or pages swapped in per second (memory), p95. */
  pressure: number | null;
  worst: { id: string; name: string; pct: number } | null;
  status: string; reason: string | null; suggested: number | null;
  /** Position in STATUS, so sorting by status puts the worst first. */
  rank: number;
}

/** Memory is in MB from Placement; shown in GB. */
const scale = (view: View) => (view === "memory" ? 1 / 1024 : 1);

export function hostRows(hosts: Host[], view: View): Row[] {
  const order = Object.keys(STATUS[view]);
  const k = scale(view);
  return hosts.map(h => {
    const a = view === "cpu" ? h.cpu : h.memory;
    const v = view === "cpu" ? h.cpu_verdict : h.mem_verdict;
    return {
      id: h.id, hostname: h.hostname, aggregates: h.aggregates.join(", "), vms: h.vms ?? null,
      ratio: a?.ratio ?? null,
      physical: a ? a.physical * k : null, reserved: a ? a.reserved * k : null,
      allocated: a ? a.allocated * k : null, capacity: a ? a.capacity * k : null,
      effective: a?.effective_ratio ?? null, alloc_pct: a?.alloc_pct ?? null,
      load: (view === "cpu" ? h.load.cpu_pct : h.load.mem_pct) ?? null,
      pressure: (view === "cpu" ? h.load.cpu_wait_pct : h.load.swap_in_pps) ?? null,
      worst: view === "cpu" ? h.load.cpu_wait_worst ?? null : null,
      status: v.status, reason: v.reason,
      suggested: view === "cpu" ? h.cpu_verdict.suggested_ratio : null,
      rank: order.indexOf(v.status),
    };
  });
}

/** "2:1", or "1.5–2:1" when a cluster's hosts differ. */
export function ratioText(a: Pick<Alloc, "ratio" | "ratios"> | null | undefined): string {
  if (!a) return "—";
  if (a.ratio != null) return `${a.ratio}:1`;
  const r = a.ratios ?? [];
  return r.length ? `${r[0]}–${r[r.length - 1]}:1` : "—";
}

/** "3 contended · 1 nearly full", worst first, leaving out OK. */
export function countsText(counts: Record<string, number>, view: View): string {
  const parts = Object.keys(STATUS[view]).filter(s => s !== "ok" && counts[s])
    .map(s => `${counts[s]} ${STATUS[view][s].label.toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "All OK";
}

/** Hosts to show: all, or those with one status. */
export const filterRows = (rows: Row[], status: string) => (status ? rows.filter(r => r.status === status) : rows);

/** "the last 36 hours" / "7 days". */
export function windowText(hours: number): string {
  if (!hours) return "";
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
}
