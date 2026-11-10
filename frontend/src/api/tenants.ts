import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";

interface Tenant { id: string; name: string; }

export function useTenants(): Map<string, string> {
  const { data } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => apiFetch<Tenant[]>("/inventory/tenants"),
    staleTime: 5 * 60_000,
  });
  return new Map((data ?? []).map((t) => [t.id, t.name]));
}

/** Every tenant's name by id, service included (admin never), for showing names. Lists to pick
 *  from use useTenants, which leaves out admin and service. */
export function useTenantNames(): Map<string, string> {
  const { data } = useQuery({
    queryKey: ["tenants", "all"],
    queryFn: () => apiFetch<Tenant[]>("/inventory/tenants?all=true"),
    staleTime: 5 * 60_000,
  });
  return new Map((data ?? []).map((t) => [t.id, t.name]));
}
