import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, Trash2, Clock, ChevronDown, ChevronUp, X } from "lucide-react";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";
import DataFreshness from "../components/DataFreshness";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Snapshot {
  id: string;
  name: string;
  size: number;
  status: string;
  volume_id: string;
  project_id: string;
  created_at: string;
}

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
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const INTERVALS = ["", "hourly", "daily", "weekly", "monthly"] as const;
const INTERVAL_LABELS: Record<string, string> = {
  "": "On demand only", hourly: "Every hour",
  daily: "Daily", weekly: "Weekly", monthly: "Monthly",
};
const TIMED_INTERVALS = new Set(["daily", "weekly", "monthly"]);

function buildSchedule(interval: string, time: string): string | null {
  if (!interval) return null;
  return TIMED_INTERVALS.has(interval) && time ? `${interval}@${time}` : interval;
}

function scheduleLabel(s: string | null): string {
  if (!s) return "On demand";
  const [interval, time = ""] = s.split("@");
  const base = INTERVAL_LABELS[interval] ?? interval;
  return TIMED_INTERVALS.has(interval) ? `${base} at ${time} UTC` : base;
}

function ageDays(isoStr: string): number {
  try {
    const dt = new Date(isoStr);
    return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 86_400_000));
  } catch {
    return 0;
  }
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusBadge(status: string | null) {
  if (!status) return <span className="badge badge-neutral">—</span>;
  if (status === "success") return <span className="badge badge-active">success</span>;
  if (status === "error") return <span className="badge badge-error">error</span>;
  if (status === "running") return <span className="badge badge-warn">running</span>;
  return <span className="badge badge-neutral">{status}</span>;
}

// ── New Policy Form ────────────────────────────────────────────────────────────

interface PolicyFormProps {
  tenants: Map<string, string>;
  onCreated: () => void;
  onCancel: () => void;
}

function PolicyForm({ tenants, onCreated, onCancel }: PolicyFormProps) {
  const [jobType, setJobType] = useState<"snapshot-create" | "snapshot-rotate">("snapshot-create");
  const [name, setName] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [interval, setInterval] = useState("daily");
  const [time, setTime] = useState("02:00");
  const [vmPattern, setVmPattern] = useState("");
  const [namePrefix, setNamePrefix] = useState("auto");
  const [retainCount, setRetainCount] = useState(7);
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (body: object) => apiFetch("/jobs/", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onCreated();
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    const config: Record<string, any> = { tenant_id: tenantId, name_prefix: namePrefix, dry_run: dryRun };
    if (jobType === "snapshot-create") {
      config.vm_name_pattern = vmPattern;
    } else {
      config.retain_count = retainCount;
    }
    create.mutate({ name: name.trim(), type: jobType, schedule: buildSchedule(interval, time), config });
  }

  return (
    <div className="card" style={{ marginBottom: 20, padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <strong>New Snapshot Policy</strong>
        <button className="btn btn-sm" onClick={onCancel} style={{ padding: "2px 8px" }}>
          <X size={14} />
        </button>
      </div>
      <form onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px" }}>
          <div className="form-group">
            <label className="form-label">Policy type</label>
            <select className="form-select" value={jobType} onChange={e => setJobType(e.target.value as any)}>
              <option value="snapshot-create">Snapshot Create — create snapshots on schedule</option>
              <option value="snapshot-rotate">Snapshot Rotate — enforce retention per volume</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Policy name</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. daily-prod-snapshots" />
          </div>
          <div className="form-group">
            <label className="form-label">Tenant</label>
            <select className="form-select" value={tenantId} onChange={e => setTenantId(e.target.value)}>
              <option value="">All tenants</option>
              {[...tenants.entries()].map(([id, tname]) => (
                <option key={id} value={id}>{tname}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Schedule</label>
            <div style={{ display: "flex", gap: 8 }}>
              <select className="form-select" value={interval} onChange={e => setInterval(e.target.value)}>
                {INTERVALS.map(i => <option key={i} value={i}>{INTERVAL_LABELS[i]}</option>)}
              </select>
              {TIMED_INTERVALS.has(interval) && (
                <input className="form-input" type="time" value={time} onChange={e => setTime(e.target.value)} style={{ width: 120 }} />
              )}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Snapshot name prefix</label>
            <input className="form-input" value={namePrefix} onChange={e => setNamePrefix(e.target.value)} placeholder="auto" />
          </div>
          {jobType === "snapshot-create" ? (
            <div className="form-group">
              <label className="form-label">VM name pattern <span className="text-muted">(regex, blank = all)</span></label>
              <input className="form-input" value={vmPattern} onChange={e => setVmPattern(e.target.value)} placeholder="e.g. prod-.*" />
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">Retain per volume</label>
              <input className="form-input" type="number" min={1} value={retainCount} onChange={e => setRetainCount(Number(e.target.value))} />
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 14 }}>
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
            Dry run (preview only, no changes)
          </label>
          {dryRun && <span className="badge badge-warn" style={{ fontSize: 12 }}>DRY RUN</span>}
        </div>
        {error && <p style={{ color: "var(--red)", fontSize: 13, marginTop: 8 }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn btn-primary btn-sm" type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create Policy"}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// ── Policies Section ───────────────────────────────────────────────────────────

function PoliciesSection({ jobs }: { jobs: Job[] }) {
  const queryClient = useQueryClient();

  const runJob = useMutation({
    mutationFn: (id: number) => apiFetch(`/jobs/${id}/run`, { method: "POST" }),
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["jobs"] }), 1500);
    },
  });

  const deleteJob = useMutation({
    mutationFn: (id: number) => apiFetch(`/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const snapshotJobs = jobs.filter(j => j.type.startsWith("snapshot-"));
  if (snapshotJobs.length === 0) {
    return (
      <div className="empty" style={{ padding: "24px 0" }}>
        <div className="empty-title">No snapshot policies</div>
        <div className="empty-body">Create a policy above to automate snapshot creation or rotation.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {snapshotJobs.map(job => (
        <div key={job.id} className="card" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{job.name}</div>
              <div className="text-muted" style={{ fontSize: 12 }}>
                {job.type === "snapshot-create" ? "Create" : job.type === "snapshot-rotate" ? "Rotate" : "Cleanup"}
                {job.config.tenant_id ? ` · tenant scoped` : " · all tenants"}
                {job.config.name_prefix ? ` · prefix: ${job.config.name_prefix}` : ""}
                {job.config.retain_count ? ` · keep ${job.config.retain_count}/vol` : ""}
                {job.config.dry_run ? " · DRY RUN" : ""}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Clock size={13} className="text-muted" />
              <span style={{ fontSize: 13 }}>{scheduleLabel(job.schedule)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <span className="text-muted">Last run:</span>
              {statusBadge(job.last_status)}
              <span>{relTime(job.last_run_at)}</span>
            </div>
            {job.next_run_at && (
              <div className="text-muted" style={{ fontSize: 12 }}>
                next: {new Date(job.next_run_at).toLocaleString()}
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <button
                className="btn btn-sm"
                title="Run now"
                disabled={runJob.isPending}
                onClick={() => runJob.mutate(job.id)}
              >
                <Play size={13} />
              </button>
              <button
                className="btn btn-sm btn-danger"
                title="Delete policy"
                onClick={() => { if (confirm(`Delete policy "${job.name}"?`)) deleteJob.mutate(job.id); }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Snapshots() {
  const [tenantFilter, setTenantFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [showPolicies, setShowPolicies] = useState(true);

  const { data: snapshots, isLoading } = useQuery({
    queryKey: ["snapshots"],
    queryFn: () => apiFetch<Snapshot[]>("/snapshots/"),
  });

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ["jobs"],
    queryFn: () => apiFetch<Job[]>("/jobs/"),
  });

  const tenants = useTenants();
  const queryClient = useQueryClient();

  const deleteSnapshot = useMutation({
    mutationFn: (id: string) => apiFetch(`/snapshots/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["snapshots"] }),
  });

  const filtered = (snapshots ?? []).filter(s =>
    tenantFilter === "all" || s.project_id === tenantFilter
  );

  const tenantIds = [...new Set((snapshots ?? []).map(s => s.project_id).filter(Boolean))];
  const totalGb = (snapshots ?? []).reduce((sum, s) => sum + (s.size || 0), 0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Snapshot Management</h1>
        <DataFreshness domainKey="snapshots:list" />
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div className="stat-card">
          <div className="stat-card-label">Total Snapshots</div>
          <div className="stat-card-value">{(snapshots ?? []).length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Total Size</div>
          <div className="stat-card-value">{totalGb} <span style={{ fontSize: 14 }}>GB</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Tenants</div>
          <div className="stat-card-value">{tenantIds.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Active Policies</div>
          <div className="stat-card-value">{jobs.filter(j => j.type.startsWith("snapshot-") && j.enabled).length}</div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <select
          className="form-select"
          style={{ width: 220 }}
          value={tenantFilter}
          onChange={e => setTenantFilter(e.target.value)}
        >
          <option value="all">All Tenants</option>
          {tenantIds.map(id => (
            <option key={id} value={id}>{tenants.get(id) ?? id}</option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(v => !v)} style={{ marginLeft: "auto" }}>
          <Plus size={14} style={{ marginRight: 4 }} />
          New Policy
        </button>
      </div>

      {/* New Policy form */}
      {showForm && (
        <PolicyForm
          tenants={tenants}
          onCreated={() => { setShowForm(false); setShowPolicies(true); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Snapshots table */}
      <div className="card table-wrap" style={{ marginBottom: 24 }}>
        <div className="card-header" style={{ padding: "12px 16px", borderBottom: "1px solid var(--gray-200)" }}>
          <span className="card-title">Volume Snapshots</span>
          {tenantFilter !== "all" && (
            <span className="badge badge-info" style={{ marginLeft: 8 }}>
              {tenants.get(tenantFilter) ?? tenantFilter}
            </span>
          )}
        </div>
        {isLoading && !snapshots && <p className="text-muted" style={{ padding: 16 }}>Waiting for first collection…</p>}
        {snapshots && filtered.length === 0 && (
          <div className="empty" style={{ padding: "24px 0" }}>
            <div className="empty-title">No snapshots</div>
            <div className="empty-body">{tenantFilter !== "all" ? "No snapshots for this tenant." : "No volume snapshots found."}</div>
          </div>
        )}
        {filtered.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Tenant</th>
                <th>Size (GB)</th>
                <th>Age</th>
                <th>Status</th>
                <th>Volume ID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td>{s.name || <span className="text-muted">(unnamed)</span>}</td>
                  <td>{tenants.get(s.project_id) ?? <span className="text-muted text-mono" style={{ fontSize: 12 }}>{s.project_id?.slice(0, 8)}</span>}</td>
                  <td>{s.size ?? "—"}</td>
                  <td>{s.created_at ? `${ageDays(s.created_at)}d` : "—"}</td>
                  <td>
                    <span className={`badge ${s.status === "available" ? "badge-active" : s.status === "error" ? "badge-error" : "badge-neutral"}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="text-mono" style={{ fontSize: 12 }}>{s.volume_id}</td>
                  <td>
                    <button
                      className="btn btn-sm btn-danger"
                      title="Delete snapshot"
                      disabled={deleteSnapshot.isPending}
                      onClick={() => { if (confirm(`Delete snapshot "${s.name}"?`)) deleteSnapshot.mutate(s.id); }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Policies section */}
      <div style={{ marginBottom: 8 }}>
        <button
          className="btn btn-sm"
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, fontWeight: 600, fontSize: 15, cursor: "pointer" }}
          onClick={() => setShowPolicies(v => !v)}
        >
          {showPolicies ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          Snapshot Policies
          <span className="badge badge-neutral" style={{ fontSize: 12 }}>
            {jobs.filter(j => j.type.startsWith("snapshot-")).length}
          </span>
        </button>
      </div>
      {showPolicies && <PoliciesSection jobs={jobs} />}
    </div>
  );
}
