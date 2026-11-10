// Config change log (backend: services/drift.py, GET /drift/changes): kinds and how a change
// reads in the table and the workbook.
import type { Kind } from "../inventory/kinds";

export type DriftKind = "flavors" | "security_groups" | "aggregates" | "hosts" | "quotas";

export const DRIFT_KINDS: { id: DriftKind; label: string; singular: string; inventory?: Kind }[] = [
  { id: "flavors", label: "Flavors", singular: "Flavor", inventory: "flavors" },
  { id: "security_groups", label: "Security groups", singular: "Security group", inventory: "security_groups" },
  { id: "aggregates", label: "Aggregates", singular: "Aggregate", inventory: "clusters" },
  { id: "hosts", label: "Hosts", singular: "Host", inventory: "hypervisors" },
  { id: "quotas", label: "Quotas", singular: "Quotas" },
];

export const KIND = Object.fromEntries(DRIFT_KINDS.map(k => [k.id, k])) as Record<DriftKind, (typeof DRIFT_KINDS)[number]>;

export const isDriftKind = (k: string | null): k is DriftKind => DRIFT_KINDS.some(x => x.id === k);

export interface FieldChange { field: string; op: "added" | "removed" | "changed"; before: unknown; after: unknown }

export interface Change {
  id: number; at: string; kind: DriftKind; item_id: string; name: string | null; project_id: string | null;
  change: "added" | "removed" | "modified"; severity: "medium" | "high"; fields: FieldChange[];
}

export const PERIODS: { days: number; label: string }[] = [
  { days: 1, label: "24 hours" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }, { days: 0, label: "All" },
];

/** A value as text: blank strings and missing values say so. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v === "") return "(blank)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One changed field: "vcpus: 4 → 8", "+ rules.ingress IPv4 tcp 22 from 0.0.0.0/0". */
export function fieldText(f: FieldChange): string {
  if (f.op === "added") return `+ ${f.field}${f.after !== "" && f.after != null ? ` = ${valueText(f.after)}` : ""}`;
  if (f.op === "removed") return `− ${f.field}${f.before !== "" && f.before != null ? ` (was ${valueText(f.before)})` : ""}`;
  return `${f.field}: ${valueText(f.before)} → ${valueText(f.after)}`;
}

/** Zone-less backend times are UTC. */
export const parseAt = (at: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`);
