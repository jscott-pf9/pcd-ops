import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Edit2, Globe, Layers, Rocket, Server, Shield, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";

interface SavedConfig {
  id: number; name: string; type: string; created_at: string; updated_at: string;
}
interface Deployment {
  id: string; app_name: string; tenant_name: string; network_name: string;
  status: string; outputs: Record<string, any>; error_msg: string | null;
  created_at: string;
}
interface AppProfile {
  name: string; description: string;
  networks?: { name: string; cidr: string }[];
  vm_profiles: { name: string; image: string; flavor: string; count: number; role: string }[];
  security_groups: { name: string; rules: any[] }[];
  load_balancer: { name: string; listeners?: { protocol: string; port: number; tls: boolean }[]; backend_profile: string } | null;
}
interface AppConfig extends SavedConfig { content: { params: AppProfile; hcl: string }; }
interface KeyPair { name: string; fingerprint: string; }
interface NetItem { name: string; id: string; external: boolean; project_id: string; shared: boolean; }
interface Tenant  { id: string; name: string; }

// ── Deploy modal ───────────────────────────────────────────────────────────────

function DeployModal({ profile, hcl, profileId, onClose, onDeployed }: {
  profile: AppProfile; hcl: string; profileId: number | null;
  onClose: () => void; onDeployed?: () => void;
}) {
  const [tenantId,          setTenantId]          = useState("");
  const [tenantName,        setTenantName]        = useState("");
  const [network,           setNetwork]           = useState("");
  const [externalNetwork,   setExternalNetwork]   = useState("");
  const [keyPair,           setKeyPair]           = useState("");
  const [tlsCertRef,        setTlsCertRef]        = useState("");
  const hasManagedNetworks = (profile.networks ?? []).length > 0;
  const hasTls = profile.load_balancer?.listeners?.some((l: any) => l.tls);
  const [copied,     setCopied]     = useState(false);
  const [deploying,  setDeploying]  = useState(false);
  const [deployLog,  setDeployLog]  = useState<string[]>([]);
  const [deployDone, setDeployDone] = useState<{ success: boolean; outputs?: any; message?: string } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const { data: allNetworks = [] } = useQuery<NetItem[]>({
    queryKey: ["generate", "networks"],
    queryFn: () => apiFetch("/generate/networks"),
    staleTime: 5 * 60_000,
  });
  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ["tenants"],
    queryFn: () => apiFetch("/inventory/tenants"),
    staleTime: 5 * 60_000,
  });
  const { data: keypairs = [] } = useQuery<KeyPair[]>({
    queryKey: ["inventory", "keypairs"],
    queryFn: () => apiFetch("/inventory/keypairs"),
    staleTime: 5 * 60_000,
  });

  // Filter networks to selected tenant + shared
  const availableNets = tenantId
    ? allNetworks.filter(n => !n.external && (n.project_id === tenantId || n.shared))
    : allNetworks.filter(n => !n.external);

  const tfvars = [
    tenantName       ? `tenant_name           = "${tenantName}"` : `# tenant_name           = "your-tenant"`,
    hasManagedNetworks
      ? (externalNetwork ? `external_network_name = "${externalNetwork}"` : `# external_network_name = "your-external-net"`)
      : (network         ? `network_name          = "${network}"`          : `# network_name          = "your-network"`),
    keyPair          ? `key_pair              = "${keyPair}"`    : `# key_pair              = "your-keypair"`,
    hasTls && tlsCertRef ? `tls_cert_ref          = "${tlsCertRef}"` : hasTls ? `# tls_cert_ref          = "https://barbican.../containers/..."` : null,
  ].filter(Boolean).join("\n");
  const fullHcl = `# terraform.tfvars\n${tfvars}\n\n# main.tf\n${hcl}`;

  function copy() {
    navigator.clipboard.writeText(fullHcl);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  async function runDeploy() {
    if (!tenantName || !network || !keyPair) return;
    setDeploying(true); setDeployLog([]); setDeployDone(null);

    try {
      const resp = await fetch("/api/generate/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hcl, tenant_name: tenantName,
          network_name: hasManagedNetworks ? "" : network,
          key_pair: keyPair, app_name: profile.name, profile_id: profileId,
          extra_vars: {
            ...(hasManagedNetworks && externalNetwork ? { external_network_name: externalNetwork } : {}),
            ...(hasTls && tlsCertRef ? { tls_cert_ref: tlsCertRef } : {}),
          },
        }),
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "log") {
              setDeployLog(prev => {
                const next = [...prev, data.line];
                setTimeout(() => logRef.current?.scrollTo({ top: 99999, behavior: "smooth" }), 10);
                return next;
              });
            } else if (data.type === "done") {
              setDeployDone({ success: true, outputs: data.outputs });
              onDeployed?.();
            } else if (data.type === "error") {
              setDeployDone({ success: false, message: data.message });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      setDeployDone({ success: false, message: String(e) });
    } finally {
      setDeploying(false);
    }
  }

  const networkOk = hasManagedNetworks ? !!externalNetwork : !!network;
  const canDeploy = !!tenantName && networkOk && !!keyPair && !deploying;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ background:"white", borderRadius:10, width:"min(95vw, 900px)", maxHeight:"90vh",
        overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,.25)" }}>

        {/* Header */}
        <div style={{ padding:"16px 24px", borderBottom:"1px solid var(--gray-100)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:700, fontSize:15 }}>Deploy: {profile.name}</div>
            <div style={{ fontSize:12, color:"var(--gray-500)", marginTop:2 }}>
              Select tenant, network, and key pair — image and cloud-init are baked in.
            </div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:"var(--gray-400)", padding:4 }}>×</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"270px 1fr", flex:1, overflow:"hidden" }}>
          {/* Left: params */}
          <div style={{ padding:"18px", borderRight:"1px solid var(--gray-100)", display:"flex", flexDirection:"column", gap:12, overflowY:"auto" }}>
            <div style={{ fontWeight:600, fontSize:11, color:"var(--gray-500)", textTransform:"uppercase", letterSpacing:".05em" }}>
              Deployment Parameters
            </div>

            <div className="form-group" style={{ marginBottom:0 }}>
              <label className="form-label">Target Tenant</label>
              <select className="form-select" value={tenantId} onChange={e => {
                const id = e.target.value;
                const t = tenants.find(t => t.id === id);
                setTenantId(id); setTenantName(t?.name ?? ""); setNetwork("");
              }}>
                <option value="">— select tenant —</option>
                {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            {hasManagedNetworks ? (
              <>
                <div className="form-group" style={{ marginBottom:0 }}>
                  <label className="form-label">Networks (will be created)</label>
                  <div style={{ padding:"8px 10px", background:"#eef2ff", borderRadius:6, fontSize:12, color:"#312e81" }}>
                    {(profile.networks ?? []).map(n => (
                      <div key={n.name} style={{ marginBottom:2 }}>🌐 <strong>{n.name}</strong> · {n.cidr}</div>
                    ))}
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom:0 }}>
                  <label className="form-label">External Network (for router gateway)</label>
                  <select className="form-select" value={externalNetwork} onChange={e => setExternalNetwork(e.target.value)}>
                    <option value="">— select external network —</option>
                    {allNetworks.filter(n => n.external).map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
                  </select>
                </div>
              </>
            ) : (
              <div className="form-group" style={{ marginBottom:0 }}>
                <label className="form-label">Target Network</label>
                <select className="form-select" value={network} onChange={e => setNetwork(e.target.value)} disabled={!tenantId}>
                  <option value="">{tenantId ? "— select network —" : "Select tenant first"}</option>
                  {availableNets.map(n => <option key={n.id} value={n.name}>{n.name}{n.shared ? " (shared)" : ""}</option>)}
                </select>
                {tenantId && availableNets.length === 0 && (
                  <div style={{ fontSize:11, color:"var(--gray-400)", marginTop:3 }}>No networks available for this tenant</div>
                )}
              </div>
            )}

            <div className="form-group" style={{ marginBottom:0 }}>
              <label className="form-label">Key Pair</label>
              {keypairs.length > 0 ? (
                <select className="form-select" value={keyPair} onChange={e => setKeyPair(e.target.value)}>
                  <option value="">— select key pair —</option>
                  {keypairs.map(kp => <option key={kp.name} value={kp.name}>{kp.name}</option>)}
                </select>
              ) : (
                <input className="form-input" placeholder="my-keypair" value={keyPair} onChange={e => setKeyPair(e.target.value)} />
              )}
            </div>

            {hasTls && (
              <div className="form-group" style={{ marginBottom:0 }}>
                <label className="form-label">TLS Certificate (Barbican URI)</label>
                <input className="form-input" placeholder="https://barbican.../containers/uuid"
                  value={tlsCertRef} onChange={e => setTlsCertRef(e.target.value)} />
                <div style={{ fontSize:10, color:"var(--gray-400)", marginTop:3 }}>
                  Required for TERMINATED_HTTPS listeners
                </div>
              </div>
            )}

            {/* Baked-in summary */}
            <div style={{ padding:"10px 12px", background:"var(--gray-50)", borderRadius:6, fontSize:12, color:"var(--gray-600)" }}>
              <div style={{ fontWeight:600, marginBottom:6 }}>Baked in:</div>
              {profile.vm_profiles.map(p => (
                <div key={p.name} style={{ marginBottom:2 }}>
                  <span style={{ fontWeight:500 }}>{p.count}× {p.name}</span>
                  <span style={{ color:"var(--gray-400)" }}> · {p.image}</span>
                </div>
              ))}
            </div>

            {/* Deploy button */}
            <button className="btn btn-primary" disabled={!canDeploy} onClick={runDeploy}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
              <Layers size={13} /> {deploying ? "Deploying…" : "Deploy Now"}
            </button>

            {!deploying && !deployDone && (
              <div style={{ fontSize:11, color:"var(--gray-400)", lineHeight:1.5 }}>
                Or copy the plan below and run <code style={{ fontFamily:"var(--font-mono)" }}>terraform apply</code> manually.
              </div>
            )}

            {deployDone && (
              <div style={{
                padding:"10px 12px", borderRadius:6, fontSize:12,
                background: deployDone.success ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${deployDone.success ? "#86efac" : "#fca5a5"}`,
                color: deployDone.success ? "#166534" : "#991b1b",
              }}>
                {deployDone.success ? "✓ Deployed successfully" : `✗ ${deployDone.message}`}
                {deployDone.success && deployDone.outputs && Object.keys(deployDone.outputs).length > 0 && (
                  <div style={{ marginTop:8 }}>
                    {Object.entries(deployDone.outputs).map(([k, v]) => (
                      <div key={k} style={{ marginTop:3 }}>
                        <span style={{ fontWeight:600 }}>{k}:</span>{" "}
                        {Array.isArray(v) ? v.join(", ") : String(v)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: terminal or HCL */}
          <div style={{ display:"flex", flexDirection:"column", overflow:"hidden" }}>
            <div style={{ padding:"8px 16px", borderBottom:"1px solid var(--gray-100)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color:"var(--gray-600)" }}>
                {deployLog.length > 0 ? "Deploy log" : "main.tf + terraform.tfvars"}
              </span>
              {deployLog.length === 0 && (
                <button className="btn btn-primary btn-sm" onClick={copy}
                  style={{ display:"flex", alignItems:"center", gap:4 }}>
                  <Copy size={12} /> {copied ? "Copied!" : "Copy All"}
                </button>
              )}
            </div>
            {deployLog.length > 0 ? (
              <pre ref={logRef} style={{
                flex:1, margin:0, padding:"12px 16px", overflow:"auto",
                fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.6,
                color:"#d1fae5", background:"#0f172a",
                whiteSpace:"pre-wrap", wordBreak:"break-all",
              }}>
                {deployLog.join("\n")}
                {deploying && <span style={{ opacity:0.6 }}>{"\n"}▌</span>}
              </pre>
            ) : (
              <pre style={{
                flex:1, margin:0, padding:"14px 16px", overflow:"auto",
                fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.6,
                color:"var(--gray-800)", background:"var(--gray-50)",
              }}>{fullHcl}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const DEP_STATUS: Record<string, { color: string; dot: string }> = {
  running:    { color:"#166534", dot:"🟢" },
  deploying:  { color:"#92400e", dot:"🟡" },
  redeploying:{ color:"#92400e", dot:"🟡" },
  destroying: { color:"#7f1d1d", dot:"🔴" },
  stopped:    { color:"#374151", dot:"⚫" },
  destroyed:  { color:"#374151", dot:"⚫" },
  error:      { color:"#991b1b", dot:"🔴" },
};

// ── App Profile card ───────────────────────────────────────────────────────────

function ProfileCard({ cfg, onDelete }: { cfg: SavedConfig; onDelete: () => void }) {
  const [deploying, setDeploying]       = useState(false);
  const [depsOpen,  setDepsOpen]        = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: detail } = useQuery<AppConfig>({
    queryKey: ["catalog", cfg.id],
    queryFn: () => apiFetch(`/generate/saved/${cfg.id}`),
    enabled: true,
  });

  const { data: deps = [], refetch: refetchDeps } = useQuery<Deployment[]>({
    queryKey: ["deployments", "profile", cfg.id],
    queryFn: () => apiFetch(`/deployments/?profile_id=${cfg.id}`),
    refetchInterval: (q) => {
      const active = (q.state.data ?? []).some(
        (d: Deployment) => ["deploying","redeploying","destroying"].includes(d.status)
      );
      return active ? 5000 : 60_000;
    },
  });

  const profile = detail?.content?.params;
  const hcl = detail?.content?.hcl ?? "";
  const totalVms = profile?.vm_profiles?.reduce((s, p) => s + p.count, 0) ?? "…";
  const sgCount  = profile?.security_groups?.length ?? "…";
  const hasLb    = !!profile?.load_balancer;

  const activeDeps = deps.filter(d => d.status !== "destroyed");

  return (
    <>
      {deploying && profile && hcl && (
        <DeployModal
          profile={profile} hcl={hcl} profileId={cfg.id}
          onClose={() => setDeploying(false)}
          onDeployed={() => { setDeploying(false); refetchDeps(); qc.invalidateQueries({ queryKey: ["deployments"] }); }}
        />
      )}
      <div className="card" style={{ display:"flex", flexDirection:"column" }}>
        {/* Header */}
        <div style={{ padding:"14px 16px", borderBottom:"1px solid var(--gray-100)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div style={{ fontWeight:700, fontSize:14 }}>{cfg.name}</div>
            <div style={{ display:"flex", gap:4 }}>
              <button onClick={() => navigate("/generate", { state: { loadProfile: detail?.content, profileId: cfg.id } })}
                title="Edit in App Builder"
                style={{ background:"none", border:"none", cursor:"pointer", color:"var(--gray-400)", padding:4 }}>
                <Edit2 size={13} />
              </button>
              <button onClick={onDelete} title="Delete"
                style={{ background:"none", border:"none", cursor:"pointer", color:"var(--gray-300)", padding:4 }}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {profile?.description && (
            <div style={{ fontSize:12, color:"var(--gray-500)", marginTop:3 }}>{profile.description}</div>
          )}
        </div>

        {/* Stats */}
        <div style={{ padding:"10px 16px", display:"flex", gap:16, borderBottom:"1px solid var(--gray-50)" }}>
          <Stat icon={<Server size={12} />} label={`${totalVms} VM${totalVms !== 1 ? "s" : ""}`} />
          <Stat icon={<Shield size={12} />} label={`${sgCount} SG${sgCount !== 1 ? "s" : ""}`} />
          <Stat icon={<Globe size={12} />} label={hasLb ? "Load Balanced" : "No LB"} dim={!hasLb} />
        </div>

        {/* VM profile chips */}
        {profile?.vm_profiles && (
          <div style={{ padding:"8px 16px", display:"flex", flexWrap:"wrap", gap:6, borderBottom:"1px solid var(--gray-50)" }}>
            {profile.vm_profiles.map(p => (
              <div key={p.name} style={{
                fontSize:11, padding:"3px 8px", borderRadius:99,
                background:"var(--gray-50)", color:"var(--gray-700)", border:"1px solid var(--gray-100)",
              }}>
                <span style={{ fontWeight:600 }}>{p.count}× {p.name}</span>
                <span style={{ color:"var(--gray-400)", marginLeft:4 }}>{p.image}</span>
              </div>
            ))}
          </div>
        )}

        {/* Deployments section */}
        <div style={{ padding:"0" }}>
          <button onClick={() => setDepsOpen(o => !o)}
            style={{
              width:"100%", textAlign:"left", padding:"8px 16px", background:"none",
              border:"none", cursor:"pointer", display:"flex", alignItems:"center", gap:6,
              fontSize:12, fontWeight:600, color:"var(--gray-600)",
              borderBottom: depsOpen ? "1px solid var(--gray-50)" : "none",
            }}>
            {depsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Deployments
            {activeDeps.length > 0 && (
              <span style={{ marginLeft:4, background:"var(--blue-primary)", color:"white",
                borderRadius:99, fontSize:10, padding:"1px 6px" }}>
                {activeDeps.length}
              </span>
            )}
          </button>

          {depsOpen && (
            <div style={{ padding:"0 16px 10px" }}>
              {deps.length === 0 && (
                <p style={{ fontSize:12, color:"var(--gray-400)", margin:"8px 0" }}>
                  No deployments yet.
                </p>
              )}
              {deps.map(dep => {
                const sc = DEP_STATUS[dep.status] ?? DEP_STATUS.error;
                const ips = Object.entries(dep.outputs)
                  .filter(([k]) => k.includes("ip"))
                  .map(([, v]) => Array.isArray(v) ? v.join(", ") : String(v))
                  .join(", ");
                return (
                  <div key={dep.id} style={{
                    padding:"7px 10px", borderRadius:6, marginBottom:4,
                    background:"var(--gray-50)", border:"1px solid var(--gray-100)",
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                  }}>
                    <div>
                      <span style={{ fontSize:12, fontWeight:500, color: sc.color }}>
                        {sc.dot} {dep.tenant_name}
                      </span>
                      {dep.network_name && (
                        <span style={{ fontSize:11, color:"var(--gray-400)", marginLeft:8 }}>
                          {dep.network_name}
                        </span>
                      )}
                      {ips && (
                        <div style={{ fontSize:10, color:"var(--gray-500)", fontFamily:"var(--font-mono)", marginTop:2 }}>
                          {ips}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize:10, color:"var(--gray-400)" }}>
                      {new Date(dep.created_at).toLocaleDateString()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:"10px 16px", marginTop:"auto", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:11, color:"var(--gray-400)" }}>
            {new Date(cfg.updated_at).toLocaleDateString()}
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => setDeploying(true)}
            style={{ display:"flex", alignItems:"center", gap:5 }}>
            <Rocket size={12} /> Deploy
          </button>
        </div>
      </div>
    </>
  );
}

function Stat({ icon, label, dim }: { icon: React.ReactNode; label: string; dim?: boolean }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:4, fontSize:12, color: dim ? "var(--gray-300)" : "var(--gray-600)" }}>
      {icon} {label}
    </div>
  );
}

// ── App Catalog page ───────────────────────────────────────────────────────────

export default function AppCatalog() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: allSaved = [], isLoading } = useQuery<SavedConfig[]>({
    queryKey: ["generate", "saved"],
    queryFn: () => apiFetch("/generate/saved"),
  });

  const profiles = allSaved.filter(c => c.type === "app-profile");

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/generate/saved/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["generate", "saved"] }),
  });

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0 }}>App Catalog</h1>
          <p className="page-subtitle" style={{ margin:"4px 0 0" }}>
            Reusable multi-tier application templates. Deploy to any tenant and network.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate("/generate")}
          style={{ display:"flex", alignItems:"center", gap:6 }}>
          <Layers size={14} /> New App
        </button>
      </div>

      {isLoading && <p className="text-muted">Loading…</p>}

      {!isLoading && profiles.length === 0 && (
        <div className="empty" style={{ padding:"64px 24px" }}>
          <Layers size={40} style={{ color:"var(--gray-200)", marginBottom:16 }} />
          <div className="empty-title">No app profiles yet</div>
          <div className="empty-body">Build a multi-tier application in the App Builder and save it as a profile.</div>
          <button className="btn btn-primary" onClick={() => navigate("/generate")}
            style={{ marginTop:16, display:"inline-flex", alignItems:"center", gap:6 }}>
            <Layers size={13} /> Open App Builder
          </button>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(320px, 1fr))", gap:"1rem" }}>
        {profiles.map(cfg => (
          <ProfileCard key={cfg.id} cfg={cfg} onDelete={() => deleteMut.mutate(cfg.id)} />
        ))}
      </div>
    </div>
  );
}
