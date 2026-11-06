import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../api/client";
import { Facts, RelatedTable, Section, Usage } from "../../../components/DetailPage";
import { formatPct } from "../../../components/format";
import MetricsCharts from "../../../components/MetricsCharts";
import { fmtDateTime, fmtSize } from "../format";
import { detailPath, useInventory } from "../kinds";
import { muted, Pill, StatCard, StatusBadge } from "../shared";
import { AllProperties, type DetailProps, KindPage, Links, To } from "./common";

const size = (v: number) => fmtSize(v);
const specs = (o?: Record<string, unknown> | null): [string, ReactNode][] =>
  Object.entries(o ?? {}).map(([k, v]) => [k, <span className="text-mono" style={{ fontSize: 12 }}>{String(v)}</span>]);

const volumeColumns = [
  { label: "Name", render: (v: any) => <strong style={{ fontWeight: 500 }}>{v.name}</strong> },
  { label: "Status", render: (v: any) => <StatusBadge status={v.status} /> },
  { label: "Size", render: (v: any) => fmtSize(v.size_gb), align: "right" as const },
  { label: "Type", render: (v: any) => v.volume_type ?? "—" },
  { label: "Attached", render: (v: any) => (v.attached_to?.length ? `${v.attached_to.length} VM` : muted("no")) },
];

// ── Volume ──────────────────────────────────────────────────────────────────────

export function VolumeDetail({ item: v, ctx }: DetailProps) {
  const servers = useInventory("servers");
  const types = useInventory("storage_types");
  const type = types.data?.find(t => t.name === v.volume_type || t.id === v.volume_type);
  const attachments = v.attachments ?? (v.attached_to ?? []).map((id: string) => ({ server_id: id }));
  return (
    <KindPage kind="volumes" item={v}
      badges={<>{<StatusBadge status={v.status} />}{v.bootable && <span className="badge badge-info">bootable</span>}</>}
      subtitle={<>{fmtSize(v.size_gb)} · {ctx.tenant(v.project_id)}</>}>
      <Section title="Volume">
        <Facts rows={[
          ["Size", fmtSize(v.size_gb)],
          ["Type", <To kind="storage_types" id={type?.id}>{v.volume_type ?? "—"}</To>],
          ["Backend", <To kind="storage_backends" id={v.backend}>{v.backend ?? "—"}</To>],
          ["Pool", v.host ? <span className="text-mono" style={{ fontSize: 11 }}>{v.host}</span> : "—"],
          ["Bootable", <Pill on={!!v.bootable} />],
          ["Tenant", ctx.tenant(v.project_id)],
          ["Created", fmtDateTime(v.created_at)],
        ]} />
      </Section>
      <Section title={`Attached to (${attachments.length})`}>
        <RelatedTable rows={attachments} rowKey={(a: any) => a.server_id ?? a.device} empty="Not attached"
          to={(a: any) => (a.server_id ? detailPath("servers", a.server_id) : null)}
          columns={[
            { label: "VM", render: (a: any) => (a.server_id
                ? servers.data?.find(s => s.id === a.server_id)?.name ?? a.server_id
                : <span className="text-muted">{a.device === "glance_store" ? "Glance image store" : "No VM"}</span>) },
            { label: "Device", render: (a: any) => <span className="text-mono">{a.device ?? "—"}</span> },
            { label: "Host", render: (a: any) => servers.data?.find(s => s.id === a.server_id)?.hypervisor_hostname ?? "—" },
          ]} />
      </Section>
      <Section title="I/O" full>
        <MetricsCharts kind="volume" id={v.id} />
        <p className="text-muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
          From the hypervisor's view of the VM disk this volume is attached as. How full the filesystem
          inside is needs a guest agent; "Allocated" is what the host sees written (file-backed volumes
          such as NFS; network disks such as Ceph RBD report 0).
        </p>
      </Section>
      <AllProperties kind="volumes" id={v.id} />
    </KindPage>
  );
}

// ── Storage backend ─────────────────────────────────────────────────────────────

export function StorageBackendDetail({ item: b }: DetailProps) {
  const volumes = useInventory("volumes");
  const types = useInventory("storage_types");
  const hyps = useInventory("hypervisors");
  const vols = (volumes.data ?? []).filter(v => v.backend === b.name).sort((x, y) => (y.size_gb ?? 0) - (x.size_gb ?? 0));
  const typeId = (name: string) => types.data?.find(t => t.name === name)?.id;
  const hypId = (name?: string | null) => hyps.data?.find(h => h.hostname === name)?.id;
  return (
    <KindPage kind="storage_backends" item={b}
      badges={<>
        {b.state && <StatusBadge status={b.state.toUpperCase()} />}
        {b.shared && <span className="badge badge-info" title="Every host reports the same capacity: one store, counted once">shared</span>}
      </>}
      subtitle={<>{b.protocol ?? "unknown protocol"}{b.vendor ? ` · ${b.vendor}` : ""}</>}
      stats={<>
        <StatCard label="Used" value={formatPct(b.used_pct)} sub={`${fmtSize(b.used_gb)} of ${fmtSize(b.total_gb)}`} accent="var(--blue-primary)" />
        <StatCard label="Free" value={fmtSize(b.free_gb)} accent="var(--green)" />
        <StatCard label="Provisioned" value={formatPct(b.provisioned_pct)}
          sub={`${fmtSize(b.provisioned_gb)} of ${fmtSize(b.effective_gb)}`} accent="var(--purple)" />
        <StatCard label="Volumes" value={String(b.volumes)} accent="var(--yellow)" />
      </>}>
      <Section title="Capacity">
        <Usage label="Used space" used={b.used_gb} total={b.total_gb} format={size} />
        <Usage label="Provisioned" used={b.provisioned_gb} total={b.effective_gb} format={size} high={90} />
        <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
          Provisioned is the size of the volumes on this backend, against its capacity
          {b.thin && b.oversubscription > 1 ? ` × ${b.oversubscription} (thin provisioning oversubscription)` : ""}.
        </p>
      </Section>
      <Section title="Backend">
        <Facts rows={[
          ["Protocol", b.protocol ?? "—"],
          ["Vendor", b.vendor ?? "—"],
          ["Driver version", b.driver_version ?? "—"],
          ["Thin provisioning", <Pill on={b.thin} />],
          ["Oversubscription", b.oversubscription != null ? `${b.oversubscription}×` : "—"],
          ["Volume types", <Links items={(b.types ?? []).map((t: string) => ({ kind: "storage_types" as const, id: typeId(t), label: t }))} />],
          ["Reported", fmtDateTime(b.reported_at)],
        ]} />
      </Section>
      <Section title="Capacity and I/O" full>
        <MetricsCharts kind="storage" id={b.name} />
      </Section>
      <Section title={`Pools (${b.pools?.length ?? 0})`} full aside={b.shared ? "One shared store, reported by each host" : undefined}>
        <RelatedTable rows={b.pools ?? []} rowKey={(p: any) => p.name}
          to={(p: any) => (hypId(p.hostname) ? detailPath("hypervisors", hypId(p.hostname)!) : null)}
          columns={[
            { label: "Host", render: (p: any) => p.hostname ?? <span className="text-mono">{p.host}</span> },
            { label: "Pool", render: (p: any) => <span className="text-mono" style={{ fontSize: 11 }}>{p.name.split("@")[1] ?? p.name}</span> },
            { label: "Capacity", render: (p: any) => fmtSize(p.total_gb), align: "right" },
            { label: "Free", render: (p: any) => fmtSize(p.free_gb), align: "right" },
            { label: "Allocated", render: (p: any) => fmtSize(p.allocated_gb), align: "right" },
            { label: "State", render: (p: any) => p.state ?? "—" },
            { label: "Reported", render: (p: any) => fmtDateTime(p.reported_at) },
          ]} />
      </Section>
      <Section title={`Volumes (${vols.length})`} full aside="Largest first">
        <RelatedTable rows={vols} rowKey={v => v.id} to={v => detailPath("volumes", v.id)} columns={volumeColumns} empty="No volumes" />
      </Section>
    </KindPage>
  );
}

// ── Storage type ────────────────────────────────────────────────────────────────

export function StorageTypeDetail({ item: t, ctx }: DetailProps) {
  const volumes = useInventory("volumes");
  const vols = (volumes.data ?? []).filter(v => v.volume_type === t.name || v.volume_type === t.id);
  return (
    <KindPage kind="storage_types" item={t}
      badges={<>{t.default && <span className="badge badge-info">default</span>}
                {!t.public && <span className="badge badge-neutral">private</span>}</>}
      subtitle={t.description || undefined}
      stats={<>
        <StatCard label="Volumes" value={String(t.volumes)} sub={fmtSize(t.volume_gb)} accent="var(--blue-primary)" />
      </>}>
      <Section title="Type">
        <Facts rows={[
          ["Backend", t.backend ? <To kind="storage_backends" id={t.backend}>{t.backend}</To> : "Any (the scheduler picks)"],
          ["Default", <Pill on={t.default} />],
          ["Public", <Pill on={t.public} />],
          ["Encrypted", <Pill on={t.encrypted} />],
          t.access_projects && ["Projects with access", t.access_projects.map((p: string) => ctx.tenant(p)).join(", ") || "—"],
        ]} />
      </Section>
      <Section title="Extra specs">
        {Object.keys(t.extra_specs ?? {}).length ? <Facts rows={specs(t.extra_specs)} />
          : <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>None</p>}
      </Section>
      <Section title="QoS">
        {t.qos ? <Facts rows={[["Spec", t.qos.name], ["Consumer", t.qos.consumer ?? "—"], ...specs(t.qos.specs)]} />
          : <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>No QoS spec</p>}
      </Section>
      <Section title={`Volumes (${vols.length})`} full>
        <RelatedTable rows={vols} rowKey={v => v.id} to={v => detailPath("volumes", v.id)} empty="No volumes"
          columns={[...volumeColumns.slice(0, 3), { label: "Backend", render: (v: any) => v.backend ?? "—" }, volumeColumns[4]]} />
      </Section>
      <AllProperties kind="storage_types" id={t.id} />
    </KindPage>
  );
}

// ── Image ───────────────────────────────────────────────────────────────────────

export function ImageDetail({ item: img, ctx }: DetailProps) {
  const servers = useInventory("servers");
  const images = useInventory("images");
  const users = (servers.data ?? []).filter(s => s.image_id === img.id);
  const snapshot = img.kind === "snapshot";
  const base = img.base_image_ref && images.data?.find(i => i.id === img.base_image_ref);
  const source = img.instance_uuid && servers.data?.find(s => s.id === img.instance_uuid);
  const snapshots = (images.data ?? []).filter(i => i.kind === "snapshot" && i.base_image_ref === img.id);
  return (
    <KindPage kind="images" item={img}
      badges={<>
        {snapshot ? <span className="badge badge-provisioning">snapshot · {img.snapshot_type}</span>
                  : <span className="badge badge-neutral">image</span>}
        <StatusBadge status={img.status?.toUpperCase()} /><StatusBadge status={img.visibility?.toUpperCase()} />
      </>}
      subtitle={<>{img.disk_format} · {img.size_gb > 0 ? fmtSize(img.size_gb) : "size unknown"}</>}>
      <Section title={snapshot ? "Snapshot" : "Image"}>
        <Facts rows={[
          snapshot && ["Snapshot of", source ? <To kind="servers" id={source.id}>{source.name}</To>
            : img.instance_uuid ? <span className="text-mono" style={{ fontSize: 11 }}>{img.instance_uuid} (deleted)</span>
            : img.snapshot_type === "volume-backed" ? "A volume-backed VM (data in Cinder snapshots)" : "—"],
          snapshot && img.base_image_ref && ["Base image", base ? <To kind="images" id={base.id}>{base.name}</To>
            : <span className="text-mono" style={{ fontSize: 11 }}>{img.base_image_ref}</span>],
          ["Disk format", img.disk_format ?? "—"],
          ["Container format", img.container_format ?? "—"],
          ["Size", img.size_gb > 0 ? fmtSize(img.size_gb) : "—"],
          ["Minimum disk", img.min_disk_gb ? `${img.min_disk_gb} GB` : "—"],
          ["Minimum RAM", img.min_ram_mb ? `${img.min_ram_mb} MB` : "—"],
          ["Visibility", img.visibility],
          ["Protected", <Pill on={img.is_protected} />],
          ["Owner", ctx.tenant(img.owner)],
          ["Created", fmtDateTime(img.created_at)],
          ["Volumes made from it", String(img.used_by_volumes ?? 0)],
        ]} />
      </Section>
      <Section title={`Used by (${users.length || img.used_by_vms?.length || 0})`}>
        {users.length
          ? <RelatedTable rows={users} rowKey={s => s.id} to={s => detailPath("servers", s.id)}
              columns={[{ label: "VM", render: s => s.name }, { label: "Status", render: s => <StatusBadge status={s.status} /> },
                        { label: "Host", render: s => s.hypervisor_hostname ?? "—" }]} />
          : <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{(img.used_by_vms ?? []).join(", ") || "No VMs"}</p>}
      </Section>
      {!snapshot && snapshots.length > 0 && (
        <Section title={`Snapshots based on it (${snapshots.length})`} full>
          <RelatedTable rows={snapshots} rowKey={i => i.id} to={i => detailPath("images", i.id)}
            columns={[{ label: "Snapshot", render: i => i.name }, { label: "Type", render: i => i.snapshot_type },
                      { label: "Size", render: i => fmtSize(i.size_gb), align: "right" },
                      { label: "Created", render: i => fmtDateTime(i.created_at) }]} />
        </Section>
      )}
      {img.snapshot_type === "volume-backed" && <SnapshotDisks id={img.id} />}
      <AllProperties kind="images" id={img.id} title="All properties and metadata" />
    </KindPage>
  );
}

/** A volume-backed VM's snapshot is an empty image whose block_device_mapping lists one Cinder
 *  snapshot per disk; shown from the page's live details. */
function SnapshotDisks({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ["inventory", "images", id, "details"],
    queryFn: () => apiFetch<{ properties: any }>(`/inventory/images/${encodeURIComponent(id)}/details`),
    retry: false, staleTime: 60_000,
  });
  let disks: any[] = [];
  try {
    const raw = data?.properties?.properties?.block_device_mapping;
    disks = (typeof raw === "string" ? JSON.parse(raw) : raw ?? []).filter((d: any) => d.snapshot_id);
  } catch {
    // not JSON: All properties shows it as it is
  }
  if (!disks.length) return null;
  return (
    <Section title={`Disks (${disks.length} Cinder snapshots)`} full>
      <RelatedTable rows={disks.sort((a, b) => (a.boot_index ?? 99) - (b.boot_index ?? 99))} rowKey={d => d.snapshot_id}
        columns={[
          { label: "Device", render: d => <span className="text-mono">{d.device_name ?? "—"}</span> },
          { label: "Boot", render: d => (d.boot_index === 0 ? "root" : "—") },
          { label: "Size", render: d => (d.volume_size ? fmtSize(d.volume_size) : "—"), align: "right" },
          { label: "Cinder snapshot", render: d => <span className="text-mono" style={{ fontSize: 11 }}>{d.snapshot_id}</span> },
          { label: "Delete with VM", render: d => <Pill on={!!d.delete_on_termination} /> },
        ]} />
    </Section>
  );
}
