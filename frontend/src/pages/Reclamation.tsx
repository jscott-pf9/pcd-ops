import React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";
import DataFreshness from "../components/DataFreshness";

export default function Reclamation() {
  const { data, isLoading } = useQuery({
    queryKey: ["reclamation", "candidates"],
    queryFn: () => apiFetch<any>("/reclamation/candidates"),
  });

  const tenants = useTenants();
  const stoppedCount = data?.stopped_servers.length ?? 0;
  const volumeCount = data?.unattached_volumes.length ?? 0;
  const fipCount = data?.unused_floating_ips.length ?? 0;
  const totalGb = data?.unattached_volumes.reduce((sum: number, v: any) => sum + (v.size ?? 0), 0) ?? 0;
  const stoppedDiskGb = data?.stopped_servers.reduce((sum: number, s: any) => sum + (s.attached_disk_gb ?? 0), 0) ?? 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Resource Reclamation</h1>
        <DataFreshness domainKey="reclamation:candidates" />
      </div>

      {isLoading && !data && <p className="text-muted" style={{ marginBottom: "1.5rem" }}>Waiting for first collection…</p>}

      {data && (
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          <StatCard label="Stopped Servers" value={String(stoppedCount)} sub={stoppedDiskGb > 0 ? `${stoppedDiskGb} GB attached` : undefined} accent="var(--yellow)" />
          <StatCard label="Unattached Volumes" value={String(volumeCount)} sub={`${totalGb} GB recoverable`} accent="var(--red)" />
          <StatCard label="Unused Floating IPs" value={String(fipCount)} accent="var(--purple)" />
        </div>
      )}

      {data && (
        <>
          <StoppedServersSection items={data.stopped_servers} tenants={tenants} />
          <UnattachedVolumesSection items={data.unattached_volumes} tenants={tenants} />
          <Section title={`Unused Floating IPs (${fipCount})`} items={data.unused_floating_ips} labelKey="floating_ip_address" subKey={(fip) => tenants.get(fip.project_id) ?? fip.project_id?.slice(0, 8) + "…"} />
        </>
      )}
    </div>
  );
}

function offlineDuration(updatedAt: string): string {
  if (!updatedAt) return "—";
  const ms = Date.now() - new Date(updatedAt).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d offline`;
  const hours = Math.floor(ms / 3_600_000);
  return `${hours}h offline`;
}

function StoppedServersSection({ items, tenants }: { items: any[]; tenants: Map<string, string> }) {
  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div className="card-header">
        <span className="card-title">Stopped Servers ({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="card-body"><p className="text-muted">None found.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Offline Since</th>
                <th>Attached Disks</th>
                <th>Tenant</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td><span className="badge badge-neutral">{s.status}</span></td>
                  <td>
                    <div>{s.updated_at ? new Date(s.updated_at).toLocaleDateString() : "—"}</div>
                    <div className="text-muted" style={{ fontSize: 11 }}>{offlineDuration(s.updated_at)}</div>
                  </td>
                  <td>{s.attached_disk_gb > 0 ? `${s.attached_disk_gb} GB` : <span className="text-muted">—</span>}</td>
                  <td>{tenants.get(s.project_id) ?? <span className="text-mono">{s.project_id?.slice(0, 8)}…</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnattachedVolumesSection({ items, tenants }: { items: any[]; tenants: Map<string, string> }) {
  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div className="card-header">
        <span className="card-title">Unattached Volumes ({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="card-body"><p className="text-muted">None found.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Backend Type</th>
                <th>AZ</th>
                <th>Bootable</th>
                <th>Created</th>
                <th>Unattached Since</th>
                <th>UUID</th>
                <th>Tenant</th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>{v.name}</strong>
                    {v.description && <div className="text-muted" style={{ fontSize: 11 }}>{v.description}</div>}
                  </td>
                  <td>{v.size} GB</td>
                  <td>{v.volume_type || <span className="text-muted">—</span>}</td>
                  <td>{v.availability_zone || <span className="text-muted">—</span>}</td>
                  <td>{v.is_bootable
                    ? <span className="badge badge-info">bootable</span>
                    : <span className="text-muted">—</span>}
                  </td>
                  <td>
                    <div>{v.created_at ? new Date(v.created_at).toLocaleDateString() : "—"}</div>
                    <div className="text-muted" style={{ fontSize: 11 }}>{ageDays(v.created_at)}</div>
                  </td>
                  <td>{unattachedSince(v.updated_at, v.created_at)}</td>
                  <td className="text-mono" style={{ fontSize: 11 }}>{v.id}</td>
                  <td>{tenants.get(v.project_id) ?? <span className="text-mono">{v.project_id?.slice(0, 8)}…</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ageDays(iso: string): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return `${days}d ago`;
}

function unattachedSince(updatedAt: string, createdAt: string): React.ReactNode {
  if (!updatedAt) return <span className="text-muted">—</span>;
  const updMs = new Date(updatedAt).getTime();
  const creMs = new Date(createdAt).getTime();
  const days = Math.floor((Date.now() - updMs) / 86_400_000);
  // If updated_at is within 60s of created_at the volume was likely never attached
  const neverAttached = Math.abs(updMs - creMs) < 60_000;
  return (
    <div>
      <div>{new Date(updatedAt).toLocaleDateString()}</div>
      <div className="text-muted" style={{ fontSize: 11 }}>
        {neverAttached ? "never attached" : `${days}d unattached`}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="stat-card" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}

function Section({ title, items, labelKey, subKey }: { title: string; items: any[]; labelKey: string; subKey: string | ((item: any) => string) }) {
  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div className="card-header">
        <span className="card-title">{title}</span>
      </div>
      {items.length === 0 ? (
        <div className="card-body">
          <p className="text-muted">None found.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item[labelKey]}</strong></td>
                  <td className="text-muted">{typeof subKey === "function" ? subKey(item) : item[subKey]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
