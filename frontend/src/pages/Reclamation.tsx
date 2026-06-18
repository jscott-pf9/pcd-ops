import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ArrowDown, ArrowUpDown, Trash2 } from "lucide-react";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";
import DataFreshness from "../components/DataFreshness";

interface StoppedServer {
  id: string; name: string; status: string; project_id: string;
  updated_at: string; attached_disk_gb: number; vcpus: number; ram_mb: number;
}

interface UnattachedVolume {
  id: string; name: string; size: number; volume_type: string;
  availability_zone: string; is_bootable: boolean; description: string;
  project_id: string; created_at: string; updated_at: string;
}

interface FloatingIp {
  id: string; floating_ip_address: string; project_id: string;
}

// ── Sortable column hook ───────────────────────────────────────────────────────

function useSort<T>(data: T[]) {
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const sorted = useMemo(() => {
    if (!sort || !data.length) return data;
    return [...data].sort((a, b) => {
      const av = (a as any)[sort.field] ?? "";
      const bv = (b as any)[sort.field] ?? "";
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [data, sort]);
  const toggle = (field: string) =>
    setSort(s => s?.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" });
  return { sorted, sort, toggle };
}

function SortTh({ label, field, sort, toggle }: {
  label: string; field: string;
  sort: { field: string; dir: "asc" | "desc" } | null;
  toggle: (f: string) => void;
}) {
  const active = sort?.field === field;
  return (
    <th onClick={() => toggle(field)} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label}
        {active
          ? sort!.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />
          : <ArrowUpDown size={11} style={{ opacity: 0.3 }} />}
      </span>
    </th>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ageInDays(iso: string): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function offlineDuration(updatedAt: string): string {
  if (!updatedAt) return "—";
  const ms = Date.now() - new Date(updatedAt).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d offline`;
  const hours = Math.floor(ms / 3_600_000);
  return `${hours}h offline`;
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Reclamation() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["reclamation", "candidates"],
    queryFn: () => apiFetch<any>("/reclamation/candidates"),
  });
  const tenants = useTenants();

  const [tenantFilter, setTenantFilter] = useState("");
  const [minAgeDays, setMinAgeDays] = useState(0);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [selectedVolumes, setSelectedVolumes] = useState<Set<string>>(new Set());
  const [selectedFips, setSelectedFips] = useState<Set<string>>(new Set());

  const deleteServer = useMutation({
    mutationFn: (id: string) => apiFetch(`/reclamation/servers/${id}`, { method: "DELETE" }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(["reclamation", "candidates"], (old: any) =>
        old ? { ...old, stopped_servers: old.stopped_servers.filter((s: any) => s.id !== id) } : old
      );
    },
    onError: (err: Error) => alert(`Delete failed: ${err.message}`),
  });

  const deleteVolume = useMutation({
    mutationFn: (id: string) => apiFetch(`/reclamation/volumes/${id}`, { method: "DELETE" }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(["reclamation", "candidates"], (old: any) =>
        old ? { ...old, unattached_volumes: old.unattached_volumes.filter((v: any) => v.id !== id) } : old
      );
    },
    onError: (err: Error) => alert(`Delete failed: ${err.message}`),
  });

  const releaseFip = useMutation({
    mutationFn: (id: string) => apiFetch(`/reclamation/floating_ips/${id}`, { method: "DELETE" }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(["reclamation", "candidates"], (old: any) =>
        old ? { ...old, unused_floating_ips: old.unused_floating_ips.filter((f: any) => f.id !== id) } : old
      );
    },
    onError: (err: Error) => alert(`Release failed: ${err.message}`),
  });

  const tenantIds = useMemo(() =>
    [...new Set([
      ...(data?.stopped_servers ?? []).map((s: any) => s.project_id),
      ...(data?.unattached_volumes ?? []).map((v: any) => v.project_id),
      ...(data?.unused_floating_ips ?? []).map((f: any) => f.project_id),
    ].filter(Boolean))],
    [data]);

  const filteredServers = useMemo<StoppedServer[]>(() =>
    (data?.stopped_servers ?? []).filter((s: StoppedServer) =>
      (!tenantFilter || s.project_id === tenantFilter) &&
      ageInDays(s.updated_at) >= minAgeDays
    ), [data, tenantFilter, minAgeDays]);

  const filteredVolumes = useMemo<UnattachedVolume[]>(() =>
    (data?.unattached_volumes ?? []).filter((v: UnattachedVolume) =>
      (!tenantFilter || v.project_id === tenantFilter) &&
      ageInDays(v.created_at) >= minAgeDays
    ), [data, tenantFilter, minAgeDays]);

  const filteredFips = useMemo<FloatingIp[]>(() =>
    (data?.unused_floating_ips ?? []).filter((f: FloatingIp) =>
      !tenantFilter || f.project_id === tenantFilter
    ), [data, tenantFilter]);

  const totalVcpus = useMemo(() => filteredServers.reduce((s, srv) => s + (srv.vcpus ?? 0), 0), [filteredServers]);
  const totalRamGb = useMemo(() => Math.round(filteredServers.reduce((s, srv) => s + (srv.ram_mb ?? 0), 0) / 1024), [filteredServers]);
  const stoppedDiskGb = useMemo(() => filteredServers.reduce((s, srv) => s + (srv.attached_disk_gb ?? 0), 0), [filteredServers]);
  const totalVolumeGb = useMemo(() => filteredVolumes.reduce((s, v) => s + (v.size ?? 0), 0), [filteredVolumes]);

  function toggleOne(setFn: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setFn(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll(set: Set<string>, setFn: React.Dispatch<React.SetStateAction<Set<string>>>, ids: string[]) {
    const allSelected = ids.length > 0 && ids.every(id => set.has(id));
    setFn(allSelected ? new Set() : new Set(ids));
  }

  async function handleBulkReclaim() {
    const parts = [
      selectedServers.size && `${selectedServers.size} server(s)`,
      selectedVolumes.size && `${selectedVolumes.size} volume(s)`,
      selectedFips.size && `${selectedFips.size} floating IP(s)`,
    ].filter(Boolean).join(", ");
    if (!confirm(`Permanently reclaim ${parts}? This cannot be undone.`)) return;

    const serverIds = [...selectedServers];
    const volumeIds = [...selectedVolumes];
    const fipIds = [...selectedFips];
    const allIds = [...serverIds, ...volumeIds, ...fipIds];

    const results = await Promise.allSettled([
      ...serverIds.map(id => apiFetch(`/reclamation/servers/${id}`, { method: "DELETE" })),
      ...volumeIds.map(id => apiFetch(`/reclamation/volumes/${id}`, { method: "DELETE" })),
      ...fipIds.map(id => apiFetch(`/reclamation/floating_ips/${id}`, { method: "DELETE" })),
    ]);

    const succeededIds = new Set(allIds.filter((_, i) => results[i].status === "fulfilled"));
    const failures = results.filter(r => r.status === "rejected");

    if (failures.length > 0) {
      const msgs = failures.map(f => (f as PromiseRejectedResult).reason?.message ?? "Unknown error");
      alert(`${failures.length} of ${allIds.length} operations failed:\n${msgs.join("\n")}`);
    }

    queryClient.setQueryData(["reclamation", "candidates"], (old: any) => {
      if (!old) return old;
      return {
        ...old,
        stopped_servers: old.stopped_servers.filter((s: any) => !succeededIds.has(s.id)),
        unattached_volumes: old.unattached_volumes.filter((v: any) => !succeededIds.has(v.id)),
        unused_floating_ips: old.unused_floating_ips.filter((f: any) => !succeededIds.has(f.id)),
      };
    });

    setSelectedServers(new Set());
    setSelectedVolumes(new Set());
    setSelectedFips(new Set());
  }

  function changeTenantFilter(val: string) {
    setTenantFilter(val);
    setSelectedServers(new Set());
    setSelectedVolumes(new Set());
    setSelectedFips(new Set());
  }

  const totalSelected = selectedServers.size + selectedVolumes.size + selectedFips.size;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Resource Reclamation</h1>
        <DataFreshness domainKey="reclamation:candidates" />
      </div>

      {isLoading && !data && <p className="text-muted" style={{ marginBottom: "1.5rem" }}>Waiting for first collection…</p>}

      {data && (
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          <StatCard label="Stopped Servers" value={String(filteredServers.length)} sub={stoppedDiskGb > 0 ? `${stoppedDiskGb} GB attached` : undefined} accent="var(--yellow)" />
          <StatCard label="vCPUs Recoverable" value={String(totalVcpus)} accent="var(--blue, #0ea5e9)" />
          <StatCard label="RAM Recoverable" value={`${totalRamGb} GB`} accent="var(--blue, #0ea5e9)" />
          <StatCard label="Unattached Storage" value={`${totalVolumeGb} GB`} sub={`${filteredVolumes.length} volume(s)`} accent="var(--red)" />
          <StatCard label="Unused Floating IPs" value={String(filteredFips.length)} accent="var(--purple)" />
        </div>
      )}

      {data && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <select
            className="form-select"
            style={{ width: 220 }}
            value={tenantFilter}
            onChange={e => changeTenantFilter(e.target.value)}
          >
            <option value="">All Tenants</option>
            {tenantIds.map(id => (
              <option key={id} value={id}>{tenants.get(id) ?? id}</option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, margin: 0 }}>
            Min age
            <input
              className="form-input"
              type="number"
              min={0}
              style={{ width: 70 }}
              value={minAgeDays || ""}
              onChange={e => setMinAgeDays(Number(e.target.value) || 0)}
              placeholder="days"
            />
            days
          </label>
          {totalSelected > 0 && (
            <button
              className="btn btn-danger btn-sm"
              style={{ marginLeft: "auto" }}
              onClick={handleBulkReclaim}
            >
              <Trash2 size={13} style={{ marginRight: 4 }} />
              Reclaim Selected ({totalSelected})
            </button>
          )}
        </div>
      )}

      {data && (
        <>
          <StoppedServersSection
            items={filteredServers}
            tenants={tenants}
            selected={selectedServers}
            onToggle={id => toggleOne(setSelectedServers, id)}
            onToggleAll={ids => toggleAll(selectedServers, setSelectedServers, ids)}
            onDelete={(id, name) => {
              if (confirm(`Permanently delete server "${name}"? This cannot be undone.`))
                deleteServer.mutate(id);
            }}
          />
          <UnattachedVolumesSection
            items={filteredVolumes}
            tenants={tenants}
            selected={selectedVolumes}
            onToggle={id => toggleOne(setSelectedVolumes, id)}
            onToggleAll={ids => toggleAll(selectedVolumes, setSelectedVolumes, ids)}
            onDelete={(id, name) => {
              if (confirm(`Permanently delete volume "${name}"? This cannot be undone.`))
                deleteVolume.mutate(id);
            }}
          />
          <UnusedFipsSection
            items={filteredFips}
            tenants={tenants}
            selected={selectedFips}
            onToggle={id => toggleOne(setSelectedFips, id)}
            onToggleAll={ids => toggleAll(selectedFips, setSelectedFips, ids)}
            onRelease={(id, addr) => {
              if (confirm(`Release floating IP ${addr} back to the pool? This cannot be undone.`))
                releaseFip.mutate(id);
            }}
          />
        </>
      )}
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function StoppedServersSection({ items, tenants, selected, onToggle, onToggleAll, onDelete }: {
  items: StoppedServer[];
  tenants: Map<string, string>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const { sorted, sort, toggle } = useSort<StoppedServer>(items);
  const allSelected = items.length > 0 && items.every(s => selected.has(s.id));
  const someSelected = items.some(s => selected.has(s.id));

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
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={() => onToggleAll(items.map(s => s.id))}
                  />
                </th>
                <SortTh label="Name" field="name" sort={sort} toggle={toggle} />
                <th>Status</th>
                <SortTh label="Offline Since" field="updated_at" sort={sort} toggle={toggle} />
                <SortTh label="Attached Disks" field="attached_disk_gb" sort={sort} toggle={toggle} />
                <SortTh label="vCPUs" field="vcpus" sort={sort} toggle={toggle} />
                <SortTh label="RAM" field="ram_mb" sort={sort} toggle={toggle} />
                <th>Tenant</th>
                <th style={{ width: 48 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(s => (
                <tr key={s.id} style={selected.has(s.id) ? { background: "var(--row-selected, rgba(99,102,241,0.08))" } : undefined}>
                  <td><input type="checkbox" checked={selected.has(s.id)} onChange={() => onToggle(s.id)} /></td>
                  <td><strong>{s.name}</strong></td>
                  <td><span className="badge badge-neutral">{s.status}</span></td>
                  <td>
                    <div>{s.updated_at ? new Date(s.updated_at).toLocaleDateString() : "—"}</div>
                    <div className="text-muted" style={{ fontSize: 11 }}>{offlineDuration(s.updated_at)}</div>
                  </td>
                  <td>{s.attached_disk_gb > 0 ? `${s.attached_disk_gb} GB` : <span className="text-muted">—</span>}</td>
                  <td>{s.vcpus > 0 ? s.vcpus : <span className="text-muted">—</span>}</td>
                  <td>{s.ram_mb > 0 ? `${Math.round(s.ram_mb / 1024)} GB` : <span className="text-muted">—</span>}</td>
                  <td>{tenants.get(s.project_id) ?? <span className="text-mono">{s.project_id?.slice(0, 8)}…</span>}</td>
                  <td>
                    <button className="btn btn-sm btn-danger" title="Delete server" onClick={() => onDelete(s.id, s.name)}>
                      <Trash2 size={13} />
                    </button>
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

function UnattachedVolumesSection({ items, tenants, selected, onToggle, onToggleAll, onDelete }: {
  items: UnattachedVolume[];
  tenants: Map<string, string>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const { sorted, sort, toggle } = useSort<UnattachedVolume>(items);
  const allSelected = items.length > 0 && items.every(v => selected.has(v.id));
  const someSelected = items.some(v => selected.has(v.id));

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
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={() => onToggleAll(items.map(v => v.id))}
                  />
                </th>
                <SortTh label="Name" field="name" sort={sort} toggle={toggle} />
                <SortTh label="Size" field="size" sort={sort} toggle={toggle} />
                <th>Backend Type</th>
                <th>AZ</th>
                <th>Bootable</th>
                <SortTh label="Created" field="created_at" sort={sort} toggle={toggle} />
                <SortTh label="Unattached Since" field="updated_at" sort={sort} toggle={toggle} />
                <th>UUID</th>
                <th>Tenant</th>
                <th style={{ width: 48 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(v => (
                <tr key={v.id} style={selected.has(v.id) ? { background: "var(--row-selected, rgba(99,102,241,0.08))" } : undefined}>
                  <td><input type="checkbox" checked={selected.has(v.id)} onChange={() => onToggle(v.id)} /></td>
                  <td>
                    <strong>{v.name}</strong>
                    {v.description && <div className="text-muted" style={{ fontSize: 11 }}>{v.description}</div>}
                  </td>
                  <td>{v.size} GB</td>
                  <td>{v.volume_type || <span className="text-muted">—</span>}</td>
                  <td>{v.availability_zone || <span className="text-muted">—</span>}</td>
                  <td>{v.is_bootable ? <span className="badge badge-info">bootable</span> : <span className="text-muted">—</span>}</td>
                  <td>
                    <div>{v.created_at ? new Date(v.created_at).toLocaleDateString() : "—"}</div>
                    <div className="text-muted" style={{ fontSize: 11 }}>{ageDays(v.created_at)}</div>
                  </td>
                  <td>{unattachedSince(v.updated_at, v.created_at)}</td>
                  <td className="text-mono" style={{ fontSize: 11 }}>{v.id}</td>
                  <td>{tenants.get(v.project_id) ?? <span className="text-mono">{v.project_id?.slice(0, 8)}…</span>}</td>
                  <td>
                    <button className="btn btn-sm btn-danger" title="Delete volume" onClick={() => onDelete(v.id, v.name)}>
                      <Trash2 size={13} />
                    </button>
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

function UnusedFipsSection({ items, tenants, selected, onToggle, onToggleAll, onRelease }: {
  items: FloatingIp[];
  tenants: Map<string, string>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onRelease: (id: string, addr: string) => void;
}) {
  const allSelected = items.length > 0 && items.every(f => selected.has(f.id));
  const someSelected = items.some(f => selected.has(f.id));

  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div className="card-header">
        <span className="card-title">Unused Floating IPs ({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="card-body"><p className="text-muted">None found.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={() => onToggleAll(items.map(f => f.id))}
                  />
                </th>
                <th>IP Address</th>
                <th>Tenant</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(fip => (
                <tr key={fip.id} style={selected.has(fip.id) ? { background: "var(--row-selected, rgba(99,102,241,0.08))" } : undefined}>
                  <td><input type="checkbox" checked={selected.has(fip.id)} onChange={() => onToggle(fip.id)} /></td>
                  <td><strong>{fip.floating_ip_address}</strong></td>
                  <td>{tenants.get(fip.project_id) ?? <span className="text-mono">{fip.project_id?.slice(0, 8)}…</span>}</td>
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={() => onRelease(fip.id, fip.floating_ip_address)}>
                      Release
                    </button>
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

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="stat-card" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}
