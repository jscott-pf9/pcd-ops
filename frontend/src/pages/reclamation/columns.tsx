// Each category's table columns and CSV.
import type React from "react";
import { ItemLink } from "../../components/DetailPage";
import { formatPct, formatRate } from "../../components/format";
import type { Cell } from "../inventory/exports";
import { fmtDate, fmtSize } from "../inventory/format";
import { detailPath, type Kind } from "../inventory/kinds";
import { ageDays, ageText, type CategoryKey } from "./model";

export interface Ctx { tenant: (id?: string | null) => string; host: (id?: string | null) => string }

export interface Column {
  label: string;
  /** Field to sort by; none = not sortable. */
  sort?: string;
  render: (i: any, ctx: Ctx) => React.ReactNode;
  csv?: (i: any, ctx: Ctx) => Cell;
}

const muted = (t = "—") => <span className="text-muted">{t}</span>;
const link = (kind: Kind, id: string | null | undefined, label: React.ReactNode) =>
  id ? <ItemLink to={detailPath(kind, id)}>{label}</ItemLink> : label;
const badge = (text: string, cls = "badge-neutral") => <span className={`badge ${cls}`}>{text}</span>;

const tenant: Column = {
  label: "Tenant", sort: "project_id",
  render: (i, c) => (i.project_id ? c.tenant(i.project_id) : i.project_name ?? muted()),
  csv: (i, c) => (i.project_id ? c.tenant(i.project_id) : i.project_name ?? ""),
};

/** How long it has been a candidate: since PCD Ops first saw it, or earlier when PCD's own
 *  timestamps say so (a stop, a detach). */
function since(label: string): Column {
  return {
    label, sort: "since",
    render: i => (
      <span title={i.since ? `Since ${new Date(i.since.endsWith("Z") ? i.since : `${i.since}Z`).toLocaleString()}${
        i.since === i.first_seen ? " (first seen by PCD Ops)" : ""}` : undefined}>
        {ageText(ageDays(i.since))}
      </span>),
    csv: i => ageDays(i.since) ?? "",
  };
}

const ram = (mb?: number) => (mb ? `${Math.round(mb / 1024)} GB` : "—");

const ORPHAN_KIND: Record<string, [string, string]> = {
  unknown: ["Unknown to PCD", "badge-error"],
  missing: ["Missing from host", "badge-error"],
  owner_deleted: ["Owner deleted", "badge-warn"],
};
const PORT_KIND: Record<string, string> = { unbound: "Unbound", vm_gone: "VM gone", router_gone: "Router gone" };

export const COLUMNS: Record<CategoryKey, Column[]> = {
  stopped_servers: [
    { label: "VM", sort: "name", render: i => link("servers", i.id, <strong>{i.name}</strong>), csv: i => i.name },
    { label: "Status", sort: "status", render: i => badge(i.status), csv: i => i.status },
    tenant,
    { label: "vCPUs", sort: "vcpus", render: i => i.vcpus || muted(), csv: i => i.vcpus },
    { label: "RAM", sort: "ram_mb", render: i => ram(i.ram_mb), csv: i => Math.round((i.ram_mb ?? 0) / 1024) },
    { label: "Attached disks", sort: "attached_disk_gb", render: i => (i.attached_disk_gb ? fmtSize(i.attached_disk_gb) : muted()), csv: i => i.attached_disk_gb },
    since("Stopped for"),
  ],
  idle_servers: [
    { label: "VM", sort: "name", render: i => link("servers", i.id, <strong>{i.name}</strong>), csv: i => i.name },
    tenant,
    { label: "vCPUs", sort: "vcpus", render: i => i.vcpus || muted(), csv: i => i.vcpus },
    { label: "RAM", sort: "ram_mb", render: i => ram(i.ram_mb), csv: i => Math.round((i.ram_mb ?? 0) / 1024) },
    { label: "CPU (p95)", sort: "cpu_pct", render: i => formatPct(i.cpu_pct), csv: i => i.cpu_pct },
    { label: "Network (p95)", sort: "net_bps", render: i => formatRate(i.net_bps), csv: i => i.net_bps },
    { label: "IOPS (p95)", sort: "iops", render: i => (i.iops == null ? "—" : i.iops.toFixed(2)), csv: i => i.iops },
    since("Idle for"),
  ],
  orphaned_vms: [
    { label: "VM", sort: "name", render: i => (i.kind === "unknown" ? <strong>{i.name}</strong> : link("servers", i.id, <strong>{i.name}</strong>)), csv: i => i.name },
    { label: "Problem", sort: "kind", render: i => badge(...(ORPHAN_KIND[i.kind] ?? [i.kind, "badge-neutral"])), csv: i => ORPHAN_KIND[i.kind]?.[0] ?? i.kind },
    { label: "Details", render: i => <span style={{ fontSize: 12 }}>{i.reason}</span>, csv: i => i.reason },
    { label: "Host", sort: "hypervisor_id", render: (i, c) => (i.hypervisor_id ? link("hypervisors", i.hypervisor_id, c.host(i.hypervisor_id)) : muted()), csv: (i, c) => (i.hypervisor_id ? c.host(i.hypervisor_id) : "") },
    tenant,
    { label: "UUID", render: i => <span className="text-mono" style={{ fontSize: 11 }}>{i.id}</span>, csv: i => i.id },
    since("Seen for"),
  ],
  empty_server_groups: [
    { label: "Server group", sort: "name", render: i => link("server_groups", i.id, <strong>{i.name}</strong>), csv: i => i.name },
    { label: "Policy", sort: "policy", render: i => i.policy ?? muted(), csv: i => i.policy },
    tenant,
    since("Empty for"),
  ],
  unattached_volumes: [
    { label: "Volume", sort: "name", render: i => link("volumes", i.id, <strong>{i.name}</strong>), csv: i => i.name },
    { label: "Size", sort: "size", render: i => fmtSize(i.size), csv: i => i.size },
    { label: "Type", sort: "volume_type", render: i => i.volume_type ?? muted(), csv: i => i.volume_type },
    { label: "Note", sort: "kind", render: i => (i.kind === "image_store"
        ? <span className="badge badge-warn" title="Glance keeps image data in this volume, and the image is gone">Image store, image deleted</span>
        : i.is_bootable ? badge("bootable", "badge-info") : muted()),
      csv: i => (i.kind === "image_store" ? "Glance image store volume; image deleted" : i.is_bootable ? "bootable" : "") },
    tenant,
    { label: "Created", sort: "created_at", render: i => fmtDate(i.created_at), csv: i => fmtDate(i.created_at) },
    since("Unattached for"),
  ],
  unused_images: [
    { label: "Image", sort: "name", render: i => link("images", i.id, <strong>{i.name}</strong>), csv: i => i.name },
    { label: "Type", sort: "kind", render: i => (i.kind === "snapshot" ? badge(`snapshot · ${i.snapshot_type}`, "badge-provisioning") : badge("image")),
      csv: i => (i.kind === "snapshot" ? `snapshot (${i.snapshot_type})` : "image") },
    { label: "Visibility", sort: "visibility", render: i => i.visibility, csv: i => i.visibility },
    { label: "Size", sort: "size_gb", render: i => (i.size_gb > 0 ? fmtSize(i.size_gb) : muted()), csv: i => i.size_gb },
    { label: "Protected", sort: "is_protected", render: i => (i.is_protected ? badge("protected", "badge-info") : muted()), csv: i => (i.is_protected ? "Yes" : "No") },
    tenant,
    { label: "Created", sort: "created_at", render: i => fmtDate(i.created_at), csv: i => fmtDate(i.created_at) },
    since("Unused for"),
  ],
  unused_floating_ips: [
    { label: "Address", sort: "floating_ip_address", render: i => link("floating_ips", i.id, <span className="text-mono">{i.floating_ip_address}</span>), csv: i => i.floating_ip_address },
    tenant,
    since("Unused for"),
  ],
  orphaned_ports: [
    { label: "Port", sort: "name", render: i => <strong>{i.name}</strong>, csv: i => i.name },
    { label: "Problem", sort: "kind", render: i => badge(PORT_KIND[i.kind] ?? i.kind, i.kind === "unbound" ? "badge-neutral" : "badge-warn"), csv: i => PORT_KIND[i.kind] ?? i.kind },
    { label: "IPs", render: i => <span className="text-mono" style={{ fontSize: 11 }}>{(i.fixed_ips ?? []).join(", ") || "—"}</span>, csv: i => (i.fixed_ips ?? []).join("; ") },
    { label: "Network", sort: "network_id", render: i => link("networks", i.network_id, <span className="text-mono" style={{ fontSize: 11 }}>{i.network_id?.slice(0, 8)}</span>), csv: i => i.network_id },
    { label: "Was attached to", render: i => (i.device_id ? <span className="text-mono" style={{ fontSize: 11 }} title={i.device_owner}>{i.device_id.slice(0, 8)}</span> : muted()), csv: i => i.device_id },
    tenant,
    { label: "Created", sort: "created_at", render: i => fmtDate(i.created_at), csv: i => fmtDate(i.created_at) },
    since("Orphaned for"),
  ],
  unused_routers: [
    { label: "Router", sort: "name", render: i => <strong>{i.name}</strong>, csv: i => i.name },
    { label: "Why", sort: "reason", render: i => i.reason, csv: i => i.reason },
    { label: "Interfaces", render: i => (i.interfaces ?? []).length || muted("none"), csv: i => (i.interfaces ?? []).length },
    { label: "Gateway", sort: "gateway", render: i => (i.gateway ? "Yes" : muted("No")), csv: i => (i.gateway ? "Yes" : "No") },
    tenant,
    since("Unused for"),
  ],
  unused_networks: [
    { label: "Network", sort: "name", render: i => link("networks", i.id, <strong>{i.name}</strong>), csv: i => i.name },
    { label: "Subnets", sort: "subnets", render: i => i.subnets, csv: i => i.subnets },
    { label: "Routers", render: i => (i.routers ?? []).length || muted("none"), csv: i => (i.routers ?? []).length },
    { label: "Shared", sort: "shared", render: i => (i.shared ? badge("shared", "badge-info") : muted("No")), csv: i => (i.shared ? "Yes" : "No") },
    tenant,
    { label: "Created", sort: "created_at", render: i => fmtDate(i.created_at), csv: i => fmtDate(i.created_at) },
    since("Without VMs for"),
  ],
  empty_tenants: [
    { label: "Tenant", sort: "name", render: i => <strong>{i.name}</strong>, csv: i => i.name },
    { label: "Enabled", sort: "enabled", render: i => (i.enabled ? "Yes" : muted("No")), csv: i => (i.enabled ? "Yes" : "No") },
    { label: "Role assignments", sort: "role_assignments", render: i => i.role_assignments, csv: i => i.role_assignments },
    { label: "Description", render: i => i.description || muted(), csv: i => i.description },
    { label: "", render: i => (i.system ? badge("system") : null) },
    since("Empty for"),
  ],
};

export function csvFor(cat: CategoryKey, items: any[], ctx: Ctx): { headers: string[]; rows: Cell[][] } {
  const cols = COLUMNS[cat].filter(c => c.csv);
  return {
    headers: [...cols.map(c => (c.sort === "since" ? `${c.label} (days)` : c.label)), "Reason", "ID"],
    rows: items.map(i => [...cols.map(c => c.csv!(i, ctx)), i.reason ?? "", i.id]),
  };
}
