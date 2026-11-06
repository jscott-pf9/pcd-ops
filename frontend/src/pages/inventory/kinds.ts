import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";

export type Kind =
  | "clusters" | "hypervisors" | "servers" | "server_groups" | "volumes" | "storage_backends"
  | "storage_types" | "networks" | "floating_ips" | "images" | "security_groups";

export interface KindDef {
  label: string;      // tab and breadcrumb
  singular: string;   // detail page subtitle
  idField: string;    // what the detail URL carries
  title: (r: any) => string;
  tenantField?: string;  // filterable by tenant
}

export const KINDS: Record<Kind, KindDef> = {
  clusters:         { label: "Clusters & Aggregates", singular: "Host aggregate", idField: "id", title: r => r.name },
  hypervisors:      { label: "Hypervisors",     singular: "Hypervisor",      idField: "id", title: r => r.hostname },
  servers:          { label: "Servers (VMs)",   singular: "VM",              idField: "id", title: r => r.name, tenantField: "project_id" },
  server_groups:    { label: "Server Groups",   singular: "Server group",    idField: "id", title: r => r.name, tenantField: "project_id" },
  volumes:          { label: "Volumes",         singular: "Volume",          idField: "id", title: r => r.name, tenantField: "project_id" },
  storage_backends: { label: "Storage Backends", singular: "Storage backend", idField: "name", title: r => r.name },
  storage_types:    { label: "Storage Types",   singular: "Volume type",     idField: "id", title: r => r.name },
  networks:         { label: "Networks",        singular: "Network",         idField: "id", title: r => r.name || r.id, tenantField: "project_id" },
  floating_ips:     { label: "Floating IPs",    singular: "Floating IP",     idField: "id", title: r => r.floating_ip_address, tenantField: "project_id" },
  images:           { label: "Images",          singular: "Image",           idField: "id", title: r => r.name, tenantField: "owner" },
  security_groups:  { label: "Security Groups", singular: "Security group",  idField: "id", title: r => r.name, tenantField: "project_id" },
};

export const TAB_ORDER: Kind[] = [
  "clusters", "hypervisors", "servers", "server_groups", "volumes", "storage_backends",
  "storage_types", "networks", "floating_ips", "images", "security_groups",
];

export const isKind = (k: string | null | undefined): k is Kind => !!k && k in KINDS;

export const detailPath = (kind: Kind, id: string | number) =>
  `/inventory/${kind}/${encodeURIComponent(String(id))}`;

export const fetchInventory = (kind: Kind) => apiFetch<any[]>(`/inventory/${kind}`);

/** One inventory list; tables and detail pages share the cache entry. */
export function useInventory(kind: Kind, enabled = true) {
  return useQuery({ queryKey: ["inventory", kind], queryFn: () => fetchInventory(kind), enabled });
}
