// What the hover card shows for a row: facts already in the row, so it costs no requests.
import { formatPct } from "../../components/format";
import { cpuName, fmtSize, mbToGb, pct, ramGb, SERVER_GROUP_STATUS } from "./format";
import type { Kind } from "./kinds";

export type Fact = [label: string, value: string];
export interface Ctx { tenant: (id?: string | null) => string }

const yes = (b: unknown) => (b ? "Yes" : "No");
const list = (xs?: string[] | null, max = 3) =>
  !xs?.length ? "—" : xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} +${xs.length - max}`;
const usedOf = (used?: number | null, total?: number | null, unit = "") =>
  total ? `${used ?? 0}${unit} of ${total}${unit} (${pct(used, total) ?? 0}%)` : "—";

export function summary(kind: Kind, r: any, ctx: Ctx): Fact[] {
  const m = r.metrics;
  switch (kind) {
    case "hypervisors": return [
      ["State", `${r.state} · ${r.status}`],
      ["IP", r.host_ip ?? "—"],
      ["CPU", cpuName(r) ?? "—"],
      ["Topology", r.cpu_sockets ? `${r.cpu_sockets} × ${r.cpu_cores} cores × ${r.cpu_threads} threads` : "—"],
      ["RAM", ramGb(r) != null ? `${ramGb(r)} GB` : "—"],
      ["VMs", String(r.running_vms ?? "—")],
      ["Load now", m ? `CPU ${formatPct(m.cpu_pct)} · memory ${formatPct(m.mem_pct)}` : "—"],
      ["Aggregates", list(r.aggregates)],
    ];
    case "servers": return [
      ["Status", r.status],
      ["Flavor", `${r.flavor_name ?? "—"} (${r.flavor_vcpus ?? "?"} vCPU, ${mbToGb(r.flavor_ram_mb) ?? "?"} GB)`],
      ["Host", r.hypervisor_hostname ?? "—"],
      ["IPs", list(r.ips)],
      ["Tenant", ctx.tenant(r.project_id)],
      ["Load now", m ? `CPU ${formatPct(m.cpu_pct)} · memory ${formatPct(m.mem_pct)}` : "—"],
      ["Server group", r.server_group?.name ?? "—"],
    ];
    case "flavors": return [
      ["vCPUs", String(r.vcpus ?? "—")],
      ["RAM", mbToGb(r.ram_mb) != null ? `${mbToGb(r.ram_mb)} GB` : "—"],
      ["Disk", r.disk_gb ? fmtSize(r.disk_gb) : "0 (boot from volume)"],
      ["Ephemeral / swap", `${r.ephemeral_gb ?? 0} GB / ${r.swap_mb ?? 0} MB`],
      ["Public", yes(r.public)],
      ["Extra specs", String(Object.keys(r.extra_specs ?? {}).length)],
      ["VMs", String(r.vms ?? 0)],
    ];
    case "volumes": return [
      ["Status", r.status],
      ["Size", fmtSize(r.size_gb)],
      ["Type", r.volume_type ?? "—"],
      ["Backend", r.backend ?? "—"],
      ["Attached", r.attachments?.length ? r.attachments.map((a: any) => a.device).filter(Boolean).join(", ") || `${r.attachments.length} VM` : "No"],
      ["Bootable", yes(r.bootable)],
      ["Tenant", ctx.tenant(r.project_id)],
    ];
    case "storage_backends": return [
      ["Protocol", r.protocol ?? "—"],
      ["Used", r.total_gb ? `${fmtSize(r.used_gb)} of ${fmtSize(r.total_gb)} (${r.used_pct}%)` : "—"],
      ["Free", fmtSize(r.free_gb)],
      ["Provisioned", r.effective_gb ? `${fmtSize(r.provisioned_gb)} of ${fmtSize(r.effective_gb)} (${r.provisioned_pct}%)` : fmtSize(r.provisioned_gb)],
      ["Volumes", String(r.volumes)],
      ["Hosts", `${list(r.hosts)}${r.shared ? " (shared)" : ""}`],
      ["Types", list(r.types)],
    ];
    case "storage_types": return [
      ["Backend", r.backend ?? "Any"],
      ["Default", yes(r.default)],
      ["Public", yes(r.public)],
      ["QoS", r.qos?.name ?? "—"],
      ["Encrypted", yes(r.encrypted)],
      ["Volumes", `${r.volumes} (${fmtSize(r.volume_gb)})`],
    ];
    case "server_groups": return [
      ["Policy", r.policy ?? "—"],
      ["Placement", `${SERVER_GROUP_STATUS[r.status]?.label ?? r.status}: ${r.detail}`],
      ["Members", String(r.members?.length ?? 0)],
      ["Hosts", list(r.hosts)],
      ["Tenant", ctx.tenant(r.project_id)],
    ];
    case "clusters": return [
      ["Kind", r.kind === "cluster" ? "PCD cluster" : "Host aggregate"],
      ["Availability zone", r.availability_zone ?? "—"],
      ["Hosts", list((r.hosts ?? []).map((h: any) => h.hostname ?? h.service_host))],
      ["VMs", String(r.vms ?? 0)],
      ["vCPUs allocated", usedOf(r.vcpus_used, r.vcpus_total)],
      ["RAM allocated", usedOf(mbToGb(r.memory_mb_used), mbToGb(r.memory_mb_total), " GB")],
    ];
    case "networks": return [
      ["Status", r.status],
      ["External", yes(r.external)],
      ["Shared", yes(r.shared)],
      ["Subnets", String(r.subnets?.length ?? 0)],
      ["Tenant", ctx.tenant(r.project_id)],
    ];
    case "floating_ips": return [
      ["Fixed IP", r.fixed_ip_address ?? "—"],
      ["Status", r.status],
      ["VM", r.server_name || "—"],
      ["Tenant", ctx.tenant(r.project_id)],
    ];
    case "images": return [
      ["Type", r.kind === "snapshot" ? `Snapshot (${r.snapshot_type})` : "Image"],
      ["Status", r.status],
      ["Visibility", r.visibility],
      ["Format", r.disk_format ?? "—"],
      ["Size", r.size_gb > 0 ? fmtSize(r.size_gb) : "—"],
      ["Used by", `${r.used_by_vms?.length ?? 0} VMs, ${r.used_by_volumes ?? 0} volumes`],
    ];
    case "security_groups": return [
      ["Rules", String(r.rules?.length ?? 0)],
      ["Open ingress", r.risky_rules > 0 ? `${r.risky_rules} rules` : "None"],
      ["Tenant", r.tenant_name || ctx.tenant(r.project_id)],
      ["Description", r.description || "—"],
    ];
  }
}
