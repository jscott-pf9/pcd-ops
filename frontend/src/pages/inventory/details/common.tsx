import React, { useMemo } from "react";
import { useTenants } from "../../../api/tenants";
import { DetailPage, ItemLink } from "../../../components/DetailPage";
import { detailPath, KINDS, type Kind } from "../kinds";
import type { Ctx } from "../summaries";

export interface DetailProps { item: any; ctx: Ctx }

/** Tenant names, as the tables show them. */
export function useCtx(): Ctx {
  const tenants = useTenants();
  return useMemo(() => ({
    tenant: (id?: string | null) => (id ? tenants.get(id) ?? id.slice(0, 8) : "—"),
  }), [tenants]);
}

/** DetailPage with the breadcrumb, title and ID for an item of `kind`. */
export function KindPage({ kind, item, ...rest }: {
  kind: Kind; item: any; badges?: React.ReactNode; subtitle?: React.ReactNode;
  stats?: React.ReactNode; children: React.ReactNode;
}) {
  const def = KINDS[kind];
  const id = String(item[def.idField]);
  return (
    <DetailPage section={def.label} sectionTo={`/?tab=${kind}`} kindLabel={def.singular}
      title={def.title(item)} id={def.idField === "id" ? id : undefined} {...rest} />
  );
}

/** A link to an item's page by id, or the plain label when there's no id. */
export function To({ kind, id, children }: { kind: Kind; id?: string | number | null; children: React.ReactNode }) {
  if (id == null || id === "") return <>{children}</>;
  return <ItemLink to={detailPath(kind, id)}>{children}</ItemLink>;
}

/** Comma-separated links. */
export function Links({ items }: { items: { kind: Kind; id?: string | null; label: string }[] }) {
  if (!items.length) return <span className="text-muted">—</span>;
  return <>{items.map((x, i) => <React.Fragment key={`${x.label}-${i}`}>{i > 0 && ", "}<To kind={x.kind} id={x.id}>{x.label}</To></React.Fragment>)}</>;
}
