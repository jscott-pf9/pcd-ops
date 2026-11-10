// Reclamation & Warnings: categories, filters and totals (pure; the page renders them).
// The backend's rules are in backend/app/services/reclamation.py.

export type Group = "compute" | "storage" | "network" | "tenants";

export const GROUPS: { id: Group; label: string }[] = [
  { id: "compute", label: "Compute" },
  { id: "storage", label: "Storage" },
  { id: "network", label: "Network" },
  { id: "tenants", label: "Tenants" },
];

export type CategoryKey =
  | "stopped_servers" | "idle_servers" | "orphaned_vms" | "empty_server_groups"
  | "unattached_volumes" | "unused_images"
  | "unused_floating_ips" | "orphaned_ports" | "unused_routers" | "unused_networks"
  | "empty_tenants";

export interface CategoryMeta {
  key: CategoryKey;
  label: string;
  group: Group;
  /** Something wrong to look into, not something to free. */
  warning?: boolean;
  /** DELETE /reclamation/<path>/<id>; none = report only. */
  deletePath?: string;
  /** Why an item can't be deleted here, if it can't. */
  cantDelete?: (item: any) => string | null;
  /** The noun for the confirm dialog. */
  noun: string;
  /** Its sheet in the Export All workbook (Excel allows 31 characters). */
  sheet: string;
}

export const CATEGORIES: CategoryMeta[] = [
  { key: "stopped_servers", label: "Stopped VMs", sheet: "Stopped VMs", group: "compute", deletePath: "servers", noun: "VM" },
  { key: "idle_servers", label: "Idle VMs", sheet: "Idle VMs", group: "compute", noun: "VM" },
  { key: "orphaned_vms", label: "Orphaned VMs", sheet: "Orphaned VMs", group: "compute", warning: true, noun: "VM" },
  { key: "empty_server_groups", label: "Empty server groups", sheet: "Empty server groups", group: "compute", deletePath: "server_groups", noun: "server group" },
  { key: "unattached_volumes", label: "Unattached volumes", sheet: "Unattached volumes", group: "storage", deletePath: "volumes", noun: "volume" },
  { key: "unused_images", label: "Unused images & snapshots", sheet: "Unused images & snapshots", group: "storage", deletePath: "images", noun: "image",
    cantDelete: i => (i.is_protected ? "Protected: unprotect it in PCD first" : null) },
  { key: "unused_floating_ips", label: "Unused floating IPs", sheet: "Unused floating IPs", group: "network", deletePath: "floating_ips", noun: "floating IP" },
  { key: "orphaned_ports", label: "Orphaned ports & router interfaces", sheet: "Orphaned ports", group: "network", deletePath: "ports", noun: "port" },
  { key: "unused_routers", label: "Unused routers", sheet: "Unused routers", group: "network", deletePath: "routers", noun: "router" },
  { key: "unused_networks", label: "Networks with no VMs", sheet: "Networks with no VMs", group: "network", deletePath: "networks", noun: "network" },
  { key: "empty_tenants", label: "Empty tenants", sheet: "Empty tenants", group: "tenants", noun: "tenant" },
];

export const CATEGORY: Record<CategoryKey, CategoryMeta> =
  Object.fromEntries(CATEGORIES.map(c => [c.key, c])) as Record<CategoryKey, CategoryMeta>;

export const isGroup = (g: string | null): g is Group => GROUPS.some(x => x.id === g);

// ── Ages ───────────────────────────────────────────────────────────────────────

/** Whole days since an ISO time (UTC when it has no zone, as the backend writes it). */
export function ageDays(iso?: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function ageText(days: number | null): string {
  if (days == null) return "—";
  if (days === 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

// ── Filters ────────────────────────────────────────────────────────────────────

export interface Filters { tenant: string; minAge: number; q: string; system: boolean }

/** The tenant an item belongs to; a tenant is its own. */
export const tenantOf = (cat: CategoryKey, item: any): string | null =>
  cat === "empty_tenants" ? item.id : item.project_id ?? null;

export function filterItems(cat: CategoryKey, items: any[] | undefined, f: Filters, now = Date.now()): any[] {
  const q = f.q.trim().toLowerCase();
  return (items ?? []).filter(i =>
    (!f.tenant || tenantOf(cat, i) === f.tenant) &&
    (!f.minAge || (ageDays(i.since, now) ?? 0) >= f.minAge) &&
    (cat !== "empty_tenants" || f.system || !i.system) &&
    (!q || [i.name, i.id, i.reason, ...(i.fixed_ips ?? []), i.floating_ip_address]
      .some(v => v && String(v).toLowerCase().includes(q))));
}

// ── What could be freed ────────────────────────────────────────────────────────

export interface Frees { vcpus: number; ram_gb: number; volume_gb: number; image_gb: number; ips: number }

export const NO_FREES: Frees = { vcpus: 0, ram_gb: 0, volume_gb: 0, image_gb: 0, ips: 0 };

/** What deleting `items` of a category frees. Idle VMs count too: stopping one frees its
 *  vCPUs and RAM. Warnings free nothing until someone decides what they are. */
export function frees(cat: CategoryKey, items: any[]): Frees {
  const out = { ...NO_FREES };
  for (const i of items) {
    switch (cat) {
      case "stopped_servers":
        out.vcpus += i.vcpus ?? 0; out.ram_gb += (i.ram_mb ?? 0) / 1024; out.volume_gb += i.attached_disk_gb ?? 0;
        break;
      case "idle_servers":
        out.vcpus += i.vcpus ?? 0; out.ram_gb += (i.ram_mb ?? 0) / 1024;
        break;
      case "unattached_volumes": out.volume_gb += i.size ?? 0; break;
      case "unused_images": out.image_gb += i.size_gb ?? 0; break;
      case "unused_floating_ips": out.ips += 1; break;
      case "orphaned_ports": out.ips += (i.fixed_ips ?? []).length; break;
    }
  }
  return out;
}

export function addFrees(a: Frees, b: Frees): Frees {
  return { vcpus: a.vcpus + b.vcpus, ram_gb: a.ram_gb + b.ram_gb, volume_gb: a.volume_gb + b.volume_gb,
           image_gb: a.image_gb + b.image_gb, ips: a.ips + b.ips };
}

/** "8 vCPU · 16 GB RAM" — the non-zero parts. */
export function freesText(f: Frees): string {
  const parts = [
    f.vcpus && `${f.vcpus} vCPU`,
    f.ram_gb && `${Math.round(f.ram_gb)} GB RAM`,
    f.volume_gb && `${Math.round(f.volume_gb)} GB volumes`,
    f.image_gb && `${f.image_gb.toFixed(1)} GB images`,
    f.ips && `${f.ips} IP${f.ips === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

/** Which category's note to show: its own, or the data source it depends on. */
export function noteFor(cat: CategoryKey, notes: Record<string, string> = {}): string | null {
  if (notes[cat]) return notes[cat];
  if (cat === "idle_servers") return notes.idle ?? null;
  if (cat === "orphaned_vms") return notes.libvirt ?? null;
  return null;
}

// ── What it saves ──────────────────────────────────────────────────────────────

/** Monthly price per unit, from Settings (reclamation_price_*); 0 = not priced. */
export interface Prices { currency: string; vcpu: number; ram_gb: number; volume_gb: number; image_gb: number; ip: number }

export const NO_PRICES: Prices = { currency: "$", vcpu: 0, ram_gb: 0, volume_gb: 0, image_gb: 0, ip: 0 };

export const priced = (p: Prices) => p.vcpu > 0 || p.ram_gb > 0 || p.volume_gb > 0 || p.image_gb > 0 || p.ip > 0;

/** What freeing `f` saves a month at `p`. */
export const monthly = (f: Frees, p: Prices) =>
  f.vcpus * p.vcpu + f.ram_gb * p.ram_gb + f.volume_gb * p.volume_gb + f.image_gb * p.image_gb + f.ips * p.ip;

/** "$1,234/month"; "—" for nothing. */
export function moneyText(v: number, p: Prices): string {
  if (!v) return "—";
  const digits = v < 100 ? 2 : 0;
  return `${p.currency}${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}/month`;
}
