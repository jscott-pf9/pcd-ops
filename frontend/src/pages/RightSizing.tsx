import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { Briefcase } from "lucide-react";
import { apiFetch } from "../api/client";
import DataFreshness from "../components/DataFreshness";
import { useTenants } from "../api/tenants";

// ── Types ──────────────────────────────────────────────────────────────────────

type Classification = "memory-pressure" | "cpu-pressure" | "overprovisioned" | "right-sized" | "idle" | "no-data";

interface Rec {
  server_id: string;
  server_name: string;
  server_status: string;
  project_id: string;
  tenant_name: string | null;
  current_flavor:   { name: string; vcpus: number; ram_mb: number };
  suggested_flavor: { id: string; name: string; vcpus: number; ram_mb: number } | null;
  classification: Classification;
  risk: "high" | "medium" | "low" | "unknown";
  cpu_avg_pct: number | null;
  mem_avg_pct: number | null;
  io_avg_iops: number | null;
  cpu_series: { ts: number; v: number }[];
  mem_series: { ts: number; v: number }[];
  io_series:  { ts: number; v: number }[];
  analysis: string | null;
}

// ── Classification config ──────────────────────────────────────────────────────

const CC: Record<Classification, { label: string; color: string; bg: string; desc: string }> = {
  "memory-pressure": { label: "Memory Pressure", color: "var(--red)",        bg: "var(--red-light)",    desc: "RAM near capacity — risk of OOM" },
  "cpu-pressure":    { label: "CPU Pressure",    color: "#B45309",           bg: "#FEF3C7",             desc: "Hitting CPU ceiling — consider upsizing" },
  "overprovisioned": { label: "Overprovisioned", color: "var(--yellow)",     bg: "var(--yellow-light)", desc: "Low CPU & RAM — candidate for downsizing" },
  "right-sized":     { label: "Right-Sized",     color: "var(--green)",      bg: "var(--green-light)",  desc: "CPU & RAM within expected range" },
  "idle":            { label: "Idle",             color: "var(--gray-500)",   bg: "var(--gray-100)",     desc: "No measurable CPU, RAM, or disk activity" },
  "no-data":         { label: "No Metrics",       color: "var(--gray-400)",   bg: "var(--gray-50)",      desc: "VM offline or not scraped" },
};

const ATTENTION_CLASSES: Classification[] = ["memory-pressure", "cpu-pressure", "overprovisioned"];
const ALL_FILTERS = ["all", "attention", "memory-pressure", "cpu-pressure", "overprovisioned", "right-sized", "idle", "no-data"] as const;
type Filter = typeof ALL_FILTERS[number];

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RightSizing() {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showJobModal, setShowJobModal] = useState(false);
  const tenants = useTenants();

  const { data: recs = [], isLoading } = useQuery<Rec[]>({
    queryKey: ["rightsizing"],
    queryFn: () => apiFetch("/rightsizing/recommendations"),
  });

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

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Right-Sizing</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowJobModal(true)}
            style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Briefcase size={13} /> Create Resize Job
          </button>
          <DataFreshness domainKey="rightsizing:recommendations" slow />
        </div>
      </div>

      {isLoading && !recs.length && <p className="text-muted">Collecting metrics…</p>}

      {/* ── Summary row ── */}
      {recs.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "0.6rem", marginBottom: 14 }}>
          {(["memory-pressure","cpu-pressure","overprovisioned","right-sized","idle","no-data"] as Classification[]).map(cls => (
            <SummaryCard key={cls} cls={cls} count={counts[cls] ?? 0} total={recs.length}
              active={filter === cls}
              onClick={() => setFilter(f => f === cls ? "all" : cls as Filter)} />
          ))}
        </div>
      )}

      {/* ── Filter tabs ── */}
      {recs.length > 0 && (
        <div className="tabs" style={{ marginBottom: 12 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: "0.75rem" }}>
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
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-900)", marginBottom: 3 }}>
                      {rec.server_name}
                    </div>
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
                    {rec.suggested_flavor && (
                      <div style={{ fontSize: 10, color: "var(--green)", marginTop: 2 }}>
                        → {rec.suggested_flavor.name}
                      </div>
                    )}
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function pctColor(v: number | null, low: number, high: number): string {
  if (v === null) return "var(--gray-300)";
  if (v >= high)  return "var(--red)";
  if (v < low)    return "var(--yellow)";
  return "var(--green)";
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

function Metric({ label, avg, unit, series, color, low, high: _high }: {
  label: string; avg: number | null; unit: string;
  series: { ts: number; v: number }[]; color: string;
  low?: number; high?: number;
}) {
  const hasData = series.length > 1;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--gray-500)" }}>
          {label}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color }}>
          {avg !== null ? `${avg.toFixed(1)}${unit}` : "—"}
        </span>
      </div>
      {/* Gauge bar */}
      {avg !== null && low !== undefined && (
        <div style={{ height: 5, background: "var(--gray-100)", borderRadius: 3, overflow: "hidden", marginBottom: 3 }}>
          <div style={{ height: "100%", width: `${Math.min(100, avg)}%`, background: color, borderRadius: 3,
            transition: "width .3s" }} />
        </div>
      )}
      {/* Sparkline */}
      {hasData ? (
        <Sparkline data={series} color={color} />
      ) : (
        <div style={{ height: 28, background: "var(--gray-50)", borderRadius: 3,
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 10, color: "var(--gray-400)" }}>no history</span>
        </div>
      )}
    </div>
  );
}

function Sparkline({ data, color }: { data: { ts: number; v: number }[]; color: string }) {
  const id = color.replace(/[^a-z0-9]/gi, "");
  return (
    <ResponsiveContainer width="100%" height={32}>
      <AreaChart data={data} margin={{ top: 1, right: 0, left: 0, bottom: 1 }}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.2} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip contentStyle={{ fontSize: 11, padding: "2px 6px", borderRadius: 4,
            border: "1px solid var(--gray-200)" }}
          formatter={(v: number) => [v.toFixed(1), ""]} labelFormatter={() => ""} />
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#g${id})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
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
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            {["overprovisioned", "idle"].map(cls => (
              <label key={cls} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={classifications.includes(cls)}
                  onChange={() => toggleClass(cls)} />
                {cls.charAt(0).toUpperCase() + cls.slice(1)}
              </label>
            ))}
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
