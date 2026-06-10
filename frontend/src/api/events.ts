import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useAgentStatus } from "./agent";

export interface AppEvent {
  id: string;
  event_type: string;
  level: "running" | "success" | "error" | "warning" | "info";
  title: string;
  detail: string | null;
  component: string | null;
  tenant: string | null;
  timestamp: string;
}

export function useEvents(limit = 100) {
  const { data: agentStatus } = useAgentStatus();
  return useQuery<AppEvent[]>({
    queryKey: ["events"],
    queryFn: () => apiFetch<AppEvent[]>(`/events?limit=${limit}`),
    refetchInterval: agentStatus?.is_running ? 3_000 : 10_000,
  });
}
