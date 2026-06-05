import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, ArrowUp, ArrowDown, Download, X, AlertTriangle, Shield } from "lucide-react";
import { Cell, Pie, PieChart, Tooltip as RTooltip } from "recharts";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";
import DataFreshness from "../components/DataFreshness";

// ── Types ──────────────────────────────────────────────────────────────────────

type Tab = "servers" | "hypervisors" | "volumes" | "networks" | "floating_ips" | "images" | "security_groups";

interface Summary {
  servers: { total: number; active: number };
  hypervisors: { total: number };
  volumes: { total: number; total_tb: number };
  networks: { total: number };
  vcpus: { used: number; total: number };
  memory_gb: { used: number; total: number };
}

// ── Shared utilities ───────────────────────────────────────────────────────────

function filterRows(data: any[] | undefined, search: string, tenantFilter: string, fields: string[]): any[] {
  if (!data) return [];
  let rows = data;
  if (tenantFilter) rows = rows.filter(r => r.project_id === tenantFilter || r.owner === tenantFilter);
  if (!search) return rows;
  const q = search.toLowerCase();
  return rows.filter(r => fields.some(f => String(r[f] ?? "").toLowerCase().includes(q)));
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function fmtSize(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb} GB`;
}

function exportCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
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

// ── Detail Drawer ──────────────────────────────────────────────────────────────

function DetailDrawer({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: 420, zIndex: 100,
      background: "#fff", borderLeft: "1px solid var(--gray-200)",
      boxShadow: "-8px 0 32px rgba(0,0,0,.12)", display: "flex", flexDirection: "column",
    }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--gray-100)",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--gray-900)" }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "var(--gray-500)", marginTop: 2 }}>{subtitle}</div>}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gray-400)", marginTop: 2 }}>
          <X size={18} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
        {children}
      </div>
    </div>
  );
}

function DrawerRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12,
      padding: "6px 0", borderBottom: "1px solid var(--gray-50)", fontSize: 12 }}>
      <span style={{ color: "var(--gray-500)", flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--gray-900)", textAlign: "right", wordBreak: "break-all" }}>{value || "—"}</span>
    </div>
  );
}

// ── Badge helpers ──────────────────────────────────────────────────────────────

const BADGE_CLASS: Record<string, string> = {
  ACTIVE: "badge-active", UP: "badge-active", ENABLED: "badge-active", ACTIVE_VM: "badge-active",
  IN_USE: "badge-info", AVAILABLE: "badge-info", PUBLIC: "badge-info",
  BUILD: "badge-provisioning",
  SHUTOFF: "badge-neutral", STOPPED: "badge-neutral", PRIVATE: "badge-neutral",
  DISABLED: "badge-warn", DEACTIVATED: "badge-warn",
  DOWN: "badge-error", ERROR: "badge-error", DELETED: "badge-error",
};

function StatusBadge({ status }: { status: string }) {
  const cls = BADGE_CLASS[status?.toUpperCase()] ?? "badge-neutral";
  return <span className={`badge ${cls}`}>{status}</span>;
}

function Pill({ on, yes = "Yes", no = "No" }: { on: boolean; yes?: string; no?: string }) {
  return <span className={on ? "text-success" : "text-muted"} style={{ fontWeight: 600, fontSize: "0.8rem" }}>{on ? yes : no}</span>;
}

function UsageBar({ used, total, label, gbConvert }: { used: number; total: number; label: string; gbConvert?: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const disp = gbConvert ? `${Math.round(used / 1024)}/${Math.round(total / 1024)} GB` : `${used}/${total} ${label}`;
  const fill = pct > 85 ? "var(--red)" : pct > 65 ? "var(--yellow)" : "var(--green)";
  return (
    <div className="usage-bar">
      <div className="usage-bar-text">{disp}</div>
      <div className="usage-bar-track"><div className="usage-bar-fill" style={{ width: `${pct}%`, background: fill }} /></div>
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

// ── Table wrapper ──────────────────────────────────────────────────────────────

function TableWrap({ isLoading, total, filtered, onExport, exportLabel, children }: {
  isLoading: boolean; total?: number; filtered: number;
  onExport?: () => void; exportLabel?: string;
  children: React.ReactNode;
}) {
  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (!total) return <p className="text-muted">No data yet — waiting for collection.</p>;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span className="text-muted" style={{ fontSize: 12 }}>
          {filtered < total ? `${filtered} of ${total}` : `${total} total`}
        </span>
        {onExport && (
          <button className="btn btn-secondary btn-sm" onClick={onExport}
            style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Download size={12} /> {exportLabel ?? "Export CSV"}
          </button>
        )}
      </div>
      <div className="card table-wrap"><table><tbody>{children}</tbody></table></div>
    </>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: "servers",         label: "Servers"         },
  { id: "hypervisors",     label: "Hypervisors"     },
  { id: "volumes",         label: "Volumes"         },
  { id: "networks",        label: "Networks"        },
  { id: "floating_ips",    label: "Floating IPs"    },
  { id: "images",          label: "Images"          },
  { id: "security_groups", label: "Security Groups" },
];

const CHART_COLORS = ["var(--blue-primary)","var(--purple)","var(--green)","var(--yellow)","var(--red)","#0891B2","#7C3AED","#059669"];

export default function Inventory() {
  const [tab,          setTab]          = useState<Tab>("servers");
  const [search,       setSearch]       = useState("");
  const [tenantFilter, setTenantFilter] = useState("");
  const tenants = useTenants();

  const summary      = useQuery({ queryKey: ["inventory","summary"],        queryFn: () => apiFetch<Summary>("/inventory/summary") });
  const servers      = useQuery({ queryKey: ["inventory","servers"],        queryFn: () => apiFetch<any[]>("/inventory/servers"),        enabled: tab==="servers" });
  const hypervisors  = useQuery({ queryKey: ["inventory","hypervisors"],    queryFn: () => apiFetch<any[]>("/inventory/hypervisors"),    enabled: tab==="hypervisors" });
  const volumes      = useQuery({ queryKey: ["inventory","volumes"],        queryFn: () => apiFetch<any[]>("/inventory/volumes"),        enabled: tab==="volumes" });
  const networks     = useQuery({ queryKey: ["inventory","networks"],       queryFn: () => apiFetch<any[]>("/inventory/networks"),       enabled: tab==="networks" });
  const floatingIps  = useQuery({ queryKey: ["inventory","floating_ips"],   queryFn: () => apiFetch<any[]>("/inventory/floating_ips"),   enabled: tab==="floating_ips" });
  const images       = useQuery({ queryKey: ["inventory","images"],         queryFn: () => apiFetch<any[]>("/inventory/images"),         enabled: tab==="images" });
  const secGroups    = useQuery({ queryKey: ["inventory","security_groups"],queryFn: () => apiFetch<any[]>("/inventory/security_groups"),enabled: tab==="security_groups" });

  const s = summary.data;

  // Tenant list for filter (non-hidden)
  const tenantList = Array.from(tenants.entries())
    .filter(([, name]) => !["admin", "service"].includes(name.toLowerCase()))
    .sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Inventory</h1>
        <DataFreshness domainKey="inventory:summary" />
      </div>

      {/* Summary stat cards */}
      {s && (
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
          <StatCard label="VMs"        value={`${s.servers.active} / ${s.servers.total}`}       sub="active / total" accent="var(--blue-primary)" />
          <StatCard label="Hypervisors"value={String(s.hypervisors.total)}                       accent="var(--purple)" />
          <StatCard label="vCPUs"      value={`${s.vcpus.used} / ${s.vcpus.total}`}             sub="used / total"   accent="var(--blue-primary)" />
          <StatCard label="Memory"     value={`${s.memory_gb.used} / ${s.memory_gb.total} GB`}  sub="used / total"   accent="var(--green)" />
          <StatCard label="Volumes"    value={String(s.volumes.total)}                           sub={`${s.volumes.total_tb} TB`} accent="var(--yellow)" />
          <StatCard label="Networks"   value={String(s.networks.total)}                          accent="var(--red)" />
        </div>
      )}

      {/* Tabs + Tenant filter + Search */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <div className="tabs" style={{ marginBottom: 0, flex: 1 }}>
          {TABS.map(t => (
            <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => { setTab(t.id); setSearch(""); }}>
              {t.label}
            </button>
          ))}
        </div>
        <select className="form-select" value={tenantFilter} onChange={e => setTenantFilter(e.target.value)}
          style={{ fontSize: 12, height: "auto", width: "auto" }}>
          <option value="">All tenants</option>
          {tenantList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <input className="form-input" placeholder={`Filter…`} value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 200, fontSize: 12 }} />
      </div>

      {tab === "servers"         && <ServersTable         data={servers.data}     isLoading={servers.isLoading}     search={search} tenantFilter={tenantFilter} tenants={tenants} />}
      {tab === "hypervisors"     && <HypervisorsTable     data={hypervisors.data} isLoading={hypervisors.isLoading} search={search} servers={servers.data} />}
      {tab === "volumes"         && <VolumesTable         data={volumes.data}     isLoading={volumes.isLoading}     search={search} tenantFilter={tenantFilter} tenants={tenants} />}
      {tab === "networks"        && <NetworksTable        data={networks.data}    isLoading={networks.isLoading}    search={search} tenantFilter={tenantFilter} tenants={tenants} />}
      {tab === "floating_ips"    && <FloatingIpsTable     data={floatingIps.data} isLoading={floatingIps.isLoading} search={search} tenantFilter={tenantFilter} tenants={tenants} />}
      {tab === "images"          && <ImagesTable          data={images.data}      isLoading={images.isLoading}      search={search} tenantFilter={tenantFilter} tenants={tenants} />}
      {tab === "security_groups" && <SecurityGroupsTable  data={secGroups.data}   isLoading={secGroups.isLoading}   search={search} tenantFilter={tenantFilter} tenants={tenants} />}
    </div>
  );
}

// ── Servers ────────────────────────────────────────────────────────────────────

function ServersTable({ data, isLoading, search, tenantFilter, tenants }: any) {
  const rows = filterRows(data, search, tenantFilter, ["name","status","project_id","flavor_name","hypervisor_hostname"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const [drawer, setDrawer] = useState<any>(null);

  // Flavor distribution chart data
  const flavorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    (data ?? []).forEach((s: any) => { if (s.flavor_name) counts[s.flavor_name] = (counts[s.flavor_name] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  }, [data]);

  return (
    <>
      {/* Flavor distribution chart */}
      {flavorCounts.length > 0 && (
        <div className="card card-body" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 24 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--gray-500)", marginBottom: 6 }}>
              Flavor Distribution
            </div>
            <PieChart width={160} height={120}>
              <Pie data={flavorCounts} dataKey="value" cx={75} cy={55} innerRadius={30} outerRadius={55} paddingAngle={2}>
                {flavorCounts.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
              </Pie>
              <RTooltip formatter={(v: number, name: string) => [`${v} VMs`, name]} contentStyle={{ fontSize: 11 }} />
            </PieChart>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
            {flavorCounts.map((f, i) => (
              <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                <span className="text-mono" style={{ fontSize: 11 }}>{f.name}</span>
                <span style={{ color: "var(--gray-400)" }}>×{f.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
        onExport={() => exportCsv("servers.csv",
          ["Name","Status","Flavor","vCPUs","RAM GB","IPs","Tenant","Hypervisor","Created"],
          sorted.map((s: any) => [s.name, s.status, s.flavor_name, s.flavor_vcpus,
            s.flavor_ram_mb ? Math.round(s.flavor_ram_mb/1024) : "", (s.ips||[]).join(";"),
            tenants.get(s.project_id) ?? s.project_id?.slice(0,8),
            s.hypervisor_hostname, fmtDate(s.created_at)]))}
      >
        <tr>{["Name","Status","Flavor","vCPUs","RAM","IPs","Tenant","Hypervisor","Created"].map((h, i) =>
          <SortTh key={h} label={h} field={["name","status","flavor_name","flavor_vcpus","flavor_ram_mb","","","hypervisor_hostname","created_at"][i]} sort={sort} toggle={toggle} />
        )}</tr>
        {sorted.map((s: any) => (
          <tr key={s.id} onClick={() => setDrawer(s)} style={{ cursor: "pointer" }}>
            <td style={{ fontWeight: 500 }}>{s.name}</td>
            <td><StatusBadge status={s.status} /></td>
            <td className="text-mono" style={{ fontSize: 11 }}>{s.flavor_name}</td>
            <td>{s.flavor_vcpus ?? "—"}</td>
            <td>{s.flavor_ram_mb ? `${Math.round(s.flavor_ram_mb/1024)} GB` : "—"}</td>
            <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{(s.ips||[]).join(", ") || "—"}</td>
            <td>{tenants.get(s.project_id) ?? <span className="text-mono">{s.project_id?.slice(0,8)}</span>}</td>
            <td className="text-mono" style={{ fontSize: 11 }}>{s.hypervisor_hostname || "—"}</td>
            <td>{fmtDate(s.created_at)}</td>
          </tr>
        ))}
      </TableWrap>

      {drawer && (
        <DetailDrawer title={drawer.name} subtitle={`VM · ${drawer.id}`} onClose={() => setDrawer(null)}>
          <DrawerRow label="Status"      value={<StatusBadge status={drawer.status} />} />
          <DrawerRow label="Flavor"      value={drawer.flavor_name} />
          <DrawerRow label="vCPUs"       value={drawer.flavor_vcpus} />
          <DrawerRow label="RAM"         value={drawer.flavor_ram_mb ? `${Math.round(drawer.flavor_ram_mb/1024)} GB` : "—"} />
          <DrawerRow label="IPs"         value={(drawer.ips||[]).join(", ") || "—"} />
          <DrawerRow label="Hypervisor"  value={drawer.hypervisor_hostname} />
          <DrawerRow label="Image ID"    value={<span className="text-mono">{drawer.image_id?.slice(0,16)}…</span>} />
          <DrawerRow label="Tenant"      value={tenants.get(drawer.project_id) ?? drawer.project_id} />
          <DrawerRow label="Created"     value={drawer.created_at ? new Date(drawer.created_at).toLocaleString() : "—"} />
          <DrawerRow label="Updated"     value={drawer.updated_at ? new Date(drawer.updated_at).toLocaleString() : "—"} />
          <DrawerRow label="ID"          value={<span className="text-mono" style={{ fontSize: 10 }}>{drawer.id}</span>} />
        </DetailDrawer>
      )}
    </>
  );
}

// ── Hypervisors ────────────────────────────────────────────────────────────────

function HypervisorsTable({ data, isLoading, search, servers }: any) {
  const rows = filterRows(data, search, "", ["hostname","state","status","host_ip"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const [drawer, setDrawer] = useState<any>(null);

  // Build hypervisor → hosted VMs map from servers data
  const vmsByHyp = useMemo(() => {
    const m: Record<string, any[]> = {};
    (servers ?? []).forEach((s: any) => {
      const h = s.hypervisor_hostname;
      if (h) (m[h] = m[h] ?? []).push(s);
    });
    return m;
  }, [servers]);

  return (
    <>
      <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
        onExport={() => exportCsv("hypervisors.csv",
          ["Hostname","State","Status","VMs","vCPUs Used","vCPUs Total","RAM Used GB","RAM Total GB","IP"],
          sorted.map((h: any) => [h.hostname,h.state,h.status,h.running_vms,
            h.vcpus_used,h.vcpus_total,
            h.memory_mb_used?Math.round(h.memory_mb_used/1024):"",
            h.memory_mb_total?Math.round(h.memory_mb_total/1024):"",h.host_ip]))}>
        <tr>{["Hostname","State","Status","VMs","vCPUs","Memory","Disk","IP"].map((h, i) =>
          <SortTh key={h} label={h} field={["hostname","state","status","running_vms","vcpus_used","memory_mb_used","disk_gb_used","host_ip"][i]} sort={sort} toggle={toggle} />
        )}</tr>
        {sorted.map((h: any) => (
          <tr key={h.id} onClick={() => setDrawer(h)} style={{ cursor: "pointer" }}>
            <td style={{ fontWeight: 500 }}>{h.hostname}</td>
            <td><StatusBadge status={h.state === "up" ? "UP" : "DOWN"} /></td>
            <td><StatusBadge status={h.status === "enabled" ? "ENABLED" : "DISABLED"} /></td>
            <td>{h.running_vms ?? "—"}</td>
            <td><UsageBar used={h.vcpus_used} total={h.vcpus_total} label="vCPUs" /></td>
            <td><UsageBar used={h.memory_mb_used} total={h.memory_mb_total} label="MB" gbConvert /></td>
            <td><UsageBar used={h.disk_gb_used} total={h.disk_gb_total} label="GB" /></td>
            <td className="text-mono">{h.host_ip}</td>
          </tr>
        ))}
      </TableWrap>

      {drawer && (
        <DetailDrawer title={drawer.hostname} subtitle="Hypervisor" onClose={() => setDrawer(null)}>
          <DrawerRow label="State"   value={<StatusBadge status={drawer.state === "up" ? "UP" : "DOWN"} />} />
          <DrawerRow label="Status"  value={<StatusBadge status={drawer.status === "enabled" ? "ENABLED" : "DISABLED"} />} />
          <DrawerRow label="IP"      value={drawer.host_ip} />
          <DrawerRow label="VMs running" value={drawer.running_vms} />
          {drawer.vcpus_total && <DrawerRow label="vCPUs" value={<UsageBar used={drawer.vcpus_used} total={drawer.vcpus_total} label="vCPUs" />} />}
          {drawer.memory_mb_total && <DrawerRow label="RAM" value={<UsageBar used={drawer.memory_mb_used} total={drawer.memory_mb_total} label="MB" gbConvert />} />}

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: "var(--gray-700)", marginBottom: 8 }}>
              Hosted VMs ({(vmsByHyp[drawer.hostname] ?? []).length})
            </div>
            {(vmsByHyp[drawer.hostname] ?? []).map((vm: any) => (
              <div key={vm.id} style={{ display: "flex", justifyContent: "space-between",
                padding: "5px 0", borderBottom: "1px solid var(--gray-50)", fontSize: 12 }}>
                <span style={{ fontWeight: 500 }}>{vm.name}</span>
                <StatusBadge status={vm.status} />
              </div>
            ))}
            {!(vmsByHyp[drawer.hostname]?.length) && (
              <p className="text-muted" style={{ fontSize: 12 }}>No VMs (check Servers tab is loaded)</p>
            )}
          </div>
        </DetailDrawer>
      )}
    </>
  );
}

// ── Volumes ────────────────────────────────────────────────────────────────────

function VolumesTable({ data, isLoading, search, tenantFilter, tenants }: any) {
  const rows = filterRows(data, search, tenantFilter, ["name","status","volume_type"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const [drawer, setDrawer] = useState<any>(null);

  return (
    <>
      <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
        onExport={() => exportCsv("volumes.csv",
          ["Name","Status","Size GB","Type","Attached To","Tenant","Created"],
          sorted.map((v: any) => [v.name,v.status,v.size_gb,v.volume_type,
            (v.attached_to||[]).join(";"), tenants.get(v.project_id)??v.project_id?.slice(0,8), fmtDate(v.created_at)]))}>
        <tr>{["Name","Status","Size","Type","Attached To","Tenant","Created"].map((h,i) =>
          <SortTh key={h} label={h} field={["name","status","size_gb","volume_type","","","created_at"][i]} sort={sort} toggle={toggle} />
        )}</tr>
        {sorted.map((v: any) => (
          <tr key={v.id} onClick={() => setDrawer(v)} style={{ cursor: "pointer" }}>
            <td style={{ fontWeight: 500 }}>{v.name}</td>
            <td><StatusBadge status={v.status} /></td>
            <td>{fmtSize(v.size_gb)}</td>
            <td>{v.volume_type || "—"}</td>
            <td className="text-mono" style={{ fontSize: 11 }}>
              {v.attached_to?.length ? v.attached_to.map((id: string) => id.slice(0,8)+"…").join(", ") : <span className="text-muted">unattached</span>}
            </td>
            <td>{tenants.get(v.project_id) ?? <span className="text-mono">{v.project_id?.slice(0,8)}</span>}</td>
            <td>{fmtDate(v.created_at)}</td>
          </tr>
        ))}
      </TableWrap>

      {drawer && (
        <DetailDrawer title={drawer.name} subtitle="Volume" onClose={() => setDrawer(null)}>
          <DrawerRow label="Status"      value={<StatusBadge status={drawer.status} />} />
          <DrawerRow label="Size"        value={fmtSize(drawer.size_gb)} />
          <DrawerRow label="Type"        value={drawer.volume_type} />
          <DrawerRow label="Attached to" value={drawer.attached_to?.join(", ") || "unattached"} />
          <DrawerRow label="Tenant"      value={tenants.get(drawer.project_id) ?? drawer.project_id} />
          <DrawerRow label="Created"     value={drawer.created_at ? new Date(drawer.created_at).toLocaleString() : "—"} />
          <DrawerRow label="ID"          value={<span className="text-mono" style={{ fontSize: 10 }}>{drawer.id}</span>} />
        </DetailDrawer>
      )}
    </>
  );
}

// ── Networks ───────────────────────────────────────────────────────────────────

function NetworksTable({ data, isLoading, search, tenantFilter, tenants }: any) {
  const rows = filterRows(data, search, tenantFilter, ["name","status"]);
  const { sorted, sort, toggle } = useSort<any>(rows);

  return (
    <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
      onExport={() => exportCsv("networks.csv",
        ["Name","Status","External","Shared","Subnets","Tenant"],
        sorted.map((n: any) => [n.name,n.status,n.external?"Yes":"No",n.shared?"Yes":"No",
          n.subnets?.length??0, tenants.get(n.project_id)??n.project_id?.slice(0,8)]))}>
      <tr>{["Name","Status","External","Shared","Subnets","Tenant"].map((h,i) =>
        <SortTh key={h} label={h} field={["name","status","external","shared","",""][i]} sort={sort} toggle={toggle} />
      )}</tr>
      {sorted.map((n: any) => (
        <tr key={n.id}>
          <td style={{ fontWeight: 500 }}>{n.name}</td>
          <td><StatusBadge status={n.status} /></td>
          <td><Pill on={n.external} /></td>
          <td><Pill on={n.shared} /></td>
          <td>{n.subnets?.length ?? 0}</td>
          <td>{tenants.get(n.project_id) ?? <span className="text-mono">{n.project_id?.slice(0,8)}</span>}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Floating IPs ───────────────────────────────────────────────────────────────

function FloatingIpsTable({ data, isLoading, search, tenantFilter, tenants }: any) {
  const rows = filterRows(data, search, tenantFilter, ["floating_ip_address","fixed_ip_address","server_name","status"]);
  const { sorted, sort, toggle } = useSort<any>(rows);

  return (
    <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
      onExport={() => exportCsv("floating_ips.csv",
        ["Floating IP","Fixed IP","Status","Associated VM","Tenant"],
        sorted.map((f: any) => [f.floating_ip_address,f.fixed_ip_address,f.status,f.server_name,
          tenants.get(f.project_id)??f.project_id?.slice(0,8)]))}>
      <tr>{["Floating IP","Fixed IP","Status","Associated VM","Tenant"].map((h,i) =>
        <SortTh key={h} label={h} field={["floating_ip_address","fixed_ip_address","status","server_name",""][i]} sort={sort} toggle={toggle} />
      )}</tr>
      {sorted.map((f: any) => (
        <tr key={f.id}>
          <td className="text-mono" style={{ fontWeight: 500 }}>{f.floating_ip_address}</td>
          <td className="text-mono">{f.fixed_ip_address || "—"}</td>
          <td>
            {f.port_id
              ? <span className="badge badge-active">Associated</span>
              : <span className="badge badge-warn">Unassociated</span>}
          </td>
          <td>{f.server_name || <span className="text-muted">—</span>}</td>
          <td>{tenants.get(f.project_id) ?? <span className="text-mono">{f.project_id?.slice(0,8)}</span>}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Images ─────────────────────────────────────────────────────────────────────

function ImagesTable({ data, isLoading, search, tenantFilter }: any) {
  const rows = filterRows(data, search, tenantFilter, ["name","status","visibility","disk_format","owner"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const [drawer, setDrawer] = useState<any>(null);

  return (
    <>
      <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
        onExport={() => exportCsv("images.csv",
          ["Name","Status","Visibility","Format","Size GB","VMs Using","Owner","Created"],
          sorted.map((img: any) => [img.name,img.status,img.visibility,img.disk_format,
            img.size_gb,(img.used_by_vms||[]).join(";"),img.owner?.slice(0,8),fmtDate(img.created_at)]))}>
        <tr>{["Name","Status","Visibility","Format","Size","VMs Using","Created"].map((h,i) =>
          <SortTh key={h} label={h} field={["name","status","visibility","disk_format","size_gb","","created_at"][i]} sort={sort} toggle={toggle} />
        )}</tr>
        {sorted.map((img: any) => (
          <tr key={img.id} onClick={() => setDrawer(img)} style={{ cursor: "pointer" }}>
            <td style={{ fontWeight: 500 }}>{img.name}</td>
            <td><StatusBadge status={img.status?.toUpperCase()} /></td>
            <td><StatusBadge status={img.visibility?.toUpperCase()} /></td>
            <td className="text-mono" style={{ fontSize: 11 }}>{img.disk_format}</td>
            <td>{img.size_gb > 0 ? fmtSize(img.size_gb) : "—"}</td>
            <td>
              {(img.used_by_vms || []).length > 0
                ? <span className="badge badge-info">{img.used_by_vms.length} VM{img.used_by_vms.length !== 1 ? "s" : ""}</span>
                : <span className="text-muted" style={{ fontSize: 11 }}>unused</span>}
            </td>
            <td>{fmtDate(img.created_at)}</td>
          </tr>
        ))}
      </TableWrap>

      {drawer && (
        <DetailDrawer title={drawer.name} subtitle="Glance Image" onClose={() => setDrawer(null)}>
          <DrawerRow label="Status"     value={<StatusBadge status={drawer.status?.toUpperCase()} />} />
          <DrawerRow label="Visibility" value={<StatusBadge status={drawer.visibility?.toUpperCase()} />} />
          <DrawerRow label="Format"     value={drawer.disk_format} />
          <DrawerRow label="Size"       value={drawer.size_gb > 0 ? fmtSize(drawer.size_gb) : "—"} />
          <DrawerRow label="Protected"  value={<Pill on={drawer.is_protected} />} />
          <DrawerRow label="Owner"      value={drawer.owner?.slice(0,8)} />
          <DrawerRow label="Created"    value={drawer.created_at ? new Date(drawer.created_at).toLocaleString() : "—"} />
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: "var(--gray-700)", marginBottom: 8 }}>
              Used by {(drawer.used_by_vms||[]).length} VM(s)
            </div>
            {(drawer.used_by_vms || []).map((name: string) => (
              <div key={name} style={{ padding: "4px 0", fontSize: 12, borderBottom: "1px solid var(--gray-50)" }}>{name}</div>
            ))}
          </div>
          <DrawerRow label="ID" value={<span className="text-mono" style={{ fontSize: 10 }}>{drawer.id}</span>} />
        </DetailDrawer>
      )}
    </>
  );
}

// ── Security Groups ────────────────────────────────────────────────────────────

function SecurityGroupsTable({ data, isLoading, search, tenantFilter, tenants }: any) {
  const rows = filterRows(data, search, tenantFilter, ["name","description"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const [drawer, setDrawer] = useState<any>(null);

  const riskyCount = (data ?? []).filter((sg: any) => sg.risky_rules > 0).length;

  return (
    <>
      {riskyCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
          background: "var(--yellow-light)", border: "1px solid var(--yellow)",
          borderRadius: 6, marginBottom: 12, fontSize: 13, color: "var(--yellow)" }}>
          <AlertTriangle size={14} />
          <strong>{riskyCount} security group{riskyCount !== 1 ? "s" : ""}</strong> with open ingress rules (0.0.0.0/0)
        </div>
      )}

      <TableWrap isLoading={isLoading} total={data?.length} filtered={sorted.length}
        onExport={() => exportCsv("security_groups.csv",
          ["Name","Description","Rules","Risky Rules","Tenant"],
          sorted.map((sg: any) => [sg.name,sg.description,sg.rules?.length??0,sg.risky_rules,
            tenants.get(sg.project_id)??sg.project_id?.slice(0,8)]))}>
        <tr>{["Name","Description","Rules","Risky","Tenant"].map((h,i) =>
          <SortTh key={h} label={h} field={["name","description","","risky_rules",""][i]} sort={sort} toggle={toggle} />
        )}</tr>
        {sorted.map((sg: any) => (
          <tr key={sg.id} onClick={() => setDrawer(sg)} style={{ cursor: "pointer" }}>
            <td style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
              <Shield size={13} style={{ color: sg.risky_rules > 0 ? "var(--yellow)" : "var(--gray-400)" }} />
              {sg.name}
            </td>
            <td className="text-muted" style={{ fontSize: 11 }}>{sg.description || "—"}</td>
            <td>{sg.rules?.length ?? 0}</td>
            <td>
              {sg.risky_rules > 0
                ? <span className="badge badge-warn">⚠ {sg.risky_rules} open</span>
                : <span className="badge badge-ok">clean</span>}
            </td>
            <td>{sg.tenant_name || tenants.get(sg.project_id) || sg.project_id?.slice(0,8)}</td>
          </tr>
        ))}
      </TableWrap>

      {drawer && (
        <DetailDrawer title={drawer.name} subtitle="Security Group" onClose={() => setDrawer(null)}>
          <DrawerRow label="Description" value={drawer.description || "—"} />
          <DrawerRow label="Tenant"      value={drawer.tenant_name || tenants.get(drawer.project_id) || drawer.project_id?.slice(0, 8)} />
          <DrawerRow label="Total Rules" value={drawer.rules?.length ?? 0} />
          <DrawerRow label="Risky Rules" value={drawer.risky_rules > 0 ? <span style={{ color: "var(--yellow)", fontWeight: 600 }}>⚠ {drawer.risky_rules} open ingress</span> : "None"} />

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: "var(--gray-700)", marginBottom: 8 }}>Rules</div>
            {(drawer.rules ?? []).map((r: any, i: number) => (
              <div key={i} style={{
                padding: "6px 10px", marginBottom: 4, borderRadius: 5, fontSize: 11,
                background: r.risky ? "var(--yellow-light)" : "var(--gray-50)",
                border: `1px solid ${r.risky ? "var(--yellow)" : "var(--gray-100)"}`,
              }}>
                <span style={{ fontWeight: 600, color: r.direction === "ingress" ? "var(--blue-primary)" : "var(--gray-600)" }}>
                  {r.direction}
                </span>
                {" · "}{r.protocol || "any"}
                {r.port_range_min != null && ` · ${r.port_range_min}${r.port_range_max !== r.port_range_min ? `-${r.port_range_max}` : ""}`}
                {r.remote_ip_prefix && <span style={{ color: r.risky ? "var(--yellow)" : "inherit" }}> · {r.remote_ip_prefix}</span>}
                {r.risky && <span style={{ marginLeft: 6, color: "var(--yellow)" }}>⚠ open</span>}
              </div>
            ))}
          </div>
          <DrawerRow label="ID" value={<span className="text-mono" style={{ fontSize: 10 }}>{drawer.id}</span>} />
        </DetailDrawer>
      )}
    </>
  );
}
