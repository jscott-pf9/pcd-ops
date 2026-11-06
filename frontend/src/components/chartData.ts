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

/** The full timestamp, for tooltips. */
export function timeLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
