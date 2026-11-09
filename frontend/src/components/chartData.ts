// Shaping metric series for the time charts.

export type Point = { ts: number; v: number };
export type Row = { ts: number } & Record<string, number | undefined>;

/** {a: [{ts, v}], b: [...]} → [{ts, a, b}], one row per timestamp in any series, oldest first.
 *  Charts that share timestamps line up when their cursors are synchronised. */
export function mergeSeries(series: Record<string, Point[] | undefined>): Row[] {
  const rows = new Map<number, Row>();
  for (const [key, points] of Object.entries(series)) {
    for (const p of points ?? []) {
      const row = rows.get(p.ts) ?? { ts: p.ts };
      row[key] = p.v;
      rows.set(p.ts, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts);
}

/** Axis labels for a range of `days`: times within a day, dates beyond. */
export function timeTick(days: number): (ts: number) => string {
  return days <= 1
    ? ts => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : ts => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Local midnights between `from` and `to` (seconds), every few days when there would be more
 *  than `max`: date ticks for a range of days, so a wide chart doesn't repeat a date. */
export function dayTicks(from: number, to: number, max = 14): number[] {
  const d = new Date(from * 1000);
  d.setHours(0, 0, 0, 0);
  const days: number[] = [];
  for (d.setDate(d.getDate() + 1); d.getTime() / 1000 <= to; d.setDate(d.getDate() + 1)) days.push(d.getTime() / 1000);
  const step = Math.ceil(days.length / max) || 1;
  return days.filter((_, i) => i % step === 0);
}

export interface SeriesStats { last: number; min: number; avg: number; p95: number; max: number; maxTs: number }

/** Latest, minimum, mean, 95th percentile and maximum (and when it was) of a series' points
 *  over the range shown; null when it has none. The points are evenly spaced, so the mean is
 *  the average over time. */
export function seriesStats(points: Point[] | undefined): SeriesStats | null {
  const pts = (points ?? []).filter(p => Number.isFinite(p.v));
  if (!pts.length) return null;
  const vals = pts.map(p => p.v).sort((a, b) => a - b);
  const top = pts.reduce((m, p) => (p.v > m.v ? p : m));
  return {
    last: pts[pts.length - 1].v, min: vals[0], max: top.v, maxTs: top.ts,
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    p95: vals[Math.min(vals.length - 1, Math.ceil(0.95 * vals.length) - 1)],
  };
}

/** A query step ("4032s", "5m", "1h") in words: "1.1 h", "5 min", "1 h". */
export function stepText(step: string): string {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(step.trim());
  if (!m) return step;
  const sec = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2] || "s"];
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = sec / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/** The full timestamp, for tooltips. */
export function timeLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
