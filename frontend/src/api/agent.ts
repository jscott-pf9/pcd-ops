import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

interface AgentStatus {
  is_running: boolean;
  domains: Record<string, string>; // key → collected_at ISO string
  recent_runs: AgentRun[];
}

interface AgentRun {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: "running" | "success" | "error";
  error: string | null;
}

export function useAgentStatus() {
  return useQuery<AgentStatus>({
    queryKey: ["agent", "status"],
    queryFn: () => apiFetch<AgentStatus>("/agent/status"),
    refetchInterval: (query) => {
      // Poll every 3s while running, every 30s otherwise
      return query.state.data?.is_running ? 3000 : 30_000;
    },
  });
}

export function useTriggerAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slow: boolean = false) =>
      apiFetch<{ triggered: boolean }>(`/agent/trigger?slow=${slow}`, { method: "POST" }),
    onSuccess: () => {
      // Immediately start polling agent status
      queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
    },
    onSettled: () => {
      // Once the run completes (status stops running), refresh all data
      const poll = setInterval(async () => {
        const status = await apiFetch<AgentStatus>("/agent/status");
        if (!status.is_running) {
          clearInterval(poll);
          queryClient.invalidateQueries();
        }
      }, 3000);
    },
  });
}
