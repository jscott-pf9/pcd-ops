import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus, Sparkles, Trash2 } from "lucide-react";
import { apiFetch } from "../api/client";

interface ResourceSummary { total: number | null; used: number; free: number | null; fits?: boolean; }
interface Plan {
  id: number;
  name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  description: string;
  additional_vcpus: number;
  additional_ram_gb: number;
  additional_storage_gb: number;
  additional_vdisks: number;
  created_at: string;
  simulation: { would_fit: boolean; projected: Record<string, ResourceSummary> } | null;
}
interface ParsedResources { vcpus: number; ram_gb: number; storage_gb: number; vdisks: number; summary: string; }

const EMPTY = { name: "", tenant_id: "", description: "", vcpus: 0, ram_gb: 0, storage_gb: 0, vdisks: 0 };

export default function CapacityPlans() {
  const { data: tenants = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["tenants"],
    queryFn: () => apiFetch("/inventory/tenants"),
    staleTime: 5 * 60_000,
  });

  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [nlText, setNlText] = useState("");

  const { data: plans = [], isLoading } = useQuery<Plan[]>({
    queryKey: ["capacity", "plans"],
    queryFn: () => apiFetch("/capacity/plans"),
  });

  const parseMut = useMutation({
    mutationFn: (description: string) =>
      apiFetch<ParsedResources>("/capacity/plans/parse", {
        method: "POST", body: JSON.stringify({ description }),
      }),
    onSuccess: (r) => setForm((f) => ({ ...f, vcpus: r.vcpus, ram_gb: r.ram_gb, storage_gb: r.storage_gb, vdisks: r.vdisks })),
  });

  const saveMut = useMutation({
    mutationFn: () => apiFetch("/capacity/plans", {
      method: "POST",
      body: JSON.stringify({
        name: form.name,
        tenant_id: form.tenant_id || null,
        tenant_name: tenants.find(t => t.id === form.tenant_id)?.name || null,
        description: form.description || nlText,
        additional_vcpus: form.vcpus,
        additional_ram_gb: form.ram_gb,
        additional_storage_gb: form.storage_gb,
        additional_vdisks: form.vdisks,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capacity", "plans"] });
      setForm(EMPTY);
      setNlText("");
      setShowForm(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/capacity/plans/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["capacity", "plans"] }),
  });

  return (
    <div>
      <h1>Forecast Plans</h1>

      {/* ── Create form ── */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="card-header" style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => setShowForm(s => !s)}>
          <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={13} /> New Plan
          </span>
          {showForm ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </div>

        {showForm && (
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Plan Name</label>
                <input className="form-input" placeholder="e.g. Q3 Beacon Expansion"
                  value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Tenant (optional)</label>
                <select className="form-select" value={form.tenant_id}
                  onChange={e => setForm(f => ({ ...f, tenant_id: e.target.value }))}>
                  <option value="">— All tenants —</option>
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Sparkles size={12} style={{ color: "var(--purple)" }} />
                Describe your workload
                <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>— AI parses resource numbers</span>
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <textarea
                  className="form-input"
                  rows={2}
                  placeholder='e.g. "10 VMs with 4 vCPUs and 16 GB RAM each, two 200 GB data volumes"'
                  value={nlText}
                  onChange={e => setNlText(e.target.value)}
                  style={{ flex: 1, resize: "vertical", fontFamily: "var(--font)" }}
                />
                <button className="btn btn-secondary btn-sm"
                  disabled={!nlText.trim() || parseMut.isPending}
                  onClick={() => parseMut.mutate(nlText)}
                  style={{ alignSelf: "flex-start", whiteSpace: "nowrap" }}>
                  <Sparkles size={12} />
                  {parseMut.isPending ? "Parsing…" : "Parse"}
                </button>
              </div>
              {parseMut.data && (
                <div style={{ marginTop: 4, fontSize: 12, color: "var(--purple)", display: "flex", alignItems: "center", gap: 5 }}>
                  <Sparkles size={11} /> {parseMut.data.summary}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
              <Num label="vCPUs" value={form.vcpus} onChange={v => setForm(f => ({ ...f, vcpus: v }))} />
              <Num label="RAM (GB)" value={form.ram_gb} onChange={v => setForm(f => ({ ...f, ram_gb: v }))} step={0.5} />
              <Num label="Storage (GB)" value={form.storage_gb} onChange={v => setForm(f => ({ ...f, storage_gb: v }))} />
              <Num label="vDisks (#)" value={form.vdisks} onChange={v => setForm(f => ({ ...f, vdisks: v }))} />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary"
                disabled={!form.name.trim() || saveMut.isPending}
                onClick={() => saveMut.mutate()}>
                {saveMut.isPending ? "Saving…" : "Save Plan"}
              </button>
              <button className="btn btn-secondary" onClick={() => { setForm(EMPTY); setNlText(""); }}>
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Saved plans ── */}
      {isLoading && <p className="text-muted">Loading plans…</p>}
      {!isLoading && plans.length === 0 && (
        <div className="empty">
          <div className="empty-title">No plans yet</div>
          <div className="empty-body">Create a plan above to simulate resource needs against current capacity.</div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "0.75rem" }}>
        {plans.map(plan => (
          <PlanCard key={plan.id} plan={plan} onDelete={() => deleteMut.mutate(plan.id)} />
        ))}
      </div>
    </div>
  );
}

function Num({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="form-label">{label}</label>
      <input type="number" min={0} step={step} className="form-input"
        value={value} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}

function PlanCard({ plan, onDelete }: { plan: Plan; onDelete: () => void }) {
  const sim = plan.simulation;
  const fits = sim?.would_fit ?? null;
  const fitColor = fits === null ? "var(--gray-300)" : fits ? "var(--green)" : "var(--red)";
  const fitBg   = fits === null ? "var(--gray-50)"  : fits ? "var(--green-light)" : "var(--red-light)";

  return (
    <div className="card" style={{ borderTop: `3px solid ${fitColor}` }}>
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: "var(--gray-900)", fontSize: 13 }}>{plan.name}</div>
          <div style={{ display: "flex", gap: 5, marginTop: 2, flexWrap: "wrap" }}>
            {plan.tenant_name && <span className="badge badge-info">{plan.tenant_name}</span>}
            <span className="text-muted" style={{ fontSize: 11 }}>{new Date(plan.created_at).toLocaleDateString()}</span>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onDelete} title="Delete"
          style={{ color: "var(--red)", flexShrink: 0 }}>
          <Trash2 size={12} />
        </button>
      </div>
      <div className="card-body">
        {plan.description && (
          <p style={{ fontSize: 12, color: "var(--gray-600)", marginBottom: 8, fontStyle: "italic" }}>
            "{plan.description}"
          </p>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginBottom: 10 }}>
          {[["vCPUs", plan.additional_vcpus], ["RAM GB", plan.additional_ram_gb],
            ["Stor GB", plan.additional_storage_gb], ["vDisks", plan.additional_vdisks]].map(([l, v]) => (
            <div key={String(l)} style={{ textAlign: "center", padding: "5px 2px", background: "var(--gray-50)", borderRadius: 5 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--gray-900)" }}>{v}</div>
              <div style={{ fontSize: 10, color: "var(--gray-500)", fontWeight: 600, textTransform: "uppercase" }}>{l}</div>
            </div>
          ))}
        </div>
        {sim && (
          <div style={{ background: fitBg, borderRadius: 5, padding: "7px 10px" }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: fitColor, marginBottom: 5 }}>
              {fits ? "✓ Fits current capacity" : "✗ Insufficient capacity"}
            </div>
            {(["vcpus", "ram_gb", "storage_gb"] as const).map(key => {
              const labels: Record<string, string> = { vcpus: "vCPUs", ram_gb: "RAM", storage_gb: "Storage" };
              const p = sim.projected[key];
              const pct = (p.total ?? 0) > 0 ? Math.min(100, Math.round(p.used / (p.total ?? 1) * 100)) : 0;
              const col = !p.fits ? "var(--red)" : pct >= 70 ? "var(--yellow)" : "var(--blue-primary)";
              return (
                <div key={key} style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 1 }}>
                    <span className="text-muted">{labels[key]}</span>
                    <span style={{ color: col, fontWeight: 600 }}>{pct}%</span>
                  </div>
                  <div style={{ height: 5, background: "var(--gray-200)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: col, borderRadius: 3 }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
