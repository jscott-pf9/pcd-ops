import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorDetail } from "../api/client";
import { useTenantNames } from "../api/tenants";
import DataFreshness from "../components/DataFreshness";
import { ItemLink } from "../components/DetailPage";
import { Sparkline } from "../components/Metric";
import { detailPath } from "./inventory/kinds";
import { StatCard } from "./inventory/shared";
import { fmtValue, type Unit, sinceText } from "./anomaly";

type Severity = "critical" | "high" | "medium";

interface Finding {
  id: string; kind: "vm" | "host"; resource_id: string; name: string; project_id: string | null;
  host: string | null; metric: string; label: string; unit: Unit;
  current: number; usual: number; spread: number; z: number; direction: "up" | "down";
  severity: Severity; baseline: "seasonal" | "window"; since: string | null;
  spark: { ts: number; v: number }[];
}

interface Data {
  source: string | null; window_days: number; history_hours: number; note: string | null;
  checked: { vm: number; host: number }; findings: Finding[];
  explanation: string | null; explanation_at: string | null; explanation_current: boolean;
}

const SEV: Record<Severity, { badge: string; accent: string }> = {
  critical: { badge: "badge-error", accent: "var(--red)" },
  high: { badge: "badge-error", accent: "var(--red)" },
  medium: { badge: "badge-warn", accent: "var(--yellow)" },
};

/** Statistical anomalies: VMs and hosts far from their usual load. Severity and kind filters,
 *  and the finding an alert linked to (?id=), live in the URL. */
export default function Anomaly() {
  const [params, setParams] = useSearchParams();
  const sev = (params.get("severity") ?? "") as Severity | "";
  const kind = params.get("kind") ?? "";
  const focus = params.get("id") ?? "";
  const set = (changes: Record<string, string>) => setParams(p => {
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    return p;
  }, { replace: true });

  const tenants = useTenantNames();
  const { data, isLoading, error } = useQuery<Data>({
    queryKey: ["anomaly"], queryFn: () => apiFetch("/anomaly/"), retry: false,
  });
  const all = data?.findings ?? [];
  const rows = all.filter(f => (!sev || f.severity === sev) && (!kind || f.kind === kind));
  const count = (s: Severity) => all.filter(f => f.severity === s).length;

  useEffect(() => {
    if (focus && data) document.getElementById(`f-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, data]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>Anomaly Detection</h1>
        <DataFreshness domainKey="anomaly:latest" />
      </div>
      <p className="text-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        Every 15 minutes, each VM's and host's last hour of CPU, memory, network, disk and CPU wait is compared
        with its usual level: the same hour on earlier days once there are {5} days of metrics, otherwise all of them.
        A finding is at least 3 standard deviations away and a real change, not a flicker on an idle VM.
        {data && data.checked && <> Checked {data.checked.vm} VMs and {data.checked.host} hosts.</>}
      </p>

      {isLoading && <p className="text-muted">Waiting for the first collection…</p>}
      {error && !data && <p className="text-muted">{errorDetail(error)}</p>}

      {data && (
        <>
          {data.note && (
            <div className="card" style={{ borderLeft: "3px solid var(--yellow)", marginBottom: "1rem" }}>
              <div className="card-body" style={{ fontSize: 13 }}>{data.note}</div>
            </div>
          )}

          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            {(["critical", "high", "medium"] as Severity[]).map(s => (
              <button key={s} type="button" onClick={() => set({ severity: sev === s ? "" : s })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", outline: sev === s ? `2px solid ${SEV[s].accent}` : undefined, borderRadius: 8 }}>
                <StatCard label={s} value={String(count(s))} sub={sev === s ? "showing only these" : "click to filter"}
                  accent={count(s) ? SEV[s].accent : "var(--green)"} />
              </button>
            ))}
          </div>

          {data.explanation && (
            <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--blue-primary)" }}>
              <div className="card-header">
                <span className="card-title">What the AI makes of it</span>
                {!data.explanation_current && data.explanation_at && (
                  <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>
                    written for the findings at {new Date(`${data.explanation_at}Z`).toLocaleString()}; they have changed since
                  </span>
                )}
              </div>
              <div className="card-body" style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{data.explanation}</div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <div className="tabs" style={{ marginBottom: 0, flex: 1 }}>
              {[["", "All"], ["vm", "VMs"], ["host", "Hosts"]].map(([k, label]) => (
                <button key={k} className={`tab${kind === k ? " active" : ""}`} onClick={() => set({ kind: k })}>
                  {label} <span className="text-muted" style={{ fontWeight: 400 }}>{k ? all.filter(f => f.kind === k).length : all.length}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card table-wrap">
            {rows.length === 0
              ? <div className="card-body"><p className="text-muted" style={{ margin: 0 }}>
                  {all.length ? "None match the filters." : "Nothing unusual right now."}</p></div>
              : (
                <table>
                  <thead>
                    <tr><th>Severity</th><th>Resource</th><th>Metric</th><th style={{ textAlign: "right" }}>Now</th>
                      <th style={{ textAlign: "right" }}>Usual</th><th style={{ textAlign: "right" }}>Deviation</th>
                      <th>For</th><th style={{ width: 160 }}>Last 48 hours</th><th>Host · tenant</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(f => (
                      <tr key={f.id} id={`f-${f.id}`} style={f.id === focus ? { background: "var(--blue-light, #eef6fc)" } : undefined}>
                        <td><span className={`badge ${SEV[f.severity].badge}`}>{f.severity}</span></td>
                        <td>
                          <ItemLink to={detailPath(f.kind === "vm" ? "servers" : "hypervisors", f.resource_id)}>
                            <strong>{f.name}</strong>
                          </ItemLink>
                          <div className="text-muted" style={{ fontSize: 11 }}>{f.kind === "vm" ? "VM" : "Host"}</div>
                        </td>
                        <td>{f.label}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtValue(f.current, f.unit)}</td>
                        <td style={{ textAlign: "right" }} title={`± ${fmtValue(f.spread, f.unit)} (${f.baseline === "seasonal" ? "same hour on earlier days" : "whole window"})`}>
                          {fmtValue(f.usual, f.unit)}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap", color: SEV[f.severity].accent, fontWeight: 600 }}>
                          {f.direction === "up" ? "▲" : "▼"} {Math.abs(f.z).toFixed(1)}σ
                        </td>
                        <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{sinceText(f.since)}</td>
                        <td style={{ width: 160 }}><Sparkline data={f.spark} color={SEV[f.severity].accent} format={v => fmtValue(v, f.unit)} /></td>
                        <td style={{ fontSize: 12 }}>
                          {f.kind === "vm" ? <>{f.host ?? "—"}{f.project_id && <div className="text-muted">{tenants.get(f.project_id) ?? f.project_id.slice(0, 8)}</div>}</> : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </>
      )}
    </div>
  );
}
