import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Trash2, Plus, ChevronDown, ChevronUp, Clock, CheckCircle, XCircle, Loader, Pencil, ExternalLink, X } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Job {
  id: number;
  name: string;
  type: string;
  schedule: string | null;
  config: Record<string, any>;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  is_due: boolean;
  created_at: string;
}

interface JobRun {
  id: number;
  job_id: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  result: string | null;
  error: string | null;
}

interface JobTypeSchema {
  label: string;
  description: string;
  config_schema: Record<string, { type: string; default: any; label: string; options?: string[] }>;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, string> = {
  "snapshot-cleanup":     "📸",
  "snapshot-create":      "🗂️",
  "snapshot-rotate":      "🔄",
  "resource-reclamation": "♻️",
  "capacity-report":      "📊",
  "rightsizing-resize":   "⚡",
};

const INTERVALS = ["", "hourly", "daily", "weekly", "monthly"] as const;
const INTERVAL_LABELS: Record<string, string> = {
  "": "On demand only", hourly: "Every hour",
  daily: "Daily", weekly: "Weekly", monthly: "Monthly",
};
// Intervals that support a time-of-day
const TIMED_INTERVALS = new Set(["daily", "weekly", "monthly"]);

/** Parse "daily@09:00" → {interval:"daily", time:"09:00"} */
function parseSchedule(s: string | null): { interval: string; time: string } {
  if (!s) return { interval: "", time: "09:00" };
  const [interval, time = ""] = s.split("@");
  return { interval, time: time || "09:00" };
}

/** Build schedule string from parts */
function buildSchedule(interval: string, time: string): string | null {
  if (!interval) return null;
  if (TIMED_INTERVALS.has(interval) && time) return `${interval}@${time}`;
  return interval;
}

/** Human-readable label for a schedule string */
function scheduleLabel(s: string | null): string {
  if (!s) return "On demand";
  const { interval, time } = parseSchedule(s);
  const base = INTERVAL_LABELS[interval] ?? interval;
  return TIMED_INTERVALS.has(interval) ? `${base} at ${time} UTC` : base;
}

/** Relative time from now */
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso + "Z").getTime() - Date.now();
  if (Math.abs(ms) < 60_000) return "now";
  const mins = Math.round(ms / 60_000);
  if (Math.abs(mins) < 60) return mins > 0 ? `in ${mins}m` : `${-mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 24) return hrs > 0 ? `in ${hrs}h` : `${-hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days > 0 ? `in ${days}d` : `${-days}d ago`;
}

function statusBadge(status: string | null) {
  if (!status) return null;
  const map: Record<string, [string, string]> = {
    success: ["badge-ok",      "✓ Success"],
    error:   ["badge-error",   "✗ Error"],
    running: ["badge-pending", "⟳ Running"],
  };
  const [cls, label] = map[status] ?? ["badge-neutral", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Jobs() {
  const qc = useQueryClient();
  const tenants = useTenants();
  const [showCreate, setShowCreate] = useState(false);

  const { data: jobs = [], isLoading } = useQuery<Job[]>({
    queryKey: ["jobs"],
    queryFn: () => apiFetch("/jobs/"),
    refetchInterval: 8000,
  });

  const { data: types = {} } = useQuery<Record<string, JobTypeSchema>>({
    queryKey: ["job-types"],
    queryFn: () => apiFetch("/jobs/types"),
    staleTime: Infinity,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const runMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/jobs/${id}/run`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/jobs/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Jobs</h1>
        <button className="btn btn-primary btn-sm"
          onClick={() => setShowCreate(s => !s)}
          style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Plus size={13} /> New Job
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateJobForm types={types} tenants={tenants}
          onCreated={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ["jobs"] }); }} />
      )}

      {/* Jobs list */}
      {isLoading && !jobs.length && <p className="text-muted">Loading jobs…</p>}
      {!isLoading && jobs.length === 0 && !showCreate && (
        <div className="empty">
          <div className="empty-title">No jobs yet</div>
          <div className="empty-body">Create a job to automate snapshot cleanup, resource reclamation, or capacity reports.</div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {jobs.map(job => (
          <JobCard key={job.id} job={job} typeMeta={types[job.type]}
            onDelete={() => deleteMut.mutate(job.id)}
            onRun={() => runMut.mutate(job.id)}
            onToggle={(enabled) => toggleMut.mutate({ id: job.id, enabled })}
            isRunning={runMut.isPending && runMut.variables === job.id} />
        ))}
      </div>
    </div>
  );
}

// ── Create form ────────────────────────────────────────────────────────────────

function CreateJobForm({ types, tenants, onCreated }: {
  types: Record<string, JobTypeSchema>;
  tenants: Map<string, string>;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState(Object.keys(types)[0] ?? "snapshot-cleanup");
  const [interval, setInterval] = useState("");
  const [schedTime, setSchedTime] = useState("09:00");
  const [config, setConfig] = useState<Record<string, any>>({});

  const schema = types[type]?.config_schema ?? {};
  const builtSchedule = buildSchedule(interval, schedTime);

  // Preview next run
  const preview = (() => {
    if (!interval) return null;
    // Simple frontend preview using the same logic
    if (interval === "hourly") return "Runs every hour";
    const now = new Date();
    const [h, m] = schedTime.split(":").map(Number);
    const candidate = new Date(now);
    candidate.setUTCHours(h, m, 0, 0);
    if (candidate <= now) {
      if (interval === "daily")   candidate.setUTCDate(candidate.getUTCDate() + 1);
      if (interval === "weekly")  candidate.setUTCDate(candidate.getUTCDate() + 7);
      if (interval === "monthly") candidate.setUTCMonth(candidate.getUTCMonth() + 1);
    }
    return `Next run: ${candidate.toLocaleString()} (local)`;
  })();

  const handleTypeChange = (t: string) => {
    setType(t);
    const defaults: Record<string, any> = {};
    for (const [k, v] of Object.entries(types[t]?.config_schema ?? {})) {
      defaults[k] = v.default;
    }
    setConfig(defaults);
  };

  const createMut = useMutation({
    mutationFn: () => apiFetch("/jobs/", {
      method: "POST",
      body: JSON.stringify({ name, type, schedule: builtSchedule, config }),
    }),
    onSuccess: onCreated,
  });

  return (
    <div className="card card-body" style={{ marginBottom: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: 12 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Job Name</label>
          <input className="form-input" placeholder="e.g. Weekly snapshot cleanup"
            value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Type</label>
          <select className="form-select" value={type} onChange={e => handleTypeChange(e.target.value)}>
            {Object.entries(types).map(([k, v]) => (
              <option key={k} value={k}>{TYPE_ICONS[k]} {v.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Schedule row */}
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", marginBottom: 12 }}>
        <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
          <label className="form-label">Frequency</label>
          <select className="form-select" value={interval} onChange={e => setInterval(e.target.value)}>
            {INTERVALS.map(s => <option key={s} value={s}>{INTERVAL_LABELS[s]}</option>)}
          </select>
        </div>
        {TIMED_INTERVALS.has(interval) && (
          <div className="form-group" style={{ marginBottom: 0, width: 110 }}>
            <label className="form-label">Time (UTC)</label>
            <input type="time" className="form-input" value={schedTime}
              onChange={e => setSchedTime(e.target.value)} />
          </div>
        )}
        {preview && (
          <div style={{ fontSize: 12, color: "var(--blue-primary)", paddingBottom: 8, whiteSpace: "nowrap" }}>
            <Clock size={11} style={{ marginRight: 4, verticalAlign: "middle" }} />{preview}
          </div>
        )}
      </div>

      {/* Dynamic config fields */}
      {Object.keys(schema).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: 12 }}>
          {Object.entries(schema).map(([key, field]) => (
            <div key={key} className="form-group" style={{ marginBottom: 0, minWidth: 140 }}>
              <label className="form-label">{field.label}</label>
              {field.type === "boolean" ? (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", marginTop: 4 }}>
                  <input type="checkbox" checked={!!config[key]} onChange={e => setConfig(c => ({ ...c, [key]: e.target.checked }))} />
                  {config[key] ? "Yes" : "No"}
                </label>
              ) : field.type === "select" ? (
                <select className="form-select" value={config[key] ?? field.default}
                  onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}>
                  {(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : key === "tenant_id" || field.type === "tenant_select" ? (
                <select className="form-select" value={config[key] ?? ""}
                  onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}>
                  <option value="">All tenants</option>
                  {Array.from(tenants.entries()).map(([id, nm]) => (
                    <option key={id} value={id}>{nm}</option>
                  ))}
                </select>
              ) : (
                <input type={field.type === "number" ? "number" : "text"}
                  className="form-input" value={config[key] ?? field.default}
                  onChange={e => setConfig(c => ({ ...c, [key]: field.type === "number" ? Number(e.target.value) : e.target.value }))} />
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" disabled={!name.trim() || createMut.isPending}
          onClick={() => createMut.mutate()}>
          {createMut.isPending ? "Creating…" : "Create Job"}
        </button>
        <button className="btn btn-secondary" onClick={onCreated}>Cancel</button>
      </div>
    </div>
  );
}

// ── Job card ───────────────────────────────────────────────────────────────────

function JobCard({ job, typeMeta, onDelete, onRun, onToggle, isRunning }: {
  job: Job; typeMeta?: JobTypeSchema; onDelete: () => void;
  onRun: () => void; onToggle: (e: boolean) => void; isRunning: boolean;
}) {
  const qc = useQueryClient();
  const [showRuns, setShowRuns] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const { data: runs = [] } = useQuery<JobRun[]>({
    queryKey: ["job-runs", job.id],
    queryFn: () => apiFetch(`/jobs/${job.id}/runs`),
    enabled: showRuns,
    refetchInterval: showRuns ? 5000 : false,
  });

  const enabled = !!job.enabled;
  const icon = TYPE_ICONS[job.type] ?? "⚙";
  const isDue = job.is_due && enabled;

  return (
    <div className="card" style={{ opacity: enabled ? 1 : 0.65, borderLeft: isDue ? "3px solid var(--blue-primary)" : undefined }}>
      <div className="card-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 18 }}>{icon}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-900)" }}>{job.name}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap", alignItems: "center" }}>
              <span className="badge badge-neutral">{typeMeta?.label ?? job.type}</span>
              {job.schedule && (
                <span style={{ fontSize: 11, color: "var(--gray-500)", display: "flex", alignItems: "center", gap: 3 }}>
                  <Clock size={11} />{scheduleLabel(job.schedule)}
                </span>
              )}
              {statusBadge(job.last_status)}
              {job.last_run_at && (
                <span className="text-muted" style={{ fontSize: 11 }}>
                  Last: {relTime(job.last_run_at)}
                </span>
              )}
              {job.next_run_at && job.schedule && (
                <span style={{ fontSize: 11, color: isDue ? "var(--blue-primary)" : "var(--gray-500)",
                  display: "flex", alignItems: "center", gap: 3 }}>
                  <Clock size={10} />
                  {isDue ? "Due now" : `Next: ${relTime(job.next_run_at)}`}
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          {/* Enable toggle */}
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 12, color: "var(--gray-600)" }}>
            <input type="checkbox" checked={enabled} onChange={e => onToggle(e.target.checked)} />
            {enabled ? "Enabled" : "Disabled"}
          </label>
          <button className="btn btn-primary btn-sm" onClick={onRun} disabled={isRunning}
            style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {isRunning ? <Loader size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={12} />}
            Run
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => { setShowEdit(s => !s); setShowRuns(false); }}
            title="Edit job" style={{ color: showEdit ? "var(--blue-primary)" : undefined }}>
            <Pencil size={12} />
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => { setShowRuns(s => !s); setShowEdit(false); }}>
            {showRuns ? <ChevronUp size={12} /> : <ChevronDown size={12} />} History
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onDelete} style={{ color: "var(--red)" }}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Config summary */}
      {Object.keys(job.config).length > 0 && (
        <div style={{ padding: "6px 14px", borderBottom: "1px solid var(--gray-100)", display: "flex", gap: 12, flexWrap: "wrap" }}>
          {Object.entries(job.config).filter(([, v]) => v !== "" && v !== null).map(([k, v]) => (
            <span key={k} style={{ fontSize: 11, color: "var(--gray-600)" }}>
              <span style={{ color: "var(--gray-400)" }}>{k}:</span> {String(v)}
            </span>
          ))}
        </div>
      )}

      {/* Edit panel */}
      {showEdit && (
        <EditJobPanel job={job} typeMeta={typeMeta} onClose={() => setShowEdit(false)} />
      )}

      {/* Run history */}
      {showRuns && (
        <div>
          {runs.length > 0 && (
            <div style={{ padding: "6px 14px", borderBottom: "1px solid var(--gray-100)", display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-secondary btn-sm"
                style={{ fontSize: 11, color: "var(--red)" }}
                onClick={() => {
                  if (confirm(`Clear all run history for "${job.name}"?`)) {
                    apiFetch(`/jobs/${job.id}/runs`, { method: "DELETE" })
                      .then(() => qc.invalidateQueries({ queryKey: ["job-runs", job.id] }));
                  }
                }}>
                <Trash2 size={11} style={{ marginRight: 3 }} /> Clear history
              </button>
            </div>
          )}
          {runs.length === 0 && <div className="card-body text-muted" style={{ fontSize: 13 }}>No runs yet.</div>}
          {runs.map(run => (
            <div key={run.id} style={{
              display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 14px",
              borderBottom: "1px solid var(--gray-100)", fontSize: 12,
            }}>
              <span style={{ paddingTop: 2, color: run.status === "success" ? "var(--green)" : run.status === "error" ? "var(--red)" : "var(--gray-400)" }}>
                {run.status === "success" ? <CheckCircle size={14} /> : run.status === "error" ? <XCircle size={14} /> : <Loader size={14} />}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: "var(--gray-500)", marginBottom: 2 }}>
                  {new Date(run.started_at).toLocaleString()}
                  {run.ended_at && ` · ${Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`}
                </div>
                {run.result && <RunDetail run={run} jobType={job.type} />}
                {run.error  && <div style={{ color: "var(--red)" }}>{run.error}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Edit panel ─────────────────────────────────────────────────────────────────

function EditJobPanel({ job, typeMeta, onClose }: {
  job: Job; typeMeta?: JobTypeSchema; onClose: () => void;
}) {
  const qc = useQueryClient();
  const tenants = useTenants();

  const parsed = parseSchedule(job.schedule);
  const [name,        setName]        = useState(job.name);
  const [selInterval, setSelInterval] = useState(parsed.interval);
  const [schedTime,   setSchedTime]   = useState(parsed.time || "09:00");
  const [config,      setConfig]      = useState<Record<string, any>>({ ...job.config });

  const schema = typeMeta?.config_schema ?? {};
  const builtSchedule = buildSchedule(selInterval, schedTime);

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/jobs/${job.id}`, {
      method: "PUT",
      body: JSON.stringify({ name, schedule: builtSchedule, config }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["jobs"] }); onClose(); },
  });

  return (
    <div style={{ padding: "12px 14px", borderTop: "1px solid var(--gray-100)", background: "var(--gray-50)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: 10 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Job Name</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
            <label className="form-label">Frequency</label>
            <select className="form-select" value={selInterval} onChange={e => setSelInterval(e.target.value)}>
              {INTERVALS.map(s => <option key={s} value={s}>{INTERVAL_LABELS[s]}</option>)}
            </select>
          </div>
          {TIMED_INTERVALS.has(selInterval) && (
            <div className="form-group" style={{ marginBottom: 0, width: 100 }}>
              <label className="form-label">Time (UTC)</label>
              <input type="time" className="form-input" value={schedTime}
                onChange={e => setSchedTime(e.target.value)} />
            </div>
          )}
        </div>
      </div>

      {Object.keys(schema).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", marginBottom: 10 }}>
          {Object.entries(schema).map(([key, field]) => (
            <div key={key} className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
              <label className="form-label">{field.label}</label>
              {field.type === "boolean" ? (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", marginTop: 4 }}>
                  <input type="checkbox" checked={!!config[key]}
                    onChange={e => setConfig(c => ({ ...c, [key]: e.target.checked }))} />
                  {config[key] ? "Yes" : "No"}
                </label>
              ) : field.type === "select" ? (
                <select className="form-select" value={config[key] ?? field.default}
                  onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}>
                  {(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : key === "tenant_id" || field.type === "tenant_select" ? (
                <select className="form-select" value={config[key] ?? ""}
                  onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}>
                  <option value="">All tenants</option>
                  {Array.from(tenants.entries()).map(([id, nm]) => (
                    <option key={id} value={id}>{nm}</option>
                  ))}
                </select>
              ) : (
                <input type={field.type === "number" ? "number" : "text"}
                  className="form-input" value={config[key] ?? field.default}
                  onChange={e => setConfig(c => ({ ...c, [key]: field.type === "number" ? Number(e.target.value) : e.target.value }))} />
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={!name.trim() || saveMut.isPending}
          onClick={() => saveMut.mutate()}>
          {saveMut.isPending ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ── Run detail — structured history rendering ───────────────────────────────────

function RunDetail({ run, jobType }: { run: JobRun; jobType: string }) {
  const [reportId, setReportId] = useState<string | null>(null);

  let parsed: any = null;
  try { if (run.result) parsed = JSON.parse(run.result); } catch {}

  if (!parsed) return <div style={{ color: "var(--gray-700)", fontSize: 12 }}>{run.result}</div>;

  const dryBadge = parsed.dry_run
    ? <span className="badge badge-warn" style={{ fontSize: 10, marginLeft: 6 }}>DRY RUN</span>
    : null;

  // ── Snapshot cleanup ──
  if (jobType === "snapshot-cleanup") {
    const snaps: any[] = parsed.snapshots ?? [];
    return (
      <div>
        <div style={{ fontSize: 12, color: "var(--gray-700)", marginBottom: 4 }}>{parsed.summary}{dryBadge}</div>
        {snaps.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead><tr>
              <th style={{ textAlign: "left", color: "var(--gray-400)", paddingBottom: 3 }}>Name</th>
              <th style={{ textAlign: "right", color: "var(--gray-400)" }}>Size</th>
              <th style={{ textAlign: "right", color: "var(--gray-400)" }}>Age</th>
              <th style={{ textAlign: "left",  color: "var(--gray-400)" }}>Tenant</th>
            </tr></thead>
            <tbody>
              {snaps.map((s, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--gray-100)" }}>
                  <td style={{ padding: "2px 8px 2px 0", color: "var(--gray-700)" }}>{s.name}</td>
                  <td style={{ padding: "2px 0", color: "var(--gray-600)", textAlign: "right" }}>{s.size_gb} GB</td>
                  <td style={{ padding: "2px 8px", color: "var(--gray-500)", textAlign: "right" }}>{s.age_days}d</td>
                  <td style={{ padding: "2px 0", color: "var(--gray-500)" }}>{s.tenant_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  // ── Resource reclamation ──
  if (jobType === "resource-reclamation") {
    const vms: any[]  = parsed.vms_actioned ?? [];
    const vols: any[] = parsed.volumes_deleted ?? [];
    return (
      <div>
        <div style={{ fontSize: 12, color: "var(--gray-700)", marginBottom: 6 }}>{parsed.summary}{dryBadge}</div>
        {vms.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--gray-500)", marginBottom: 3 }}>VMs {parsed.action}d</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <tbody>
                {vms.map((v, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--gray-100)" }}>
                    <td style={{ padding: "2px 8px 2px 0", color: "var(--gray-700)", fontWeight: 500 }}>{v.name}</td>
                    <td style={{ color: "var(--gray-500)" }}>{v.offline_days}d offline</td>
                    <td style={{ color: "var(--gray-500)", textAlign: "right" }}>{v.attached_gb > 0 ? `${v.attached_gb} GB disk` : ""}</td>
                    <td style={{ color: "var(--gray-400)", textAlign: "right", paddingLeft: 8 }}>{v.tenant_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {vols.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--gray-500)", marginBottom: 3 }}>Volumes deleted</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <tbody>
                {vols.map((v, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--gray-100)" }}>
                    <td style={{ padding: "2px 8px 2px 0", color: "var(--gray-700)" }}>{v.name}</td>
                    <td style={{ color: "var(--gray-500)" }}>{v.size_gb} GB</td>
                    <td style={{ color: "var(--gray-500)", textAlign: "right" }}>{v.unattached_days}d unattached</td>
                    <td style={{ color: "var(--gray-400)", textAlign: "right", paddingLeft: 8 }}>{v.tenant_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── Capacity report ──
  if (jobType === "capacity-report") {
    return (
      <div>
        <div style={{ fontSize: 12, color: "var(--gray-700)", marginBottom: 4 }}>{parsed.summary}</div>
        {parsed.email_sent_to && (
          <div style={{ fontSize: 11, color: "var(--gray-500)" }}>📧 Sent to {parsed.email_sent_to}</div>
        )}
        {parsed.report_id && (
          <button className="btn btn-secondary btn-sm" onClick={() => setReportId(parsed.report_id)}
            style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ExternalLink size={11} /> View Report
          </button>
        )}
        {reportId && <CapacityReportModal reportId={reportId} onClose={() => setReportId(null)} />}
      </div>
    );
  }

  // Fallback
  return <div style={{ fontSize: 12, color: "var(--gray-700)" }}>{parsed.summary ?? run.result}</div>;
}

// ── Formatted AI analysis ──────────────────────────────────────────────────────

interface AnalysisSection {
  heading: string | null;       // section title shown with blue bar
  intro:   string | null;       // optional sub-heading line before items
  items:   string[];
  numbered: boolean;
}

/** True if a single-line block looks like a section title rather than content */
function looksLikeHeading(line: string): boolean {
  return (
    line.length < 90 &&
    !line.startsWith("*") && !line.startsWith("•") &&
    !/^\d+\./.test(line) &&
    !line.endsWith(".")
  );
}

function parseAnalysis(text: string): AnalysisSection[] {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  const blocks = normalized.split(/\n\n+/).map(b => b.trim()).filter(Boolean);

  const sections: AnalysisSection[] = [];
  let heading: string | null = null;
  let intro:   string | null = null;

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    const first = lines[0];
    const single = lines.length === 1;

    // ── Pure heading block (single short line, no list markers, no period) ──
    if (single && looksLikeHeading(first)) {
      const clean = first.replace(/:$/, "").trim();
      // If we already have a heading pending with no content, a new heading means
      // the previous one was a section divider — emit it with no items, reset.
      if (heading !== null && intro === null) {
        sections.push({ heading, intro: null, items: [], numbered: false });
      }
      // Intro-style headings start with lowercase or common intro words
      const isIntro = /^(the |all |no |none |most |some )/i.test(clean) && clean.length > 25;
      if (isIntro) {
        intro = clean;
      } else {
        heading = clean;
        intro   = null;
      }
      continue;
    }

    // ── First-line colon heading followed by list on next lines ──
    if (first.endsWith(":") && lines.length > 1 && looksLikeHeading(first)) {
      intro = first.slice(0, -1).trim();
      const rest = lines.slice(1).join("\n");
      sections.push({ heading, intro, items: extractItems(rest), numbered: /^\d+\./.test(rest.trim()) });
      intro = null;
      continue;
    }

    // ── Regular content block ──
    sections.push({ heading, intro, items: extractItems(block), numbered: /^\s*\d+\./.test(block) });
    intro = null;
    // heading stays active across multiple content blocks in the same section
  }

  return sections.length > 0
    ? sections
    : [{ heading: null, intro: null, items: [text], numbered: false }];
}

function extractItems(body: string): string[] {
  const lines = body
    .split("\n")
    .map(l => l.replace(/^[*•]\s*/, "").replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [body.trim()];
}

function FormattedAnalysis({ text }: { text: string }) {
  const sections = parseAnalysis(text);
  // Group consecutive sections that share the same heading
  const grouped: { heading: string | null; subs: AnalysisSection[] }[] = [];
  for (const sec of sections) {
    const last = grouped[grouped.length - 1];
    if (last && last.heading === sec.heading) {
      last.subs.push(sec);
    } else {
      grouped.push({ heading: sec.heading, subs: [sec] });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {grouped.map((group, gi) => (
        <div key={gi} style={{
          paddingTop: gi === 0 ? 0 : 18,
          borderTop: gi > 0 ? "1px solid var(--gray-100)" : "none",
        }}>
          {/* Section heading with blue bar */}
          {group.heading && (
            <div style={{
              fontWeight: 700, fontSize: 13, color: "var(--gray-900)",
              marginBottom: 10, paddingTop: gi > 0 ? 16 : 0,
              display: "flex", alignItems: "center", gap: 7,
            }}>
              <span style={{ width: 3, height: 15, background: "var(--blue-primary)", borderRadius: 2, flexShrink: 0 }} />
              {group.heading}
            </div>
          )}

          {/* Sub-sections within this heading group */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: group.heading ? 10 : 0 }}>
            {group.subs.map((sec, si) => (
              <div key={si}>
                {/* Intro line (e.g. "The tenants consuming the most resources are") */}
                {sec.intro && (
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--gray-600)", marginBottom: 5, fontStyle: "italic" }}>
                    {sec.intro}
                  </div>
                )}
                {/* Items */}
                {sec.items.length === 0 ? null
                  : sec.items.length === 1 ? (
                    <p style={{ margin: 0, lineHeight: 1.7, color: "var(--gray-700)" }}>{sec.items[0]}</p>
                  ) : sec.numbered ? (
                    <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 7 }}>
                      {sec.items.map((item, i) => (
                        <li key={i} style={{ lineHeight: 1.65, color: "var(--gray-700)" }}>{item}</li>
                      ))}
                    </ol>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 0, display: "flex", flexDirection: "column", gap: 5, listStyle: "none" }}>
                      {sec.items.map((item, i) => (
                        <li key={i} style={{ lineHeight: 1.65, color: "var(--gray-700)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <span style={{ color: "var(--blue-primary)", fontWeight: 700, flexShrink: 0, marginTop: 2, fontSize: 16 }}>·</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  )
                }
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Capacity Report Modal ───────────────────────────────────────────────────────

interface ReportTenant {
  name: string; tenant_id: string;
  vcpus: { used: number; max: number; pct: number };
  ram_gb: { used: number; max: number; pct: number };
  storage_gb: { used: number; max: number; pct: number };
  cpu_series: { ts: number; v: number }[];
  mem_series: { ts: number; v: number }[];
}
interface CapacityReport {
  report_id: string; generated_at: string; tenant_filter: string | null;
  cluster: any; tenants: ReportTenant[]; ai_analysis: string | null; email_sent_to: string | null;
}

const CHART_COLORS = ["var(--blue-primary)","var(--purple)","var(--green)","#B45309","var(--red)","#0891B2"];

function CapacityReportModal({ reportId, onClose }: { reportId: string; onClose: () => void }) {
  const { data: report, isLoading } = useQuery<CapacityReport>({
    queryKey: ["report", reportId],
    queryFn: () => apiFetch(`/reports/${reportId}`),
  });

  function pctColor(pct: number) {
    return pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--yellow)" : "var(--green)";
  }

  function UsageBar({ label, r }: { label: string; r: { used: number; max: number; pct: number } }) {
    const color = pctColor(r.pct);
    return (
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
          <span style={{ color: "var(--gray-600)" }}>{label}</span>
          <span style={{ color, fontWeight: 600 }}>{r.pct}%</span>
        </div>
        <div style={{ height: 6, background: "var(--gray-100)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${r.pct}%`, background: color, borderRadius: 3 }} />
        </div>
        <div style={{ fontSize: 10, color: "var(--gray-400)", marginTop: 1 }}>
          {Math.round(r.used)} / {Math.round(r.max)}
        </div>
      </div>
    );
  }

  // Build multi-series trend data — merge timestamps across top tenants
  function buildTrendData(key: "cpu_series" | "mem_series", tenants: ReportTenant[]) {
    const top5 = tenants.slice(0, 5);
    const tsSet = new Set<number>();
    top5.forEach(t => (t[key] ?? []).forEach((p: any) => tsSet.add(p.ts)));
    const tsList = Array.from(tsSet).sort();
    return tsList.map(ts => {
      const row: Record<string, any> = { ts };
      top5.forEach(t => {
        const pt = (t[key] ?? []).find((p: any) => p.ts === ts);
        row[t.name] = pt?.v ?? null;
      });
      return row;
    });
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "32px 16px", overflowY: "auto",
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#fff", borderRadius: 12, width: "100%", maxWidth: 1100,
        boxShadow: "0 24px 60px rgba(0,0,0,.25)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 24px", background: "var(--gray-50)", borderBottom: "1px solid var(--gray-200)",
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "var(--gray-900)" }}>
              Capacity Report{report?.tenant_filter ? ` — ${report.tenant_filter}` : ""}
            </div>
            {report && (
              <div style={{ fontSize: 12, color: "var(--gray-500)", marginTop: 2 }}>
                Generated {new Date(report.generated_at).toLocaleString()}
                {report.email_sent_to && ` · Emailed to ${report.email_sent_to}`}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {report && (
              <button className="btn btn-secondary btn-sm"
                style={{ fontSize: 11, color: "var(--red)" }}
                onClick={() => {
                  if (confirm("Delete this report permanently?")) {
                    apiFetch(`/reports/${report.report_id}`, { method: "DELETE" })
                      .then(onClose);
                  }
                }}>
                <Trash2 size={11} style={{ marginRight: 3 }} /> Delete report
              </button>
            )}
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gray-400)" }}>
              <X size={20} />
            </button>
          </div>
        </div>

        {isLoading && <div style={{ padding: 48, textAlign: "center", color: "var(--gray-500)" }}>Loading report…</div>}

        {report && (
          <div style={{ padding: "20px 24px" }}>
            {/* Cluster summary */}
            {report.cluster && (
              <section style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--gray-900)", marginBottom: 10 }}>Cluster Overview</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "1rem" }}>
                  {[
                    { label: "vCPUs",   r: report.cluster.vcpus,      unit: "" },
                    { label: "Memory",  r: report.cluster.ram_gb,     unit: "GB" },
                    { label: "Storage", r: report.cluster.storage_gb, unit: "GB" },
                  ].map(({ label, r, unit }) => r && (
                    <div key={label} className="card card-body">
                      <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--gray-900)" }}>{label}</div>
                      {r.total ? (
                        <>
                          <div style={{ fontSize: 22, fontWeight: 700, color: pctColor(Math.round(r.used/r.total*100)) }}>
                            {Math.round(r.used/r.total*100)}%
                          </div>
                          <div style={{ height: 6, background: "var(--gray-100)", borderRadius: 3, overflow: "hidden", margin: "6px 0" }}>
                            <div style={{ height: "100%", width: `${Math.min(100, Math.round(r.used/r.total*100))}%`,
                              background: pctColor(Math.round(r.used/r.total*100)), borderRadius: 3 }} />
                          </div>
                          <div style={{ fontSize: 12, color: "var(--gray-500)" }}>
                            {Math.round(r.used)}{unit} used / {Math.round(r.total)}{unit} total
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--blue-primary)" }}>
                          {Math.round(r.used)}{unit} used
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Per-tenant breakdown */}
            {report.tenants.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--gray-900)", marginBottom: 10 }}>
                  Tenant Breakdown ({report.tenants.length})
                </div>
                <div className="card table-wrap">
                  <table>
                    <thead><tr>
                      <th>Tenant</th>
                      <th style={{ width: 180 }}>vCPUs</th>
                      <th style={{ width: 180 }}>Memory</th>
                      <th style={{ width: 180 }}>Storage</th>
                    </tr></thead>
                    <tbody>
                      {report.tenants.map(t => (
                        <tr key={t.tenant_id}>
                          <td style={{ fontWeight: 600 }}>{t.name}</td>
                          <td><UsageBar label="" r={t.vcpus} /></td>
                          <td><UsageBar label="" r={t.ram_gb} /></td>
                          <td><UsageBar label="" r={t.storage_gb} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Trend charts */}
            {report.tenants.some(t => t.cpu_series.length > 1) && (
              <section style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--gray-900)", marginBottom: 10 }}>7-Day Trends (top 5 tenants)</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                  {[
                    { title: "vCPU Usage", key: "cpu_series" as const, unit: "vCPUs" },
                    { title: "Memory (GB)", key: "mem_series" as const, unit: "GB" },
                  ].map(({ title, key, unit }) => {
                    const chartData = buildTrendData(key, report.tenants);
                    const top5 = report.tenants.slice(0, 5);
                    if (!chartData.length) return null;
                    return (
                      <div key={title} className="card card-body" style={{ padding: "10px 12px" }}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>{title}</div>
                        <ResponsiveContainer width="100%" height={160}>
                          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-100)" />
                            <XAxis dataKey="ts" hide />
                            <YAxis tick={{ fontSize: 10, fill: "var(--gray-400)" }} />
                            <Tooltip contentStyle={{ fontSize: 11 }}
                              formatter={(v: number) => [`${v} ${unit}`, ""]}
                              labelFormatter={() => ""} />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            {top5.map((t, i) => (
                              <Area key={t.name} type="monotone" dataKey={t.name}
                                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                                fill="transparent" strokeWidth={1.5} dot={false} />
                            ))}
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* AI analysis */}
            {report.ai_analysis && (
              <section>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--gray-900)", marginBottom: 8 }}>🤖 AI Analysis</div>
                <div className="card card-body" style={{ fontSize: 13, color: "var(--gray-700)" }}>
                  <FormattedAnalysis text={report.ai_analysis} />
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
