import React, { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, Copy } from "lucide-react";

/** A full page for one inventory item: breadcrumb, title with badges, stat cards, then
 *  sections in a responsive grid. */
export function DetailPage({ section, sectionTo, kindLabel, title, badges, subtitle, id, stats, children }: {
  section: string; sectionTo: string; kindLabel: string; title: string;
  badges?: React.ReactNode; subtitle?: React.ReactNode; id?: string;
  stats?: React.ReactNode; children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--gray-500)", marginBottom: 10 }}>
        <button className="btn btn-secondary btn-sm" style={{ padding: "2px 8px", marginRight: 6 }}
          onClick={() => (loc.key !== "default" ? navigate(-1) : navigate(sectionTo))} title="Back">
          <ArrowLeft size={13} />
        </button>
        <Link to={from ?? "/"} style={{ color: "inherit" }}>Inventory</Link>
        <ChevronRight size={12} />
        <Link to={sectionTo} style={{ color: "inherit" }}>{section}</Link>
        <ChevronRight size={12} />
        <span style={{ color: "var(--gray-900)", fontWeight: 600 }}>{title}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{title}</h1>
        {badges}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4, marginBottom: 14,
        fontSize: 12, color: "var(--gray-500)" }}>
        <span>{kindLabel}</span>
        {subtitle && <><span style={{ color: "var(--gray-300)" }}>·</span>{subtitle}</>}
        {id && <><span style={{ color: "var(--gray-300)" }}>·</span><CopyId id={id} /></>}
      </div>

      {stats && <div style={{ display: "flex", gap: "0.75rem", marginBottom: 14, flexWrap: "wrap" }}>{stats}</div>}

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", alignItems: "start" }}>
        {children}
      </div>
    </div>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title="Copy ID"
      onClick={() => { navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0,
        cursor: "pointer", color: "inherit", fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {id}{copied ? <Check size={11} color="var(--green)" /> : <Copy size={11} />}
    </button>
  );
}

/** A card section; `full` spans the whole row. */
export function Section({ title, full, aside, children }: {
  title: string; full?: boolean; aside?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="card" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <div className="card-header">
        <span className="card-title">{title}</span>
        {aside && <span style={{ fontSize: 12, color: "var(--gray-500)" }}>{aside}</span>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

/** Label/value pairs in two columns; null values are left out. */
export function Facts({ rows }: { rows: ([string, React.ReactNode] | null | false)[] }) {
  const shown = rows.filter((r): r is [string, React.ReactNode] => !!r);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, max-content) 1fr", fontSize: 13 }}>
      {shown.map(([k, v]) => (
        <React.Fragment key={k}>
          <div style={{ color: "var(--gray-500)", padding: "6px 16px 6px 0", borderBottom: "1px solid var(--gray-50)" }}>{k}</div>
          <div style={{ color: "var(--gray-900)", padding: "6px 0", borderBottom: "1px solid var(--gray-50)", wordBreak: "break-word" }}>
            {v ?? "—"}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

export interface Column<T> { label: string; render: (r: T) => React.ReactNode; align?: "right" }

/** A compact table of related items; rows with `to` open that item's page. */
export function RelatedTable<T>({ columns, rows, to, empty = "None", rowKey }: {
  columns: Column<T>[]; rows: T[]; to?: (r: T) => string | null; empty?: string; rowKey: (r: T) => string;
}) {
  const navigate = useNavigate();
  const loc = useLocation();
  if (!rows.length) return <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{empty}</p>;
  return (
    <div className="table-wrap" style={{ margin: "-14px", maxHeight: 420, overflowY: "auto" }}>
      <table>
        <thead>
          <tr>{columns.map(c => <th key={c.label} style={{ textAlign: c.align }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const href = to?.(r);
            return (
              <tr key={rowKey(r)} style={href ? { cursor: "pointer" } : undefined}
                onClick={href ? () => navigate(href, { state: loc.state }) : undefined}>
                {columns.map(c => <td key={c.label} style={{ textAlign: c.align }}>{c.render(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A link to another item's page, keeping where the visit to the inventory started. */
export function ItemLink({ to, children }: { to: string; children: React.ReactNode }) {
  const loc = useLocation();
  return <Link to={to} state={loc.state} onClick={e => e.stopPropagation()}>{children}</Link>;
}

/** Used of total as a labelled bar. `neutral` for allocations that may exceed 100% by design
 *  (vCPU overcommit). */
export function Usage({ label, used, total, format, high = 85, neutral }: {
  label: string; used?: number | null; total?: number | null; format: (v: number) => string;
  high?: number; neutral?: boolean;
}) {
  const p = used != null && total ? (used / total) * 100 : null;
  const color = p == null ? "var(--gray-300)" : neutral ? "var(--blue-primary)"
    : p >= high ? "var(--red)" : p >= high - 15 ? "var(--yellow)" : "var(--green)";
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: "var(--gray-600)", fontWeight: 600 }}>{label}</span>
        <span style={{ color: "var(--gray-700)" }}>
          {used != null ? format(used) : "—"} of {total != null ? format(total) : "—"}
          {p != null && <strong style={{ color, marginLeft: 6 }}>{p.toFixed(1)}%</strong>}
        </span>
      </div>
      <div className="usage-bar-track"><div className="usage-bar-fill" style={{ width: `${Math.min(100, p ?? 0)}%`, background: color }} /></div>
    </div>
  );
}
