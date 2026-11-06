import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorDetail } from "../../../api/client";
import { useTenants } from "../../../api/tenants";
import { DetailPage, ItemLink, Section } from "../../../components/DetailPage";
import { flatten } from "../format";
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

/** Everything PCD reports for the item, fetched live with the signed-in user's token when the
 *  page opens: metadata, image properties, extra specs and the rest. */
export function AllProperties({ kind, id, title = "All properties" }: { kind: Kind; id: string; title?: string }) {
  const [filter, setFilter] = useState("");
  const { data, error, isLoading } = useQuery({
    queryKey: ["inventory", kind, id, "details"],
    queryFn: () => apiFetch<{ properties: Record<string, unknown> }>(`/inventory/${kind}/${encodeURIComponent(id)}/details`),
    retry: false, staleTime: 60_000,
  });
  const rows = flatten(data?.properties ?? {});
  const q = filter.toLowerCase();
  const shown = rows.filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q));
  return (
    <Section title={title} full aside={
      <input className="form-input" placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)}
        style={{ width: 180, fontSize: 12, padding: "3px 8px" }} />
    }>
      {isLoading && <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>Loading from PCD…</p>}
      {error && <p className="text-danger" style={{ fontSize: 12, margin: 0 }}>{errorDetail(error)}</p>}
      {data && (
        <>
          <div style={{ columnWidth: 460, columnGap: 28 }}>
            {shown.map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 12, padding: "4px 0", borderBottom: "1px solid var(--gray-50)",
                fontSize: 12, breakInside: "avoid" }}>
                <span className="text-mono" style={{ color: "var(--gray-500)", minWidth: 170, maxWidth: 240, wordBreak: "break-all" }}>{k}</span>
                <span style={{ color: "var(--gray-900)", wordBreak: "break-word" }}>{v}</span>
              </div>
            ))}
          </div>
          <p className="text-muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
            {shown.length} of {rows.length} properties, as PCD reports them now.
          </p>
        </>
      )}
    </Section>
  );
}
