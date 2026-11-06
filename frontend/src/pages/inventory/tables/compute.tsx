import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cell, Pie, PieChart, Tooltip as RTooltip } from "recharts";
import { errorDetail } from "../../../api/client";
import { EXPORTER_STATUS, type ExporterHost, getExporterProbe, probeExporters } from "../../../api/exporters";
import { cpuName, fmtDate, mbToGb, pct, ramGb, SERVER_GROUP_STATUS } from "../format";
import {
  ExporterDot, filterRows, HeaderRow, LoadCells, muted, PctBar, StatusBadge, type TableProps,
  TableWrap, useRows, useSort,
} from "../shared";

const CHART_COLORS = ["var(--blue-primary)", "var(--purple)", "var(--green)", "var(--yellow)", "var(--red)", "#0891B2", "#7C3AED", "#059669"];

// ── Clusters & aggregates ─────────────────────────────────────────────────────────

export function ClustersTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "availability_zone", "kind"])
    .map(c => ({ ...c, host_count: c.hosts?.length ?? 0,
                 vcpu_pct: pct(c.vcpus_used, c.vcpus_total), mem_pct: pct(c.memory_mb_used, c.memory_mb_total) }));
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("clusters", ctx);
  return (
    <TableWrap kind="clusters" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Kind", "kind"],
        ["Availability Zone", "availability_zone"], ["Hosts", "host_count"], ["VMs", "vms"],
        ["vCPUs Allocated", "vcpu_pct"], ["RAM Allocated", "mem_pct"], ["Updated", "updated_at"]]} />
      {sorted.map(c => (
        <tr key={c.id} {...rowProps(c)}>
          <td style={{ fontWeight: 500 }}>{c.name}</td>
          <td>{c.kind === "cluster" ? <span className="badge badge-info">PCD cluster</span>
                                    : <span className="badge badge-neutral">aggregate</span>}</td>
          <td>{c.availability_zone || muted()}</td>
          <td style={{ fontSize: 12 }}>
            {c.host_count}{" "}
            <span className="text-muted" style={{ fontSize: 11 }}>
              {(c.hosts ?? []).slice(0, 3).map((h: any) => h.hostname ?? h.service_host?.slice(0, 8)).join(", ")}
              {c.host_count > 3 && " …"}
            </span>
          </td>
          <td>{c.vms ?? 0}</td>
          <td><PctBar v={c.vcpu_pct} high={Infinity} /><span className="text-muted" style={{ fontSize: 10 }}>{c.vcpus_used} / {c.vcpus_total}</span></td>
          <td><PctBar v={c.mem_pct} /><span className="text-muted" style={{ fontSize: 10 }}>{mbToGb(c.memory_mb_used)} / {mbToGb(c.memory_mb_total)} GB</span></td>
          <td>{fmtDate(c.updated_at)}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Hypervisors ─────────────────────────────────────────────────────────────────

export function HypervisorsTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  // Latest load, flattened so the columns sort.
  const rows = filterRows(data, search, tenantFilter, ["hostname", "state", "status", "host_ip", "cpu_model", "cpu_vendor", "hypervisor_type"])
    .map(h => ({ ...h, ram_gb: ramGb(h), load_cpu: h.metrics?.cpu_pct, load_mem: h.metrics?.mem_pct,
                 load_disk: h.metrics?.disk_pct,
                 load_net: (h.metrics?.net_rx_bps ?? 0) + (h.metrics?.net_tx_bps ?? 0) || undefined }));
  const hasMetrics = (data ?? []).some(h => h.metrics);
  const hasSsh = (data ?? []).some(h => h.ssh_ok != null);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("hypervisors", ctx);

  // Exporter probe: can this appliance scrape node-exporter and libvirt-exporter directly?
  const queryClient = useQueryClient();
  const { data: probe } = useQuery({ queryKey: ["exporters"], queryFn: getExporterProbe, retry: false });
  const probeMut = useMutation({
    mutationFn: probeExporters,
    onSuccess: r => queryClient.setQueryData(["exporters"], r),
  });
  const probeByHost = useMemo(() => {
    const m: Record<string, ExporterHost> = {};
    (probe?.hosts ?? []).forEach(h => { m[h.hypervisor_id] = h; });
    return m;
  }, [probe]);
  const reachable = (probe?.hosts ?? []).filter(h =>
    EXPORTER_STATUS[h.node.status].ok && EXPORTER_STATUS[h.libvirt.status].ok).length;

  const cols: [string, string][] = [
    ["Hostname", "hostname"], ["State", "state"], ["VMs", "running_vms"], ["Sockets", "cpu_sockets"],
    ["Cores/Socket", "cpu_cores"], ["RAM", "ram_gb"], ["CPU Model", "cpu_model"], ["Type", "hypervisor_type"],
    ...(hasMetrics ? [["CPU", "load_cpu"], ["Memory", "load_mem"], ["Disk", "load_disk"], ["Network", "load_net"]] as [string, string][] : []),
    ...(hasSsh ? [["SSH / NICs", "nic_count"], ["OS", "os_version"], ["Patches", "pending_patches"]] as [string, string][] : []),
    ...(probe ? [["Exporters", ""]] as [string, string][] : []),
  ];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 10px", fontSize: 12, flexWrap: "wrap" }}>
        <button className="btn btn-secondary btn-sm" disabled={probeMut.isPending} onClick={() => probeMut.mutate()}
          title="Check that this appliance can reach node-exporter (:9388) and libvirt-exporter (:9177) on each hypervisor">
          {probeMut.isPending ? "Probing…" : "Probe exporters"}
        </button>
        {probe && (
          <span className="text-muted">
            Exporters reachable on {reachable} of {probe.hosts.length} hosts · probed {new Date(probe.probed_at + "Z").toLocaleString()}
          </span>
        )}
        {probeMut.isError && <span className="text-danger">{errorDetail(probeMut.error)}</span>}
      </div>
      <TableWrap kind="hypervisors" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
        <HeaderRow cols={cols} sort={sort} toggle={toggle} />
        {sorted.map(h => (
          <tr key={h.id} {...rowProps(h)}>
            <td style={{ fontWeight: 500 }}>{h.hostname}</td>
            <td><StatusBadge status={h.state === "up" ? "UP" : "DOWN"} /></td>
            <td>{h.running_vms ?? "—"}</td>
            <td>{h.cpu_sockets ?? "—"}</td>
            <td>{h.cpu_cores ?? "—"}</td>
            <td title={h.memory_mb_installed && h.memory_mb_total
                  ? `${mbToGb(h.memory_mb_total)} GB usable by the OS` : undefined}>
              {h.ram_gb != null ? `${h.ram_gb} GB` : "—"}
            </td>
            <td className="text-mono" style={{ fontSize: 11, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {cpuName(h) ?? "—"}
            </td>
            <td className="text-mono" style={{ fontSize: 11 }}>{h.hypervisor_type ?? "—"}</td>
            {hasMetrics && <LoadCells m={h.metrics} />}
            {hasSsh && (
              <td>
                {h.ssh_ok === true && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)" }} />{h.nic_count} NIC{h.nic_count !== 1 ? "s" : ""}</span>}
                {h.ssh_ok === false && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--red)" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--red)" }} />unreachable</span>}
                {h.ssh_ok == null && muted()}
              </td>
            )}
            {hasSsh && <td style={{ fontSize: 11 }}>{h.os_version ?? "—"}</td>}
            {hasSsh && (
              <td>
                {h.pending_patches == null ? muted()
                  : h.pending_patches === 0 ? <span className="badge badge-ok">up to date</span>
                  : <span className="badge badge-warn">{h.pending_patches} pending</span>}
              </td>
            )}
            {probe && (
              <td style={{ whiteSpace: "nowrap" }}>
                {probeByHost[h.id]
                  ? <><ExporterDot name="node" r={probeByHost[h.id].node} />{" "}<ExporterDot name="libvirt" r={probeByHost[h.id].libvirt} /></>
                  : muted()}
              </td>
            )}
          </tr>
        ))}
      </TableWrap>
    </>
  );
}

// ── Servers ─────────────────────────────────────────────────────────────────────

export function ServersTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "status", "project_id", "flavor_name", "hypervisor_hostname"])
    .map(s => ({ ...s, load_cpu: s.metrics?.cpu_pct, load_mem: s.metrics?.mem_pct,
                 load_net: (s.metrics?.net_rx_bps ?? 0) + (s.metrics?.net_tx_bps ?? 0) || undefined }));
  const hasMetrics = (data ?? []).some(s => s.metrics);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("servers", ctx);

  const flavorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    (data ?? []).forEach(s => { if (s.flavor_name) counts[s.flavor_name] = (counts[s.flavor_name] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  }, [data]);

  return (
    <>
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

      <TableWrap kind="servers" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
        <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Status", "status"],
          ["Flavor", "flavor_name"], ["vCPUs", "flavor_vcpus"], ["RAM", "flavor_ram_mb"], ["IPs", ""],
          ["Tenant", ""], ["Hypervisor", "hypervisor_hostname"],
          ...(hasMetrics ? [["CPU", "load_cpu"], ["Memory", "load_mem"], ["Network", "load_net"]] as [string, string][] : []),
          ["Created", "created_at"]]} />
        {sorted.map(s => (
          <tr key={s.id} {...rowProps(s)}>
            <td style={{ fontWeight: 500 }}>{s.name}</td>
            <td><StatusBadge status={s.status} /></td>
            <td className="text-mono" style={{ fontSize: 11 }}>{s.flavor_name}</td>
            <td>{s.flavor_vcpus ?? "—"}</td>
            <td>{mbToGb(s.flavor_ram_mb) != null ? `${mbToGb(s.flavor_ram_mb)} GB` : "—"}</td>
            <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{(s.ips || []).join(", ") || "—"}</td>
            <td>{ctx.tenant(s.project_id)}</td>
            <td className="text-mono" style={{ fontSize: 11 }}>{s.hypervisor_hostname || "—"}</td>
            {hasMetrics && <LoadCells m={s.metrics} disk={false} />}
            <td>{fmtDate(s.created_at)}</td>
          </tr>
        ))}
      </TableWrap>
    </>
  );
}

// ── Server groups ───────────────────────────────────────────────────────────────

export function ServerGroupsTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "policy", "status"])
    .map(g => ({ ...g, member_count: g.members?.length ?? 0, host_count: g.hosts?.length ?? 0 }));
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("server_groups", ctx);
  const broken = (data ?? []).filter(g => g.status === "violated").length;
  return (
    <>
      {broken > 0 && (
        <div className="text-danger" style={{ padding: "8px 14px", background: "var(--red-light)", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          <strong>{broken} server group{broken !== 1 ? "s" : ""}</strong> with members placed against a hard policy.
        </div>
      )}
      <TableWrap kind="server_groups" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
        <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Policy", "policy"],
          ["Placement", "status"], ["Members", "member_count"], ["Hosts", "host_count"], ["Tenant", ""]]} />
        {sorted.map(g => {
          const st = SERVER_GROUP_STATUS[g.status] ?? { label: g.status, badge: "badge-neutral" };
          return (
            <tr key={g.id} {...rowProps(g)}>
              <td style={{ fontWeight: 500 }}>{g.name}</td>
              <td className="text-mono" style={{ fontSize: 11 }}>
                {g.policy}{g.rules?.max_server_per_host ? ` (max ${g.rules.max_server_per_host}/host)` : ""}
              </td>
              <td><span className={`badge ${st.badge}`} title={g.detail}>{st.label}</span></td>
              <td>{g.member_count}</td>
              <td>{g.host_count}</td>
              <td>{ctx.tenant(g.project_id)}</td>
            </tr>
          );
        })}
      </TableWrap>
    </>
  );
}

// ── Flavors ─────────────────────────────────────────────────────────────────────

export function FlavorsTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "description"])
    .map(f => ({ ...f, spec_count: Object.keys(f.extra_specs ?? {}).length }));
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("flavors", ctx);
  return (
    <TableWrap kind="flavors" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["vCPUs", "vcpus"], ["RAM", "ram_mb"],
        ["Disk", "disk_gb"], ["Ephemeral", "ephemeral_gb"], ["Swap", "swap_mb"], ["Public", "public"],
        ["Extra Specs", "spec_count"], ["VMs", "vms"]]} />
      {sorted.map(f => (
        <tr key={f.id} {...rowProps(f)}>
          <td className="text-mono" style={{ fontWeight: 500 }}>
            {f.name}{f.disabled && <span className="badge badge-warn" style={{ marginLeft: 6 }}>disabled</span>}
          </td>
          <td>{f.vcpus}</td>
          <td>{mbToGb(f.ram_mb) != null ? `${mbToGb(f.ram_mb)} GB` : `${f.ram_mb} MB`}</td>
          <td>{f.disk_gb ? `${f.disk_gb} GB` : muted("0")}</td>
          <td>{f.ephemeral_gb ? `${f.ephemeral_gb} GB` : muted("0")}</td>
          <td>{f.swap_mb ? `${f.swap_mb} MB` : muted("0")}</td>
          <td>{f.public ? <span className="text-success" style={{ fontWeight: 600, fontSize: 12 }}>Yes</span> : muted("No")}</td>
          <td style={{ fontSize: 11 }}>
            {f.spec_count ? Object.entries(f.extra_specs).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(", ") + (f.spec_count > 2 ? " …" : "") : muted()}
          </td>
          <td>{f.vms ?? 0}</td>
        </tr>
      ))}
    </TableWrap>
  );
}
