import { AlertTriangle, Shield } from "lucide-react";
import {
  filterRows, HeaderRow, muted, Pill, StatusBadge, type TableProps, TableWrap, useRows, useSort,
} from "../shared";

// ── Networks ────────────────────────────────────────────────────────────────────

export function NetworksTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "status"])
    .map(n => ({ ...n, subnet_count: n.subnets?.length ?? 0 }));
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("networks", ctx);
  return (
    <TableWrap kind="networks" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Status", "status"], ["External", "external"],
        ["Shared", "shared"], ["Subnets", "subnet_count"], ["Tenant", ""]]} />
      {sorted.map(n => (
        <tr key={n.id} {...rowProps(n)}>
          <td style={{ fontWeight: 500 }}>{n.name || muted("(unnamed)")}</td>
          <td><StatusBadge status={n.status} /></td>
          <td><Pill on={n.external} /></td>
          <td><Pill on={n.shared} /></td>
          <td>{n.subnet_count}</td>
          <td>{ctx.tenant(n.project_id)}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Floating IPs ────────────────────────────────────────────────────────────────

export function FloatingIpsTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["floating_ip_address", "fixed_ip_address", "server_name", "status"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("floating_ips", ctx);
  return (
    <TableWrap kind="floating_ips" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Floating IP", "floating_ip_address"], ["Fixed IP", "fixed_ip_address"],
        ["Status", "status"], ["Associated VM", "server_name"], ["Tenant", ""]]} />
      {sorted.map(f => (
        <tr key={f.id} {...rowProps(f)}>
          <td className="text-mono" style={{ fontWeight: 500 }}>{f.floating_ip_address}</td>
          <td className="text-mono">{f.fixed_ip_address || "—"}</td>
          <td>{f.port_id ? <span className="badge badge-active">Associated</span>
                         : <span className="badge badge-warn">Unassociated</span>}</td>
          <td>{f.server_name || muted()}</td>
          <td>{ctx.tenant(f.project_id)}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Security groups ─────────────────────────────────────────────────────────────

export function SecurityGroupsTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "description"])
    .map(sg => ({ ...sg, rule_count: sg.rules?.length ?? 0 }));
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("security_groups", ctx);
  const riskyCount = (data ?? []).filter(sg => sg.risky_rules > 0).length;
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
      <TableWrap kind="security_groups" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
        <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Description", "description"],
          ["Rules", "rule_count"], ["Risky", "risky_rules"], ["Tenant", ""]]} />
        {sorted.map(sg => (
          <tr key={sg.id} {...rowProps(sg)}>
            <td style={{ fontWeight: 500 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Shield size={13} style={{ color: sg.risky_rules > 0 ? "var(--yellow)" : "var(--gray-400)" }} />
                {sg.name}
              </span>
            </td>
            <td className="text-muted" style={{ fontSize: 11 }}>{sg.description || "—"}</td>
            <td>{sg.rule_count}</td>
            <td>{sg.risky_rules > 0 ? <span className="badge badge-warn">⚠ {sg.risky_rules} open</span>
                                    : <span className="badge badge-ok">clean</span>}</td>
            <td>{sg.tenant_name || ctx.tenant(sg.project_id)}</td>
          </tr>
        ))}
      </TableWrap>
    </>
  );
}
