import type { ComponentType } from "react";
import { Link, useParams } from "react-router-dom";
import { errorDetail } from "../../api/client";
import { type DetailProps, useCtx } from "./details/common";
import { ClusterDetail, FlavorDetail, HypervisorDetail, ServerDetail, ServerGroupDetail } from "./details/compute";
import { FloatingIpDetail, NetworkDetail, SecurityGroupDetail } from "./details/network";
import { ImageDetail, StorageBackendDetail, StorageTypeDetail, VolumeDetail } from "./details/storage";
import { isKind, KINDS, type Kind, useInventory } from "./kinds";

const PAGES: Record<Kind, ComponentType<DetailProps>> = {
  clusters: ClusterDetail,
  hypervisors: HypervisorDetail,
  servers: ServerDetail,
  flavors: FlavorDetail,
  server_groups: ServerGroupDetail,
  volumes: VolumeDetail,
  storage_backends: StorageBackendDetail,
  storage_types: StorageTypeDetail,
  networks: NetworkDetail,
  floating_ips: FloatingIpDetail,
  images: ImageDetail,
  security_groups: SecurityGroupDetail,
};

/** /inventory/:kind/:id — one item's page, found in the same list the Inventory tab loads. */
export default function InventoryDetail() {
  const { kind = "", id = "" } = useParams();
  const valid = isKind(kind);
  const list = useInventory(valid ? kind : "servers", valid);
  const ctx = useCtx();
  if (!valid) return <NotFound text={`There's no inventory section called "${kind}".`} />;

  const def = KINDS[kind];
  if (list.isLoading) return <p className="text-muted">Loading…</p>;
  if (list.error) return <NotFound text={errorDetail(list.error)} kind={kind} />;
  const item = list.data?.find(r => String(r[def.idField]) === id);
  if (!item) return <NotFound text={`${def.singular} ${id} isn't in the inventory (anymore).`} kind={kind} />;
  const Page = PAGES[kind];
  return <Page item={item} ctx={ctx} />;
}

function NotFound({ text, kind }: { text: string; kind?: Kind }) {
  return (
    <div className="empty">
      <div className="empty-title">Not found</div>
      <div className="empty-body">{text}</div>
      <Link className="btn btn-secondary" to={kind ? `/?tab=${kind}` : "/"}>
        Back to {kind ? KINDS[kind].label : "Inventory"}
      </Link>
    </div>
  );
}
