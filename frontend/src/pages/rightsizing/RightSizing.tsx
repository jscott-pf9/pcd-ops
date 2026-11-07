import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Briefcase, ChevronRight } from "lucide-react";
import { apiFetch, errorDetail, noDataReason } from "../../api/client";
import { Metric } from "../../components/Metric";
import { pctColor } from "../../components/format";
import DataFreshness from "../../components/DataFreshness";
import { useTenants } from "../../api/tenants";
import { getSettings } from "../../api/settings";
import { CC, type Classification, FIT, isUpsize, pctText, type Rec } from "./model";

/** Classes the resize job can act on: down to a smaller flavor, or up to a bigger one. */
const RESIZE_CLASSES: [Classification, string][] = [
  ["overprovisioned", "Overprovisioned"], ["idle", "Idle"],
  ["cpu-pressure", "CPU pressure"], ["memory-pressure", "Memory pressure"],
];

const ATTENTION_CLASSES: Classification[] = ["memory-pressure", "cpu-pressure", "overprovisioned"];
const ALL_FILTERS = ["all", "attention", "memory-pressure", "cpu-pressure", "overprovisioned", "right-sized", "idle", "no-data"] as const;
type Filter = typeof ALL_FILTERS[number];

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RightSizing() {
  // The filter lives in the URL, so coming back from a VM's drill-down keeps it
  const [params, setParams] = useSearchParams();
  const filter = (ALL_FILTERS as readonly string[]).includes(params.get("class") ?? "")
    ? params.get("class") as Filter : "all";
  const setFilter = (f: Filter | ((cur: Filter) => Filter)) => {
    const next = typeof f === "function" ? f(filter) : f;
    setParams(p => { if (next === "all") p.delete("class"); else p.set("class", next); return p; }, { replace: true });
  };
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showJobModal, setShowJobModal] = useState(false);
  const tenants = useTenants();

  const { data: recs = [], isLoading, error } = useQuery<Rec[]>({
    queryKey: ["rightsizing"],
    queryFn: () => apiFetch("/rightsizing/recommendations"),
    retry: false,
  });
  const noData = noDataReason(error);

  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettings, staleTime: 60_000 });
  const aiDisabled = settings?.ai_rightsizing_enabled === false;

  const counts: Record<string, number> = { all: recs.length };
  for (const r of recs) counts[r.classification] = (counts[r.classification] ?? 0) + 1;

  const attention = recs.filter(r => ATTENTION_CLASSES.includes(r.classification));

  const filtered = filter === "all"       ? recs
                 : filter === "attention" ? attention
                 : recs.filter(r => r.classification === filter);

  const toggle = (id: string) =>
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div>
      {showJobModal && <ResizeJobModal onClose={() => setShowJobModal(false)} tenants={tenants} />}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Right-Sizing</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowJobModal(true)}
            style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Briefcase size={13} /> Create Resize Job
          </button>
          <DataFreshness domainKey="rightsizing:recommendations" slow />
        </div>
      </div>

      {aiDisabled && (
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          AI insights are disabled — VMs are classified from metrics only, with no narrative analysis.
        </div>
      )}

      {isLoading && !recs.length && <p className="text-muted">Collecting metrics…</p>}

      {noData && (
        <div className="empty">
          <div className="empty-title">{noData.failed ? "Right-sizing couldn't run" : "No right-sizing data yet"}</div>
          <div className="empty-body">
            {noData.failed
              ? <>The last run failed: <code>{noData.failed}</code></>
              : "It needs VM metrics from Grafana (Settings → Connection)."}
            {" "}Click Refresh to run it now; with AI insights on, this takes a while.
          </div>
        </div>
      )}
      {error && !noData && <p className="text-danger">{errorDetail(error)}</p>}
      {!isLoading && !error && recs.length === 0 && (
        <div className="empty"><div className="empty-title">No VMs found</div></div>
      )}

      {/* ── Summary row ── */}
      {recs.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "0.6rem", marginBottom: 14 }}>
          {(["memory-pressure","cpu-pressure","overprovisioned","right-sized","idle","no-data"] as Classification[]).map(cls => (
            <SummaryCard key={cls} cls={cls} count={counts[cls] ?? 0} total={recs.length}
              active={filter === cls}
              onClick={() => setFilter(f => f === cls ? "all" : cls as Filter)} />
          ))}
        </div>
      )}

      {/* ── Filter tabs ── */}
      {recs.length > 0 && (
        <div className="tabs" style={{ marginBottom: 12, overflowX: "auto" }}>
          <button className={`tab${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
            All <span style={{ color: "var(--gray-400)", fontSize: 11, marginLeft: 4 }}>{recs.length}</span>
          </button>
          {attention.length > 0 && (
            <button className={`tab${filter === "attention" ? " active" : ""}`}
              onClick={() => setFilter(f => f === "attention" ? "all" : "attention")}
              style={{ color: filter === "attention" ? "var(--red)" : "var(--red)", fontWeight: 600 }}>
              ⚠ Needs Attention <span style={{ fontSize: 11, marginLeft: 4 }}>{attention.length}</span>
            </button>
          )}
          {(["memory-pressure","cpu-pressure","overprovisioned","right-sized","idle","no-data"] as Classification[])
            .filter(c => (counts[c] ?? 0) > 0)
            .map(c => (
              <button key={c} className={`tab${filter === c ? " active" : ""}`} onClick={() => setFilter(f => f === c ? "all" : c)}>
                {CC[c].label}
                <span style={{ color: "var(--gray-400)", fontSize: 11, marginLeft: 4 }}>{counts[c] ?? 0}</span>
              </button>
            ))}
        </div>
      )}

      {/* ── Cards grid ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(360px, 100%), 1fr))", gap: "0.75rem" }}>
        {filtered.map(rec => {
          const cfg = CC[rec.classification];
          const isOpen = expanded.has(rec.server_id);
          const tenantName = tenants.get(rec.project_id) ?? rec.tenant_name ?? null;

          return (
            <div key={rec.server_id} className="card" style={{ borderLeft: `4px solid ${cfg.color}` }}>

              {/* Header */}
              <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid var(--gray-100)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <Link to={`/rightsizing/${rec.server_id}`} title="Details: why, projected use, alternatives, hosts"
                      style={{ display: "block", fontWeight: 600, fontSize: 13, color: "var(--gray-900)", marginBottom: 3 }}>
                      {rec.server_name}
                    </Link>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                        background: cfg.bg, color: cfg.color }}>
                        {cfg.label}
                      </span>
                      {rec.risk === "high" && <span className="badge badge-error" style={{ fontSize: 10 }}>High Risk</span>}
                      {rec.risk === "medium" && <span className="badge badge-warn" style={{ fontSize: 10 }}>Medium Risk</span>}
                      {tenantName && <span className="badge badge-neutral" style={{ fontSize: 10 }}>{tenantName}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: "var(--gray-500)", fontFamily: "var(--font-mono)" }}>
                      {rec.current_flavor.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--gray-400)" }}>
                      {rec.current_flavor.vcpus}v · {Math.round(rec.current_flavor.ram_mb / 1024)}GB
                    </div>
                    {rec.suggested_flavor && (() => {
                      const up = isUpsize(rec.current_flavor, rec.suggested_flavor);
                      const fit = rec.fit && FIT[rec.fit.status];
                      return (
                        <div style={{ fontSize: 10, marginTop: 2 }}
                          title={`Suggested flavor: ${rec.suggested_flavor.vcpus}v · ${Math.round(rec.suggested_flavor.ram_mb / 1024)}GB, the smallest that runs its average load with room to spare${rec.fit ? `. ${rec.fit.reason}` : ""}`}>
                          <span style={{ color: up ? "#B45309" : "var(--green)" }}>{up ? "↑" : "↓"} {rec.suggested_flavor.name}</span>
                          {fit && <div style={{ color: fit.color }}>{fit.label}</div>}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Metrics */}
              <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                <Metric
                  label="CPU"
                  avg={rec.cpu_avg_pct}
                  unit="%"
                  series={rec.cpu_series}
                  low={20} high={80}
                  color={pctColor(rec.cpu_avg_pct, 20, 80)}
                />
                <Metric
                  label="RAM"
                  avg={rec.mem_avg_pct}
                  unit="%"
                  series={rec.mem_series}
                  low={20} high={80}
                  color={pctColor(rec.mem_avg_pct, 20, 80)}
                />
                {(rec.stats?.cpu?.p95 != null || rec.stats?.mem?.p95 != null) && (
                  <div style={{ fontSize: 11, color: "var(--gray-500)" }}
                    title="95th percentile of hourly averages over the window: its busy hours, not its average">
                    Busiest hours (p95): CPU {pctText(rec.stats?.cpu?.p95)} · RAM {pctText(rec.stats?.mem?.p95)}
                  </div>
                )}
                {rec.io_series.length > 1 && (
                  <Metric
                    label="Disk IOPS"
                    avg={rec.io_avg_iops}
                    unit=" avg"
                    series={rec.io_series}
                    color="var(--purple)"
                  />
                )}
              </div>

              <Link to={`/rightsizing/${rec.server_id}`}
                style={{ display: "flex", alignItems: "center", gap: 3, padding: "6px 12px", fontSize: 12,
                  borderTop: "1px solid var(--gray-100)", color: "var(--blue-primary)", fontWeight: 500 }}>
                Details <ChevronRight size={13} />
              </Link>

              {/* AI insight */}
              {rec.analysis && (
                <div style={{ borderTop: "1px solid var(--gray-100)" }}>
                  <button onClick={() => toggle(rec.server_id)}
                    style={{ width: "100%", textAlign: "left", padding: "6px 12px",
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: 12, color: "var(--blue-primary)", fontWeight: 500,
                      display: "flex", alignItems: "center", gap: 5 }}>
                    <span>🤖</span>{isOpen ? "▲ Hide insight" : "▼ AI insight"}
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 12px 10px", fontSize: 12, color: "var(--gray-700)", lineHeight: 1.6 }}>
                      {rec.analysis}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SummaryCard({ cls, count, total, active, onClick }: {
  cls: Classification; count: number; total: number; active: boolean; onClick: () => void;
}) {
  const cfg = CC[cls];
  const pct = total > 0 ? Math.round(count / total * 100) : 0;
  return (
    <button onClick={onClick} style={{
      background: active ? cfg.bg : "#fff",
      border: `1px solid ${active ? cfg.color : "var(--gray-200)"}`,
      borderRadius: "var(--radius)", padding: "8px 10px",
      textAlign: "left", cursor: "pointer", transition: "all .12s",
      boxShadow: active ? `0 0 0 2px ${cfg.color}30` : "var(--shadow-sm)",
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em",
        color: "var(--gray-500)", marginBottom: 2 }}>{cfg.label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: cfg.color, lineHeight: 1 }}>{count}</span>
        <span style={{ fontSize: 11, color: "var(--gray-400)" }}>{pct}%</span>
      </div>
    </button>
  );
}

// ── Resize Job Modal ───────────────────────────────────────────────────────────

function ResizeJobModal({ onClose, tenants }: { onClose: () => void; tenants: Map<string, string> }) {
  const [name, setName] = useState("Right-Sizing Resize");
  const [classifications, setClassifications] = useState<string[]>(["overprovisioned", "idle"]);
  const [tenantId, setTenantId] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [schedule, setSchedule] = useState("");
  const [saved, setSaved] = useState(false);

  const tenantList = Array.from(tenants.entries()).sort((a, b) => a[1].localeCompare(b[1]));

  const toggleClass = (cls: string) =>
    setClassifications(cs => cs.includes(cls) ? cs.filter(c => c !== cls) : [...cs, cls]);

  const createMut = useMutation({
    mutationFn: () => apiFetch("/jobs/", {
      method: "POST",
      body: JSON.stringify({
        name,
        type: "rightsizing-resize",
        schedule: schedule || null,
        config: { classifications, tenant_id: tenantId || null, dry_run: dryRun },
      }),
    }),
    onSuccess: () => setSaved(true),
  });

  if (saved) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="card card-body" style={{ width: 400 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--green)" }}>✓ Job created</div>
          <p style={{ fontSize: 13, margin: "0 0 16px" }}>The resize job was saved. View and run it from the Jobs page.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
            <a href="/jobs" className="btn btn-primary" style={{ textDecoration: "none" }}>Go to Jobs</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card card-body" style={{ width: 440, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Create Resize Job</div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Job Name</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Target Classifications</label>
          <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
            {RESIZE_CLASSES.map(([cls, label]) => (
              <label key={cls} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={classifications.includes(cls)}
                  onChange={() => toggleClass(cls)} />
                {label}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--gray-500)", marginTop: 4 }}>
            A VM is skipped when no host in its cluster has room for its suggested flavor.
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Tenant (optional)</label>
          <select className="form-select" value={tenantId} onChange={e => setTenantId(e.target.value)}>
            <option value="">All tenants</option>
            {tenantList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Schedule (optional)</label>
          <input className="form-input" placeholder='e.g. daily@02:00 or weekly@03:00' value={schedule}
            onChange={e => setSchedule(e.target.value)} />
        </div>

        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>Dry Run</div>
              {!dryRun && (
                <div style={{ fontSize: 11, color: "var(--red)", marginTop: 2 }}>
                  ⚠ Live mode — VMs will actually be resized and rebooted
                </div>
              )}
              {dryRun && (
                <div style={{ fontSize: 11, color: "var(--gray-500)", marginTop: 2 }}>
                  Safe — shows what would be resized without making changes
                </div>
              )}
            </div>
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name || !classifications.length || createMut.isPending}
            onClick={() => createMut.mutate()}>
            {createMut.isPending ? "Creating…" : "Create Job"}
          </button>
        </div>
      </div>
    </div>
  );
}
