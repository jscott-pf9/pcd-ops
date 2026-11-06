// What each inventory kind exports: the tab's CSV files and the "Export All" workbook sheets.
import { fmtDate, mbToGb, ramGb } from "./format";
import type { Kind } from "./kinds";
import type { Ctx } from "./summaries";

type Cell = string | number | null | undefined;
export interface Sheet { name: string; file: string; headers: string[]; rows: (items: any[], ctx: Ctx) => Cell[][] }

const r1 = (v?: number | null) => (v == null ? "" : Math.round(v * 10) / 10);
const yn = (b: unknown) => (b ? "Yes" : "No");
const join = (xs?: (string | null | undefined)[] | null) => (xs ?? []).filter(Boolean).join("; ");

export const HYP_METRIC_HEADERS = ["CPU %", "Memory %", "Disk %", "Net In B/s", "Net Out B/s"];
export function hypMetricCells(h: any): Cell[] {
  const m = h.metrics;
  return [r1(m?.cpu_pct), r1(m?.mem_pct), r1(m?.disk_pct), r1(m?.net_rx_bps), r1(m?.net_tx_bps)];
}

export const EXPORTS: Record<Kind, Sheet[]> = {
  clusters: [{
    name: "Clusters & Aggregates", file: "clusters_aggregates.csv",
    headers: ["Name", "Kind", "Availability Zone", "Host Count", "Hosts", "VMs", "vCPUs Allocated",
      "vCPUs Total", "RAM Allocated GB", "RAM Total GB", "Metadata", "Created", "Updated", "ID"],
    rows: items => items.map(c => [
      c.name, c.kind === "cluster" ? "PCD cluster" : "Aggregate", c.availability_zone ?? "",
      (c.hosts ?? []).length, join((c.hosts ?? []).map((h: any) => h.hostname ?? h.service_host)),
      c.vms ?? "", c.vcpus_used ?? "", c.vcpus_total ?? "", mbToGb(c.memory_mb_used) ?? "",
      mbToGb(c.memory_mb_total) ?? "",
      Object.entries(c.metadata ?? {}).map(([k, v]) => `${k}=${v}`).join("; "),
      fmtDate(c.created_at), fmtDate(c.updated_at), c.id,
    ]),
  }],
  hypervisors: [{
    name: "Hypervisors", file: "hypervisors.csv",
    headers: ["Hostname", "State", "Status", "VMs", "Sockets", "Cores/Socket", "Threads", "Logical CPUs",
      "RAM GB", "RAM Usable GB", "RAM Allocated GB", "CPU Vendor", "CPU Model", "CPU Arch", "NICs", "SSH",
      "OS Version", "Pending Patches", "Hypervisor Type", "Hypervisor Version", "Aggregates", "IP",
      ...HYP_METRIC_HEADERS],
    rows: items => items.map(h => [
      h.hostname, h.state, h.status, h.running_vms ?? "",
      h.cpu_sockets ?? "", h.cpu_cores ?? "", h.cpu_threads ?? "", h.cpu_logical ?? "",
      ramGb(h) ?? "", mbToGb(h.memory_mb_total) ?? "", mbToGb(h.memory_mb_used) ?? "",
      h.cpu_vendor ?? "", h.cpu_model ?? "", h.cpu_arch ?? "", h.nic_count ?? "",
      h.ssh_ok === true ? "reachable" : h.ssh_ok === false ? "unreachable" : "",
      h.os_version ?? "", h.pending_patches ?? "", h.hypervisor_type ?? "", h.hypervisor_version ?? "",
      join(h.aggregates), h.host_ip ?? "", ...hypMetricCells(h),
    ]),
  }],
  servers: [{
    name: "Servers", file: "servers.csv",
    headers: ["Name", "Status", "Flavor", "vCPUs", "RAM GB", "IPs", "Tenant", "Hypervisor",
      "Server Group", "Security Groups", "CPU %", "Memory %", "Created", "Updated", "Image ID", "ID"],
    rows: (items, ctx) => items.map(s => [
      s.name, s.status, s.flavor_name, s.flavor_vcpus ?? "", mbToGb(s.flavor_ram_mb) ?? "",
      join(s.ips), ctx.tenant(s.project_id), s.hypervisor_hostname ?? "", s.server_group?.name ?? "",
      join(s.security_groups), r1(s.metrics?.cpu_pct), r1(s.metrics?.mem_pct),
      fmtDate(s.created_at), fmtDate(s.updated_at), s.image_id ?? "", s.id,
    ]),
  }],
  flavors: [{
    name: "Flavors", file: "flavors.csv",
    headers: ["Name", "vCPUs", "RAM GB", "Disk GB", "Ephemeral GB", "Swap MB", "Public", "Disabled",
      "RX/TX Factor", "VMs", "Extra Specs", "Description", "ID"],
    rows: items => items.map(f => [
      f.name, f.vcpus, mbToGb(f.ram_mb) ?? "", f.disk_gb, f.ephemeral_gb ?? "", f.swap_mb ?? "",
      yn(f.public), yn(f.disabled), f.rxtx_factor ?? "", f.vms ?? 0,
      Object.entries(f.extra_specs ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), f.description ?? "", f.id,
    ]),
  }],
  server_groups: [{
    name: "Server Groups", file: "server_groups.csv",
    headers: ["Name", "Policy", "Max Per Host", "Placement", "Detail", "Members", "Member Names",
      "Hosts", "Tenant", "ID"],
    rows: (items, ctx) => items.map(g => [
      g.name, g.policy ?? "", g.rules?.max_server_per_host ?? "", g.status, g.detail,
      g.members?.length ?? 0, join((g.members ?? []).map((m: any) => m.name ?? m.id)), join(g.hosts),
      ctx.tenant(g.project_id), g.id,
    ]),
  }],
  volumes: [{
    name: "Volumes", file: "volumes.csv",
    headers: ["Name", "Status", "Size GB", "Type", "Backend", "Pool", "Bootable", "Attached To", "Devices",
      "Tenant", "Created", "ID"],
    rows: (items, ctx) => items.map(v => [
      v.name, v.status, v.size_gb, v.volume_type ?? "", v.backend ?? "", v.host ?? "", yn(v.bootable),
      join(v.attached_to), join((v.attachments ?? []).map((a: any) => a.device)),
      ctx.tenant(v.project_id), fmtDate(v.created_at), v.id,
    ]),
  }],
  storage_backends: [{
    name: "Storage Backends", file: "storage_backends.csv",
    headers: ["Backend", "Protocol", "Vendor", "Driver", "State", "Shared", "Hosts", "Capacity GB",
      "Used GB", "Free GB", "Used %", "Oversubscription", "Thin", "Effective GB", "Provisioned GB",
      "Provisioned %", "Volumes", "Types", "Reported"],
    rows: items => items.map(b => [
      b.name, b.protocol ?? "", b.vendor ?? "", b.driver_version ?? "", b.state ?? "", yn(b.shared),
      join(b.hosts), b.total_gb ?? "", b.used_gb ?? "", b.free_gb ?? "", b.used_pct ?? "",
      b.oversubscription ?? "", yn(b.thin), b.effective_gb ?? "", b.provisioned_gb,
      b.provisioned_pct ?? "", b.volumes, join(b.types), b.reported_at ?? "",
    ]),
  }, {
    name: "Storage Pools", file: "storage_pools.csv",
    headers: ["Backend", "Pool", "Host", "Protocol", "Capacity GB", "Free GB", "Allocated GB",
      "Oversubscription", "Thin", "Reserved %", "State", "Reported"],
    rows: items => items.flatMap(b => (b.pools ?? []).map((p: any) => [
      b.name, p.name, p.hostname ?? p.host, p.protocol ?? "", p.total_gb ?? "", p.free_gb ?? "",
      p.allocated_gb ?? "", p.oversubscription ?? "", yn(p.thin), p.reserved_pct ?? "",
      p.state ?? "", p.reported_at ?? "",
    ])),
  }],
  storage_types: [{
    name: "Storage Types", file: "storage_types.csv",
    headers: ["Name", "Backend", "Default", "Public", "QoS", "QoS Specs", "Encrypted", "Volumes",
      "Volume GB", "Extra Specs", "Access Projects", "Description", "ID"],
    rows: (items, ctx) => items.map(t => [
      t.name, t.backend ?? "Any", yn(t.default), yn(t.public), t.qos?.name ?? "",
      Object.entries(t.qos?.specs ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), yn(t.encrypted),
      t.volumes, t.volume_gb, Object.entries(t.extra_specs ?? {}).map(([k, v]) => `${k}=${v}`).join("; "),
      join((t.access_projects ?? []).map((p: string) => ctx.tenant(p))), t.description ?? "", t.id,
    ]),
  }],
  networks: [{
    name: "Networks", file: "networks.csv",
    headers: ["Name", "Status", "External", "Shared", "Admin State", "Subnet IDs", "Tenant", "ID"],
    rows: (items, ctx) => items.map(n => [
      n.name, n.status, yn(n.external), yn(n.shared), n.admin_state_up ? "up" : "down",
      join(n.subnets), ctx.tenant(n.project_id), n.id,
    ]),
  }],
  floating_ips: [{
    name: "Floating IPs", file: "floating_ips.csv",
    headers: ["Floating IP", "Fixed IP", "Status", "Associated VM", "Server ID", "Port ID", "Tenant", "ID"],
    rows: (items, ctx) => items.map(f => [
      f.floating_ip_address, f.fixed_ip_address ?? "", f.status, f.server_name ?? "",
      f.server_id ?? "", f.port_id ?? "", ctx.tenant(f.project_id), f.id,
    ]),
  }],
  images: [{
    name: "Images & Snapshots", file: "images.csv",
    headers: ["Name", "Type", "Snapshot Of", "Base Image", "Status", "Visibility", "Format", "Size GB",
      "Min Disk GB", "Min RAM MB", "VMs Using", "Volumes From It", "Protected", "Owner", "Created", "ID"],
    rows: (items, ctx) => items.map(img => [
      img.name, img.kind === "snapshot" ? `snapshot (${img.snapshot_type})` : "image",
      img.instance_uuid ?? "", img.base_image_ref ?? "", img.status, img.visibility, img.disk_format,
      img.size_gb, img.min_disk_gb ?? "", img.min_ram_mb ?? "", join(img.used_by_vms), img.used_by_volumes ?? 0,
      yn(img.is_protected), ctx.tenant(img.owner), fmtDate(img.created_at), img.id,
    ]),
  }],
  security_groups: [{
    name: "Security Groups", file: "security_groups.csv",
    headers: ["Name", "Description", "Rules", "Risky Rules", "Tenant", "ID"],
    rows: (items, ctx) => items.map(sg => [
      sg.name, sg.description ?? "", sg.rules?.length ?? 0, sg.risky_rules ?? 0,
      sg.tenant_name || ctx.tenant(sg.project_id), sg.id,
    ]),
  }, {
    name: "SG Rules", file: "security_group_rules.csv",
    headers: ["Group Name", "Group ID", "Direction", "Protocol", "Port Min", "Port Max", "CIDR",
      "Remote Group", "Ethertype", "Description", "Risky"],
    rows: items => {
      const names = new Map(items.map(sg => [sg.id, sg.name]));
      return items.flatMap(sg => (sg.rules ?? []).map((r: any) => [
        sg.name, sg.id, r.direction, r.protocol ?? "any", r.port_range_min ?? "", r.port_range_max ?? "",
        r.remote_ip_prefix ?? "", r.remote_group_id ? names.get(r.remote_group_id) ?? r.remote_group_id : "",
        r.ethertype ?? "", r.description ?? "", r.risky ? "Yes" : "No",
      ]));
    },
  }],
};

export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows]
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

/** The tab's CSV files, for the rows it shows. */
export function exportKind(kind: Kind, items: any[], ctx: Ctx) {
  for (const s of EXPORTS[kind]) download(s.file, toCsv(s.headers, s.rows(items, ctx)));
}
