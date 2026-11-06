import { Facts, RelatedTable, Section } from "../../../components/DetailPage";
import { detailPath, useInventory } from "../kinds";
import { Pill, StatCard, StatusBadge } from "../shared";
import { type DetailProps, KindPage, To } from "./common";

// ── Network ─────────────────────────────────────────────────────────────────────

export function NetworkDetail({ item: n, ctx }: DetailProps) {
  return (
    <KindPage kind="networks" item={n}
      badges={<>
        <StatusBadge status={n.status} />
        {n.external && <span className="badge badge-info">external</span>}
        {n.shared && <span className="badge badge-neutral">shared</span>}
      </>}
      subtitle={ctx.tenant(n.project_id)}>
      <Section title="Network">
        <Facts rows={[
          ["Admin state", n.admin_state_up ? "up" : "down"],
          ["External", <Pill on={n.external} />],
          ["Shared", <Pill on={n.shared} />],
          ["Tenant", ctx.tenant(n.project_id)],
        ]} />
      </Section>
      <Section title={`Subnets (${n.subnets?.length ?? 0})`}>
        {(n.subnets ?? []).length
          ? (n.subnets as string[]).map(id => <div key={id} className="text-mono" style={{ fontSize: 12, padding: "3px 0" }}>{id}</div>)
          : <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>None</p>}
      </Section>
    </KindPage>
  );
}

// ── Floating IP ─────────────────────────────────────────────────────────────────

export function FloatingIpDetail({ item: f, ctx }: DetailProps) {
  return (
    <KindPage kind="floating_ips" item={f}
      badges={f.port_id ? <span className="badge badge-active">Associated</span> : <span className="badge badge-warn">Unassociated</span>}
      subtitle={ctx.tenant(f.project_id)}>
      <Section title="Floating IP">
        <Facts rows={[
          ["Address", <span className="text-mono">{f.floating_ip_address}</span>],
          ["Fixed IP", f.fixed_ip_address ? <span className="text-mono">{f.fixed_ip_address}</span> : "—"],
          ["Status", f.status],
          ["VM", f.server_id ? <To kind="servers" id={f.server_id}>{f.server_name || f.server_id}</To> : "—"],
          ["Port", f.port_id ? <span className="text-mono" style={{ fontSize: 11 }}>{f.port_id}</span> : "—"],
          ["Tenant", ctx.tenant(f.project_id)],
        ]} />
      </Section>
    </KindPage>
  );
}

// ── Security group ──────────────────────────────────────────────────────────────

export function SecurityGroupDetail({ item: sg, ctx }: DetailProps) {
  const servers = useInventory("servers");
  // Servers carry security group names; match within the group's project
  const users = (servers.data ?? []).filter(s =>
    (s.security_groups ?? []).includes(sg.name) && (!sg.project_id || s.project_id === sg.project_id));
  const rules = sg.rules ?? [];
  const sgs = useInventory("security_groups");
  const groupName = (id: string) => (id === sg.id ? `${sg.name} (itself)` : sgs.data?.find(g => g.id === id)?.name ?? id.slice(0, 8));
  return (
    <KindPage kind="security_groups" item={sg}
      badges={sg.risky_rules > 0 ? <span className="badge badge-warn">⚠ {sg.risky_rules} open ingress</span>
                                 : <span className="badge badge-ok">clean</span>}
      subtitle={sg.tenant_name || ctx.tenant(sg.project_id)}
      stats={<>
        <StatCard label="Rules" value={String(rules.length)} accent="var(--blue-primary)" />
        <StatCard label="VMs" value={String(users.length)} accent="var(--purple)" />
      </>}>
      <Section title="Security group">
        <Facts rows={[
          ["Description", sg.description || "—"],
          ["Tenant", sg.tenant_name || ctx.tenant(sg.project_id)],
          ["Open ingress rules", sg.risky_rules > 0 ? <span style={{ color: "var(--yellow)", fontWeight: 600 }}>{sg.risky_rules}</span> : "None"],
        ]} />
      </Section>
      <Section title={`VMs using it (${users.length})`}>
        <RelatedTable rows={users} rowKey={s => s.id} to={s => detailPath("servers", s.id)} empty="No VMs"
          columns={[{ label: "VM", render: s => s.name }, { label: "Status", render: s => <StatusBadge status={s.status} /> },
                    { label: "Host", render: s => s.hypervisor_hostname ?? "—" }]} />
      </Section>
      {(["ingress", "egress"] as const).map(dir => {
        const mine = rules.filter((r: any) => r.direction === dir);
        return (
          <Section key={dir} title={`${dir === "ingress" ? "Ingress (inbound)" : "Egress (outbound)"} rules (${mine.length})`} full
            aside={dir === "ingress" && sg.risky_rules > 0 ? `${sg.risky_rules} open to the internet` : undefined}>
            <RelatedTable rows={mine} rowKey={(r: any) => r.id || JSON.stringify(r)} empty={`No ${dir} rules`}
              columns={[
                { label: "Protocol", render: (r: any) => r.protocol ?? "any" },
                { label: "Ports", render: (r: any) => (r.port_range_min == null ? "all" : r.port_range_max !== r.port_range_min ? `${r.port_range_min}–${r.port_range_max}` : r.port_range_min) },
                { label: dir === "ingress" ? "From" : "To", render: (r: any) => r.remote_group_id
                    ? <>group <To kind="security_groups" id={r.remote_group_id}>{groupName(r.remote_group_id)}</To></>
                    : <span className="text-mono" style={{ fontSize: 11 }}>{r.remote_ip_prefix ?? "any"}</span> },
                { label: "Ethertype", render: (r: any) => r.ethertype ?? "—" },
                { label: "Description", render: (r: any) => r.description || <span className="text-muted">—</span> },
                { label: "", render: (r: any) => (r.risky ? <span className="badge badge-warn">⚠ open</span> : null) },
              ]} />
          </Section>
        );
      })}
    </KindPage>
  );
}
