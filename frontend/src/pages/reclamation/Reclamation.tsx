import React, { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Trash2 } from "lucide-react";
import { apiFetch, errorDetail } from "../../api/client";
import { useTenantNames } from "../../api/tenants";
import DataFreshness from "../../components/DataFreshness";
import { downloadWorkbook } from "../../components/workbook";
import { useInventory } from "../inventory/kinds";
import { StatCard, useSort } from "../inventory/shared";
import { useSettings } from "../settings/useSettings";
import { COLUMNS, sheetFor, type Ctx } from "./columns";
import {
  addFrees, CATEGORIES, CATEGORY, type CategoryKey, type Filters, filterItems, frees, freesText,
  type Group, GROUPS, isGroup, NO_FREES, noteFor,
} from "./model";

type Data = Record<CategoryKey, any[]> & {
  notes?: Record<string, string>;
  idle_rule?: { days: number; cpu_pct: number; net_kbps: number; iops: number; source: string | null };
  orphan_check?: { source: string | null; hosts_compared: number; pending: number };
};

const KEY = ["reclamation", "candidates"];

/** Reclamation & Warnings: what could be freed and what looks wrong, grouped in tabs. Tab and
 *  filters live in the URL, so Back from an item's page returns to them. */
export default function Reclamation() {
  const [params, setParams] = useSearchParams();
  const tab = isGroup(params.get("tab")) ? (params.get("tab") as Group) : "overview";
  const filters: Filters = {
    tenant: params.get("tenant") ?? "", minAge: Number(params.get("age")) || 0,
    q: params.get("q") ?? "", system: params.get("system") === "1",
  };
  const set = (changes: Record<string, string>) => setParams(p => {
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    return p;
  }, { replace: true });

  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: () => apiFetch<Data>("/reclamation/candidates") });
  const tenants = useTenantNames();
  const hyps = useInventory("hypervisors");
  const ctx: Ctx = useMemo(() => {
    const hostNames = new Map((hyps.data ?? []).map(h => [String(h.id), h.hostname]));
    return {
      tenant: id => (id ? tenants.get(id) ?? id.slice(0, 8) : "—"),
      host: id => (id ? hostNames.get(String(id)) ?? String(id).slice(0, 8) : "—"),
    };
  }, [tenants, hyps.data]);

  const shown = useMemo(() => Object.fromEntries(CATEGORIES.map(c =>
    [c.key, filterItems(c.key, data?.[c.key], filters)])) as Record<CategoryKey, any[]>,
  [data, filters.tenant, filters.minAge, filters.q, filters.system]);

  const tenantIds = useMemo(() => [...new Set(CATEGORIES.flatMap(c =>
    (data?.[c.key] ?? []).map(i => (c.key === "empty_tenants" ? i.id : i.project_id))).filter(Boolean))]
    .sort((a, b) => ctx.tenant(a).localeCompare(ctx.tenant(b))), [data, ctx]);

  const groupCount = (g: Group) => CATEGORIES.filter(c => c.group === g).reduce((n, c) => n + shown[c.key].length, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Reclamation &amp; Warnings</h1>
        <DataFreshness domainKey="reclamation:candidates" />
      </div>

      {isLoading && <p className="text-muted">Waiting for the first collection…</p>}
      {error && !data && <p className="text-muted">{errorDetail(error)}</p>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <div className="tabs" style={{ marginBottom: 0, flex: 1, flexWrap: "wrap" }}>
              <button className={`tab${tab === "overview" ? " active" : ""}`} onClick={() => set({ tab: "" })}>Overview</button>
              {GROUPS.map(g => (
                <button key={g.id} className={`tab${tab === g.id ? " active" : ""}`} onClick={() => set({ tab: g.id })}>
                  {g.label} <span className="text-muted" style={{ fontWeight: 400 }}>{groupCount(g.id)}</span>
                </button>
              ))}
            </div>
            <select className="form-select" value={filters.tenant} onChange={e => set({ tenant: e.target.value })}
              style={{ fontSize: 12, height: "auto", width: "auto" }}>
              <option value="">All tenants</option>
              {tenantIds.map(id => <option key={id} value={id}>{ctx.tenant(id)}</option>)}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: 0 }}>
              At least
              <input className="form-input" type="number" min={0} value={filters.minAge || ""} placeholder="0"
                onChange={e => set({ age: String(Number(e.target.value) || "") })} style={{ width: 64, fontSize: 12 }} />
              days
            </label>
            <input className="form-input" placeholder="Filter…" value={filters.q}
              onChange={e => set({ q: e.target.value })} style={{ width: 180, fontSize: 12 }} />
          </div>

          {tab === "overview"
            ? <Overview data={data} shown={shown} ctx={ctx} onOpen={g => set({ tab: g })} />
            : <>
                {tab === "tenants" && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 10 }}>
                    <input type="checkbox" checked={filters.system} onChange={e => set({ system: e.target.checked ? "1" : "" })} />
                    Show system projects (service, domain projects)
                  </label>
                )}
                {CATEGORIES.filter(c => c.group === tab).map(c => (
                  <CategorySection key={c.key} cat={c.key} items={shown[c.key]} total={data[c.key]?.length ?? 0}
                    note={noteFor(c.key, data.notes)} ctx={ctx}
                    extra={c.key === "idle_servers" ? <IdleRule rule={data.idle_rule} />
                      : c.key === "orphaned_vms" ? <OrphanCheck check={data.orphan_check} /> : null} />
                ))}
              </>}
        </>
      )}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────────

function Overview({ data, shown, ctx, onOpen }: {
  data: Data; shown: Record<CategoryKey, any[]>; ctx: Ctx; onOpen: (g: Group) => void;
}) {
  const total = CATEGORIES.filter(c => !c.warning)
    .reduce((acc, c) => addFrees(acc, frees(c.key, shown[c.key])), NO_FREES);
  const warnings = CATEGORIES.filter(c => c.warning && shown[c.key].length);
  const leaked = shown.unattached_volumes.filter(v => v.kind === "image_store").length;
  return (
    <>
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
        <StatCard label="vCPUs" value={String(total.vcpus)} sub="stopped and idle VMs" accent="var(--blue-primary)" />
        <StatCard label="RAM" value={`${Math.round(total.ram_gb)} GB`} sub="stopped and idle VMs" accent="var(--blue-primary)" />
        <StatCard label="Volume storage" value={`${Math.round(total.volume_gb)} GB`} sub="unattached, and stopped VMs' disks" accent="var(--yellow)" />
        <StatCard label="Image storage" value={`${total.image_gb.toFixed(1)} GB`} sub="unused images and snapshots" accent="var(--purple)" />
        <StatCard label="IP addresses" value={String(total.ips)} sub="floating IPs and orphaned ports" accent="var(--green)" />
      </div>

      {(warnings.length > 0 || leaked > 0) && (
        <div className="card" style={{ borderLeft: "3px solid var(--red)", marginBottom: "1.25rem" }}>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            {warnings.map(c => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={14} color="var(--red)" />
                <span><strong>{c.label}: {shown[c.key].length}</strong> ({summarizeKinds(shown[c.key])})</span>
                <button className="btn btn-sm btn-secondary" onClick={() => onOpen(c.group)}>Review</button>
              </div>
            ))}
            {leaked > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={14} color="var(--yellow)" />
                <span><strong>{leaked} Glance image store volume{leaked === 1 ? "" : "s"}</strong> left behind by deleted images</span>
                <button className="btn btn-sm btn-secondary" onClick={() => onOpen("storage")}>Review</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => exportAll(data, shown, ctx)}
          title="One workbook: a summary sheet and a sheet per category, with the filters above applied"
          style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Download size={12} /> Export All
        </button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Category</th><th>Area</th><th style={{ textAlign: "right" }}>Count</th><th>Would free</th><th /></tr></thead>
          <tbody>
            {CATEGORIES.map(c => {
              const n = shown[c.key].length;
              const note = noteFor(c.key, data.notes);
              return (
                <tr key={c.key} style={{ cursor: "pointer" }} onClick={() => onOpen(c.group)}>
                  <td style={{ fontWeight: 500 }}>
                    {c.label} {c.warning && n > 0 && <span className="badge badge-warn" style={{ marginLeft: 4 }}>warning</span>}
                  </td>
                  <td className="text-muted">{GROUPS.find(g => g.id === c.group)!.label}</td>
                  <td style={{ textAlign: "right", fontWeight: n ? 600 : 400 }}>{n || <span className="text-muted">0</span>}</td>
                  <td style={{ fontSize: 12 }}>{c.warning ? <span className="text-muted">—</span> : freesText(frees(c.key, shown[c.key]))}</td>
                  <td className="text-muted" style={{ fontSize: 11, maxWidth: 360 }}>{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** reclamation.xlsx: a Summary sheet, then one sheet per category (as filtered). */
function exportAll(data: Data, shown: Record<CategoryKey, any[]>, ctx: Ctx) {
  const summary = CATEGORIES.map(c => {
    const f = frees(c.key, shown[c.key]);
    return [c.label, GROUPS.find(g => g.id === c.group)!.label, shown[c.key].length,
            f.vcpus, Math.round(f.ram_gb), Math.round(f.volume_gb), Math.round(f.image_gb * 10) / 10, f.ips,
            noteFor(c.key, data.notes) ?? ""];
  });
  downloadWorkbook("reclamation.xlsx", [
    { name: "Summary", rows: summary,
      headers: ["Category", "Area", "Count", "vCPUs", "RAM GB", "Volume GB", "Image GB", "IPs", "Note"] },
    ...CATEGORIES.map(c => ({ name: c.sheet, ...sheetFor(c.key, shown[c.key], ctx) })),
  ]);
}

const ORPHAN_LABEL: Record<string, string> = { unknown: "unknown to PCD", missing: "missing from their host", owner_deleted: "owner deleted" };

function summarizeKinds(items: any[]): string {
  const counts: Record<string, number> = {};
  items.forEach(i => { counts[i.kind] = (counts[i.kind] ?? 0) + 1; });
  return Object.entries(counts).map(([k, n]) => `${n} ${ORPHAN_LABEL[k] ?? k}`).join(", ");
}

// ── One category ─────────────────────────────────────────────────────────────────

function CategorySection({ cat, items, total, note, ctx, extra }: {
  cat: CategoryKey; items: any[]; total: number; note: string | null; ctx: Ctx; extra?: React.ReactNode;
}) {
  const meta = CATEGORY[cat];
  const qc = useQueryClient();
  const { sorted, sort, toggle } = useSort<any>(items);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const deletable = items.filter(i => meta.deletePath && !meta.cantDelete?.(i));
  const chosen = deletable.filter(i => selected.has(i.id));
  const cols = COLUMNS[cat];

  async function reclaim(list: any[]) {
    const names = list.slice(0, 10).map(i => `• ${i.name ?? i.id}`).join("\n") + (list.length > 10 ? `\n…and ${list.length - 10} more` : "");
    if (!confirm(`Permanently delete ${list.length} ${meta.noun}${list.length === 1 ? "" : "s"}?${confirmNote(cat, list)}\n\n${names}\n\nThis cannot be undone.`)) return;
    setBusy(true);
    const results = await Promise.allSettled(list.map(i =>
      apiFetch(`/reclamation/${meta.deletePath}/${encodeURIComponent(i.id)}`, { method: "DELETE" })));
    setBusy(false);
    const done = new Set(list.filter((_, n) => results[n].status === "fulfilled").map(i => i.id));
    const failed = results.flatMap((r, n) => (r.status === "rejected" ? [`${list[n].name ?? list[n].id}: ${errorDetail(r.reason)}`] : []));
    if (failed.length) alert(`${failed.length} of ${list.length} failed:\n${failed.join("\n")}`);
    qc.setQueryData<Data>(KEY, old => (old ? { ...old, [cat]: old[cat].filter((i: any) => !done.has(i.id)) } : old));
    setSelected(new Set());
  }

  const toggleOne = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = deletable.length > 0 && deletable.every(i => selected.has(i.id));

  return (
    <div className="card" style={{ marginBottom: "1.25rem" }} id={cat}>
      <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="card-title">
          {meta.label} ({items.length < total ? `${items.length} of ${total}` : total})
          {meta.warning && items.length > 0 && <span className="badge badge-warn" style={{ marginLeft: 6 }}>warning</span>}
        </span>
        {!meta.warning && freesText(frees(cat, items)) !== "—" && (
          <span className="text-muted" style={{ fontSize: 12 }}>frees {freesText(frees(cat, items))}</span>
        )}
        <span style={{ flex: 1 }} />
        {chosen.length > 0 && (
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => reclaim(chosen)}
            style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Trash2 size={12} /> Delete {chosen.length} selected
          </button>
        )}
      </div>
      {(extra || note) && (
        <div style={{ padding: "6px 16px 0", fontSize: 12 }} className="text-muted">
          {extra}{note && <div>{note}</div>}
        </div>
      )}
      {items.length === 0
        ? <div className="card-body"><p className="text-muted" style={{ margin: 0 }}>{total ? "None match the filters." : "None found."}</p></div>
        : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {meta.deletePath && (
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={allOn} disabled={!deletable.length}
                        onChange={() => setSelected(allOn ? new Set() : new Set(deletable.map(i => i.id)))} />
                    </th>
                  )}
                  {cols.map(c => <SortHeader key={c.label} label={c.label} field={c.sort} sort={sort} toggle={toggle} />)}
                  {meta.deletePath && <th style={{ width: 44 }} />}
                </tr>
              </thead>
              <tbody>
                {sorted.map(i => {
                  const why = meta.cantDelete?.(i);
                  return (
                    <tr key={i.id} title={i.reason}
                      style={selected.has(i.id) ? { background: "var(--row-selected, rgba(99,102,241,0.08))" } : undefined}>
                      {meta.deletePath && (
                        <td><input type="checkbox" checked={selected.has(i.id)} disabled={!!why} onChange={() => toggleOne(i.id)} /></td>
                      )}
                      {cols.map(c => <td key={c.label}>{c.render(i, ctx)}</td>)}
                      {meta.deletePath && (
                        <td>
                          <button className="btn btn-sm btn-danger" disabled={busy || !!why} title={why ?? `Delete ${meta.noun}`}
                            onClick={() => reclaim([i])}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function SortHeader({ label, field, sort, toggle }: {
  label: string; field?: string; sort: { field: string; dir: "asc" | "desc" } | null; toggle: (f: string) => void;
}) {
  if (!field) return <th style={{ whiteSpace: "nowrap" }}>{label}</th>;
  const on = sort?.field === field;
  return (
    <th onClick={() => toggle(field)} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}{on ? (sort!.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

/** What else a delete does, for the confirm dialog. */
function confirmNote(cat: CategoryKey, list: any[]): string {
  switch (cat) {
    case "unused_routers": return "\nInterfaces are detached and the gateway cleared first.";
    case "unused_networks": return "\nTheir subnets are deleted too.";
    case "stopped_servers": return "\nAttached volumes stay.";
    case "unused_images":
      return list.some(i => i.snapshot_type === "volume-backed")
        ? "\nVolume-backed VM snapshots: their Cinder volume snapshots stay (Snapshots page)." : "";
    default: return "";
  }
}

// ── Notes beside sections ────────────────────────────────────────────────────────

function IdleRule({ rule }: { rule?: Data["idle_rule"] }) {
  const [editing, setEditing] = useState(false);
  const s = useSettings(["reclamation_idle_days", "reclamation_idle_cpu_pct", "reclamation_idle_net_kbps", "reclamation_idle_iops"]);
  if (!rule) return null;
  const num = (f: Parameters<typeof s.set>[0]) => ({
    value: String(s.form[f] ?? ""), type: "number", min: 0, step: "any", className: "form-input",
    style: { width: 70, fontSize: 12, padding: "2px 6px" },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => s.set(f, Number(e.target.value)),
  });
  if (!editing) {
    return (
      <div>
        Idle: running at least {rule.days} days with 95th-percentile CPU under {rule.cpu_pct}%, network under{" "}
        {rule.net_kbps} KB/s and disk under {rule.iops} IOPS. Right-Sizing uses the same rule.{" "}
        <button type="button" className="btn btn-sm btn-secondary" style={{ padding: "0 6px", fontSize: 11 }}
          onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }
  return (
    <form onSubmit={async e => { await s.save(e); }} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", color: "var(--gray-700)" }}>
      <label>Window (days) <input {...num("reclamation_idle_days")} /></label>
      <label>CPU % <input {...num("reclamation_idle_cpu_pct")} /></label>
      <label>Network KB/s <input {...num("reclamation_idle_net_kbps")} /></label>
      <label>IOPS <input {...num("reclamation_idle_iops")} /></label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={!s.loaded || s.status === "saving"}>Save</button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Close</button>
      {s.status === "saved" && <span className="text-success">Saved; applies at the next collection.</span>}
      {s.status === "error" && <span className="text-danger">{s.error}</span>}
    </form>
  );
}

function OrphanCheck({ check }: { check?: Data["orphan_check"] }) {
  if (!check || !check.hosts_compared) return null;
  return (
    <div>
      Compared PCD's VMs with what {check.hosts_compared} host{check.hosts_compared === 1 ? "" : "s"} run.
      {check.pending > 0 && ` ${check.pending} more will be listed if they still look wrong at the next collection.`}
    </div>
  );
}
