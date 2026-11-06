// Building blocks for the inventory tables.
import React, { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { EXPORTER_STATUS, type ExporterResult } from "../../api/exporters";
import { formatPct, formatRate, pctColor } from "../../components/format";
import { useRowHover } from "../../components/RowHoverCard";
import { exportKind } from "./exports";
import { detailPath, KINDS, type Kind } from "./kinds";
import { type Ctx, summary } from "./summaries";

export interface TableProps {
  data?: any[]; isLoading: boolean; search: string; tenantFilter: string; ctx: Ctx;
}

export function filterRows(data: any[] | undefined, search: string, tenantFilter: string,
                           fields: string[], tenantField = "project_id"): any[] {
  if (!data) return [];
  let rows = data;
  if (tenantFilter) rows = rows.filter(r => r[tenantField] === tenantFilter);
  if (!search) return rows;
  const q = search.toLowerCase();
  return rows.filter(r => fields.some(f => String(r[f] ?? "").toLowerCase().includes(q)));
}

// ── Sorting ────────────────────────────────────────────────────────────────────

type SortState = { field: string; dir: "asc" | "desc" } | null;

export function useSort<T>(data: T[]) {
  const [sort, setSort] = useState<SortState>(null);
  const sorted = useMemo(() => {
    if (!sort || !data.length) return data;
    return [...data].sort((a, b) => {
      const av = (a as any)[sort.field] ?? "";
      const bv = (b as any)[sort.field] ?? "";
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [data, sort]);
  const toggle = (field: string) =>
    setSort(s => s?.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" });
  return { sorted, sort, toggle };
}

export function SortTh({ label, field, sort, toggle }: {
  label: string; field: string; sort: SortState; toggle: (f: string) => void;
}) {
  if (!field) return <th style={{ whiteSpace: "nowrap" }}>{label}</th>;
  const active = sort?.field === field;
  return (
    <th onClick={() => toggle(field)} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label}
        {active
          ? sort!.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />
          : <ArrowUpDown size={11} style={{ opacity: 0.3 }} />}
      </span>
    </th>
  );
}

/** A header row from [label, sort field] pairs ("" = not sortable). */
export function HeaderRow({ cols, sort, toggle }: {
  cols: [string, string][]; sort: SortState; toggle: (f: string) => void;
}) {
  return <tr>{cols.map(([label, field]) => <SortTh key={label} label={label} field={field} sort={sort} toggle={toggle} />)}</tr>;
}

// ── Rows that open a detail page ─────────────────────────────────────────────────

/** Row props for a table of `kind`: click opens the detail page (Ctrl/⌘-click or middle-click
 *  in a new tab), hovering shows the facts card. Render `card` once, beside the table. */
export function useRows(kind: Kind, ctx: Ctx) {
  const navigate = useNavigate();
  const loc = useLocation();
  const { bind, card, hide } = useRowHover();
  const def = KINDS[kind];
  const rowProps = (r: any) => {
    const to = detailPath(kind, r[def.idField]);
    return {
      style: { cursor: "pointer" },
      onClick: (e: React.MouseEvent) => {
        hide();
        if (e.metaKey || e.ctrlKey) window.open(to, "_blank");
        else navigate(to, { state: { from: loc.pathname + loc.search } });
      },
      onAuxClick: (e: React.MouseEvent) => { if (e.button === 1) window.open(to, "_blank"); },
      ...bind(def.title(r), () => summary(kind, r, ctx)),
    };
  };
  return { rowProps, card };
}

// ── Badges and cells ─────────────────────────────────────────────────────────────

const BADGE_CLASS: Record<string, string> = {
  ACTIVE: "badge-active", UP: "badge-active", ENABLED: "badge-active", ACTIVE_VM: "badge-active",
  IN_USE: "badge-info", "IN-USE": "badge-info", AVAILABLE: "badge-info", PUBLIC: "badge-info",
  BUILD: "badge-provisioning",
  SHUTOFF: "badge-neutral", STOPPED: "badge-neutral", PRIVATE: "badge-neutral",
  DISABLED: "badge-warn", DEACTIVATED: "badge-warn",
  DOWN: "badge-error", ERROR: "badge-error", DELETED: "badge-error",
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-muted">—</span>;
  const cls = BADGE_CLASS[status.toUpperCase()] ?? "badge-neutral";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function Pill({ on, yes = "Yes", no = "No" }: { on: boolean; yes?: string; no?: string }) {
  return <span className={on ? "text-success" : "text-muted"} style={{ fontWeight: 600, fontSize: "0.8rem" }}>{on ? yes : no}</span>;
}

export function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="stat-card" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}

/** A percentage as a small bar, for table cells. */
export function PctBar({ v, low = 0, high = 85 }: { v?: number | null; low?: number; high?: number }) {
  if (v == null) return <span className="text-muted">—</span>;
  const color = pctColor(v, low, high);
  return (
    <div title={formatPct(v)} style={{ minWidth: 64 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color }}>{formatPct(v)}</div>
      <div style={{ height: 4, background: "var(--gray-100)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, v)}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
}

/** Latest CPU, memory (and disk, for hosts) as bars, plus network in/out. */
export function LoadCells({ m, disk = true }: { m: any; disk?: boolean }) {
  const cols = disk ? 4 : 3;
  if (!m) return <td colSpan={cols} className="text-muted" style={{ fontSize: 11 }} title="No metrics yet">—</td>;
  return (
    <>
      <td><PctBar v={m.cpu_pct} /></td>
      <td><PctBar v={m.mem_pct} /></td>
      {disk && <td><PctBar v={m.disk_pct} /></td>}
      <td style={{ fontSize: 11, whiteSpace: "nowrap" }}>
        ↓ {formatRate(m.net_rx_bps)}<br />↑ {formatRate(m.net_tx_bps)}
        {m.stale && <div><span className="badge badge-error" style={{ fontSize: 10 }}>stale</span></div>}
      </td>
    </>
  );
}

export function ExporterDot({ name, r }: { name: string; r: ExporterResult }) {
  const st = EXPORTER_STATUS[r.status];
  return (
    <span title={`${name ? name + ": " : ""}${st.label}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11,
               color: st.ok ? "var(--gray-700)" : "var(--red)" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: st.ok ? "var(--green)" : "var(--red)" }} />
      {name}
    </span>
  );
}

// ── Table frame ──────────────────────────────────────────────────────────────────

/** Count, CSV export of the shown rows, the table, and the hover card. */
export function TableWrap({ kind, ctx, isLoading, total, rows, card, children }: {
  kind: Kind; ctx: Ctx; isLoading: boolean; total?: number; rows: any[];
  card?: React.ReactNode; children: React.ReactNode;
}) {
  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (total === undefined) return <p className="text-muted">No data yet — waiting for collection.</p>;
  if (total === 0) return <p className="text-muted">None in PCD.</p>;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span className="text-muted" style={{ fontSize: 12 }}>
          {rows.length < total ? `${rows.length} of ${total}` : `${total} total`}
        </span>
        <button className="btn btn-secondary btn-sm" onClick={() => exportKind(kind, rows, ctx)}
          style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Download size={12} /> Export CSV
        </button>
      </div>
      <div className="card table-wrap"><table><tbody>{children}</tbody></table></div>
      {card}
    </>
  );
}

export const muted = (text = "—") => <span className="text-muted">{text}</span>;
