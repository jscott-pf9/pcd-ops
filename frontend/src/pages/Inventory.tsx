import { type ComponentType, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import * as XLSX from "xlsx";
import { apiFetch } from "../api/client";
import DataFreshness from "../components/DataFreshness";
import { useCtx } from "./inventory/details/common";
import { EXPORTS } from "./inventory/exports";
import { fetchInventory, isKind, KINDS, type Kind, TAB_ORDER, useInventory } from "./inventory/kinds";
import { StatCard, type TableProps } from "./inventory/shared";
import { ClustersTable, FlavorsTable, HypervisorsTable, ServerGroupsTable, ServersTable } from "./inventory/tables/compute";
import { FloatingIpsTable, NetworksTable, SecurityGroupsTable } from "./inventory/tables/network";
import { ImagesTable, StorageBackendsTable, StorageTypesTable, VolumesTable } from "./inventory/tables/storage";

interface Summary {
  servers: { total: number; active: number };
  hypervisors: { total: number };
  volumes: { total: number; total_tb: number };
  networks: { total: number };
  clusters: { total: number };
  vcpus: { used: number; total: number };
  memory_gb: { used: number; total: number };
}

const TABLES: Record<Kind, ComponentType<TableProps>> = {
  clusters: ClustersTable,
  hypervisors: HypervisorsTable,
  servers: ServersTable,
  flavors: FlavorsTable,
  server_groups: ServerGroupsTable,
  volumes: VolumesTable,
  storage_backends: StorageBackendsTable,
  storage_types: StorageTypesTable,
  networks: NetworksTable,
  floating_ips: FloatingIpsTable,
  images: ImagesTable,
  security_groups: SecurityGroupsTable,
};

export default function Inventory() {
  // Tab, filter and tenant live in the URL, so Back from a detail page returns to them.
  const [params, setParams] = useSearchParams();
  const tab: Kind = isKind(params.get("tab")) ? (params.get("tab") as Kind) : "clusters";
  const search = params.get("q") ?? "";
  const tenantFilter = KINDS[tab].tenantField ? params.get("tenant") ?? "" : "";
  const set = (changes: Record<string, string>) => setParams(p => {
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    return p;
  }, { replace: true });

  const [exportingAll, setExportingAll] = useState(false);
  const ctx = useCtx();
  const summary = useQuery({ queryKey: ["inventory", "summary"], queryFn: () => apiFetch<Summary>("/inventory/summary") });
  const list = useInventory(tab);
  const s = summary.data;

  async function handleExportAll() {
    setExportingAll(true);
    try {
      const lists = await Promise.all(TAB_ORDER.map(k => fetchInventory(k).catch(() => [] as any[])));
      const wb = XLSX.utils.book_new();
      TAB_ORDER.forEach((k, i) => {
        for (const sheet of EXPORTS[k]) {
          const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows(lists[i], ctx)]);
          XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
        }
      });
      XLSX.writeFile(wb, "inventory.xlsx");
    } finally {
      setExportingAll(false);
    }
  }

  const tenantList = Array.from(new Map(Array.from(new Set((list.data ?? [])
      .map(r => r[KINDS[tab].tenantField ?? ""]).filter(Boolean)))
      .map(id => [id as string, ctx.tenant(id as string)])).entries())
    .sort((a, b) => a[1].localeCompare(b[1]));

  const Table = TABLES[tab];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Inventory</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DataFreshness domainKey="inventory:summary" />
          <button className="btn btn-secondary btn-sm" onClick={handleExportAll} disabled={exportingAll}
            style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Download size={12} /> {exportingAll ? "Exporting…" : "Export All"}
          </button>
        </div>
      </div>

      {s && (
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
          <StatCard label="VMs"         value={`${s.servers.active} / ${s.servers.total}`}       sub="active / total" accent="var(--blue-primary)" />
          <StatCard label="Hypervisors" value={String(s.hypervisors.total)}                       accent="var(--purple)" />
          <StatCard label="vCPUs"       value={`${s.vcpus.used} / ${s.vcpus.total}`}             sub="allocated / total" accent="var(--blue-primary)" />
          <StatCard label="Memory"      value={`${s.memory_gb.used} / ${s.memory_gb.total} GB`}  sub="allocated / total" accent="var(--green)" />
          <StatCard label="Volumes"     value={String(s.volumes.total)}                           sub={`${s.volumes.total_tb} TB`} accent="var(--yellow)" />
          <StatCard label="Networks"    value={String(s.networks.total)}                          accent="var(--red)" />
          {s.clusters && <StatCard label="Clusters & aggregates" value={String(s.clusters.total)} accent="var(--purple)" />}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <div className="tabs" style={{ marginBottom: 0, flex: 1, flexWrap: "wrap" }}>
          {TAB_ORDER.map(k => (
            <button key={k} className={`tab${tab === k ? " active" : ""}`}
              onClick={() => set({ tab: k, q: "", tenant: "", type: "" })}>
              {KINDS[k].label}
            </button>
          ))}
        </div>
        {KINDS[tab].tenantField && (
          <select className="form-select" value={tenantFilter} onChange={e => set({ tenant: e.target.value })}
            style={{ fontSize: 12, height: "auto", width: "auto" }}>
            <option value="">All tenants</option>
            {tenantList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <input className="form-input" placeholder="Filter…" value={search}
          onChange={e => set({ q: e.target.value })} style={{ width: 200, fontSize: 12 }} />
      </div>

      <Table data={list.data} isLoading={list.isLoading} search={search} tenantFilter={tenantFilter} ctx={ctx} />
    </div>
  );
}
