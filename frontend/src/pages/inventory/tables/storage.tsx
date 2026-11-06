import { fmtDate, fmtSize } from "../format";
import {
  filterRows, HeaderRow, muted, PctBar, Pill, StatusBadge, type TableProps, TableWrap, useRows, useSort,
} from "../shared";

// ── Volumes ─────────────────────────────────────────────────────────────────────

export function VolumesTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "status", "volume_type", "backend"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("volumes", ctx);
  return (
    <TableWrap kind="volumes" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Status", "status"], ["Size", "size_gb"],
        ["Type", "volume_type"], ["Backend", "backend"], ["Attached To", ""], ["Tenant", ""], ["Created", "created_at"]]} />
      {sorted.map(v => (
        <tr key={v.id} {...rowProps(v)}>
          <td style={{ fontWeight: 500 }}>{v.name}</td>
          <td><StatusBadge status={v.status} /></td>
          <td>{fmtSize(v.size_gb)}</td>
          <td>{v.volume_type || muted()}</td>
          <td>{v.backend || muted()}</td>
          <td className="text-mono" style={{ fontSize: 11 }}>
            {v.attached_to?.length ? v.attached_to.map((id: string) => id.slice(0, 8) + "…").join(", ") : muted("unattached")}
          </td>
          <td>{ctx.tenant(v.project_id)}</td>
          <td>{fmtDate(v.created_at)}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Storage backends ────────────────────────────────────────────────────────────

export function StorageBackendsTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "protocol", "vendor"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("storage_backends", ctx);
  return (
    <TableWrap kind="storage_backends" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Backend", "name"], ["Protocol", "protocol"],
        ["Capacity", "total_gb"], ["Used", "used_pct"], ["Free", "free_gb"],
        ["Provisioned", "provisioned_pct"], ["Volumes", "volumes"], ["Hosts", ""], ["Types", ""]]} />
      {sorted.map(b => (
        <tr key={b.name} {...rowProps(b)}>
          <td style={{ fontWeight: 500 }}>
            {b.name}{" "}
            {b.state === "down" && <span className="badge badge-error">down</span>}
          </td>
          <td className="text-mono" style={{ fontSize: 11 }}>{b.protocol ?? "—"}</td>
          <td>{fmtSize(b.total_gb)}</td>
          <td style={{ minWidth: 110 }}>
            <PctBar v={b.used_pct} low={0} high={85} />
            <span className="text-muted" style={{ fontSize: 10 }}>{fmtSize(b.used_gb)}</span>
          </td>
          <td>{fmtSize(b.free_gb)}</td>
          <td style={{ minWidth: 110 }} title={`Provisioned volumes against ${b.oversubscription}× oversubscribed capacity`}>
            <PctBar v={b.provisioned_pct} low={0} high={90} />
            <span className="text-muted" style={{ fontSize: 10 }}>
              {fmtSize(b.provisioned_gb)} of {fmtSize(b.effective_gb)}{b.thin && b.oversubscription > 1 ? ` (${b.oversubscription}×)` : ""}
            </span>
          </td>
          <td>{b.volumes}</td>
          <td style={{ fontSize: 11 }}>
            {(b.hosts ?? []).join(", ") || "—"}
            {b.shared && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 10 }}>shared</span>}
          </td>
          <td style={{ fontSize: 11 }}>{(b.types ?? []).join(", ") || muted()}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Storage (volume) types ──────────────────────────────────────────────────────

export function StorageTypesTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "backend", "description"]);
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("storage_types", ctx);
  return (
    <TableWrap kind="storage_types" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Backend", "backend"], ["Default", "default"],
        ["Public", "public"], ["QoS", ""], ["Encrypted", "encrypted"], ["Volumes", "volumes"], ["Size", "volume_gb"],
        ["Description", "description"]]} />
      {sorted.map(t => (
        <tr key={t.id} {...rowProps(t)}>
          <td style={{ fontWeight: 500 }}>{t.name}</td>
          <td>{t.backend ?? muted("any")}</td>
          <td>{t.default ? <span className="badge badge-info">default</span> : muted("")}</td>
          <td><Pill on={t.public} /></td>
          <td>{t.qos?.name ?? muted()}</td>
          <td><Pill on={t.encrypted} /></td>
          <td>{t.volumes}</td>
          <td>{fmtSize(t.volume_gb)}</td>
          <td className="text-muted" style={{ fontSize: 11 }}>{t.description || "—"}</td>
        </tr>
      ))}
    </TableWrap>
  );
}

// ── Images ──────────────────────────────────────────────────────────────────────

export function ImagesTable({ data, isLoading, search, tenantFilter, ctx }: TableProps) {
  const rows = filterRows(data, search, tenantFilter, ["name", "status", "visibility", "disk_format", "owner"], "owner")
    .map(img => ({ ...img, vm_count: img.used_by_vms?.length ?? 0 }));
  const { sorted, sort, toggle } = useSort<any>(rows);
  const { rowProps, card } = useRows("images", ctx);
  return (
    <TableWrap kind="images" ctx={ctx} isLoading={isLoading} total={data?.length} rows={sorted} card={card}>
      <HeaderRow sort={sort} toggle={toggle} cols={[["Name", "name"], ["Status", "status"], ["Visibility", "visibility"],
        ["Format", "disk_format"], ["Size", "size_gb"], ["VMs Using", "vm_count"], ["Created", "created_at"]]} />
      {sorted.map(img => (
        <tr key={img.id} {...rowProps(img)}>
          <td style={{ fontWeight: 500 }}>{img.name}</td>
          <td><StatusBadge status={img.status?.toUpperCase()} /></td>
          <td><StatusBadge status={img.visibility?.toUpperCase()} /></td>
          <td className="text-mono" style={{ fontSize: 11 }}>{img.disk_format}</td>
          <td>{img.size_gb > 0 ? fmtSize(img.size_gb) : "—"}</td>
          <td>
            {img.vm_count > 0
              ? <span className="badge badge-info">{img.vm_count} VM{img.vm_count !== 1 ? "s" : ""}</span>
              : muted("unused")}
          </td>
          <td>{fmtDate(img.created_at)}</td>
        </tr>
      ))}
    </TableWrap>
  );
}
