import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, Rocket, Trash2 } from "lucide-react";
import { apiFetch } from "../api/client";

interface Deployment {
  id: string;
  app_name: string;
  profile_id: number | null;
  tenant_name: string;
  network_name: string;
  key_pair: string;
  outputs: Record<string, any>;
  status: string;
  error_msg: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_CFG: Record<string, { color: string; bg: string; label: string; dot: string }> = {
  running:    { color:"#166534", bg:"#f0fdf4", label:"Running",    dot:"🟢" },
  deploying:  { color:"#92400e", bg:"#fffbeb", label:"Deploying",  dot:"🟡" },
  redeploying:{ color:"#92400e", bg:"#fffbeb", label:"Redeploying",dot:"🟡" },
  destroying: { color:"#7f1d1d", bg:"#fef2f2", label:"Destroying", dot:"🔴" },
  stopped:    { color:"#374151", bg:"#f9fafb", label:"Stopped",    dot:"⚫" },
  destroyed:  { color:"#374151", bg:"#f9fafb", label:"Destroyed",  dot:"⚫" },
  error:      { color:"#991b1b", bg:"#fef2f2", label:"Error",      dot:"🔴" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? STATUS_CFG.error;
  return (
    <span style={{
      fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99,
      background: cfg.bg, color: cfg.color,
    }}>
      {cfg.dot} {cfg.label}
    </span>
  );
}

// ── Terminal panel (reusable SSE log view) ─────────────────────────────────────

function TerminalPanel({ lines, running, result }: {
  lines: string[]; running: boolean;
  result: { success: boolean; outputs?: any; message?: string } | null;
}) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div style={{ marginTop:8 }}>
      <pre ref={ref} style={{
        background:"#0f172a", color:"#d1fae5", fontFamily:"var(--font-mono)",
        fontSize:11, lineHeight:1.6, padding:"10px 14px", borderRadius:6,
        maxHeight:240, overflowY:"auto", margin:0, whiteSpace:"pre-wrap", wordBreak:"break-all",
      }}>
        {lines.join("\n")}
        {running && <span style={{ opacity:.6 }}>{"\n"}▌</span>}
      </pre>
      {result && (
        <div style={{
          marginTop:6, padding:"8px 12px", borderRadius:6, fontSize:12,
          background: result.success ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${result.success ? "#86efac" : "#fca5a5"}`,
          color: result.success ? "#166534" : "#991b1b",
        }}>
          {result.success ? "✓ Operation completed" : `✗ ${result.message}`}
          {result.success && result.outputs && Object.keys(result.outputs).length > 0 && (
            <div style={{ marginTop:6 }}>
              {Object.entries(result.outputs).map(([k, v]) => (
                <div key={k}><strong>{k}:</strong> {Array.isArray(v) ? v.join(", ") : String(v)}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Deployment row ─────────────────────────────────────────────────────────────

function DeploymentRow({ dep, onRefresh }: { dep: Deployment; onRefresh: () => void }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [opLog, setOpLog]       = useState<string[]>([]);
  const [opRunning, setOpRunning] = useState(false);
  const [opResult, setOpResult]   = useState<any>(null);

  const _cfg = STATUS_CFG[dep.status] ?? STATUS_CFG.error; void _cfg;
  const ips = Object.entries(dep.outputs)
    .filter(([k]) => k.includes("ip"))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join(" · ");

  async function streamOp(url: string) {
    setOpLog([]); setOpResult(null); setOpRunning(true);
    try {
      const resp = await fetch(url, { method: "POST" });
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === "log") setOpLog(prev => [...prev, d.line]);
            else if (d.type === "done") setOpResult({ success: true, outputs: d.outputs });
            else if (d.type === "error") setOpResult({ success: false, message: d.message });
          } catch {}
        }
      }
    } catch (e: any) {
      setOpResult({ success: false, message: String(e) });
    } finally {
      setOpRunning(false);
      onRefresh();
    }
  }

  const stopMut = useMutation({
    mutationFn: () => apiFetch(`/deployments/${dep.id}/stop`, { method: "POST" }),
    onSuccess: onRefresh,
  });
  const deleteMut = useMutation({
    mutationFn: () => apiFetch(`/deployments/${dep.id}`, { method: "DELETE" }),
    onSuccess: () => { onRefresh(); qc.invalidateQueries({ queryKey: ["deployments"] }); },
  });
  const statusMut = useMutation({
    mutationFn: () => apiFetch(`/deployments/${dep.id}/status`),
    onSuccess: onRefresh,
  });

  const canRedeploy = !["deploying","destroying","redeploying"].includes(dep.status);
  const canDestroy  = !["deploying","destroying","destroyed"].includes(dep.status);
  const canStop     = dep.status === "running";
  const canDelete   = ["destroyed","error"].includes(dep.status);

  return (
    <div className="card" style={{ marginBottom:8 }}>
      <div style={{ padding:"12px 16px", display:"flex", alignItems:"center", gap:12, cursor:"pointer" }}
        onClick={() => setExpanded(e => !e)}>
        {expanded ? <ChevronDown size={14} style={{ color:"var(--gray-400)", flexShrink:0 }} />
                  : <ChevronRight size={14} style={{ color:"var(--gray-400)", flexShrink:0 }} />}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
            <span style={{ fontWeight:700, fontSize:14 }}>{dep.app_name}</span>
            <StatusBadge status={dep.status} />
            <span style={{ fontSize:12, color:"var(--gray-500)" }}>→ {dep.tenant_name}</span>
            {dep.network_name && <span style={{ fontSize:11, color:"var(--gray-400)" }}>{dep.network_name}</span>}
          </div>
          {ips && <div style={{ fontSize:11, color:"var(--gray-500)", marginTop:3, fontFamily:"var(--font-mono)" }}>{ips}</div>}
          {dep.error_msg && <div style={{ fontSize:11, color:"var(--red)", marginTop:3 }}>{dep.error_msg}</div>}
        </div>
        <div style={{ fontSize:11, color:"var(--gray-400)", whiteSpace:"nowrap" }}>
          {new Date(dep.created_at).toLocaleDateString()}
        </div>
      </div>

      {expanded && (
        <div style={{ padding:"0 16px 14px", borderTop:"1px solid var(--gray-50)" }}>
          {/* Action buttons */}
          <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
            <button className="btn btn-secondary btn-sm"
              disabled={!canRedeploy || opRunning}
              onClick={() => streamOp(`/api/deployments/${dep.id}/redeploy`)}
              style={{ display:"flex", alignItems:"center", gap:4 }}>
              <Rocket size={12} /> Redeploy
            </button>
            <button className="btn btn-secondary btn-sm"
              disabled={!canStop || stopMut.isPending}
              onClick={() => stopMut.mutate()}
              style={{ display:"flex", alignItems:"center", gap:4 }}>
              ⏸ Stop VMs
            </button>
            <button className="btn btn-secondary btn-sm"
              disabled={opRunning}
              onClick={() => statusMut.mutate()}
              style={{ display:"flex", alignItems:"center", gap:4 }}>
              <RefreshCw size={12} /> Refresh Status
            </button>
            <button className="btn btn-secondary btn-sm"
              disabled={!canDestroy || opRunning}
              onClick={() => { if (window.confirm("Destroy all resources in this deployment?")) streamOp(`/api/deployments/${dep.id}/destroy`); }}
              style={{ display:"flex", alignItems:"center", gap:4, color:"var(--red)" }}>
              🗑 Destroy
            </button>
            {canDelete && (
              <button className="btn btn-secondary btn-sm"
                disabled={deleteMut.isPending}
                onClick={() => { if (window.confirm("Remove this deployment record?")) deleteMut.mutate(); }}
                style={{ display:"flex", alignItems:"center", gap:4, color:"var(--gray-400)" }}>
                <Trash2 size={12} /> Remove Record
              </button>
            )}
          </div>

          {/* Outputs */}
          {Object.keys(dep.outputs).length > 0 && (
            <div style={{ marginTop:12 }}>
              <div style={{ fontSize:12, fontWeight:600, color:"var(--gray-700)", marginBottom:4 }}>Outputs</div>
              {Object.entries(dep.outputs).map(([k, v]) => (
                <div key={k} style={{ fontSize:12, fontFamily:"var(--font-mono)", marginBottom:2 }}>
                  <span style={{ color:"var(--gray-500)" }}>{k}: </span>
                  {Array.isArray(v) ? v.join(", ") : String(v)}
                </div>
              ))}
            </div>
          )}

          {/* Terminal */}
          {(opLog.length > 0 || opRunning || opResult) && (
            <TerminalPanel lines={opLog} running={opRunning} result={opResult} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Deployments() {
  const { data: deps = [], isLoading, refetch } = useQuery<Deployment[]>({
    queryKey: ["deployments"],
    queryFn: () => apiFetch("/deployments/"),
    refetchInterval: (q) => {
      const active = (q.state.data ?? []).some(
        (d: Deployment) => ["deploying","redeploying","destroying"].includes(d.status)
      );
      return active ? 5000 : 30_000;
    },
  });

  const byStatus = {
    active:   deps.filter(d => d.status === "running").length,
    deploying: deps.filter(d => ["deploying","redeploying"].includes(d.status)).length,
    error:    deps.filter(d => d.status === "error").length,
    other:    deps.filter(d => ["stopped","destroyed","destroying"].includes(d.status)).length,
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0 }}>Deployments</h1>
          <p className="page-subtitle" style={{ margin:"4px 0 0" }}>
            All app deployments across tenants. Redeploy, stop, or destroy from here.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => refetch()}
          style={{ display:"flex", alignItems:"center", gap:5 }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Summary badges */}
      {deps.length > 0 && (
        <div style={{ display:"flex", gap:12, marginBottom:20, flexWrap:"wrap" }}>
          <SumBadge label="Running"   count={byStatus.active}    color="#166534" bg="#f0fdf4" />
          <SumBadge label="Deploying" count={byStatus.deploying}  color="#92400e" bg="#fffbeb" />
          <SumBadge label="Error"     count={byStatus.error}      color="#991b1b" bg="#fef2f2" />
          <SumBadge label="Other"     count={byStatus.other}      color="#374151" bg="#f9fafb" />
        </div>
      )}

      {isLoading && <p className="text-muted">Loading…</p>}

      {!isLoading && deps.length === 0 && (
        <div className="empty" style={{ padding:"64px 24px" }}>
          <Rocket size={40} style={{ color:"var(--gray-200)", marginBottom:16 }} />
          <div className="empty-title">No deployments yet</div>
          <div className="empty-body">
            Deploy an app from the App Catalog to see it here.
          </div>
        </div>
      )}

      {deps.map(dep => (
        <DeploymentRow key={dep.id} dep={dep} onRefresh={refetch} />
      ))}
    </div>
  );
}

function SumBadge({ label, count, color, bg }: { label: string; count: number; color: string; bg: string }) {
  if (count === 0) return null;
  return (
    <div style={{ padding:"6px 14px", borderRadius:8, background:bg, border:`1px solid ${color}33` }}>
      <span style={{ fontWeight:700, fontSize:18, color }}>{count}</span>
      <span style={{ fontSize:12, color, marginLeft:5 }}>{label}</span>
    </div>
  );
}
