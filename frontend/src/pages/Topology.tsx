import { useCallback, useEffect, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";
import DataFreshness from "../components/DataFreshness";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TopoNode { id: string; type: string; data: Record<string, any>; }
interface TopoEdge { id: string; source: string; target: string; type: string; }
interface Topology  { nodes: TopoNode[]; edges: TopoEdge[]; }

// ── Status color helpers ───────────────────────────────────────────────────────

function statusColor(status: string | undefined): string {
  switch ((status || "").toUpperCase()) {
    case "ACTIVE": case "UP": case "ENABLED": return "var(--green)";
    case "SHUTOFF": case "STOPPED":           return "var(--gray-400)";
    case "ERROR":                              return "var(--red)";
    case "BUILD": case "ACTIVE":              return "var(--blue-primary)";
    default:                                  return "var(--gray-300)";
  }
}

// ── Custom node components ─────────────────────────────────────────────────────

const NODE_W = 180;

function BaseNode({ emoji, title, subtitle, status, selected, orphan }: {
  emoji: string; title: string; subtitle?: string; status?: string; selected?: boolean; orphan?: string;
}) {
  const color = statusColor(status);
  const isStoppedOrphan    = orphan === "stopped";
  const isUnattachedOrphan = orphan === "unattached";
  const borderColor = selected ? "var(--blue-primary)"
    : isUnattachedOrphan ? "var(--yellow)"
    : color;
  return (
    <div style={{
      background: isUnattachedOrphan ? "var(--yellow-light)" : "#fff",
      border: `${isStoppedOrphan ? "2px dashed" : "2px solid"} ${borderColor}`,
      borderRadius: 8,
      padding: "8px 12px",
      width: NODE_W,
      opacity: isStoppedOrphan ? 0.7 : 1,
      boxShadow: selected ? "0 0 0 3px rgba(0,137,199,.2)" : "0 1px 4px rgba(0,0,0,.08)",
      fontSize: 12,
      fontFamily: "var(--font)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 16 }}>{emoji}</span>
        <span style={{ fontWeight: 600, color: "var(--gray-900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <span style={{ marginLeft: "auto", width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
      </div>
      {subtitle && <div style={{ color: "var(--gray-500)", fontSize: 11 }}>{subtitle}</div>}
    </div>
  );
}

function HypervisorNode({ data, selected }: any) {
  return (
    <>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <BaseNode emoji="🖥" title={data.hostname} subtitle={data.host_ip}
        status={data.state === "up" ? "UP" : "DOWN"} selected={selected} />
    </>
  );
}

function VMNode({ data, selected }: any) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <BaseNode emoji="⚙" title={data.name} subtitle={`${data.flavor_name || "—"} · ${data.flavor_vcpus || 0}v`}
        status={data.status} selected={selected} orphan={data._orphan} />
    </>
  );
}

function VolumeNode({ data, selected }: any) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <BaseNode emoji="💾" title={data.name || "(unnamed)"} subtitle={`${data.size_gb || data.size || "?"} GB`}
        status={data.status} selected={selected} orphan={data._orphan} />
    </>
  );
}

function NetworkNode({ data, selected }: any) {
  return (
    <>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <BaseNode emoji="🌐" title={data.name} subtitle={data.external ? "External" : "Internal"}
        status={data.status} selected={selected} />
    </>
  );
}

const NODE_TYPES = { hypervisor: HypervisorNode, vm: VMNode, volume: VolumeNode, network: NetworkNode };

// ── Layout helpers ─────────────────────────────────────────────────────────────

const COLS_PER_HYP = 6;   // max VMs per row under each hypervisor
const H_GAP = 200, V_GAP = 130;

function autoLayout(apiNodes: TopoNode[], apiEdges: TopoEdge[], tenantFilter: string) {
  // Filter VMs by tenant
  let filteredVMs = apiNodes.filter(n => n.type === "vm");
  if (tenantFilter) filteredVMs = filteredVMs.filter(n => n.data.project_id === tenantFilter);
  const vmIds = new Set(filteredVMs.map(n => n.id));

  const hyps = apiNodes.filter(n => n.type === "hypervisor");
  const vols = apiNodes.filter(n => n.type === "volume" &&
    apiEdges.some(e => e.type === "attached" && e.target === n.id && vmIds.has(e.source)));
  // Only show tenant networks when filtering; show all when unfiltered (limit to 8)
  const nets = tenantFilter
    ? apiNodes.filter(n => n.type === "network" && n.data.project_id === tenantFilter)
    : apiNodes.filter(n => n.type === "network").slice(0, 8);

  // Per-hypervisor VM lists
  const hypVMs: Record<string, string[]> = {};
  for (const e of apiEdges) {
    if (e.type === "hosts" && vmIds.has(e.target)) {
      hypVMs[e.source] = hypVMs[e.source] || [];
      hypVMs[e.source].push(e.target);
    }
  }

  const rfNodes: any[] = [];
  const rfEdges: any[] = [];

  // Calculate per-hypervisor column widths (VMs wrap into rows of COLS_PER_HYP)
  let xCursor = 0;
  const hypLayout: Record<string, { x: number; width: number; rows: number }> = {};
  for (const h of hyps) {
    const vms = hypVMs[h.id] || [];
    const cols = Math.min(vms.length || 1, COLS_PER_HYP);
    const width = cols * H_GAP;
    const rows = Math.ceil(vms.length / COLS_PER_HYP);
    hypLayout[h.id] = { x: xCursor + width / 2 - H_GAP / 2, width, rows };
    xCursor += width + H_GAP * 0.5;
  }

  // Row 0: Hypervisors
  for (const h of hyps) {
    const l = hypLayout[h.id];
    rfNodes.push({ id: h.id, type: "hypervisor", data: h.data, position: { x: l.x, y: 0 } });
  }

  // Rows 1+: VMs under each hypervisor, wrapped
  const vmPositioned = new Set<string>();
  let maxVMBottom = 0;
  for (const h of hyps) {
    const vms = hypVMs[h.id] || [];
    const l = hypLayout[h.id];
    const cols = Math.min(vms.length || 1, COLS_PER_HYP);
    vms.forEach((vmId, idx) => {
      const vm = filteredVMs.find(n => n.id === vmId);
      if (!vm) return;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const y = V_GAP + row * V_GAP;
      rfNodes.push({ id: vm.id, type: "vm", data: vm.data, position: { x: l.x - (cols - 1) * H_GAP / 2 + col * H_GAP, y } });
      vmPositioned.add(vmId);
      maxVMBottom = Math.max(maxVMBottom, y);
    });
  }
  // Orphan VMs
  filteredVMs.filter(v => !vmPositioned.has(v.id)).forEach((vm, i) => {
    rfNodes.push({ id: vm.id, type: "vm", data: vm.data, position: { x: i * H_GAP, y: maxVMBottom + V_GAP } });
    maxVMBottom = Math.max(maxVMBottom, maxVMBottom + V_GAP);
  });

  // Volumes below VMs
  const volY = maxVMBottom + V_GAP;
  vols.forEach((v, i) => {
    rfNodes.push({ id: v.id, type: "volume", data: v.data, position: { x: i * H_GAP, y: volY } });
  });

  // Networks — right column
  const netX = xCursor + H_GAP * 0.5;
  nets.forEach((n, i) => {
    rfNodes.push({ id: n.id, type: "network", data: n.data, position: { x: netX, y: i * V_GAP * 0.9 } });
  });

  // Edges — only between visible nodes
  const nodeIds = new Set(rfNodes.map(n => n.id));
  for (const e of apiEdges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const edgeStyle =
      e.type === "hosts"    ? { stroke: "var(--blue-primary)", strokeWidth: 2 } :
      e.type === "attached" ? { stroke: "var(--yellow)",       strokeWidth: 1.5, strokeDasharray: "4 2" } :
                              { stroke: "var(--gray-200)",      strokeWidth: 1,   strokeDasharray: "3 3" };
    rfEdges.push({ id: e.id, source: e.source, target: e.target, style: edgeStyle,
      animated: e.type === "hosts", type: "straight" });
  }

  return { rfNodes, rfEdges };
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Topology() {
  return (
    <div style={{ height: "calc(100vh - 80px)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Topology</h1>
        <DataFreshness domainKey="inventory:summary" />
      </div>
      <div style={{ flex: 1, borderRadius: 8, overflow: "hidden", border: "1px solid var(--gray-200)" }}>
        <TopologyGraph />
      </div>
    </div>
  );
}

function TopologyGraph() {
  const tenants = useTenants();
  const [tenantFilter, setTenantFilter] = useState("");
  const [showOrphans, setShowOrphans] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);

  const { data: topo } = useQuery<Topology>({
    queryKey: ["topology"],
    queryFn: () => apiFetch("/inventory/topology"),
  });

  // Reclamation data for orphan overlay
  const { data: reclamation } = useQuery<any>({
    queryKey: ["reclamation", "candidates"],
    queryFn: () => apiFetch("/reclamation/candidates"),
  });

  const orphanVmIds = new Set<string>(
    (reclamation?.stopped_servers ?? []).map((s: any) => s.id)
  );
  const orphanVolIds = new Set<string>(
    (reclamation?.unattached_volumes ?? []).map((v: any) => v.id)
  );

  useEffect(() => {
    if (!topo) return;
    const { rfNodes, rfEdges } = autoLayout(topo.nodes, topo.edges, tenantFilter);
    // Apply orphan overlays
    if (showOrphans) {
      rfNodes.forEach((node: any) => {
        if (node.type === "vm" && orphanVmIds.has(node.data?.id)) {
          node.data = { ...node.data, _orphan: "stopped" };
        }
        if (node.type === "volume" && orphanVolIds.has(node.data?.id)) {
          node.data = { ...node.data, _orphan: "unattached" };
        }
      });
    }
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [topo, tenantFilter, showOrphans, reclamation]);

  const onNodeClick = useCallback((_: any, node: any) => setSelected(node), []);
  const onPaneClick = useCallback(() => setSelected(null), []);

  const tenantList = Array.from(tenants.entries())
    .filter(([, name]) => !["admin","service"].includes(name.toLowerCase()))
    .sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Filter bar */}
      <div style={{
        position: "absolute", top: 12, left: 12, zIndex: 10,
        display: "flex", gap: 8, alignItems: "center",
        background: "#fff", padding: "6px 10px", borderRadius: 6,
        border: "1px solid var(--gray-200)", boxShadow: "var(--shadow-sm)",
      }}>
        <span style={{ fontSize: 12, color: "var(--gray-500)", fontWeight: 600 }}>Tenant</span>
        <select className="form-select" value={tenantFilter}
          onChange={e => setTenantFilter(e.target.value)}
          style={{ fontSize: 12, padding: "3px 8px", height: "auto", width: "auto" }}>
          <option value="">All tenants</option>
          {tenantList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>

        <div style={{ width: 1, height: 18, background: "var(--gray-200)" }} />

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer", color: "var(--gray-600)" }}>
          <input type="checkbox" checked={showOrphans} onChange={e => setShowOrphans(e.target.checked)} />
          Highlight orphans
        </label>
        {showOrphans && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--gray-500)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ width: 10, height: 10, border: "2px dashed var(--gray-400)", borderRadius: 3 }} /> Stopped VM
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ width: 10, height: 10, background: "var(--yellow-light)", border: "1.5px solid var(--yellow)", borderRadius: 3 }} /> Unattached vol
            </span>
          </div>
        )}

        {/* Legend */}
        <div style={{ display: "flex", gap: 10, marginLeft: 8, borderLeft: "1px solid var(--gray-200)", paddingLeft: 10 }}>
          {[
            { color: "var(--blue-primary)", label: "Hosts" },
            { color: "var(--yellow)", label: "Attached", dash: true },
            { color: "var(--gray-300)", label: "Network", dash: true },
          ].map(l => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--gray-600)" }}>
              <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke={l.color}
                strokeWidth="2" strokeDasharray={l.dash ? "4 2" : undefined} /></svg>
              {l.label}
            </div>
          ))}
        </div>
      </div>

      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick} onPaneClick={onPaneClick}
        nodeTypes={NODE_TYPES}
        fitView fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2} maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--gray-200)" gap={20} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === "hypervisor") return "var(--blue-primary)";
            if (n.type === "vm") return statusColor((n.data as any)?.status);
            if (n.type === "volume") return "var(--yellow)";
            return "var(--gray-300)";
          }}
          style={{ border: "1px solid var(--gray-200)", borderRadius: 6 }}
        />
      </ReactFlow>

      {/* Detail panel */}
      {selected && (
        <DetailPanel node={selected} tenants={tenants} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function DetailPanel({ node, tenants, onClose }: { node: any; tenants: Map<string,string>; onClose: () => void }) {
  const d = node.data;
  const tenantName = d.project_id ? (tenants.get(d.project_id) ?? d.project_id.slice(0,8)) : null;

  const rows: [string, string][] = [];
  if (node.type === "hypervisor") {
    rows.push(["Host IP", d.host_ip], ["State", d.state], ["Status", d.status]);
    if (d.vcpus_total) rows.push(["vCPUs", `${d.vcpus_used ?? "?"}/${d.vcpus_total}`]);
  } else if (node.type === "vm") {
    rows.push(["Status", d.status], ["Flavor", d.flavor_name || "—"],
      ["vCPUs", String(d.flavor_vcpus ?? "—")], ["RAM", d.flavor_ram_mb ? `${Math.round(d.flavor_ram_mb/1024)} GB` : "—"]);
    if (tenantName) rows.push(["Tenant", tenantName]);
    if (d.ips?.length) rows.push(["IPs", d.ips.join(", ")]);
  } else if (node.type === "volume") {
    rows.push(["Size", `${d.size_gb || d.size || "?"} GB`], ["Status", d.status],
      ["Type", d.volume_type || "—"]);
    if (tenantName) rows.push(["Tenant", tenantName]);
  } else if (node.type === "network") {
    rows.push(["Status", d.status], ["External", d.external ? "Yes" : "No"],
      ["Shared", d.shared ? "Yes" : "No"]);
  }

  const typeLabel = node.type.charAt(0).toUpperCase() + node.type.slice(1);
  const title = d.name || d.hostname || d.id;

  return (
    <div style={{
      position: "absolute", top: 12, right: 12, zIndex: 10,
      background: "#fff", border: "1px solid var(--gray-200)",
      borderRadius: 8, width: 240, boxShadow: "var(--shadow-md)",
      fontSize: 12,
    }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--gray-100)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 600, color: "var(--gray-900)" }}>{title}</div>
          <div style={{ color: "var(--gray-500)", fontSize: 11 }}>{typeLabel}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gray-400)", fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ padding: "10px 12px" }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
            <span style={{ color: "var(--gray-500)" }}>{k}</span>
            <span style={{ color: "var(--gray-900)", fontWeight: 500, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
