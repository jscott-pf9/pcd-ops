// A what-if's outcome (POST /capacity/what-if, and each plan's `simulation`): projected use of
// the cloud's capacity and, for a tenant, of its quotas.

export interface ProjectedResource { total: number | null; used: number; free: number | null; fits?: boolean }

export interface QuotaRow { resource: string; label: string; limit: number | null; used: number; after: number; fits: boolean }

export interface Simulation {
  would_fit: boolean;
  projected: Record<"vcpus" | "ram_gb" | "storage_gb", ProjectedResource>;
  quota?: QuotaRow[];
  quota_fits?: boolean;
  quota_error?: string;
}

const LABELS = { vcpus: "vCPUs", ram_gb: "RAM", storage_gb: "Storage" } as const;

function Bar({ label, pct, fits, detail }: { label: string; pct: number; fits: boolean; detail: string }) {
  const col = !fits ? "var(--red)" : pct >= 70 ? "var(--yellow)" : "var(--blue-primary)";
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 1, gap: 8 }}>
        <span className="text-muted">{label}</span>
        <span style={{ color: col, fontWeight: 600 }} title={detail}>{detail} · {pct}%</span>
      </div>
      <div style={{ height: 5, background: "var(--gray-200)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: col, borderRadius: 3 }} />
      </div>
    </div>
  );
}

export default function WhatIfResult({ sim }: { sim: Simulation }) {
  const fits = sim.would_fit;
  const capacityFits = Object.values(sim.projected).every(p => p.fits !== false);
  const color = fits ? "var(--green)" : "var(--red)";
  const headline = fits ? "✓ Fits"
    : !capacityFits && sim.quota_fits === false ? "✗ Not enough capacity, and over the tenant's quota"
    : !capacityFits ? "✗ Not enough capacity" : "✗ Over the tenant's quota";
  return (
    <div style={{ background: fits ? "var(--green-light)" : "var(--red-light)", borderRadius: 5, padding: "7px 10px" }}>
      <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 5 }}>{headline}</div>
      {(["vcpus", "ram_gb", "storage_gb"] as const).map(key => {
        const p = sim.projected[key];
        const pct = p.total ? Math.round((p.used / p.total) * 100) : 0;
        const detail = p.total == null ? `${Math.round(p.used)} · capacity unknown`
          : `${Math.round(p.used)} of ${Math.round(p.total)}`;
        return <Bar key={key} label={LABELS[key]} pct={pct} fits={p.fits !== false} detail={detail} />;
      })}
      {sim.quota && sim.quota.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--gray-600)", margin: "8px 0 3px" }}>Tenant quota</div>
          {sim.quota.map(q => {
            const unlimited = q.limit == null || q.limit < 0;
            const pct = unlimited || !q.limit ? 0 : Math.round((q.after / q.limit) * 100);
            return (
              <Bar key={q.resource} label={q.label} pct={pct} fits={q.fits}
                detail={unlimited ? `${q.after} · unlimited` : `${q.after} of ${q.limit}`} />
            );
          })}
        </>
      )}
      {sim.quota_error && <div style={{ fontSize: 11, color: "var(--yellow)", marginTop: 4 }}>{sim.quota_error}</div>}
    </div>
  );
}
