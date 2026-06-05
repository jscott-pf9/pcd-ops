import { RefreshCw } from "lucide-react";
import { useAgentStatus, useTriggerAgent } from "../api/agent";

interface Props {
  domainKey: string;   // e.g. "inventory:servers" or "reclamation:candidates"
  slow?: boolean;      // true = also runs AI collectors
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function DataFreshness({ domainKey, slow = false }: Props) {
  const { data: status } = useAgentStatus();
  const trigger = useTriggerAgent();

  const collectedAt = status?.domains?.[domainKey];
  const isRunning = status?.is_running ?? false;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      {collectedAt ? (
        <span className="text-muted" style={{ fontSize: 12 }}>
          Updated {relativeTime(collectedAt)}
        </span>
      ) : (
        <span className="text-muted" style={{ fontSize: 12 }}>No data yet</span>
      )}
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => trigger.mutate(slow)}
        disabled={isRunning || trigger.isPending}
        title={slow ? "Refresh all (including AI analysis)" : "Refresh data"}
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        <RefreshCw size={12} style={{ animation: isRunning ? "spin 1s linear infinite" : "none" }} />
        {isRunning ? "Collecting…" : "Refresh"}
      </button>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
