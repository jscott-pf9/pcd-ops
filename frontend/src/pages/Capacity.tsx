import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiFetch } from "../api/client";
import DataFreshness from "../components/DataFreshness";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ResourceSummary { total: number | null; used: number; free: number | null; }
interface Summary { vcpus: ResourceSummary; ram_gb: ResourceSummary; storage_gb: ResourceSummary; }

interface TrendPoint { ts: number; label: string; used: number; total: number; pct: number; }
interface ResourceTrend {
  series: TrendPoint[];
  latest: { used: number; total: number; pct: number };
  trend: { slope_per_day: number; r_squared: number } | null;
  forecast: { days_to_80pct: number | null; days_to_90pct: number | null; days_to_100pct: number | null } | null;
}
interface Trends {
  window_days: number;
  resources: { vcpus: ResourceTrend; ram_gb: ResourceTrend; storage_gb: ResourceTrend };
  ai_analysis: string | null;
  period_start: string;
  period_end: string;
}


// ── Main page ──────────────────────────────────────────────────────────────────

export default function Capacity() {
  const { data: summary } = useQuery<Summary>({
    queryKey: ["capacity", "summary"],
    queryFn: () => apiFetch<Summary>("/capacity/summary"),
  });

  const { data: trends } = useQuery<Trends>({
    queryKey: ["capacity", "trends"],
    queryFn: () => apiFetch<Trends>("/capacity/trends"),
    retry: false,
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Capacity Planning</h1>
        <DataFreshness domainKey="capacity:summary" />
      </div>

      {summary && (
        <section style={{ marginBottom: 16 }}>
          <SectionTitle>Current Utilization</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
            <UtilCard label="vCPUs" r={summary.vcpus} unit="" />
            <UtilCard label="Memory" r={summary.ram_gb} unit="GB" />
            <UtilCard label="Storage" r={summary.storage_gb} unit="GB" />
          </div>
        </section>
      )}

      {trends && (
        <section style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <SectionTitle style={{ marginBottom: 0 }}>{trends.window_days}-Day Trends</SectionTitle>
            <DataFreshness domainKey="capacity:trends" slow />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
            <TrendCard label="vCPUs" data={trends.resources.vcpus} unit="" color="var(--blue-primary)" />
            <TrendCard label="Memory (GB)" data={trends.resources.ram_gb} unit="GB" color="var(--purple)" />
            <TrendCard label="Storage (GB)" data={trends.resources.storage_gb} unit="GB" color="var(--green)" />
          </div>
        </section>
      )}

      {trends && (
        <section style={{ marginBottom: 16 }}>
          <SectionTitle>Capacity Runway</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem", marginBottom: 12 }}>
            <RunwayCard label="vCPUs" data={trends.resources.vcpus} />
            <RunwayCard label="Memory" data={trends.resources.ram_gb} />
            <RunwayCard label="Storage" data={trends.resources.storage_gb} />
          </div>
          {trends.ai_analysis && (
            <AiAnalysis text={trends.ai_analysis} resources={trends.resources} />
          )}
        </section>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--gray-900)", marginBottom: 12, ...style }}>
      {children}
    </div>
  );
}

function UtilCard({ label, r, unit }: { label: string; r: ResourceSummary; unit: string }) {
  const hasTotal = r.total !== null && r.total > 0;
  const pct = hasTotal ? Math.round((r.used / r.total!) * 100) : null;
  const fillColor = pct === null ? "var(--blue-primary)"
    : pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--yellow)" : "var(--blue-primary)";

  return (
    <div className="card card-body">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <span style={{ fontWeight: 600, color: "var(--gray-900)" }}>{label}</span>
        {pct !== null
          ? <span style={{ fontSize: 22, fontWeight: 700, color: fillColor }}>{pct}%</span>
          : <span style={{ fontSize: 18, fontWeight: 700, color: fillColor }}>{Math.round(r.used)}{unit}</span>
        }
      </div>
      {hasTotal && (
        <div style={{ height: 8, background: "var(--gray-100)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
          <div style={{ height: "100%", width: `${pct}%`, background: fillColor, borderRadius: 4, transition: "width .4s" }} />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--gray-500)" }}>
        <span>{Math.round(r.used)}{unit} used</span>
        {r.free !== null
          ? <span>{Math.round(r.free)}{unit} free</span>
          : <span className="text-muted">capacity unknown</span>}
        {hasTotal && <span>{Math.round(r.total!)}{unit} total</span>}
      </div>
    </div>
  );
}

function TrendCard({ label, data, unit, color }: { label: string; data: ResourceTrend; unit: string; color: string }) {
  if (!data.series.length) {
    return (
      <div className="card card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 180 }}>
        <span className="text-muted" style={{ fontSize: 13 }}>No trend data yet</span>
      </div>
    );
  }

  const slope = data.trend?.slope_per_day ?? 0;
  const trendLabel = slope > 0.01
    ? `+${slope.toFixed(2)} ${unit}/day`
    : slope < -0.01
    ? `${slope.toFixed(2)} ${unit}/day`
    : "Stable";

  return (
    <div className="card card-body" style={{ padding: "14px 14px 8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-900)" }}>{label}</span>
        <span className="text-muted" style={{ fontSize: 11 }}>{trendLabel}</span>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={data.series} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id={`fill-${label}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.15} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-100)" />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--gray-400)" }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: "var(--gray-400)" }} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid var(--gray-200)" }}
            formatter={(val: number) => [`${val} ${unit}`, ""]}
          />
          {data.latest && (
            <ReferenceLine
              y={data.latest.total}
              stroke="var(--gray-300)"
              strokeDasharray="4 4"
              label={{ value: "Capacity", position: "insideTopRight", fontSize: 10, fill: "var(--gray-400)" }}
            />
          )}
          <Area
            type="monotone"
            dataKey="used"
            stroke={color}
            strokeWidth={2}
            fill={`url(#fill-${label})`}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      {data.latest && (
        <div className="text-muted" style={{ fontSize: 11, textAlign: "right", marginTop: 2 }}>
          Now: {data.latest.used} / {data.latest.total} {unit} ({data.latest.pct}%)
        </div>
      )}
    </div>
  );
}

function RunwayCard({ label, data }: { label: string; data: ResourceTrend }) {
  const f = data.forecast;
  const latest = data.latest;

  if (!f || (f.days_to_80pct === null && f.days_to_90pct === null)) {
    return (
      <div className="card card-body">
        <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--gray-900)" }}>{label}</div>
        {latest && <div className="text-muted" style={{ fontSize: 13 }}>{latest.pct}% utilized — stable or declining</div>}
      </div>
    );
  }

  const thresholds = [
    { label: "80%", days: f.days_to_80pct, warnAt: 60 },
    { label: "90%", days: f.days_to_90pct, warnAt: 30 },
    { label: "100%", days: f.days_to_100pct, warnAt: 14 },
  ];

  return (
    <div className="card card-body">
      <div style={{ fontWeight: 600, marginBottom: 10, color: "var(--gray-900)" }}>{label}</div>
      {thresholds.map(({ label: pct, days, warnAt }) => {
        if (days === null) return null;
        const color = days <= warnAt ? "var(--red)" : days <= warnAt * 3 ? "var(--yellow)" : "var(--green)";
        return (
          <div key={pct} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
            <span className="text-muted">Until {pct}</span>
            <span style={{ fontWeight: 600, color }}>
              {days <= 0 ? "Already exceeded" : `~${days} days`}
            </span>
          </div>
        );
      })}
      {data.trend && (
        <div className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
          R² = {data.trend.r_squared.toFixed(2)} (trend confidence)
        </div>
      )}
    </div>
  );
}


// ── AI Analysis visual component ───────────────────────────────────────────────

interface AiAnalysisProps {
  text: string;
  resources: Trends["resources"];
}

function resourceStatus(pct: number | undefined): { label: string; color: string; bg: string; icon: string } {
  if (pct === undefined) return { label: "Unknown",  color: "var(--gray-500)",   bg: "var(--gray-100)",    icon: "○" };
  if (pct >= 90)         return { label: "Critical",  color: "var(--red)",        bg: "var(--red-light)",   icon: "▲" };
  if (pct >= 70)         return { label: "Warning",   color: "var(--yellow)",     bg: "var(--yellow-light)", icon: "●" };
  return                        { label: "Healthy",   color: "var(--green)",      bg: "var(--green-light)", icon: "✓" };
}

function trendIcon(slope: number | undefined): string {
  if (slope === undefined || Math.abs(slope) < 0.01) return "→ Stable";
  return slope > 0 ? `↑ +${slope.toFixed(2)}/day` : `↓ ${slope.toFixed(2)}/day`;
}

/** Extract numbered recommendation items from AI text, strip markdown bold. */
function parseRecommendations(text: string): string[] {
  const lines = text.split("\n");
  const recs: string[] = [];
  let inRecs = false;
  for (const line of lines) {
    if (/specific recommendations/i.test(line)) { inRecs = true; continue; }
    if (inRecs && /^\d+\./.test(line.trim())) {
      recs.push(line.trim().replace(/\*\*/g, "").replace(/^\d+\.\s*/, ""));
    }
  }
  return recs;
}

function AiAnalysis({ text, resources }: AiAnalysisProps) {
  const [expanded, setExpanded] = React.useState(false);

  const chips = [
    { label: "vCPUs",   pct: resources.vcpus?.latest?.pct,      slope: resources.vcpus?.trend?.slope_per_day },
    { label: "Memory",  pct: resources.ram_gb?.latest?.pct,     slope: resources.ram_gb?.trend?.slope_per_day },
    { label: "Storage", pct: resources.storage_gb?.latest?.pct, slope: resources.storage_gb?.trend?.slope_per_day },
  ];

  const recommendations = parseRecommendations(text);

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {/* Header */}
      <div className="card-header" style={{ background: "var(--gray-50)" }}>
        <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>🤖</span> AI Analysis
        </span>
        <span className="text-muted" style={{ fontSize: 11 }}>Ollama · llama3.1</span>
      </div>

      {/* Resource status row */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--gray-100)" }}>
        {chips.map(({ label, pct, slope }) => {
          const s = resourceStatus(pct);
          return (
            <div key={label} style={{
              flex: 1, padding: "14px 18px",
              borderRight: "1px solid var(--gray-100)",
              background: s.bg,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-900)" }}>{label}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: s.color,
                  background: "#fff", padding: "1px 7px", borderRadius: 99,
                  border: `1px solid ${s.color}`,
                }}>
                  {s.icon} {s.label}
                </span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1 }}>
                {pct !== undefined ? `${pct}%` : "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--gray-500)", marginTop: 3 }}>
                {trendIcon(slope)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--gray-100)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--gray-500)", marginBottom: 10 }}>
            Recommendations
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recommendations.map((rec, i) => {
              const [title, ...rest] = rec.split(":");
              const detail = rest.join(":").trim();
              const priorityColor = i === 0 ? "var(--blue-primary)" : i === 1 ? "var(--purple)" : "var(--gray-400)";
              return (
                <div key={i} style={{
                  display: "flex", gap: 12, alignItems: "flex-start",
                  padding: "10px 14px",
                  background: "var(--gray-50)",
                  borderRadius: 6,
                  borderLeft: `3px solid ${priorityColor}`,
                }}>
                  <span style={{
                    minWidth: 22, height: 22, borderRadius: "50%",
                    background: priorityColor, color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, flexShrink: 0,
                  }}>{i + 1}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-900)" }}>{title.trim()}</div>
                    {detail && <div style={{ fontSize: 12, color: "var(--gray-600)", marginTop: 2 }}>{detail}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Collapsible full narrative */}
      <div style={{ padding: "10px 18px" }}>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            fontSize: 12, color: "var(--blue-primary)", fontWeight: 500,
          }}
        >
          {expanded ? "▲ Hide full analysis" : "▼ Show full analysis"}
        </button>
        {expanded && (
          <div style={{
            marginTop: 12, padding: "12px 14px",
            background: "var(--gray-50)", borderRadius: 6,
            fontSize: 12, color: "var(--gray-700)", lineHeight: 1.6,
            whiteSpace: "pre-wrap",
          }}>
            {text.replace(/\*\*/g, "")}
          </div>
        )}
      </div>
    </div>
  );
}

