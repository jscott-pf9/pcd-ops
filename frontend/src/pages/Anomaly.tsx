import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import DataFreshness from "../components/DataFreshness";

interface Finding {
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  instance: string | null;
}

interface AnomalyData {
  lookback_hours: number;
  period_start: string;
  period_end: string;
  analysis: string | null;
  findings: Finding[];
  metric_summary: Record<string, number>;
}

const SEV_CONFIG: Record<string, { color: string; bg: string; icon: string }> = {
  critical: { color: "var(--red)",       bg: "var(--red-light)",    icon: "🔴" },
  high:     { color: "var(--red)",       bg: "var(--red-light)",    icon: "🟠" },
  medium:   { color: "var(--yellow)",    bg: "var(--yellow-light)", icon: "🟡" },
  low:      { color: "var(--green)",     bg: "var(--green-light)",  icon: "🟢" },
};

export default function Anomaly() {
  const [showFull, setShowFull] = useState(false);

  const { data, isLoading } = useQuery<AnomalyData>({
    queryKey: ["anomaly"],
    queryFn: () => apiFetch("/anomaly/"),
    retry: false,
  });

  const findings = data?.findings ?? [];
  const bySev = {
    critical: findings.filter(f => f.severity === "critical"),
    high:     findings.filter(f => f.severity === "high"),
    medium:   findings.filter(f => f.severity === "medium"),
    low:      findings.filter(f => f.severity === "low"),
  };
  const hasAlerts = bySev.critical.length + bySev.high.length > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Anomaly Detection</h1>
        <DataFreshness domainKey="anomaly:latest" slow />
      </div>

      {isLoading && !data && <p className="text-muted">Waiting for first AI collection…</p>}

      {data && (
        <>
          {/* ── Alert banner ── */}
          {hasAlerts && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 16px", borderRadius: 8, marginBottom: 16,
              background: "var(--red-light)", border: "1px solid var(--red)",
              color: "var(--red)", fontWeight: 600, fontSize: 13,
            }}>
              🚨 {bySev.critical.length + bySev.high.length} high-severity anomalies detected —
              check Alerts settings to enable email/webhook notifications.
            </div>
          )}

          {/* ── Severity summary cards ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.6rem", marginBottom: 16 }}>
            {(["critical","high","medium","low"] as const).map(sev => {
              const cfg = SEV_CONFIG[sev];
              const count = bySev[sev].length;
              return (
                <div key={sev} className="stat-card" style={{ borderTop: `3px solid ${cfg.color}`, opacity: count === 0 ? 0.5 : 1 }}>
                  <div className="stat-card-label">{sev}</div>
                  <div className="stat-card-value" style={{ color: cfg.color }}>{count}</div>
                  <div className="stat-card-sub">{count === 0 ? "none detected" : "finding(s)"}</div>
                </div>
              );
            })}
          </div>

          {/* ── Metric coverage ── */}
          {data.metric_summary && Object.keys(data.metric_summary).length > 0 && (
            <div className="card card-body" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--gray-900)" }}>
                Metrics Analyzed
                <span className="text-muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                  {new Date(data.period_start).toLocaleString()} — {new Date(data.period_end).toLocaleString()}
                </span>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {Object.entries(data.metric_summary).map(([metric, count]) => (
                  <div key={metric} style={{ fontSize: 12 }}>
                    <span className="badge badge-info">{metric}</span>
                    <span className="text-muted" style={{ marginLeft: 4 }}>{count} series</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Individual findings ── */}
          {findings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--gray-900)", marginBottom: 8 }}>Findings</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {findings.map((f, i) => {
                  const cfg = SEV_CONFIG[f.severity] ?? SEV_CONFIG.low;
                  return (
                    <div key={i} style={{
                      display: "flex", gap: 12, alignItems: "flex-start",
                      padding: "10px 14px",
                      background: cfg.bg, borderRadius: 6,
                      borderLeft: `3px solid ${cfg.color}`,
                    }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{cfg.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: cfg.color, marginBottom: 2, textTransform: "uppercase" }}>
                          {f.severity}
                          {f.instance && <span style={{ color: "var(--gray-600)", fontWeight: 400, textTransform: "none", marginLeft: 6 }}>· {f.instance}</span>}
                        </div>
                        <div style={{ fontSize: 13, color: "var(--gray-800)" }}>{f.description}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {findings.length === 0 && data.analysis && (
            <div className="card card-body" style={{ marginBottom: 16 }}>
              <div style={{ color: "var(--green)", fontWeight: 600, marginBottom: 6 }}>✓ No anomalies detected</div>
              <div className="text-muted" style={{ fontSize: 13 }}>All monitored metrics appear within normal ranges for the {data.lookback_hours}-hour window.</div>
            </div>
          )}

          {/* ── Full AI narrative ── */}
          {data.analysis && (
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="card-header" style={{ background: "var(--gray-50)" }}>
                <span className="card-title">🤖 Full AI Analysis</span>
                <span className="text-muted" style={{ fontSize: 11 }}>Ollama · {data.lookback_hours}h window</span>
              </div>
              <button onClick={() => setShowFull(s => !s)} style={{
                width: "100%", textAlign: "left", padding: "8px 14px",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 12, color: "var(--blue-primary)", fontWeight: 500,
              }}>
                {showFull ? "▲ Hide" : "▼ Show full analysis"}
              </button>
              {showFull && (
                <div style={{ padding: "0 14px 14px", fontSize: 13, color: "var(--gray-700)", lineHeight: 1.7 }}>
                  {data.analysis}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
