import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { EXPORTER_STATUS, getExporterProbe } from "../../../api/exporters";
import { Facts, RelatedTable, Section, Usage } from "../../../components/DetailPage";
import { formatPct, formatRate } from "../../../components/format";
import MetricsCharts from "../../../components/MetricsCharts";
import { cpuName, fmtDate, fmtDateTime, fmtSize, mbToGb, SERVER_GROUP_STATUS } from "../format";
import { detailPath, useInventory } from "../kinds";
import { ExporterDot, muted, Pill, PctBar, StatCard, StatusBadge } from "../shared";
import { type DetailProps, KindPage, Links, To } from "./common";

const gb = (v: number) => `${Math.round(v)} GB`;
const n0 = (v: number) => String(Math.round(v));

/** Latest CPU, memory (and disk) as stat cards. */
function LoadStats({ m, disk }: { m: any; disk?: boolean }) {
  if (!m) return null;
  return (
    <>
      <StatCard label="CPU now" value={formatPct(m.cpu_pct)} accent="var(--blue-primary)" />
      <StatCard label="Memory now" value={formatPct(m.mem_pct)} accent="var(--green)" />
      {disk && <StatCard label="Disk space" value={formatPct(m.disk_pct)} accent="var(--purple)" />}
      <StatCard label="Network" value={formatRate((m.net_rx_bps ?? 0) + (m.net_tx_bps ?? 0))}
        sub={`↓ ${formatRate(m.net_rx_bps)} ↑ ${formatRate(m.net_tx_bps)}`} accent="var(--yellow)" />
    </>
  );
}

const vmColumns = (ctx: DetailProps["ctx"]) => [
  { label: "Name", render: (s: any) => <strong style={{ fontWeight: 500 }}>{s.name}</strong> },
  { label: "Status", render: (s: any) => <StatusBadge status={s.status} /> },
  { label: "Flavor", render: (s: any) => <span className="text-mono" style={{ fontSize: 11 }}>{s.flavor_name}</span> },
  { label: "vCPUs", render: (s: any) => s.flavor_vcpus ?? "—", align: "right" as const },
  { label: "RAM", render: (s: any) => (mbToGb(s.flavor_ram_mb) != null ? `${mbToGb(s.flavor_ram_mb)} GB` : "—"), align: "right" as const },
  { label: "CPU", render: (s: any) => <PctBar v={s.metrics?.cpu_pct} /> },
  { label: "Memory", render: (s: any) => <PctBar v={s.metrics?.mem_pct} /> },
  { label: "Tenant", render: (s: any) => ctx.tenant(s.project_id) },
];

// ── Hypervisor ──────────────────────────────────────────────────────────────────

export function HypervisorDetail({ item: h, ctx }: DetailProps) {
  const servers = useInventory("servers");
  const clusters = useInventory("clusters");
  const { data: probe } = useQuery({ queryKey: ["exporters"], queryFn: getExporterProbe, retry: false });
  const vms = (servers.data ?? []).filter(s => s.hypervisor_hostname === h.hostname);
  const exporters = probe?.hosts.find(x => x.hypervisor_id === h.id);
  const aggId = (name: string) => clusters.data?.find(c => c.name === name)?.id;
  const m = h.metrics;
  return (
    <KindPage kind="hypervisors" item={h}
      badges={<><StatusBadge status={h.state === "up" ? "UP" : "DOWN"} />
                <StatusBadge status={h.status === "enabled" ? "ENABLED" : "DISABLED"} />
                {m?.stale && <span className="badge badge-error">metrics stale</span>}</>}
      subtitle={<>{h.host_ip} · {cpuName(h) ?? "unknown CPU"}</>}
      stats={<><StatCard label="VMs" value={String(h.running_vms ?? vms.length)} accent="var(--purple)" /><LoadStats m={m} disk /></>}>
      <Section title="Hardware">
        <Facts rows={[
          ["CPU", cpuName(h) ?? "—"],
          ["Architecture", h.cpu_arch ?? "—"],
          ["Topology", h.cpu_sockets ? `${h.cpu_sockets} socket × ${h.cpu_cores} cores × ${h.cpu_threads} threads` : "—"],
          ["Logical CPUs", h.cpu_logical ?? "—"],
          h.memory_mb_installed != null && ["RAM installed", `${mbToGb(h.memory_mb_installed)} GB`],
          ["RAM usable by OS", mbToGb(h.memory_mb_total) != null ? `${mbToGb(h.memory_mb_total)} GB` : "—"],
          h.nic_count != null && ["Physical NICs", h.nic_count],
        ]} />
      </Section>
      <Section title="Host">
        <Facts rows={[
          ["IP", <span className="text-mono">{h.host_ip}</span>],
          ["Hypervisor", `${h.hypervisor_type ?? "—"} ${h.hypervisor_version ?? ""}`],
          h.os_version && ["OS", h.os_version],
          h.pending_patches != null && ["Patches", h.pending_patches === 0
            ? <span className="badge badge-ok">up to date</span>
            : <span className="badge badge-warn">{h.pending_patches} pending</span>],
          h.ssh_ok != null && ["SSH", h.ssh_ok ? <span className="text-success">reachable</span> : <span className="text-danger">unreachable</span>],
          ["Aggregates", <Links items={(h.aggregates ?? []).map((a: string) => ({ kind: "clusters" as const, id: aggId(a), label: a }))} />],
          h.service_host && ["PCD host ID", <span className="text-mono" style={{ fontSize: 11 }}>{h.service_host}</span>],
          exporters && ["Exporters", <span style={{ display: "inline-flex", gap: 10 }}>
            <ExporterDot name={`node-exporter · ${EXPORTER_STATUS[exporters.node.status].label}`} r={exporters.node} />
            <ExporterDot name={`libvirt-exporter · ${EXPORTER_STATUS[exporters.libvirt.status].label}`} r={exporters.libvirt} />
          </span>],
        ]} />
      </Section>
      <Section title="Allocation (Nova)">
        <Usage label="vCPUs" used={h.vcpus_used} total={h.vcpus_total} format={n0} neutral />
        <Usage label="Memory" used={mbToGb(h.memory_mb_used)} total={mbToGb(h.memory_mb_total)} format={gb} />
        <Usage label="Local disk" used={h.disk_gb_used} total={h.disk_gb_total} format={gb} />
        <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
          What VM flavors reserve, against what Nova schedules; actual use is under Metrics.
        </p>
      </Section>
      <Section title="Metrics" full>
        <MetricsCharts kind="host" id={h.id} />
      </Section>
      <Section title={`Hosted VMs (${vms.length})`} full>
        <RelatedTable rows={vms} rowKey={s => s.id} to={s => detailPath("servers", s.id)}
          columns={vmColumns(ctx)} empty="No VMs on this host" />
      </Section>
    </KindPage>
  );
}

// ── VM ──────────────────────────────────────────────────────────────────────────

export function ServerDetail({ item: s, ctx }: DetailProps) {
  const hyps = useInventory("hypervisors");
  const volumes = useInventory("volumes");
  const fips = useInventory("floating_ips");
  const sgs = useInventory("security_groups");
  const groups = useInventory("server_groups");
  const images = useInventory("images");
  const host = hyps.data?.find(h => h.hostname === s.hypervisor_hostname);
  const attached = (volumes.data ?? []).filter(v => (v.attached_to ?? []).includes(s.id));
  const myFips = (fips.data ?? []).filter(f => f.server_id === s.id);
  const group = s.server_group && groups.data?.find(g => g.id === s.server_group.id);
  const image = images.data?.find(i => i.id === s.image_id);
  const sgId = (name: string) => sgs.data?.find(g => g.name === name && g.project_id === s.project_id)?.id
    ?? sgs.data?.find(g => g.name === name)?.id;
  return (
    <KindPage kind="servers" item={s}
      badges={<StatusBadge status={s.status} />}
      subtitle={<>{s.flavor_name} · {ctx.tenant(s.project_id)}</>}
      stats={<>
        <StatCard label="Flavor" value={`${s.flavor_vcpus ?? "?"} vCPU`} sub={`${mbToGb(s.flavor_ram_mb) ?? "?"} GB RAM`} accent="var(--purple)" />
        <LoadStats m={s.metrics} />
      </>}>
      <Section title="Configuration">
        <Facts rows={[
          ["Flavor", <span className="text-mono">{s.flavor_name}</span>],
          ["vCPUs", s.flavor_vcpus ?? "—"],
          ["RAM", mbToGb(s.flavor_ram_mb) != null ? `${mbToGb(s.flavor_ram_mb)} GB` : "—"],
          ["Image", image ? <To kind="images" id={image.id}>{image.name}</To>
                          : s.image_id ? <span className="text-mono" style={{ fontSize: 11 }}>{s.image_id}</span> : "Boot from volume"],
          ["Tenant", ctx.tenant(s.project_id)],
          ["Created", fmtDateTime(s.created_at)],
          ["Updated", fmtDateTime(s.updated_at)],
        ]} />
      </Section>
      <Section title="Placement">
        <Facts rows={[
          ["Hypervisor", host ? <To kind="hypervisors" id={host.id}>{host.hostname}</To> : s.hypervisor_hostname ?? "—"],
          host && ["Aggregates", (host.aggregates ?? []).join(", ") || "—"],
          ["Server group", s.server_group
            ? <><To kind="server_groups" id={s.server_group.id}>{s.server_group.name}</To>
                {group && <span className="text-muted"> · {group.policy} · {SERVER_GROUP_STATUS[group.status]?.label}</span>}</>
            : "—"],
        ]} />
      </Section>
      <Section title="Network">
        <Facts rows={[
          ["IPs", (s.ips ?? []).length ? <span className="text-mono">{s.ips.join(", ")}</span> : "—"],
          ["Floating IPs", <Links items={myFips.map(f => ({ kind: "floating_ips" as const, id: f.id, label: f.floating_ip_address }))} />],
          ["Security groups", <Links items={(s.security_groups ?? []).map((n: string) => ({ kind: "security_groups" as const, id: sgId(n), label: n }))} />],
        ]} />
      </Section>
      <Section title="Metrics" full>
        <MetricsCharts kind="vm" id={s.id} />
      </Section>
      <Section title={`Volumes (${attached.length})`} full>
        <RelatedTable rows={attached} rowKey={v => v.id} to={v => detailPath("volumes", v.id)} empty="No volumes attached"
          columns={[
            { label: "Name", render: v => v.name },
            { label: "Status", render: v => <StatusBadge status={v.status} /> },
            { label: "Size", render: v => fmtSize(v.size_gb), align: "right" },
            { label: "Type", render: v => v.volume_type ?? "—" },
            { label: "Backend", render: v => v.backend ?? "—" },
          ]} />
      </Section>
    </KindPage>
  );
}

// ── Server group ────────────────────────────────────────────────────────────────

export function ServerGroupDetail({ item: g, ctx }: DetailProps) {
  const servers = useInventory("servers");
  const hyps = useInventory("hypervisors");
  const st = SERVER_GROUP_STATUS[g.status] ?? { label: g.status, badge: "badge-neutral" };
  const members = (g.members ?? []).map((m: any) => ({ ...m, ...(servers.data?.find(s => s.id === m.id) ?? {}) }));
  const perHost = useMemo(() => {
    const c: Record<string, number> = {};
    members.forEach((m: any) => { if (m.host ?? m.hypervisor_hostname) { const k = m.host ?? m.hypervisor_hostname; c[k] = (c[k] ?? 0) + 1; } });
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [members]);
  const hypId = (name: string) => hyps.data?.find(h => h.hostname === name)?.id;
  const banner = g.status === "violated" ? { bg: "var(--red-light)", fg: "var(--red)" }
    : g.status === "not_satisfied" ? { bg: "var(--yellow-light)", fg: "var(--yellow)" } : null;
  return (
    <KindPage kind="server_groups" item={g}
      badges={<span className={`badge ${st.badge}`}>{st.label}</span>}
      subtitle={<>{g.policy} · {ctx.tenant(g.project_id)}</>}
      stats={<>
        <StatCard label="Members" value={String(members.length)} accent="var(--blue-primary)" />
        <StatCard label="Hosts" value={String(perHost.length)} accent="var(--purple)" />
      </>}>
      {banner && (
        <div style={{ gridColumn: "1 / -1", background: banner.bg, color: banner.fg, borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
          <strong>{st.label}:</strong> {g.detail}
        </div>
      )}
      <Section title="Policy">
        <Facts rows={[
          ["Policy", <span className="text-mono">{g.policy}</span>],
          ["Max per host", g.rules?.max_server_per_host ?? (g.policy?.includes("anti-affinity") ? "1" : "—")],
          ["Placement", g.detail],
          ["Tenant", ctx.tenant(g.project_id)],
        ]} />
      </Section>
      <Section title="Members per host">
        {perHost.length ? (
          <Facts rows={perHost.map(([host, n]) => [host, <To kind="hypervisors" id={hypId(host)}>{`${n} member${n !== 1 ? "s" : ""}`}</To>])} />
        ) : <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>No member is placed.</p>}
      </Section>
      <Section title={`Members (${members.length})`} full>
        <RelatedTable rows={members} rowKey={(m: any) => m.id} to={(m: any) => detailPath("servers", m.id)} empty="No members"
          columns={[
            { label: "Name", render: (m: any) => m.name ?? <span className="text-mono">{m.id}</span> },
            { label: "Status", render: (m: any) => <StatusBadge status={m.status} /> },
            { label: "Host", render: (m: any) => m.host ?? m.hypervisor_hostname ?? "—" },
            { label: "Flavor", render: (m: any) => m.flavor_name ?? "—" },
          ]} />
      </Section>
    </KindPage>
  );
}

// ── Cluster / aggregate ─────────────────────────────────────────────────────────

export function ClusterDetail({ item: c, ctx }: DetailProps) {
  const hyps = useInventory("hypervisors");
  const servers = useInventory("servers");
  const hosts = (c.hosts ?? []).map((h: any) => ({ ...h, ...(hyps.data?.find(x => x.id === h.hypervisor_id) ?? {}) }));
  const names = new Set(hosts.map((h: any) => h.hostname).filter(Boolean));
  const vms = (servers.data ?? []).filter(s => names.has(s.hypervisor_hostname));
  const meta = Object.entries(c.metadata ?? {});
  return (
    <KindPage kind="clusters" item={c}
      badges={c.kind === "cluster" ? <span className="badge badge-info">PCD cluster</span> : <span className="badge badge-neutral">aggregate</span>}
      subtitle={c.availability_zone ? `Availability zone ${c.availability_zone}` : "No availability zone"}
      stats={<>
        <StatCard label="Hosts" value={String(hosts.length)} accent="var(--purple)" />
        <StatCard label="VMs" value={String(c.vms ?? vms.length)} accent="var(--blue-primary)" />
        <StatCard label="vCPUs" value={`${c.vcpus_used} / ${c.vcpus_total}`} sub="allocated / total" accent="var(--blue-primary)" />
        <StatCard label="RAM" value={`${mbToGb(c.memory_mb_used) ?? 0} / ${mbToGb(c.memory_mb_total) ?? 0} GB`} sub="allocated / total" accent="var(--green)" />
      </>}>
      <Section title="Allocation">
        <Usage label="vCPUs" used={c.vcpus_used} total={c.vcpus_total} format={n0} neutral />
        <Usage label="Memory" used={mbToGb(c.memory_mb_used)} total={mbToGb(c.memory_mb_total)} format={gb} />
      </Section>
      <Section title="Details">
        <Facts rows={[
          ["Kind", c.kind === "cluster" ? "PCD cluster (pf9-managed aggregate)" : "Host aggregate"],
          ["Availability zone", c.availability_zone ?? "—"],
          ["Created", fmtDate(c.created_at)],
          ["Updated", fmtDate(c.updated_at)],
          ...meta.map(([k, v]) => [k, <span className="text-mono" style={{ fontSize: 12 }}>{String(v)}</span>] as [string, React.ReactNode]),
        ]} />
      </Section>
      <Section title={`Hosts (${hosts.length})`} full>
        <RelatedTable rows={hosts} rowKey={(h: any) => h.service_host} empty="No hosts"
          to={(h: any) => (h.hypervisor_id ? detailPath("hypervisors", h.hypervisor_id) : null)}
          columns={[
            { label: "Host", render: (h: any) => <strong style={{ fontWeight: 500 }}>{h.hostname ?? <span className="text-mono">{h.service_host}</span>}</strong> },
            { label: "State", render: (h: any) => (h.state ? <StatusBadge status={h.state === "up" ? "UP" : "DOWN"} /> : muted()) },
            { label: "VMs", render: (h: any) => h.running_vms ?? "—", align: "right" },
            { label: "vCPUs", render: (h: any) => (h.vcpus_total ? `${h.vcpus_used} / ${h.vcpus_total}` : "—"), align: "right" },
            { label: "RAM", render: (h: any) => (h.memory_mb_total ? `${mbToGb(h.memory_mb_used)} / ${mbToGb(h.memory_mb_total)} GB` : "—"), align: "right" },
            { label: "CPU", render: (h: any) => <PctBar v={h.metrics?.cpu_pct} /> },
            { label: "Memory", render: (h: any) => <PctBar v={h.metrics?.mem_pct} /> },
            { label: "SSH", render: (h: any) => (h.ssh_ok == null ? muted() : <Pill on={h.ssh_ok} yes="ok" no="unreachable" />) },
          ]} />
      </Section>
      <Section title={`VMs (${vms.length})`} full>
        <RelatedTable rows={vms} rowKey={s => s.id} to={s => detailPath("servers", s.id)} columns={vmColumns(ctx)} empty="No VMs" />
      </Section>
    </KindPage>
  );
}
