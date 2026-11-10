import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorDetail } from "../../api/client";
import DataFreshness from "../../components/DataFreshness";
import { ItemLink } from "../../components/DetailPage";
import { formatPct, pctColor } from "../../components/format";
import { detailPath } from "../inventory/kinds";
import { HeaderRow, PctBar, StatCard, muted, useSort } from "../inventory/shared";
import {
  type Cluster, countsText, type Data, filterRows, hostRows, ratioText, type Row, STATUS, type View,
  windowText,
} from "./model";

const UNIT: Record<View, string> = { cpu: "vCPUs", memory: "GB" };
const EFFECTIVE: Record<View, string> = { cpu: "vCPUs per CPU", memory: "GB per GB" };
/** A host's worst VM is named when it waits at least this much (%). */
const WORST_SHOWN = 1;
const num = (v: number | null, digits = 0) => (v == null ? "—" : v.toFixed(digits));

/** CPU and memory overcommit: what Placement lets Nova allocate on each host against what the
 *  host really does. View (CPU or memory) and status filter live in the URL. */
export default function Overcommit() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "memory" ? "memory" : "cpu";
  const status = params.get("status") ?? "";
  const set = (changes: Record<string, string>) => setParams(p => {
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    return p;
  }, { replace: true });

  const { data, isLoading, error } = useQuery({
    queryKey: ["capacity", "overcommit"], queryFn: () => apiFetch<Data>("/capacity/overcommit"),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>Overcommit</h1>
        <DataFreshness domainKey="capacity:overcommit" />
      </div>
      <p className="text-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        What Placement lets Nova allocate on each host (host CPUs or memory, minus reserved, times the
        allocation ratio) against how loaded the host really is.
        {data?.load.hours ? ` Load is the 95th percentile over ${windowText(data.load.hours)}` +
          ` from ${data.load.source === "local" ? "PCD Ops' metrics store" : "PCD's Grafana"}.` : ""}
      </p>

      {isLoading && <p className="text-muted">Waiting for the first collection…</p>}
      {error && !data && <p className="text-muted">{errorDetail(error)}</p>}
      {data && <Body data={data} view={view} status={status} set={set} />}
    </div>
  );
}

function Body({ data, view, status, set }: {
  data: Data; view: View; status: string; set: (c: Record<string, string>) => void;
}) {
  const rows = useMemo(() => hostRows(data.hosts, view), [data, view]);
  const shown = filterRows(rows, status);
  const t = data.totals;
  const cpuTotal = t.cpu, memTotal = t.memory;
  const counts = view === "cpu" ? t.cpu_counts : t.mem_counts;

  return (
    <>
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <StatCard label="vCPUs per host CPU" value={cpuTotal?.effective_ratio != null ? `${cpuTotal.effective_ratio}` : "—"}
          sub={cpuTotal ? `${cpuTotal.allocated} of ${cpuTotal.capacity} allowed (${ratioText(cpuTotal)})` : "No Placement data"}
          accent="var(--blue-primary)" />
        <StatCard label="Memory allocated" value={memTotal?.alloc_pct != null ? formatPct(memTotal.alloc_pct) : "—"}
          sub={memTotal ? `${Math.round(memTotal.allocated / 1024)} of ${Math.round(memTotal.capacity / 1024)} GB allowed (${ratioText(memTotal)})` : "No Placement data"}
          accent="var(--purple)" />
        <StatCard label="CPU" value={String(t.cpu_counts.contended ?? 0)} sub={`contended · ${t.cpu_counts.room ?? 0} with room to raise the ratio`}
          accent={(t.cpu_counts.contended ?? 0) ? "var(--red)" : "var(--green)"} />
        <StatCard label="Memory" value={String(t.mem_counts.pressure ?? 0)} sub={`under pressure · ${t.mem_counts.near_full ?? 0} nearly full`}
          accent={(t.mem_counts.pressure ?? 0) ? "var(--red)" : "var(--green)"} />
      </div>

      {data.load.note && (
        <div className="card" style={{ borderLeft: "3px solid var(--yellow)", marginBottom: "1rem" }}>
          <div className="card-body" style={{ fontSize: 13 }}>{data.load.note}</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div className="tabs" style={{ marginBottom: 0, flex: 1 }}>
          {(["cpu", "memory"] as View[]).map(v => (
            <button key={v} className={`tab${view === v ? " active" : ""}`}
              onClick={() => set({ view: v === "cpu" ? "" : v, status: "" })}>
              {v === "cpu" ? "CPU" : "Memory"}
            </button>
          ))}
        </div>
        <select className="input" style={{ width: "auto" }} value={status} onChange={e => set({ status: e.target.value })}>
          <option value="">All hosts ({rows.length})</option>
          {Object.entries(STATUS[view]).filter(([s]) => counts[s]).map(([s, m]) => (
            <option key={s} value={s}>{m.label} ({counts[s]})</option>
          ))}
        </select>
      </div>

      {data.clusters.length > 0 && <Clusters clusters={data.clusters} view={view} />}
      <Hosts rows={shown} view={view} total={rows.length} />
      <Legend view={view} thresholds={data.thresholds} />
    </>
  );
}

function StatusBadge({ view, status, title }: { view: View; status: string; title?: string | null }) {
  const m = STATUS[view][status] ?? { label: status, badge: "badge-neutral", help: "" };
  return <span className={`badge ${m.badge}`} title={title || m.help || undefined}>{m.label}</span>;
}

/** "27 of 32" over a bar of the share allocated. */
function AllocCell({ used, cap, pct, digits = 0 }: { used: number; cap: number; pct: number | null; digits?: number }) {
  const color = pctColor(pct, 0, 95);
  return (
    <div title={pct == null ? undefined : `${formatPct(pct)} of what the ratio allows`} style={{ minWidth: 110 }}>
      <div style={{ fontSize: 12, whiteSpace: "nowrap" }}>
        <strong>{num(used, digits)}</strong> <span className="text-muted">of {num(cap, digits)}</span>
        <span style={{ color, fontWeight: 600, fontSize: 11, marginLeft: 6 }}>{formatPct(pct)}</span>
      </div>
      <div style={{ height: 4, background: "var(--gray-100)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct ?? 0)}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
}

function Clusters({ clusters, view }: { clusters: Cluster[]; view: View }) {
  const k = view === "memory" ? 1 / 1024 : 1;
  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div className="card-header"><span className="card-title">Clusters &amp; aggregates</span></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cluster</th><th style={{ textAlign: "right" }}>Hosts</th><th>Ratio</th>
              <th>Allocated ({UNIT[view]}) of allowed</th>
              <th style={{ textAlign: "right" }}>{EFFECTIVE[view]}</th>
              <th>{view === "cpu" ? "CPU (p95)" : "Used (p95)"}</th>
              {view === "cpu" && <th style={{ textAlign: "right" }}>CPU wait</th>}
              <th>Hosts</th>
            </tr>
          </thead>
          <tbody>
            {clusters.map(c => {
              const a = view === "cpu" ? c.cpu : c.memory;
              return (
                <tr key={c.id}>
                  <td><ItemLink to={detailPath("clusters", c.id)}><strong>{c.name}</strong></ItemLink></td>
                  <td style={{ textAlign: "right" }}>{c.hosts}</td>
                  <td>{ratioText(a)}</td>
                  <td>{a ? <AllocCell used={a.allocated * k} cap={a.capacity * k} pct={a.alloc_pct} /> : "—"}</td>
                  <td style={{ textAlign: "right" }}>{a?.effective_ratio ?? "—"}</td>
                  <td><PctBar v={view === "cpu" ? c.load.cpu_pct : c.load.mem_pct} /></td>
                  {view === "cpu" && <td style={{ textAlign: "right" }}>{formatPct(c.load.cpu_wait_pct)}</td>}
                  <td>
                    <StatusBadge view={view} status={view === "cpu" ? c.cpu_status : c.mem_status} />{" "}
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      {countsText(view === "cpu" ? c.cpu_counts : c.mem_counts, view)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Hosts({ rows, view, total }: { rows: Row[]; view: View; total: number }) {
  const { sorted, sort, toggle } = useSort(rows);
  const cols: [string, string][] = [
    ["Host", "hostname"], ["Cluster", "aggregates"], ["VMs", "vms"],
    [view === "cpu" ? "Host CPUs" : "Host GB", "physical"], ["Ratio", "ratio"],
    [`Allocated (${UNIT[view]}) of allowed`, "alloc_pct"], [EFFECTIVE[view], "effective"],
    [view === "cpu" ? "CPU (p95)" : "Used (p95)", "load"],
    [view === "cpu" ? "CPU wait (p95)" : "Swap-in (p95)", "pressure"], ["Status", "rank"],
  ];
  const digits = view === "memory" ? 1 : 0;
  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div className="card-header">
        <span className="card-title">Hosts</span>
        {rows.length !== total && <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>{rows.length} of {total}</span>}
      </div>
      {rows.length === 0
        ? <div className="card-body"><p className="text-muted" style={{ margin: 0 }}>No hosts.</p></div>
        : (
          <div className="table-wrap">
            <table>
              <thead><HeaderRow cols={cols} sort={sort} toggle={toggle} /></thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.id}>
                    <td><ItemLink to={detailPath("hypervisors", r.id)}><strong>{r.hostname}</strong></ItemLink></td>
                    <td>{r.aggregates || muted()}</td>
                    <td style={{ textAlign: "right" }}>{r.vms ?? "—"}</td>
                    <td style={{ textAlign: "right" }} title={r.reserved ? `${num(r.reserved, digits)} reserved for the host` : undefined}>
                      {num(r.physical, digits)}
                      {!!r.reserved && <div className="text-muted" style={{ fontSize: 11 }}>−{num(r.reserved, digits)} reserved</div>}
                    </td>
                    <td>{r.ratio != null ? `${r.ratio}:1` : "—"}</td>
                    <td>{r.allocated != null ? <AllocCell used={r.allocated} cap={r.capacity ?? 0} pct={r.alloc_pct} digits={digits} /> : muted()}</td>
                    <td style={{ textAlign: "right", fontWeight: (r.effective ?? 0) > 1 ? 600 : undefined }}>{r.effective ?? "—"}</td>
                    <td><PctBar v={r.load} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {view === "cpu"
                        ? <>
                            {formatPct(r.pressure)}
                            {r.worst && r.worst.pct >= WORST_SHOWN && r.worst.pct > (r.pressure ?? 0) && (
                              <div style={{ fontSize: 11 }} className="text-muted">
                                worst <ItemLink to={detailPath("servers", r.worst.id)}>{r.worst.name}</ItemLink> {formatPct(r.worst.pct)}
                              </div>)}
                          </>
                        : r.pressure == null ? muted() : `${num(r.pressure, 1)} pages/s`}
                    </td>
                    <td style={{ minWidth: 160, maxWidth: 280 }}>
                      <StatusBadge view={view} status={r.status} />
                      {r.reason && <div style={{ fontSize: 11, marginTop: 2 }} className="text-muted">{r.reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function Legend({ view, thresholds: th }: { view: View; thresholds: Record<string, number> }) {
  const items: [string, string][] = view === "cpu"
    ? [
        ["Contended", `more vCPUs allocated than host CPUs, and VMs wait ≥ ${th.cpu_wait_high}% of the time for a CPU or the host is ≥ ${th.cpu_busy_high}% busy`],
        ["Busy", "the same load without overcommit, so a lower ratio wouldn't help"],
        ["Nearly full", `≥ ${th.near_full}% of what the ratio allows is allocated`],
        ["Room to raise", `nearly full, but the host is under ${th.cpu_room_load}% busy: the suggested ratio keeps it near ${th.cpu_target}% if load grows with the vCPUs (an estimate)`],
      ]
    : [
        ["Pressure", `swapping in ≥ ${th.swap_in_pps} pages/s, or more memory allocated than the host has and ≥ ${th.mem_high}% used`],
        ["High usage", `≥ ${th.mem_high}% used without overcommit`],
        ["Nearly full", `≥ ${th.near_full}% of what the ratio allows is allocated`],
      ];
  return (
    <div className="text-muted" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
      {items.map(([k, v]) => <div key={k}><strong>{k}:</strong> {v}.</div>)}
      {view === "cpu" && <div><strong>CPU wait:</strong> time a VM's vCPUs were ready to run but had no host CPU (steal), averaged over the host's VMs by their vCPUs.</div>}
    </div>
  );
}

