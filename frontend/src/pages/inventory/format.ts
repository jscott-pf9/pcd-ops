// Formatting for inventory records (pure: shared by tables, detail pages, hover cards, exports).

export function fmtDate(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export function fmtDateTime(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** GB → "512 GB" / "7.2 TB"; "—" without a value. */
export function fmtSize(gb?: number | null): string {
  if (gb == null || !Number.isFinite(gb)) return "—";
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export const mbToGb = (mb?: number | null) => (mb ? Math.round(mb / 1024) : null);

/** Installed RAM (DIMMs, over SSH) when known, else what the OS can use; in GB. */
export function ramGb(h: any): number | null {
  return mbToGb(h.memory_mb_installed ?? h.memory_mb_total);
}

/** "AMD Ryzen 7 5700U…" from lscpu already names the vendor; Nova's "EPYC-Rome-v5" doesn't. */
export function cpuName(h: any): string | null {
  const { cpu_vendor: v, cpu_model: m } = h;
  if (!m) return v || null;
  return v && !m.toLowerCase().startsWith(v.toLowerCase()) ? `${v} ${m}` : m;
}

export const pct = (used?: number | null, total?: number | null) =>
  used != null && total ? Math.round((used / total) * 1000) / 10 : null;

export const SERVER_GROUP_STATUS: Record<string, { label: string; badge: string }> = {
  ok:            { label: "Satisfied",     badge: "badge-ok" },
  violated:      { label: "Violated",      badge: "badge-error" },
  not_satisfied: { label: "Not satisfied", badge: "badge-warn" },
  empty:         { label: "No members",    badge: "badge-neutral" },
};
