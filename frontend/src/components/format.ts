// Number formatting for metrics.

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** 1536 → "1.5 KB" (decimal-free above 100: "256 GB"). */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const s = v >= 100 || i === 0 ? Math.round(v).toString() : v.toFixed(1);
  return `${n < 0 ? "-" : ""}${s} ${UNITS[i]}`;
}

/** Bytes per second → "12.3 MB/s". */
export function formatRate(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${formatBytes(n)}/s`;
}

/** 42.345 → "42.3%". */
export function formatPct(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`;
}

/** Green in range, yellow under `low`, red at or over `high`, grey without a value. */
export function pctColor(v: number | null | undefined, low: number, high: number): string {
  if (v == null) return "var(--gray-300)";
  if (v >= high)  return "var(--red)";
  if (v < low)    return "var(--yellow)";
  return "var(--green)";
}
