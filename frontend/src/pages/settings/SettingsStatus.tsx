import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { useAgentStatus, useTriggerAgent } from "../../api/agent";
import { Fieldset } from "./SettingsConnection";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ServiceStatus {
  ok: boolean;
  error: string | null;
  configured: boolean;
}

interface ConnectionsResult {
  openstack: ServiceStatus;
  grafana: ServiceStatus;
}

// ── Domain groups for the cache display ───────────────────────────────────────

const DOMAIN_GROUPS: { label: string; keys: string[] }[] = [
  {
    label: "Inventory",
    keys: ["inventory:servers", "inventory:hypervisors", "inventory:volumes",
           "inventory:networks", "inventory:tenants", "inventory:images",
           "inventory:floating_ips", "inventory:security_groups",
           "inventory:keypairs", "inventory:clusters", "inventory:flavors",
           "snapshots:list", "reclamation:candidates"],
  },
  {
    label: "Metrics & Analysis",
    keys: ["capacity:summary", "capacity:trends", "anomaly:latest",
           "rightsizing:recommendations"],
  },
  {
    label: "Logs",
    keys: ["logs:recent"],
  },
];

function friendlyKey(k: string): string {
  return k.replace(/^[^:]+:/, "").replace(/_/g, " ");
}

function timeAgo(iso: string): string {
  // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" with no timezone marker.
  // Browsers parse bare strings as local time; append Z to force UTC interpretation.
  const normalized = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(" ", "T") + "Z";
  const diff = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
  if (diff < 0)    return "just now";
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── Connection dot ─────────────────────────────────────────────────────────────

function Dot({ state }: { state: "ok" | "error" | "unknown" | "checking" }) {
  const color = state === "ok" ? "var(--green)" : state === "error" ? "var(--red)" : "var(--gray-300)";
  const label = state === "checking" ? "●" : "●";
  return (
    <span style={{
      color,
      fontSize: 16,
      lineHeight: 1,
      animation: state === "checking" ? "pulse 1s infinite" : undefined,
    }}>{label}</span>
  );
}

// ── Connection panel ───────────────────────────────────────────────────────────

function ConnectionPanel() {
  const [enabled, setEnabled] = useState(false);

  const { data, isFetching, refetch } = useQuery<ConnectionsResult>({
    queryKey: ["system", "connections"],
    queryFn: () => apiFetch<ConnectionsResult>("/system/connections"),
    enabled,
    staleTime: 0,
  });

  function test() {
    setEnabled(true);
    // If already enabled, just refetch
    if (enabled) refetch();
  }

  const row = (label: string, svc?: ServiceStatus) => {
    const state = isFetching ? "checking" : !svc ? "unknown" : svc.ok ? "ok" : "error";
    return (
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0",
        borderBottom: "1px solid var(--gray-50)" }}>
        <Dot state={state} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-800)" }}>{label}</div>
          {svc && !svc.ok && svc.error && (
            <div style={{ fontSize: 12, color: "var(--red)", marginTop: 2 }}>{svc.error}</div>
          )}
          {svc?.ok && (
            <div style={{ fontSize: 12, color: "var(--green)", marginTop: 2 }}>Connected</div>
          )}
          {!data && !isFetching && (
            <div style={{ fontSize: 12, color: "var(--gray-400)", marginTop: 2 }}>Not tested yet</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <Fieldset title="Connection Status">
      {row("PCD / OpenStack", data?.openstack)}
      {row("Grafana / Prometheus", data?.grafana)}
      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-secondary" onClick={test} disabled={isFetching}
          style={{ fontSize: 12 }}>
          {isFetching ? "Testing…" : "Test Connections"}
        </button>
        {data && !isFetching && (
          <span style={{ fontSize: 12, color: "var(--gray-400)" }}>
            {data.openstack.ok && data.grafana.ok
              ? "All connections OK"
              : "Check Settings → PCD & Metrics"}
          </span>
        )}
      </div>
    </Fieldset>
  );
}

// ── Agent panel ────────────────────────────────────────────────────────────────

function AgentPanel() {
  const { data: agent } = useAgentStatus();
  const trigger = useTriggerAgent();

  const isRunning = agent?.is_running ?? false;
  const domains = agent?.domains ?? {};
  const lastRun = agent?.recent_runs?.[0];

  return (
    <Fieldset title="Collection Agent">
      {/* Status row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Dot state={isRunning ? "checking" : Object.keys(domains).length > 0 ? "ok" : "unknown"} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gray-800)" }}>
          {isRunning ? "Running…" : "Idle"}
        </span>
        {lastRun && !isRunning && (
          <span style={{ fontSize: 12, color: "var(--gray-400)" }}>
            — last run {timeAgo(lastRun.completed_at ?? lastRun.started_at)}
            {lastRun.status === "error" && (
              <span style={{ color: "var(--red)" }}> (error)</span>
            )}
          </span>
        )}
        {!lastRun && !isRunning && (
          <span style={{ fontSize: 12, color: "var(--gray-400)" }}>— never run</span>
        )}
      </div>

      {/* Domain cache table */}
      <div style={{ marginBottom: 12 }}>
        {DOMAIN_GROUPS.map(group => {
          const collected = group.keys.filter(k => domains[k]);
          const missing   = group.keys.filter(k => !domains[k]);
          const hasAny    = collected.length > 0;

          return (
            <div key={group.label} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gray-500)",
                textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                {group.label}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
                {group.keys.map(k => {
                  const ts = domains[k];
                  return (
                    <span key={k} style={{
                      fontSize: 11,
                      color: ts ? "var(--gray-700)" : "var(--gray-300)",
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      <span style={{ color: ts ? "var(--green)" : "var(--gray-300)" }}>●</span>
                      {friendlyKey(k)}
                      {ts && <span style={{ color: "var(--gray-400)" }}>({timeAgo(ts)})</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="btn btn-primary"
          disabled={isRunning || trigger.isPending}
          onClick={() => trigger.mutate(true)}
          style={{ fontSize: 12 }}
        >
          {isRunning ? "Running…" : "Collect Now"}
        </button>
        <span style={{ fontSize: 12, color: "var(--gray-400)" }}>
          Runs all collectors including AI analysis (~1–2 min)
        </span>
      </div>
      {trigger.isError && (
        <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>
          {String(trigger.error)}
        </div>
      )}
    </Fieldset>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SettingsStatus() {
  return (
    <div style={{ maxWidth: 640 }}>
      <h1>System Status</h1>
      <p style={{ fontSize: 13, color: "var(--gray-500)", marginBottom: "1.25rem" }}>
        Verify your connections and trigger a data collection run after initial setup.
      </p>
      <ConnectionPanel />
      <AgentPanel />
    </div>
  );
}
