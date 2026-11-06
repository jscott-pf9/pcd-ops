import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type Row, timeLabel, timeTick } from "./chartData";

export type SeriesDef = { key: string; label: string; color: string };

/** One metric over time: a time axis, a value axis, one area per series and a tooltip with
 *  every series. Charts with the same `syncId` move their cursors together. */
export default function TimeChart({ data, series, format, days, syncId, height = 170, max }: {
  data: Row[]; series: SeriesDef[]; format: (v: number) => string; days: number;
  syncId?: string; height?: number;
  /** Fix the top of the value axis (100 for percentages) unless the data goes above it. */
  max?: number;
}) {
  const tick = timeTick(days);
  const top = max == null ? "auto" : (dataMax: number) => Math.max(max, Math.ceil(dataMax));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} syncId={syncId} syncMethod="value"
        margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map(s => (
            <linearGradient key={s.key} id={`fill-${syncId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={s.color} stopOpacity={0.18} />
              <stop offset="95%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--gray-100)" vertical={false} />
        <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]}
          tickFormatter={tick} minTickGap={40} tick={{ fontSize: 10, fill: "var(--gray-500)" }}
          axisLine={{ stroke: "var(--gray-200)" }} tickLine={false} />
        <YAxis domain={[0, top]} tickFormatter={format} width={78}
          tick={{ fontSize: 10, fill: "var(--gray-500)" }} axisLine={false} tickLine={false} />
        <Tooltip
          isAnimationActive={false}
          cursor={{ stroke: "var(--gray-400)", strokeDasharray: "3 3" }}
          content={({ active, payload, label }) => active && payload?.length ? (
            <div style={{ background: "#fff", border: "1px solid var(--gray-200)", borderRadius: 6,
              boxShadow: "var(--shadow-md)", padding: "6px 9px", fontSize: 11 }}>
              <div style={{ color: "var(--gray-500)", marginBottom: 3 }}>{timeLabel(Number(label))}</div>
              {series.map(s => {
                const v = payload.find(p => p.dataKey === s.key)?.value;
                return v == null ? null : (
                  <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                    <span style={{ color: "var(--gray-600)" }}>{s.label}</span>
                    <span style={{ marginLeft: "auto", paddingLeft: 10, fontWeight: 600 }}>
                      {format(Number(v))}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null} />
        {series.map(s => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color}
            strokeWidth={1.6} fill={`url(#fill-${syncId}-${s.key})`} dot={false}
            activeDot={{ r: 3 }} connectNulls isAnimationActive={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
