import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";

export type Point = { ts: number; v: number };

/** A labelled value with an optional gauge (when `low` is given, for percentages) and a
 *  sparkline of its history. */
export function Metric({ label, avg, unit = "", series, color, low, format }: {
  label: string; avg: number | null | undefined; unit?: string;
  series: Point[]; color: string;
  low?: number; high?: number;
  format?: (v: number) => string;
}) {
  const hasData = series.length > 1;
  const show = (v: number) => (format ? format(v) : `${v.toFixed(1)}${unit}`);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--gray-500)" }}>
          {label}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color }}>
          {avg != null ? show(avg) : "—"}
        </span>
      </div>
      {avg != null && low !== undefined && (
        <div style={{ height: 5, background: "var(--gray-100)", borderRadius: 3, overflow: "hidden", marginBottom: 3 }}>
          <div style={{ height: "100%", width: `${Math.min(100, avg)}%`, background: color, borderRadius: 3,
            transition: "width .3s" }} />
        </div>
      )}
      {hasData ? (
        <Sparkline data={series} color={color} format={show} />
      ) : (
        <div style={{ height: 28, background: "var(--gray-50)", borderRadius: 3,
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 10, color: "var(--gray-400)" }}>no history</span>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ data, color, format }: {
  data: Point[]; color: string; format?: (v: number) => string;
}) {
  // Unique per instance: several sparklines of the same colour share a page.
  const id = `spark${useId().replace(/[^a-z0-9]/gi, "")}`;
  return (
    <ResponsiveContainer width="100%" height={32}>
      <AreaChart data={data} margin={{ top: 1, right: 0, left: 0, bottom: 1 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.2} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip contentStyle={{ fontSize: 11, padding: "2px 6px", borderRadius: 4,
            border: "1px solid var(--gray-200)" }}
          formatter={(v: number) => [format ? format(v) : v.toFixed(1), ""]}
          labelFormatter={(_, p) => {
            const ts = p?.[0]?.payload?.ts;
            return ts ? new Date(ts * 1000).toLocaleString() : "";
          }} />
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#${id})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
