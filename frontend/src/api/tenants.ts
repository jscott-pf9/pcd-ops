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
