import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { apiFetch, errorDetail } from "../../api/client";
import { useTenantNames } from "../../api/tenants";
import DataFreshness from "../../components/DataFreshness";
import { ItemLink } from "../../components/DetailPage";
import { downloadWorkbook } from "../../components/workbook";
import { detailPath } from "../inventory/kinds";
import { actionsText, type Change, DRIFT_KINDS, fieldText, isDriftKind, KIND, parseAt, PERIODS } from "./model";

interface Status {
  started_at: string; last_run: string; notes: Record<string, string>; items: Record<string, number>;
  last_changes: number; counts_24h: Record<string, number>; counts_7d: Record<string, number>;
}

/** Config Changes: VMs, flavors, security groups, aggregates, hosts and quotas changed between
 *  collections, and for VMs what Nova did and who asked. Kind, period and filter live in the URL. */
export default function ChangeLog() {
  const [params, setParams] = useSearchParams();
  const kind = isDriftKind(params.get("kind")) ? params.get("kind")! : "";
  const days = params.has("days") ? Number(params.get("days")) || 0 : 7;
  const q = params.get("q") ?? "";
  const set = (changes: Record<string, string>) => setParams(p => {
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    return p;
  }, { replace: true });

  const tenants = useTenantNames();
  const status = useQuery({ queryKey: ["drift", "status"], queryFn: () => apiFetch<Status>("/drift/status"), retry: false });
  const changes = useQuery({
    queryKey: ["drift", "changes", kind, days, q],
    queryFn: () => apiFetch<Change[]>(`/drift/changes?limit=2000${kind ? `&kind=${kind}` : ""}${days ? `&days=${days}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    enabled: status.isSuccess,
  });
  const rows = changes.data ?? [];
  const st = status.data;
  const counts = days === 1 ? st?.counts_24h : st?.counts_7d;

  function exportAll() {
    downloadWorkbook("config-changes.xlsx", [{
      name: "Config changes",
      headers: ["When (UTC)", "Kind", "Item", "Tenant", "Change", "Severity", "Nova actions", "Field", "Before", "After"],
      rows: rows.flatMap(c => {
        const base = [c.at.slice(0, 19).replace("T", " "), KIND[c.kind]?.singular ?? c.kind, c.name ?? c.item_id,
                      c.project_id ? tenants.get(c.project_id) ?? c.project_id : "", c.change, c.severity,
                      actionsText(c.actions)];
        return c.fields.length
          ? c.fields.map(f => [...base, f.field, f.op === "added" ? "" : String(f.before ?? ""), f.op === "removed" ? "" : String(f.after ?? "")])
          : [[...base, "", "", ""]];
      }),
    }]);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>Config Changes</h1>
        <DataFreshness domainKey="drift:status" />
      </div>
      <p className="text-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        VMs, flavors, security groups, aggregates, hosts and tenant quotas, compared at every collection (every 15 minutes).
        A change shows what changed and when it was first seen. Who changed it is known only for VMs, from Nova's
        action log; PCD doesn't record it for the rest. A VM's size, host, image and security groups count, not starting or stopping it.
        {st && <> Recording since {parseAt(st.started_at).toLocaleString()}.</>}
      </p>

      {status.isLoading && <p className="text-muted">Waiting for the first collection…</p>}
      {status.error && <p className="text-muted">{errorDetail(status.error)}</p>}

      {st && (
        <>
          {Object.keys(st.notes).length > 0 && (
            <div className="card" style={{ borderLeft: "3px solid var(--yellow)", marginBottom: "1rem" }}>
              <div className="card-body" style={{ fontSize: 13 }}>{Object.values(st.notes).join(". ")}.</div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <div className="tabs" style={{ marginBottom: 0, flex: 1, flexWrap: "wrap" }}>
              <button className={`tab${kind === "" ? " active" : ""}`} onClick={() => set({ kind: "" })}>All</button>
              {DRIFT_KINDS.map(k => (
                <button key={k.id} className={`tab${kind === k.id ? " active" : ""}`} onClick={() => set({ kind: k.id })}
                  title={`${st.items[k.id] ?? 0} tracked`}>
                  {k.label} {days === 1 || days === 7
                    ? <span className="text-muted" style={{ fontWeight: 400 }}>{counts?.[k.id] ?? 0}</span> : null}
                </button>
              ))}
            </div>
            <select className="form-select" style={{ width: "auto" }} value={days}
              onChange={e => set({ days: e.target.value === "7" ? "" : e.target.value })}>
              {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
            </select>
            <input className="form-input" style={{ width: 200 }} placeholder="Filter by name or field…" value={q}
              onChange={e => set({ q: e.target.value })} />
            <button className="btn btn-secondary btn-sm" onClick={exportAll} disabled={!rows.length}
              style={{ display: "flex", alignItems: "center", gap: 4 }} title="The changes shown, one row per changed field">
              <Download size={12} /> Export
            </button>
          </div>

          <div className="card table-wrap">
            {rows.length === 0
              ? <div className="card-body"><p className="text-muted" style={{ margin: 0 }}>
                  {changes.isLoading ? "Loading…" : "No changes in this period."}</p></div>
              : (
                <table>
                  <thead><tr><th>When</th><th>Kind</th><th>Item</th><th>Change</th><th>What changed</th><th>Tenant</th></tr></thead>
                  <tbody>
                    {rows.map(c => {
                      const k = KIND[c.kind];
                      const gone = c.change === "removed";
                      return (
                        <tr key={c.id}>
                          <td style={{ whiteSpace: "nowrap", fontSize: 12 }} title={c.at}>{parseAt(c.at).toLocaleString()}</td>
                          <td style={{ fontSize: 12 }}>{k?.singular ?? c.kind}</td>
                          <td style={{ fontWeight: 500 }}>
                            {k?.inventory && !gone
                              ? <ItemLink to={detailPath(k.inventory, c.item_id)}>{c.name ?? c.item_id}</ItemLink>
                              : c.name ?? c.item_id}
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <span className={`badge ${c.change === "added" ? "badge-info" : c.change === "removed" ? "badge-neutral" : "badge-warn"}`}>{c.change}</span>
                            {c.severity === "high" && <span className="badge badge-error" style={{ marginLeft: 4 }}>high</span>}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {c.actions?.length ? (
                              <div style={{ marginBottom: 2 }} title={c.actions.map(a => `${parseAt(a.at).toLocaleString()} ${a.action}${a.user ? ` by ${a.user}` : ""}`).join("\n")}>
                                {actionsText(c.actions)}
                              </div>
                            ) : null}
                            {c.fields.length === 0 ? (c.actions?.length ? null : <span className="text-muted">—</span>)
                              : c.fields.map((f, i) => (
                                  <div key={i} className="text-mono" style={{ fontSize: 11, color: f.op === "removed" ? "var(--red)" : f.op === "added" ? "var(--green)" : undefined }}>
                                    {fieldText(f)}
                                  </div>
                                ))}
                          </td>
                          <td style={{ fontSize: 12 }}>{c.project_id ? tenants.get(c.project_id) ?? c.project_id.slice(0, 8) : <span className="text-muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
          </div>
        </>
      )}
    </div>
  );
}
