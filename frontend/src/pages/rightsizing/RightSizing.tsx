import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Briefcase } from "lucide-react";
import { apiFetch, errorDetail, noDataReason } from "../../api/client";
import { pctColor } from "../../components/format";
import DataFreshness from "../../components/DataFreshness";
import { useTenants } from "../../api/tenants";
import { getSettings } from "../../api/settings";
import { HeaderRow, useSort } from "../inventory/shared";
import {
  ATTENTION, CC, CLASS_RANK, CLASSES, type Classification, FIT, filterRecs, flavorText, isUpsize, pctText,
  type Rec,
} from "./model";

/** Classes the resize job can act on: down to a smaller flavor, or up to a bigger one. */
const RESIZE_CLASSES: [Classification, string][] = [
  ["overprovisioned", "Overprovisioned"], ["idle", "Idle"],
  ["cpu-pressure", "CPU pressure"], ["memory-pressure", "Memory pressure"],
];

const ALL_FILTERS = ["all", "attention", ...CLASSES] as const;
type Filter = typeof ALL_FILTERS[number];
const PAGE = 200;

const COLS: [string, string][] = [
  ["VM", "server_name"], ["Tenant", "tenant"], ["Class", "rank"], ["Flavor", "flavor"],
  ["Suggested", "suggested"], ["CPU avg", "cpu_avg_pct"], ["RAM avg", "mem_avg_pct"],
  ["Disk IOPS", "io_avg_iops"], ["Host", "hypervisor"],
];

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RightSizing() {
  // Filters live in the URL, so coming back from a VM's drill-down keeps them
  const [params, setParams] = useSearchParams();
  const filter = (ALL_FILTERS as readonly string[]).includes(params.get("class") ?? "")
    ? params.get("class") as Filter : "all";
  const tenant = params.get("tenant") ?? "";
  const q = params.get("q") ?? "";
  const setParam = (key: string, value: string, empty = "") =>
    setParams(p => { if (value === empty) p.delete(key); else p.set(key, value); return p; }, { replace: true });
  const setFilter = (f: Filter) => setParam("class", filter === f ? "all" : f, "all");
  const [showJobModal, setShowJobModal] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const tenants = useTenants();
  const navigate = useNavigate();

  const { data: recs = [], isLoading, error } = useQuery<Rec[]>({
    queryKey: ["rightsizing"],
    queryFn: () => apiFetch("/rightsizing/recommendations?series=false"),
    retry: false,
  });
  const noData = noDataReason(error);

  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettings, staleTime: 60_000 });
  const aiDisabled = settings?.ai_rightsizing_enabled === false;

  const counts: Record<string, number> = { all: recs.length };
  for (const r of recs) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  const attention = recs.filter(r => ATTENTION.includes(r.classification)).length;

  const tenantName = (r: Rec) => tenants.get(r.project_id) ?? r.tenant_name ?? r.project_id;
  const tenantList = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of recs) seen.set(r.project_id, tenants.get(r.project_id) ?? r.tenant_name ?? r.project_id);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [recs, tenants]);

  // Sortable rows: the derived columns become fields
  const rows = useMemo(() => filterRecs(recs, { cls: filter, tenant, q }).map(r => ({
    ...r, tenant: tenantName(r), rank: CLASS_RANK[r.classification], flavor: r.current_flavor.name,
    suggested: r.suggested_flavor?.name ?? "",
  })), [recs, filter, tenant, q, tenants]);
  const { sorted, sort, toggle } = useSort(rows);
  useEffect(() => setLimit(PAGE), [filter, tenant, q]);

  const open = (e: React.MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest("a")) return;
    if (e.ctrlKey || e.metaKey) window.open(`/rightsizing/${id}`, "_blank");
    else navigate(`/rightsizing/${id}`);
  };

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
          {CLASSES.map(cls => (
            <SummaryCard key={cls} cls={cls} count={counts[cls] ?? 0} total={recs.length}
              active={filter === cls} onClick={() => setFilter(cls)} />
          ))}
        </div>
      )}

      {/* ── Filter tabs ── */}
      {recs.length > 0 && (
        <div className="tabs" style={{ marginBottom: 12, overflowX: "auto" }}>
          <button className={`tab${filter === "all" ? " active" : ""}`} onClick={() => setParam("class", "all", "all")}>
            All <span style={{ color: "var(--gray-400)", fontSize: 11, marginLeft: 4 }}>{recs.length}</span>
          </button>
          {attention > 0 && (
            <button className={`tab${filter === "attention" ? " active" : ""}`}
              onClick={() => setFilter("attention")} style={{ color: "var(--red)", fontWeight: 600 }}>
              ⚠ Needs Attention <span style={{ fontSize: 11, marginLeft: 4 }}>{attention}</span>
            </button>
          )}
          {CLASSES.filter(c => (counts[c] ?? 0) > 0).map(c => (
            <button key={c} className={`tab${filter === c ? " active" : ""}`} onClick={() => setFilter(c)}>
              {CC[c].label}
              <span style={{ color: "var(--gray-400)", fontSize: 11, marginLeft: 4 }}>{counts[c] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Tenant and search ── */}
      {recs.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <select className="form-select" style={{ width: "auto", maxWidth: "100%" }} value={tenant}
            onChange={e => setParam("tenant", e.target.value)} aria-label="Tenant">
            <option value="">All tenants</option>
            {tenantList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <input className="form-input" style={{ width: 220, maxWidth: "100%" }} value={q}
            placeholder="Search VM, flavor or host…" onChange={e => setParam("q", e.target.value)} />
          <span className="text-muted" style={{ fontSize: 12, marginLeft: "auto" }}>
            {sorted.length === recs.length ? `${recs.length} VMs` : `${sorted.length} of ${recs.length} VMs`}
          </span>
        </div>
      )}

      {/* ── The list ── */}
      {recs.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><HeaderRow cols={COLS} sort={sort} toggle={toggle} /></thead>
            <tbody>
              {sorted.slice(0, limit).map(rec => <Row key={rec.server_id} rec={rec} tenant={rec.tenant}
                onClick={e => open(e, rec.server_id)} />)}
              {sorted.length === 0 && (
                <tr><td colSpan={COLS.length} className="text-muted" style={{ textAlign: "center", padding: 20 }}>
                  No VMs match these filters.
                </td></tr>
              )}
            </tbody>
          </table>
          {sorted.length > limit && (
            <div style={{ padding: 10, textAlign: "center" }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setLimit(l => l + PAGE)}>
                Show {Math.min(PAGE, sorted.length - limit)} more ({sorted.length - limit} not shown)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Row({ rec, tenant, onClick }: { rec: Rec; tenant: string; onClick: (e: React.MouseEvent) => void }) {
  const cfg = CC[rec.classification];
  const sug = rec.suggested_flavor;
  const fit = sug && rec.fit ? FIT[rec.fit.status] : null;
  const up = sug && isUpsize(rec.current_flavor, sug);
  const sub = { fontSize: 11, color: "var(--gray-500)" };
  return (
    <tr onClick={onClick} style={{ cursor: "pointer" }}>
      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
        <Link to={`/rightsizing/${rec.server_id}`} style={{ color: "var(--gray-900)" }}>{rec.server_name}</Link>
      </td>
      <td>{tenant}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: cfg.bg, color: cfg.color }}
          title={cfg.desc}>{cfg.label}</span>
        {rec.risk === "high" && <span className="badge badge-error" style={{ fontSize: 10, marginLeft: 4 }}>High Risk</span>}
        {rec.risk === "medium" && <span className="badge badge-warn" style={{ fontSize: 10, marginLeft: 4 }}>Medium Risk</span>}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{rec.current_flavor.name}</div>
        <div style={sub}>{flavorText(rec.current_flavor)}</div>
      </td>
      <td style={{ whiteSpace: "nowrap" }} title={sug && rec.fit ? rec.fit.reason : undefined}>
        {sug ? (
          <>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: up ? "#B45309" : "var(--green)" }}>
              {up ? "↑" : "↓"} {sug.name}
            </div>
            <div style={sub}>
              {flavorText(sug)}{fit && <span style={{ color: fit.color }}> · {fit.label}</span>}
            </div>
          </>
        ) : !rec.custom_flavor && <span className="text-muted">—</span>}
        {rec.custom_flavor && (
          <div style={{ fontSize: 11, color: "var(--blue-primary)" }}
            title={`A flavor shaped for it: ${rec.custom_flavor.reason}`}>
            ✱ custom {flavorText(rec.custom_flavor)}
          </div>
        )}
      </td>
      <Pct v={rec.cpu_avg_pct} p95={rec.stats?.cpu?.p95} />
      <Pct v={rec.mem_avg_pct} p95={rec.stats?.mem?.p95} cache={rec.mem_source === "pcd"} />
      <td style={{ whiteSpace: "nowrap" }}>{rec.io_avg_iops == null ? "—" : rec.io_avg_iops.toFixed(rec.io_avg_iops < 10 ? 1 : 0)}</td>
      <td style={{ whiteSpace: "nowrap", fontSize: 12 }}>{rec.hypervisor ?? "—"}</td>
    </tr>
  );
}

/** An average %, coloured against the thresholds, with its busiest hours (p95) underneath.
 *  `cache`: RAM from PCD's Grafana, which counts disk cache as used. */
function Pct({ v, p95, cache }: { v: number | null; p95?: number | null; cache?: boolean }) {
  return (
    <td style={{ whiteSpace: "nowrap" }}>
      <div style={{ fontWeight: 600, color: cache ? "var(--gray-500)" : pctColor(v, 20, 80) }}>{pctText(v)}</div>
      {cache && <div style={{ fontSize: 11, color: "var(--gray-400)" }}
        title="From PCD's Grafana, which counts the guest's disk cache as used; not treated as memory pressure">counts cache</div>}
      {p95 != null && <div style={{ fontSize: 11, color: "var(--gray-500)" }} title="Busiest hours: 95th percentile of hourly averages">
        p95 {pctText(p95)}</div>}
    </td>
  );
}

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
