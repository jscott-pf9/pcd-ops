import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Copy, Layers, Plus, Shield, Sparkles, Trash2, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Flavor    { name: string; vcpus: number; ram_mb: number; disk_gb: number; }
interface ImageItem { name: string; id: string; }
interface KeyPair   { name: string; fingerprint: string; type: string; }
interface SavedItem { id: number; name: string; type: string; updated_at: string; }

interface VmProfile {
  name: string;
  image_name: string;
  flavor_name: string;
  count: number;
  role: string;
  role_id: number | null;
  cloud_init_yaml: string;
  security_groups: string[];
  network_name: string;     // which AppNetwork this tier attaches to
}
interface SgRule    { direction: string; protocol: string; port_min: number|""; port_max: number|""; cidr: string; }
interface SgDef     { name: string; description: string; rules: SgRule[]; }
interface LbListener { protocol: "HTTP" | "HTTPS" | "TCP"; port: number; tls: boolean; }
interface LbDef     { name: string; backend_profile: string; health_monitor: string; listeners: LbListener[]; }
interface AppNetwork { name: string; cidr: string; dns: string; }

// ── Shared query hooks & helpers ───────────────────────────────────────────────

function useSavedList() {
  return useQuery<SavedItem[]>({
    queryKey: ["generate", "saved"],
    queryFn: () => apiFetch("/generate/saved"),
    staleTime: 30_000,
  });
}

interface NetItem { name: string; id: string; external: boolean; }

function useInventory() {
  const { data: allFlavors = [] } = useQuery<Flavor[]>({
    queryKey: ["generate", "flavors"],
    queryFn: () => apiFetch("/generate/flavors"),
    staleTime: 5 * 60_000,
  });
  const { data: images = [] } = useQuery<ImageItem[]>({
    queryKey: ["generate", "images"],
    queryFn: () => apiFetch("/generate/images"),
    staleTime: 5 * 60_000,
  });
  const { data: keypairs = [] } = useQuery<KeyPair[]>({
    queryKey: ["inventory", "keypairs"],
    queryFn: () => apiFetch("/inventory/keypairs"),
    staleTime: 5 * 60_000,
  });
  const { data: pcdNetworks = [] } = useQuery<NetItem[]>({
    queryKey: ["generate", "networks"],
    queryFn: () => apiFetch("/generate/networks"),
    staleTime: 5 * 60_000,
  });
  const flavors = allFlavors.filter(f => f.disk_gb === 0 || f.disk_gb === -1);
  return { flavors, images, keypairs, pcdNetworks };
}

function FormField({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="form-label">{label}{required && <span style={{ color: "var(--red)" }}> *</span>}</label>
      {children}
    </div>
  );
}


const SG_PRESETS: { label: string; rules: SgRule[] }[] = [
  { label: "Web",  rules: [
    { direction:"ingress", protocol:"tcp", port_min:80,   port_max:80,   cidr:"0.0.0.0/0" },
    { direction:"ingress", protocol:"tcp", port_min:443,  port_max:443,  cidr:"0.0.0.0/0" },
  ]},
  { label: "SSH",  rules: [{ direction:"ingress", protocol:"tcp", port_min:22, port_max:22, cidr:"0.0.0.0/0" }] },
  { label: "Database", rules: [
    { direction:"ingress", protocol:"tcp", port_min:5432, port_max:5432, cidr:"10.0.0.0/8" },
    { direction:"ingress", protocol:"tcp", port_min:3306, port_max:3306, cidr:"10.0.0.0/8" },
  ]},
];

// ── Rule row component (reused in AppBuilder and SGLibrary) ────────────────────

function RuleRow({ r, onChange, onRemove }: {
  r: SgRule;
  onChange: (k: keyof SgRule, v: any) => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 75px 75px 1fr auto", gap:4, marginBottom:4, alignItems:"end" }}>
      <select className="form-select" style={{ fontSize:11 }} value={r.direction} onChange={e => onChange("direction", e.target.value)}>
        <option value="ingress">Ingress</option><option value="egress">Egress</option>
      </select>
      <select className="form-select" style={{ fontSize:11 }} value={r.protocol} onChange={e => onChange("protocol", e.target.value)}>
        <option value="tcp">TCP</option><option value="udp">UDP</option>
        <option value="icmp">ICMP</option><option value="">Any</option>
      </select>
      <input className="form-input" style={{ fontSize:11 }} placeholder="From" type="number" value={r.port_min}
        onChange={e => onChange("port_min", e.target.value === "" ? "" : Number(e.target.value))} />
      <input className="form-input" style={{ fontSize:11 }} placeholder="To" type="number" value={r.port_max}
        onChange={e => onChange("port_max", e.target.value === "" ? "" : Number(e.target.value))} />
      <input className="form-input" style={{ fontSize:11 }} placeholder="CIDR" value={r.cidr}
        onChange={e => onChange("cidr", e.target.value)} />
      <button onClick={onRemove} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--gray-300)", padding:4 }}>
        <X size={12} />
      </button>
    </div>
  );
}

// ── Page shell (holds lifted App Builder state) ────────────────────────────────

type TabType = "app-builder" | "roles" | "security-groups";

const DEFAULT_LB: LbDef = {
  name: "app-lb", backend_profile: "", health_monitor: "HTTP",
  listeners: [
    { protocol: "HTTP",  port: 80,  tls: false },
    { protocol: "HTTPS", port: 443, tls: true  },
  ],
};
const DEFAULT_NETWORK: AppNetwork = { name: "app-net", cidr: "192.168.10.0/24", dns: "8.8.8.8, 8.8.4.4" };

export default function Generate() {
  const location = useLocation();
  const lp = (location.state as any)?.loadProfile ?? null;
  const editProfileId: number | null = (location.state as any)?.profileId ?? null;
  const [tab, setTab] = useState<TabType>("app-builder");

  // Lifted state — survives tab switches
  const [appName,     setAppName]     = useState<string>(lp?.params?.name ?? "");
  const [description, setDescription] = useState<string>(lp?.params?.description ?? "");
  const [keyPair,     setKeyPair]     = useState<string>(lp?.params?.key_pair ?? "");
  const [vmProfiles,  setVmProfiles]  = useState<VmProfile[]>(
    lp?.params?.vm_profiles?.map((p: any) => ({
      name: p.name, image_name: p.image ?? "", flavor_name: p.flavor ?? "",
      count: p.count ?? 1, role: p.role ?? "", role_id: null,
      cloud_init_yaml: p.cloud_init_yaml ?? "",
      security_groups: p.security_groups ?? [], network_name: p.network_name ?? "",
    })) ?? [{ name:"web", image_name:"", flavor_name:"", count:2, role:"", role_id:null, cloud_init_yaml:"", security_groups:[], network_name:"" }]
  );
  const [sgs, setSgs] = useState<SgDef[]>(
    lp?.params?.security_groups?.map((sg: any) => ({
      name: sg.name, description: sg.description ?? "", rules: sg.rules ?? [],
    })) ?? []
  );
  const [networks,  setNetworks]  = useState<AppNetwork[]>(
    lp?.params?.networks?.map((n: any) => ({ name: n.name, cidr: n.cidr, dns: Array.isArray(n.dns) ? n.dns.join(", ") : n.dns ?? "" })) ?? [{ ...DEFAULT_NETWORK }]
  );
  const [lbEnabled, setLbEnabled] = useState<boolean>(!!lp?.params?.load_balancer);
  const [lb,        setLb]        = useState<LbDef>(lp?.params?.load_balancer ?? { ...DEFAULT_LB });
  const [hcl,       setHcl]       = useState<string>(lp?.hcl ?? "");

  const TABS: { id: TabType; label: string }[] = [
    { id: "app-builder",     label: "🏗 App Builder" },
    { id: "roles",           label: "Roles" },
    { id: "security-groups", label: "Security Groups" },
  ];

  return (
    <div>
      <h1>App Builder</h1>
      <p className="page-subtitle">Design a complete multi-tier application and save it to the App Catalog.</p>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Always mounted — display:none preserves state when switching tabs */}
      <div style={{ display: tab === "app-builder" ? "block" : "none" }}>
        <AppBuilder
          appName={appName} setAppName={setAppName}
          description={description} setDescription={setDescription}
          keyPair={keyPair} setKeyPair={setKeyPair}
          editProfileId={editProfileId}
          networks={networks} setNetworks={setNetworks}
          vmProfiles={vmProfiles} setVmProfiles={setVmProfiles}
          sgs={sgs} setSgs={setSgs}
          lbEnabled={lbEnabled} setLbEnabled={setLbEnabled}
          lb={lb} setLb={setLb}
          hcl={hcl} setHcl={setHcl}
          onSwitchToRoles={() => setTab("roles")}
          onSwitchToSGs={() => setTab("security-groups")}
        />
      </div>
      <div style={{ display: tab === "roles" ? "block" : "none" }}>
        <RolesLibrary />
      </div>
      <div style={{ display: tab === "security-groups" ? "block" : "none" }}>
        <SGLibrary />
      </div>
    </div>
  );
}

// ── App Builder ────────────────────────────────────────────────────────────────

interface AppBuilderProps {
  editProfileId: number | null;
  appName: string; setAppName: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  keyPair: string; setKeyPair: (v: string) => void;
  networks: AppNetwork[]; setNetworks: (v: AppNetwork[]) => void;
  vmProfiles: VmProfile[]; setVmProfiles: React.Dispatch<React.SetStateAction<VmProfile[]>>;
  sgs: SgDef[]; setSgs: (v: SgDef[]) => void;
  lbEnabled: boolean; setLbEnabled: (v: boolean) => void;
  lb: LbDef; setLb: (v: LbDef) => void;
  hcl: string; setHcl: (v: string) => void;
  onSwitchToRoles: () => void;
  onSwitchToSGs: () => void;
}

function AppBuilder(props: AppBuilderProps) {
  const { editProfileId, appName, setAppName, description, setDescription, keyPair, setKeyPair,
          networks, setNetworks, vmProfiles, setVmProfiles, sgs, setSgs,
          lbEnabled, setLbEnabled, lb, setLb, hcl, setHcl,
          onSwitchToRoles, onSwitchToSGs } = props;

  // Network helpers
  const addNet    = () => setNetworks([...networks, { name:"", cidr:"192.168.10.0/24", dns:"8.8.8.8" }]);
  const removeNet = (i: number) => setNetworks(networks.filter((_, idx) => idx !== i));
  const setNet    = (i: number, k: keyof AppNetwork, v: string) =>
    setNetworks(networks.map((n, idx) => idx === i ? { ...n, [k]: v } : n));

  // Listener helpers
  const addListener    = () => setLb({ ...lb, listeners: [...lb.listeners, { protocol:"HTTP", port:80, tls:false }] });
  const removeListener = (i: number) => setLb({ ...lb, listeners: lb.listeners.filter((_, idx) => idx !== i) });
  const setListener    = (i: number, updates: Partial<LbListener>) =>
    setLb({ ...lb, listeners: lb.listeners.map((l, idx) => idx === i ? { ...l, ...updates } : l) });

  const navigate = useNavigate();
  const qc = useQueryClient();
  const { flavors, images, keypairs, pcdNetworks } = useInventory();
  const providerNets = pcdNetworks.filter(n => n.external);
  const internalPcdNets = pcdNetworks.filter(n => !n.external);
  const { data: allSaved = [] } = useSavedList();
  const savedRoles = allSaved.filter(s => s.type === "role");
  const savedSgTemplates = allSaved.filter(s => s.type === "sg-template");

  const [outputTab, setOutputTab] = useState<"diagram" | "hcl">("diagram");
  const [saveError, setSaveError] = useState(false);
  const [nlDesc,    setNlDesc]    = useState("");
  const hclFileRef = useRef<HTMLInputElement>(null);

  // VM helpers
  const setVm = (i: number, updates: Partial<VmProfile>) =>
    setVmProfiles((prev: VmProfile[]) => prev.map((p: VmProfile, idx: number) => idx === i ? { ...p, ...updates } : p));
  const addVm    = () => setVmProfiles([...vmProfiles, { name:"", image_name:"", flavor_name:"", count:1, role:"", role_id:null, cloud_init_yaml:"", security_groups:[], network_name:"" }]);
  const removeVm = (i: number) => setVmProfiles(vmProfiles.filter((_, idx) => idx !== i));

  const handleRoleSelect = async (profileIdx: number, roleId: number, roleName: string) => {
    setVm(profileIdx, { role: roleName, role_id: roleId, cloud_init_yaml: "" });
    if (roleId > 0) {
      try {
        const detail = await apiFetch<{ name: string; content: { yaml?: string } }>(`/generate/saved/${roleId}`);
        setVm(profileIdx, { cloud_init_yaml: detail.content?.yaml ?? "" });
      } catch { /* non-fatal */ }
    }
  };

  // SG helpers
  const addSg    = () => setSgs([...sgs, { name:"", description:"", rules:[] }]);
  const removeSg = (i: number) => setSgs(sgs.filter((_, idx) => idx !== i));
  const setSg    = (i: number, k: keyof SgDef, v: any) =>
    setSgs(sgs.map((sg, idx) => idx === i ? { ...sg, [k]: v } : sg));
  const addRule  = (i: number) =>
    setSgs(sgs.map((sg, idx) => idx !== i ? sg : {
      ...sg, rules: [...sg.rules, { direction:"ingress", protocol:"tcp", port_min:"", port_max:"", cidr:"0.0.0.0/0" }],
    }));
  const setRule  = (si: number, ri: number, k: keyof SgRule, v: any) =>
    setSgs(sgs.map((sg, idx) => idx !== si ? sg : {
      ...sg, rules: sg.rules.map((r, rIdx) => rIdx !== ri ? r : { ...r, [k]: v }),
    }));
  const removeRule = (si: number, ri: number) =>
    setSgs(sgs.map((sg, idx) => idx !== si ? sg : { ...sg, rules: sg.rules.filter((_, rIdx) => rIdx !== ri) }));

  const addSgFromTemplate = async (templateId: number) => {
    try {
      const detail = await apiFetch<{ name: string; content: { description?: string; rules: SgRule[] } }>(`/generate/saved/${templateId}`);
      setSgs([...sgs, { name: detail.name, description: detail.content?.description ?? "", rules: detail.content?.rules ?? [] }]);
    } catch { /* non-fatal */ }
  };

  // NL → populate form (AI)
  const nlMut = useMutation({
    mutationFn: () => apiFetch<any>("/generate/app-profile-from-description", {
      method: "POST", body: JSON.stringify({ description: nlDesc }),
    }),
    onError: (err: any) => {
      console.error("NL fill error:", err);
    },
    onSuccess: (d) => {
      if (d.name) setAppName(d.name);
      if (d.description) setDescription(d.description);
      if (d.networks?.length) {
        setNetworks(d.networks.map((n: any) => ({
          name: n.name ?? "", cidr: n.cidr ?? "192.168.10.0/24",
          dns: Array.isArray(n.dns) ? n.dns.join(", ") : n.dns ?? "8.8.8.8",
        })));
      }
      if (d.vm_profiles?.length) {
        const profiles: VmProfile[] = d.vm_profiles.map((p: any) => ({
          name: p.name ?? "", image_name: p.image_name ?? "", flavor_name: p.flavor_name ?? "",
          count: p.count ?? 1, role: p.role ?? "", role_id: null,
          cloud_init_yaml: "",
          security_groups: p.security_groups ?? [],
          network_name: p.network_name ?? "",
        }));
        setVmProfiles(profiles);

        // Auto-load YAML for any role name that matches a saved role
        profiles.forEach((profile, idx) => {
          if (!profile.role) return;
          const match = savedRoles.find(r =>
            r.name.toLowerCase() === profile.role.toLowerCase()
          );
          if (match) {
            handleRoleSelect(idx, match.id, match.name);
          }
        });
      }
      if (d.security_groups?.length) {
        setSgs(d.security_groups.map((sg: any) => ({
          name: sg.name ?? "", description: sg.description ?? "",
          rules: (sg.rules ?? []).map((r: any) => ({
            direction: r.direction ?? "ingress", protocol: r.protocol ?? "tcp",
            port_min: r.port_min ?? "", port_max: r.port_max ?? "", cidr: r.cidr ?? "0.0.0.0/0",
          })),
        })));
      }
      if (d.load_balancer) {
        setLbEnabled(true);
        setLb({
          name: d.load_balancer.name ?? "app-lb",
          backend_profile: d.load_balancer.backend_profile ?? "",
          health_monitor: d.load_balancer.health_monitor ?? "HTTP",
          listeners: d.load_balancer.listeners?.length
            ? d.load_balancer.listeners.map((l: any) => ({
                protocol: l.protocol ?? "HTTP",
                port: l.port ?? 80,
                tls: l.tls ?? (l.protocol === "HTTPS"),
              }))
            : [{ protocol: "HTTP", port: 80, tls: false }],
        });
      } else if (d.load_balancer === null) {
        setLbEnabled(false);
      }
    },
  });

  // Deterministic generation (no AI)
  const genMut = useMutation({
    mutationFn: () => apiFetch<{ hcl: string }>("/generate/app-profile-terraform", {
      method: "POST",
      body: JSON.stringify({
        name: appName, description, key_pair: keyPair,
        networks: networks.map(n => ({ name:n.name, cidr:n.cidr, dns: n.dns.split(",").map((d: string) => d.trim()).filter(Boolean) })),
        vm_profiles: vmProfiles,
        security_groups: sgs,
        load_balancer: lbEnabled ? lb : null,
      }),
    }),
    onSuccess: d => { setHcl(d.hcl); setOutputTab("hcl"); },
  });

  // Save to catalog — uses appName directly, no modal
  const _saveContent = () => ({
    hcl,
    params: {
      name: appName, description, key_pair: keyPair,
      networks,
      vm_profiles: vmProfiles.map(p => ({ name:p.name, image:p.image_name, flavor:p.flavor_name, count:p.count, role:p.role, cloud_init_yaml:p.cloud_init_yaml, security_groups:p.security_groups, network_name:p.network_name })),
      security_groups: sgs,
      load_balancer: lbEnabled ? lb : null,
    },
  });

  const saveMut = useMutation({
    mutationFn: () => editProfileId
      // Editing an existing catalog entry — update in place
      ? apiFetch(`/generate/saved/${editProfileId}`, {
          method: "PUT",
          body: JSON.stringify({ name: appName, content: _saveContent() }),
        })
      // New entry
      : apiFetch("/generate/saved", {
          method: "POST",
          body: JSON.stringify({ name: appName, type: "app-profile", content: _saveContent() }),
        }),
    onSuccess: () => { qc.invalidateQueries({ queryKey:["generate","saved"] }); navigate("/catalog"); },
  });

  // Validation
  const missingFields: string[] = [];
  if (!appName) missingFields.push("App name is required");
  vmProfiles.forEach((p, i) => {
    if (!p.name) missingFields.push(`VM profile ${i + 1}: tier name required`);
    if (!p.flavor_name) missingFields.push(`${p.name || `Profile ${i+1}`}: flavor required`);
  });
  const canGenerate = missingFields.length === 0;

  return (
    <>
      {/* NL bar */}
      <div style={{ display:"flex", gap:8, marginBottom:8, alignItems:"flex-end" }}>
        <div style={{ flex:1 }}>
          <label className="form-label" style={{ fontSize:11, color:"var(--purple)", fontWeight:600 }}>
            <Sparkles size={11} style={{ display:"inline", marginRight:4 }} />Describe your app (AI fills the form)
          </label>
          <input className="form-input" value={nlDesc} onChange={e => setNlDesc(e.target.value)}
            placeholder='e.g. "2 nginx web servers, 1 postgres DB, load balancer on 80/443"'
            style={{ fontSize:12 }}
            disabled={nlMut.isPending}
            onKeyDown={e => e.key === "Enter" && nlDesc.trim() && !nlMut.isPending && nlMut.mutate()} />
        </div>
        <button className="btn btn-primary" disabled={!nlDesc.trim() || nlMut.isPending}
          style={{ display:"flex", alignItems:"center", gap:5, whiteSpace:"nowrap" }}
          onClick={() => nlMut.mutate()}>
          <Sparkles size={12} /> {nlMut.isPending ? "Working…" : "Fill from description"}
        </button>
      </div>

      {/* Prominent loading state */}
      {nlMut.isPending && (
        <div style={{ marginBottom:12, padding:"10px 14px", background:"#faf5ff", border:"1px solid #c4b5fd", borderRadius:6, fontSize:12, color:"#6d28d9", display:"flex", alignItems:"center", gap:8 }}>
          <Sparkles size={14} style={{ flexShrink:0, animation:"spin 2s linear infinite" }} />
          <span><strong>AI is analyzing your description</strong> — structuring networks, VMs, security groups, and load balancer. This may take up to 90 seconds…</span>
        </div>
      )}

      {nlMut.isSuccess && (
        <div style={{ marginBottom:12, padding:"8px 12px", background:"#f0fdf4", border:"1px solid #86efac", borderRadius:6, fontSize:12, color:"#166534" }}>
          ✓ Form pre-filled — matching roles loaded automatically. Any unmatched tiers need a Role selected from the dropdown.
        </div>
      )}
      {nlMut.isError && (
        <div style={{ marginBottom:12, padding:"8px 12px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:6, fontSize:12, color:"#991b1b" }}>
          ✗ AI could not parse the description — try rephrasing or be more specific (e.g. "2 nginx web servers with HTTP/HTTPS load balancer and postgres DB").
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"480px 1fr", gap:"1rem", alignItems:"start" }}>
        {/* Left: form */}
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

          {/* App details */}
          <div className="card card-body">
            <div style={{ fontWeight:700, fontSize:13, marginBottom:10, color:"var(--gray-800)" }}>App Details</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <FormField label="App Name" required>
                <input className="form-input" placeholder="my-web-app" value={appName} onChange={e => setAppName(e.target.value)} />
              </FormField>
              <FormField label="Description">
                <input className="form-input" placeholder="3-tier web application" value={description} onChange={e => setDescription(e.target.value)} />
              </FormField>
              <FormField label="Key Pair">
                {keypairs.length > 0 ? (
                  <select className="form-select" value={keyPair} onChange={e => setKeyPair(e.target.value)}>
                    <option value="">— select key pair —</option>
                    {keypairs.map(kp => <option key={kp.name} value={kp.name}>{kp.name}</option>)}
                  </select>
                ) : (
                  <input className="form-input" placeholder="my-keypair" value={keyPair} onChange={e => setKeyPair(e.target.value)} />
                )}
              </FormField>
              <div style={{ fontSize:11, color:"var(--gray-400)", background:"var(--gray-50)", padding:"8px 10px", borderRadius:6 }}>
                Tenant and network are deployment-time variables — select them when deploying from the App Catalog.
              </div>
            </div>
          </div>

          {/* Networks */}
          <div className="card card-body">
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"var(--gray-800)" }}>Networks</div>
              <button className="btn btn-secondary btn-sm" onClick={addNet}
                style={{ display:"flex", alignItems:"center", gap:4 }}>
                <Plus size={11} /> Add Network
              </button>
            </div>
            {networks.map((net, i) => (
              <div key={i} style={{ border:"1px solid var(--gray-100)", borderRadius:8, padding:10, marginBottom:8, display:"grid", gridTemplateColumns:"1fr 1fr 1fr auto", gap:8, alignItems:"end" }}>
                <FormField label="Name">
                  <input className="form-input" placeholder='e.g. "app-net"' value={net.name} onChange={e => setNet(i, "name", e.target.value)} />
                </FormField>
                <FormField label="CIDR">
                  <input className="form-input" placeholder="192.168.10.0/24" value={net.cidr} onChange={e => setNet(i, "cidr", e.target.value)} />
                </FormField>
                <FormField label="DNS">
                  <input className="form-input" placeholder="8.8.8.8, 8.8.4.4" value={net.dns} onChange={e => setNet(i, "dns", e.target.value)} />
                </FormField>
                {networks.length > 1 && (
                  <button onClick={() => removeNet(i)} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--gray-300)", padding:4, alignSelf:"center" }}>
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            <div style={{ fontSize:11, color:"var(--gray-400)", marginTop:4 }}>
              Terraform will create these networks + subnets + a router. Set <code style={{ fontFamily:"var(--font-mono)" }}>external_network_name</code> at deploy time.
            </div>
          </div>

          {/* VM Profiles */}
          <div className="card card-body">
            <div style={{ fontWeight:700, fontSize:13, marginBottom:10, color:"var(--gray-800)" }}>VM Profiles</div>
            {vmProfiles.map((p, i) => (
              <div key={i} style={{ border:"1px solid var(--gray-100)", borderRadius:8, padding:12, marginBottom:10, position:"relative" }}>
                {vmProfiles.length > 1 && (
                  <button onClick={() => removeVm(i)} style={{ position:"absolute", top:8, right:8, background:"none", border:"none", cursor:"pointer", color:"var(--gray-300)", padding:2 }}>
                    <X size={13} />
                  </button>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <FormField label="Tier Name">
                    <input className="form-input" placeholder='e.g. "web"' value={p.name} onChange={e => setVm(i, { name: e.target.value })} />
                  </FormField>
                  <FormField label="Count">
                    <input type="number" min={1} max={20} className="form-input" value={p.count}
                      onChange={e => setVm(i, { count: Number(e.target.value) })} />
                  </FormField>
                  <FormField label="Image (baked in)">
                    <select className="form-select" value={p.image_name} onChange={e => setVm(i, { image_name: e.target.value })}>
                      <option value="">— select image —</option>
                      {images.map(img => <option key={img.id} value={img.name}>{img.name}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Flavor (boot-from-vol)">
                    <select className="form-select" value={p.flavor_name} onChange={e => setVm(i, { flavor_name: e.target.value })}>
                      <option value="">— select flavor —</option>
                      {flavors.map(f => (
                        <option key={f.name} value={f.name}>
                          {f.name} ({f.vcpus}v · {Math.round(f.ram_mb/1024)}GB)
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <div style={{ gridColumn:"1/-1" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                      <label className="form-label" style={{ marginBottom:0 }}>Role (cloud-init)</label>
                      <button className="btn btn-secondary btn-sm" style={{ fontSize:10 }} onClick={onSwitchToRoles}>
                        + Manage Roles
                      </button>
                    </div>
                    {savedRoles.length > 0 ? (
                      <select className="form-select"
                        value={p.role_id ?? ""}
                        onChange={e => {
                          const id = Number(e.target.value);
                          if (id) {
                            const r = savedRoles.find(r => r.id === id);
                            handleRoleSelect(i, id, r?.name ?? "");
                          } else {
                            setVm(i, { role:"", role_id:null, cloud_init_yaml:"" });
                          }
                        }}>
                        <option value="">— select role —</option>
                        {savedRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    ) : (
                      <div style={{ fontSize:11, color:"var(--gray-400)", padding:"6px 0" }}>
                        No roles saved yet —{" "}
                        <button onClick={onSwitchToRoles} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--blue-primary)", fontSize:11, textDecoration:"underline" }}>
                          create one in the Roles tab
                        </button>
                      </div>
                    )}
                    {p.role && <div style={{ fontSize:11, color:"var(--gray-500)", marginTop:3 }}>{p.role}</div>}
                    {p.cloud_init_yaml && (
                      <div style={{ fontSize:10, color:"var(--green)", marginTop:2 }}>✓ cloud-init YAML loaded</div>
                    )}
                  </div>

                  {/* Network assignment */}
                  <div style={{ gridColumn:"1/-1" }}>
                    <FormField label="Network">
                      <select className="form-select" value={p.network_name} onChange={e => setVm(i, { network_name: e.target.value })}>
                        <option value="">— select network —</option>
                        {networks.filter(n => n.name).length > 0 && (
                          <optgroup label="App Networks (created by Terraform)">
                            {networks.filter(n => n.name).map(n => (
                              <option key={n.name} value={n.name}>{n.name} · {n.cidr}</option>
                            ))}
                          </optgroup>
                        )}
                        {providerNets.length > 0 && (
                          <optgroup label="Provider / External Networks (existing in PCD)">
                            {providerNets.map(n => (
                              <option key={n.id} value={n.name}>🌐 {n.name}</option>
                            ))}
                          </optgroup>
                        )}
                        {internalPcdNets.length > 0 && (
                          <optgroup label="Existing PCD Internal Networks">
                            {internalPcdNets.map(n => (
                              <option key={n.id} value={n.name}>{n.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </FormField>
                  </div>

                  {/* SG assignment */}
                  {sgs.length > 0 && (
                    <div style={{ gridColumn:"1/-1", marginTop:4 }}>
                      <label className="form-label" style={{ marginBottom:4 }}>Security Groups</label>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                        {sgs.filter(sg => sg.name).map(sg => (
                          <label key={sg.name} style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, cursor:"pointer" }}>
                            <input type="checkbox"
                              checked={p.security_groups.includes(sg.name)}
                              onChange={e => setVm(i, {
                                security_groups: e.target.checked
                                  ? [...p.security_groups, sg.name]
                                  : p.security_groups.filter(n => n !== sg.name)
                              })} />
                            {sg.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" onClick={addVm}
              style={{ display:"flex", alignItems:"center", gap:5 }}>
              <Plus size={12} /> Add VM Profile
            </button>
          </div>

          {/* Security Groups */}
          <div className="card card-body">
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"var(--gray-800)" }}>Security Groups</div>
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                {savedSgTemplates.length > 0 && (
                  <select className="form-select" style={{ fontSize:11, width:"auto" }}
                    value="" onChange={async e => { const id = Number(e.target.value); if (id) await addSgFromTemplate(id); }}>
                    <option value="">+ From library…</option>
                    {savedSgTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}
                <button className="btn btn-secondary btn-sm" style={{ fontSize:10 }} onClick={onSwitchToSGs}>
                  Manage SGs
                </button>
              </div>
            </div>
            {sgs.map((sg, si) => (
              <div key={si} style={{ border:"1px solid var(--gray-100)", borderRadius:8, padding:12, marginBottom:10 }}>
                <div style={{ display:"flex", gap:8, marginBottom:8, alignItems:"flex-end" }}>
                  <div style={{ flex:1 }}>
                    <FormField label="Group Name">
                      <input className="form-input" placeholder="web-sg" value={sg.name} onChange={e => setSg(si, "name", e.target.value)} />
                    </FormField>
                  </div>
                  <div style={{ display:"flex", gap:4, alignItems:"flex-end", paddingBottom:1 }}>
                    {SG_PRESETS.map(pr => (
                      <button key={pr.label} className="btn btn-secondary btn-sm" style={{ fontSize:10 }}
                        onClick={() => setSg(si, "rules", pr.rules)}>{pr.label}</button>
                    ))}
                    <button onClick={() => removeSg(si)} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--gray-300)", padding:4 }}>
                      <X size={13} />
                    </button>
                  </div>
                </div>
                {sg.rules.map((r, ri) => (
                  <RuleRow key={ri} r={r}
                    onChange={(k, v) => setRule(si, ri, k, v)}
                    onRemove={() => removeRule(si, ri)} />
                ))}
                <button className="btn btn-secondary btn-sm" style={{ marginTop:4, display:"flex", alignItems:"center", gap:4 }}
                  onClick={() => addRule(si)}>
                  <Plus size={11} /> Add Rule
                </button>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" onClick={addSg}
              style={{ display:"flex", alignItems:"center", gap:5 }}>
              <Shield size={12} /> Add Blank Security Group
            </button>
          </div>

          {/* Load Balancer */}
          <div className="card card-body">
            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", marginBottom:lbEnabled ? 12 : 0 }}>
              <input type="checkbox" checked={lbEnabled} onChange={e => setLbEnabled(e.target.checked)} />
              <span style={{ fontWeight:700, fontSize:13, color:"var(--gray-800)" }}>Include Load Balancer</span>
            </label>
            {lbEnabled && (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <FormField label="LB Name">
                    <input className="form-input" value={lb.name} onChange={e => setLb({ ...lb, name:e.target.value })} />
                  </FormField>
                  <FormField label="Backend VM Profile">
                    <select className="form-select" value={lb.backend_profile} onChange={e => setLb({ ...lb, backend_profile:e.target.value })}>
                      <option value="">— select profile —</option>
                      {vmProfiles.filter(p => p.name).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Health Monitor">
                    <select className="form-select" value={lb.health_monitor} onChange={e => setLb({ ...lb, health_monitor:e.target.value })}>
                      <option>HTTP</option><option>TCP</option><option>PING</option>
                    </select>
                  </FormField>
                </div>

                {/* Listeners */}
                <div>
                  <div style={{ fontWeight:600, fontSize:12, color:"var(--gray-700)", marginBottom:6 }}>Listeners</div>
                  {lb.listeners.map((l, i) => (
                    <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 75px 1fr auto", gap:6, marginBottom:6, alignItems:"end" }}>
                      <select className="form-select" style={{ fontSize:12 }} value={l.protocol}
                        onChange={e => {
                          const proto = e.target.value as "HTTP"|"HTTPS"|"TCP";
                          setListener(i, { protocol: proto, tls: proto === "HTTPS", port: proto === "HTTPS" ? 443 : l.port });
                        }}>
                        <option value="HTTP">HTTP</option>
                        <option value="HTTPS">HTTPS</option>
                        <option value="TCP">TCP</option>
                      </select>
                      <input type="number" className="form-input" style={{ fontSize:12 }} value={l.port}
                        onChange={e => setListener(i, { port: Number(e.target.value) })} />
                      <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, cursor:"pointer", paddingBottom:4 }}>
                        <input type="checkbox" checked={l.tls} onChange={e => setListener(i, { tls: e.target.checked })} />
                        <span style={{ color: l.tls ? "var(--blue-primary)" : "var(--gray-500)" }}>
                          TLS Terminate {l.tls && <span style={{ fontSize:10, color:"var(--gray-400)" }}>(Barbican cert)</span>}
                        </span>
                      </label>
                      {lb.listeners.length > 1 && (
                        <button onClick={() => removeListener(i)} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--gray-300)", padding:4 }}>
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button className="btn btn-secondary btn-sm" onClick={addListener}
                    style={{ display:"flex", alignItems:"center", gap:4, marginTop:4 }}>
                    <Plus size={11} /> Add Listener
                  </button>
                  {lb.listeners.some(l => l.tls) && (
                    <div style={{ fontSize:11, color:"var(--gray-400)", marginTop:6 }}>
                      TLS listeners need <code style={{ fontFamily:"var(--font-mono)" }}>tls_cert_ref</code> (Barbican URI) at deploy time.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Generate button + validation hints */}
          <div>
            <button className="btn btn-primary" disabled={!canGenerate || genMut.isPending}
              onClick={() => genMut.mutate()}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, padding:"10px", width:"100%" }}>
              {genMut.isPending ? "Building Terraform plan…" : "Generate App Plan"}
            </button>
            {!canGenerate && missingFields.length > 0 && (
              <div style={{ marginTop:8, fontSize:11, color:"var(--gray-500)" }}>
                {missingFields.map((m, i) => <div key={i}>· {m}</div>)}
              </div>
            )}
          </div>
        </div>

        {/* Right: diagram + HCL tabs */}
        <div className="card" style={{ overflow:"hidden", display:"flex", flexDirection:"column", height:"calc(100vh - 195px)" }}>
          {/* Tab strip + actions */}
          <div className="card-header" style={{ gap:0, padding:"0 12px" }}>
            <div style={{ display:"flex", gap:0 }}>
              {(["diagram","hcl"] as const).map(t => (
                <button key={t} onClick={() => setOutputTab(t)}
                  style={{
                    padding:"10px 14px", background:"none", border:"none", cursor:"pointer",
                    fontSize:12, fontWeight: outputTab === t ? 600 : 400,
                    color: outputTab === t ? "var(--blue-primary)" : "var(--gray-500)",
                    borderBottom: outputTab === t ? "2px solid var(--blue-primary)" : "2px solid transparent",
                  }}>
                  {t === "diagram" ? "📐 Diagram" : "📄 HCL ✎"}
                </button>
              ))}
            </div>
            <div style={{ display:"flex", gap:6, marginLeft:"auto", alignItems:"center" }}>
              {/* Import .tf — always visible */}
              <input type="file" accept=".tf,.hcl,.txt" ref={hclFileRef} style={{ display:"none" }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = ev => { setHcl(ev.target?.result as string ?? ""); setOutputTab("hcl"); };
                  reader.readAsText(file);
                  e.target.value = "";
                }} />
              <button className="btn btn-secondary btn-sm" onClick={() => hclFileRef.current?.click()}
                style={{ display:"flex", alignItems:"center", gap:4 }}>
                📂 Import .tf
              </button>

              {hcl && (
                <>
                  <button className="btn btn-primary btn-sm"
                    disabled={!appName || saveMut.isPending}
                    onClick={() => { if (!appName) { setSaveError(true); setTimeout(() => setSaveError(false), 3000); } else saveMut.mutate(); }}
                    style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <BookOpen size={12} /> {saveMut.isPending ? "Saving…" : editProfileId ? "Update Catalog" : "Save to Catalog"}
                  </button>
                  <button className="btn btn-secondary btn-sm"
                    onClick={() => navigator.clipboard.writeText(hcl)}
                    style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <Copy size={12} /> Copy
                  </button>
                </>
              )}
            </div>
          </div>
          {saveError && (
            <div style={{ padding:"6px 16px", background:"#fef2f2", fontSize:11, color:"var(--red)", borderBottom:"1px solid #fecaca" }}>
              Fill in App Name before saving.
            </div>
          )}

          {/* Diagram tab */}
          {outputTab === "diagram" && (
            <div style={{ flex:1, overflowY:"auto", padding:"24px 16px" }}>
              <AppDiagram vmProfiles={vmProfiles} sgs={sgs} lbEnabled={lbEnabled} lb={lb} networks={networks} />
            </div>
          )}

          {/* HCL tab */}
          {outputTab === "hcl" && (
            hcl ? (
              <textarea value={hcl} onChange={e => setHcl(e.target.value)} spellCheck={false}
                style={{
                  flex:1, padding:"14px 16px", margin:0, border:"none", outline:"none",
                  resize:"none",
                  fontFamily:"var(--font-mono)", fontSize:12, color:"var(--gray-800)",
                  background:"var(--gray-50)", lineHeight:1.6,
                }} />
            ) : (
              <div className="empty" style={{ padding:"64px 24px" }}>
                <div className="empty-title">{genMut.isPending ? "Building plan…" : "No HCL yet"}</div>
                <div className="empty-body">Click Generate App Plan to produce the Terraform configuration.</div>
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}

// ── App Diagram — LB → Network → VMs ──────────────────────────────────────────

const TIER_COLORS = ["#3b82f6","#10b981","#f59e0b","#8b5cf6","#ef4444","#06b6d4"];

function TierCard({ p, color, isLbBackend, tierSgs }: {
  p: VmProfile; color: string; isLbBackend: boolean; tierSgs: SgDef[];
}) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:5 }}>
      <div style={{
        border:`2px solid ${color}`, borderRadius:10, padding:"10px 16px", minWidth:160,
        background: isLbBackend ? `${color}11` : "white",
        boxShadow: isLbBackend ? `0 0 0 3px ${color}33` : undefined,
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:5 }}>
          <div style={{ fontWeight:700, fontSize:13 }}>{p.name}</div>
          <span style={{ background:color, color:"white", borderRadius:99, fontSize:10, fontWeight:700, padding:"1px 6px" }}>{p.count}×</span>
        </div>
        {p.image_name && <div style={{ fontSize:10, color:"var(--gray-500)", marginBottom:2 }}>🖼 {p.image_name}</div>}
        {p.flavor_name && <div style={{ fontSize:10, color:"var(--gray-500)", marginBottom:2 }}>⚙ {p.flavor_name}</div>}
        {p.role && <div style={{ fontSize:10, color, fontWeight:500, marginTop:3, borderTop:"1px solid var(--gray-100)", paddingTop:3 }}>{p.role}</div>}
        {p.cloud_init_yaml && <div style={{ fontSize:9, color:"var(--green)", marginTop:2 }}>✓ cloud-init</div>}
      </div>
      {tierSgs.length > 0 && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:3, justifyContent:"center" }}>
          {tierSgs.map(sg => (
            <span key={sg.name} style={{ fontSize:9, padding:"2px 6px", borderRadius:99, background:"#fef3c7", border:"1px solid #fbbf24", color:"#92400e" }}>
              🛡 {sg.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Connector({ color = "var(--gray-200)" }: { color?: string }) {
  return (
    <div style={{ width:2, height:20, background:color, margin:"0 auto", position:"relative" }}>
      <div style={{ position:"absolute", bottom:-5, left:-4, width:0, height:0,
        borderLeft:"5px solid transparent", borderRight:"5px solid transparent",
        borderTop:`6px solid ${color}` }} />
    </div>
  );
}

function AppDiagram({ vmProfiles, sgs, lbEnabled, lb, networks }: {
  vmProfiles: VmProfile[]; sgs: SgDef[]; lbEnabled: boolean; lb: LbDef; networks: AppNetwork[];
}) {
  const activeTiers = vmProfiles.filter(p => p.name);
  if (!activeTiers.length) {
    return (
      <div style={{ textAlign:"center", padding:"40px 20px", color:"var(--gray-300)" }}>
        <Layers size={40} style={{ marginBottom:12 }} />
        <div style={{ fontSize:13, fontWeight:500 }}>Add VM profiles to see your architecture</div>
      </div>
    );
  }

  const sgForTier = (p: VmProfile) => sgs.filter(sg => sg.name && p.security_groups.includes(sg.name));

  // Group tiers by their assigned network
  const hasNetworks = networks.filter(n => n.name).length > 0;
  const managedNetNames = new Set(networks.map(n => n.name));
  type NetGroup = { net: AppNetwork | null; key: string; tiers: VmProfile[]; isProvider?: boolean };
  let netGroups: NetGroup[];

  if (hasNetworks) {
    // Managed app networks
    netGroups = networks.filter(n => n.name).map(net => ({
      net, key: net.name,
      tiers: activeTiers.filter(p => p.network_name === net.name),
    }));
    // Tiers with no network go to first group
    const unassigned = activeTiers.filter(p => !p.network_name);
    if (unassigned.length && netGroups.length > 0) {
      netGroups[0].tiers = [...new Set([...netGroups[0].tiers, ...unassigned])];
    }
    // Provider/external networks (tiers referencing a network NOT in managed list)
    const providerTiers = activeTiers.filter(p => p.network_name && !managedNetNames.has(p.network_name));
    const byProviderNet: Record<string, VmProfile[]> = {};
    providerTiers.forEach(p => { (byProviderNet[p.network_name] ??= []).push(p); });
    Object.entries(byProviderNet).forEach(([name, tiers]) => {
      netGroups.push({ net: null, key: name, tiers, isProvider: true });
    });
  } else {
    netGroups = [{ net: null, key: "var", tiers: activeTiers }];
  }

  const unassignedSgs = sgs.filter(sg => sg.name && !new Set(vmProfiles.flatMap(p => p.security_groups)).has(sg.name));

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:0, minHeight:200 }}>

      {/* Internet / Provider Network — shown when managed networks create a router */}
      {hasNetworks && (
        <>
          <div style={{
            border:"2px solid #d1d5db", borderRadius:10, padding:"7px 20px",
            minWidth:200, textAlign:"center", background:"#f8fafc",
            display:"flex", alignItems:"center", justifyContent:"center", gap:8,
          }}>
            <span style={{ fontSize:16 }}>🌐</span>
            <div>
              <div style={{ fontSize:9, color:"var(--gray-400)", fontWeight:700, textTransform:"uppercase", letterSpacing:".05em" }}>Provider / External Network</div>
              <div style={{ fontSize:11, color:"var(--gray-500)", fontFamily:"var(--font-mono)" }}>var.external_network_name</div>
            </div>
          </div>
          <Connector color="#d1d5db" />
        </>
      )}

      {/* Row 1: Load Balancer */}
      {lbEnabled && lb.name && (
        <>
          <div style={{ background:"#eff6ff", border:"2px solid #3b82f6", borderRadius:10, padding:"10px 20px", minWidth:220, textAlign:"center" }}>
            <div style={{ fontSize:10, color:"#3b82f6", fontWeight:700, letterSpacing:".06em", textTransform:"uppercase" }}>Load Balancer</div>
            <div style={{ fontWeight:700, fontSize:14, marginTop:2 }}>{lb.name}</div>
            <div style={{ display:"flex", gap:6, justifyContent:"center", marginTop:4, flexWrap:"wrap" }}>
              {lb.listeners.map((l, i) => (
                <span key={i} style={{ fontSize:10, padding:"1px 7px", borderRadius:99, background: l.tls ? "#dbeafe" : "#e0f2fe", color:"#1e40af", fontWeight:600 }}>
                  {l.tls ? "HTTPS" : l.protocol}:{l.port}
                </span>
              ))}
            </div>
          </div>
          <Connector color="#3b82f6" />
        </>
      )}

      {/* Row 2 + 3: Networks with their tiers below */}
      <div style={{ display:"flex", gap:24, justifyContent:"center", flexWrap:"wrap", alignItems:"flex-start" }}>
        {netGroups.map((group) => (
          <div key={group.key} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:0 }}>
            {/* Network box */}
            {group.isProvider ? (
              <div style={{ border:"2px solid #d1d5db", borderRadius:10, padding:"8px 18px", minWidth:160, textAlign:"center", background:"#f8fafc" }}>
                <div style={{ fontSize:9, color:"var(--gray-400)", fontWeight:700, textTransform:"uppercase", letterSpacing:".05em" }}>🌐 Provider Network</div>
                <div style={{ fontWeight:600, fontSize:12, color:"var(--gray-700)", marginTop:1 }}>{group.key}</div>
              </div>
            ) : group.net ? (
              <div style={{ border:"2px solid #6366f1", borderRadius:10, padding:"8px 20px", minWidth:180, textAlign:"center", background:"#eef2ff" }}>
                <div style={{ fontSize:9, color:"#4338ca", fontWeight:700, textTransform:"uppercase", letterSpacing:".05em" }}>Network</div>
                <div style={{ fontWeight:700, fontSize:13, color:"#312e81", marginTop:1 }}>{group.net.name}</div>
                <div style={{ fontSize:10, color:"#6366f1", fontFamily:"var(--font-mono)", marginTop:1 }}>{group.net.cidr}</div>
              </div>
            ) : (
              <div style={{ border:"2px dashed var(--gray-300)", borderRadius:10, padding:"8px 20px", minWidth:200, textAlign:"center", background:"var(--gray-50)" }}>
                <div style={{ fontSize:9, color:"var(--gray-400)", fontWeight:700, textTransform:"uppercase", letterSpacing:".05em" }}>Network (deploy-time)</div>
                <div style={{ fontWeight:600, fontSize:12, color:"var(--gray-600)", fontFamily:"var(--font-mono)", marginTop:1 }}>var.network_name</div>
              </div>
            )}

            {/* Connector + tiers */}
            {group.tiers.length > 0 && (
              <>
                <div style={{ width:2, height:16, background:"var(--gray-200)" }} />
                <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
                  {group.tiers.map((p) => {
                    const colorIdx = activeTiers.indexOf(p);
                    const color = TIER_COLORS[colorIdx % TIER_COLORS.length];
                    return (
                      <TierCard key={p.name} p={p} color={color}
                        isLbBackend={lbEnabled && lb.backend_profile === p.name}
                        tierSgs={sgForTier(p)} />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Unassigned SGs */}
      {unassignedSgs.length > 0 && (
        <div style={{ marginTop:14, display:"flex", gap:6, flexWrap:"wrap", justifyContent:"center", alignItems:"center" }}>
          <span style={{ fontSize:10, color:"var(--gray-400)" }}>Unassigned SGs:</span>
          {unassignedSgs.map(sg => (
            <span key={sg.name} style={{ fontSize:10, padding:"3px 8px", borderRadius:6, background:"#fff7ed", border:"1px dashed #fdba74", color:"#9a3412" }}>
              🛡 {sg.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Roles Library ──────────────────────────────────────────────────────────────

function RolesLibrary() {
  const qc = useQueryClient();
  const { data: allSaved = [] } = useSavedList();
  const roles = allSaved.filter(s => s.type === "role");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorDesc, setEditorDesc] = useState("");
  const [editorYaml, setEditorYaml] = useState("");
  const [flash, setFlash] = useState(false);
  const [refineDesc, setRefineDesc] = useState("");
  const yamlFileRef = useRef<HTMLInputElement>(null);

  const loadRole = async (id: number) => {
    const detail = await apiFetch<{ name: string; content: { description?: string; yaml?: string } }>(`/generate/saved/${id}`);
    setSelectedId(id);
    setEditorName(detail.name);
    setEditorDesc(detail.content?.description ?? "");
    setEditorYaml(detail.content?.yaml ?? "");
  };

  const newRole = () => { setSelectedId(null); setEditorName(""); setEditorDesc(""); setEditorYaml(""); };

  const saveMut = useMutation({
    mutationFn: () => selectedId
      ? apiFetch(`/generate/saved/${selectedId}`, { method:"PUT",
          body: JSON.stringify({ name:editorName, content:{ description:editorDesc, yaml:editorYaml } }) })
      : apiFetch("/generate/saved", { method:"POST",
          body: JSON.stringify({ name:editorName, type:"role", content:{ description:editorDesc, yaml:editorYaml } }) }),
    onSuccess: (data: any) => {
      if (!selectedId && data?.id) setSelectedId(data.id);
      qc.invalidateQueries({ queryKey:["generate","saved"] });
      setFlash(true); setTimeout(() => setFlash(false), 2000);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => apiFetch(`/generate/saved/${selectedId}`, { method:"DELETE" }),
    onSuccess: () => { newRole(); qc.invalidateQueries({ queryKey:["generate","saved"] }); },
  });

  const aiMut = useMutation({
    mutationFn: () => apiFetch<{ yaml: string }>("/generate/cloud-init", {
      method:"POST", body: JSON.stringify({ role:editorName, extra_notes:editorDesc }),
    }),
    onSuccess: d => setEditorYaml(d.yaml ?? ""),
  });

  const refineMut = useMutation({
    mutationFn: () => apiFetch<{ yaml: string }>("/generate/cloud-init-refine", {
      method:"POST", body: JSON.stringify({ current_yaml: editorYaml, instruction: refineDesc }),
    }),
    onSuccess: d => { setEditorYaml(d.yaml ?? ""); setRefineDesc(""); },
  });

  return (
    <div style={{ display:"grid", gridTemplateColumns:"260px 1fr", gap:"1rem", alignItems:"start" }}>
      <div className="card" style={{ overflow:"hidden" }}>
        <div className="card-header">
          <span className="card-title">Saved Roles</span>
          <button className="btn btn-secondary btn-sm" onClick={newRole}>+ New</button>
        </div>
        {roles.length === 0 && (
          <p style={{ padding:"12px 16px", fontSize:12, color:"var(--gray-500)" }}>
            No roles yet — create one to select in the App Builder.
          </p>
        )}
        {roles.map(r => (
          <div key={r.id} onClick={() => loadRole(r.id)} style={{
            padding:"10px 16px", cursor:"pointer", borderBottom:"1px solid var(--gray-50)",
            background: r.id === selectedId ? "var(--gray-50)" : undefined,
            borderLeft: r.id === selectedId ? "3px solid var(--blue-primary)" : "3px solid transparent",
          }}>
            <div style={{ fontWeight:500, fontSize:13 }}>{r.name}</div>
            <div style={{ fontSize:11, color:"var(--gray-400)" }}>{r.updated_at?.slice(0,10)}</div>
          </div>
        ))}
      </div>

      <div className="card card-body" style={{ display:"flex", flexDirection:"column", gap:12 }}>
        <div style={{ fontWeight:700, fontSize:13, color:"var(--gray-800)" }}>
          {selectedId ? "Edit Role" : "New Role"}
        </div>
        <FormField label="Role Name" required>
          <input className="form-input" placeholder='e.g. "NGINX Web Server"' value={editorName}
            onChange={e => setEditorName(e.target.value)} />
        </FormField>
        <FormField label="Description">
          <input className="form-input" placeholder="Brief description of this role" value={editorDesc}
            onChange={e => setEditorDesc(e.target.value)} />
        </FormField>
        <div>
          <input type="file" accept=".yaml,.yml,.txt" ref={yamlFileRef} style={{ display:"none" }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = ev => setEditorYaml(ev.target?.result as string ?? "");
              reader.readAsText(file);
              e.target.value = "";   // reset so same file can be re-selected
            }} />
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <div>
              <label className="form-label" style={{ marginBottom:0 }}>cloud-init YAML</label>
              <div style={{ fontSize:10, color:"var(--gray-400)", marginTop:1 }}>paste directly or import a file</div>
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => yamlFileRef.current?.click()}
                style={{ display:"flex", alignItems:"center", gap:4, fontSize:11 }}>
                📂 Import file
              </button>
              <button className="btn btn-secondary btn-sm" disabled={!editorName || aiMut.isPending}
                onClick={() => aiMut.mutate()}
                style={{ display:"flex", alignItems:"center", gap:4, fontSize:11 }}>
                <Sparkles size={11} /> {aiMut.isPending ? "Generating…" : "Generate with AI"}
              </button>
            </div>
          </div>
          <textarea value={editorYaml} onChange={e => setEditorYaml(e.target.value)} spellCheck={false}
            placeholder={"#cloud-config\npackage_update: true\n..."}
            style={{
              width:"100%", height:400, fontFamily:"var(--font-mono)", fontSize:12,
              border: refineMut.isPending ? "1px solid var(--purple)" : "1px solid var(--gray-200)",
              borderRadius:6, padding:"10px 12px",
              resize:"vertical", lineHeight:1.6, boxSizing:"border-box",
              background:"var(--gray-50)", color:"var(--gray-800)", outline:"none",
              transition:"border-color .2s",
            }} />

          {/* Refine strip — visible only when YAML exists */}
          {editorYaml.trim() && (
            <div style={{
              marginTop:8, padding:"10px 12px", background:"#faf5ff",
              border:"1px solid #e9d5ff", borderRadius:6,
            }}>
              <label style={{ fontSize:11, fontWeight:600, color:"#7c3aed", display:"block", marginBottom:6 }}>
                <Sparkles size={11} style={{ display:"inline", marginRight:4 }} />Refine this YAML
              </label>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <input className="form-input" value={refineDesc} onChange={e => setRefineDesc(e.target.value)}
                  placeholder='e.g. "also install certbot", "use port 8080", "add a monitoring user"'
                  style={{ fontSize:12, flex:1 }}
                  disabled={refineMut.isPending}
                  onKeyDown={e => e.key === "Enter" && refineDesc.trim() && refineMut.mutate()} />
                <button className="btn btn-primary btn-sm"
                  disabled={!refineDesc.trim() || refineMut.isPending}
                  onClick={() => refineMut.mutate()}
                  style={{ display:"flex", alignItems:"center", gap:4, whiteSpace:"nowrap" }}>
                  <Sparkles size={11} /> {refineMut.isPending ? "Refining…" : "Refine with AI"}
                </button>
              </div>
              {refineMut.isError && (
                <div style={{ fontSize:11, color:"var(--red)", marginTop:4 }}>
                  Refinement failed — try rephrasing your instruction.
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <button className="btn btn-primary" disabled={!editorName || saveMut.isPending} onClick={() => saveMut.mutate()}>
            {flash ? "Saved ✓" : selectedId ? "Update Role" : "Save Role"}
          </button>
          {selectedId && (
            <button className="btn btn-secondary" disabled={deleteMut.isPending}
              onClick={() => { if (window.confirm(`Delete role "${editorName}"?`)) deleteMut.mutate(); }}
              style={{ display:"flex", alignItems:"center", gap:4, color:"var(--red)" }}>
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Security Group Library ─────────────────────────────────────────────────────

function SGLibrary() {
  const qc = useQueryClient();
  const { data: allSaved = [] } = useSavedList();
  const templates = allSaved.filter(s => s.type === "sg-template");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorDesc, setEditorDesc] = useState("");
  const [editorRules, setEditorRules] = useState<SgRule[]>([]);
  const [flash, setFlash] = useState(false);

  const loadTemplate = async (id: number) => {
    const detail = await apiFetch<{ name: string; content: { description?: string; rules?: SgRule[] } }>(`/generate/saved/${id}`);
    setSelectedId(id);
    setEditorName(detail.name);
    setEditorDesc(detail.content?.description ?? "");
    setEditorRules(detail.content?.rules ?? []);
  };

  const newTemplate = () => {
    setSelectedId(null); setEditorName(""); setEditorDesc("");
    setEditorRules([{ direction:"ingress", protocol:"tcp", port_min:"", port_max:"", cidr:"0.0.0.0/0" }]);
  };

  const saveMut = useMutation({
    mutationFn: () => selectedId
      ? apiFetch(`/generate/saved/${selectedId}`, { method:"PUT",
          body: JSON.stringify({ name:editorName, content:{ description:editorDesc, rules:editorRules } }) })
      : apiFetch("/generate/saved", { method:"POST",
          body: JSON.stringify({ name:editorName, type:"sg-template", content:{ description:editorDesc, rules:editorRules } }) }),
    onSuccess: (data: any) => {
      if (!selectedId && data?.id) setSelectedId(data.id);
      qc.invalidateQueries({ queryKey:["generate","saved"] });
      setFlash(true); setTimeout(() => setFlash(false), 2000);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => apiFetch(`/generate/saved/${selectedId}`, { method:"DELETE" }),
    onSuccess: () => { newTemplate(); qc.invalidateQueries({ queryKey:["generate","saved"] }); },
  });

  const addRule = () => setEditorRules(r => [...r, { direction:"ingress", protocol:"tcp", port_min:"", port_max:"", cidr:"0.0.0.0/0" }]);

  return (
    <div style={{ display:"grid", gridTemplateColumns:"260px 1fr", gap:"1rem", alignItems:"start" }}>
      <div className="card" style={{ overflow:"hidden" }}>
        <div className="card-header">
          <span className="card-title">SG Templates</span>
          <button className="btn btn-secondary btn-sm" onClick={newTemplate}>+ New</button>
        </div>
        {templates.length === 0 && (
          <p style={{ padding:"12px 16px", fontSize:12, color:"var(--gray-500)" }}>
            No templates yet — create one to quick-add in the App Builder.
          </p>
        )}
        {templates.map(t => (
          <div key={t.id} onClick={() => loadTemplate(t.id)} style={{
            padding:"10px 16px", cursor:"pointer", borderBottom:"1px solid var(--gray-50)",
            background: t.id === selectedId ? "var(--gray-50)" : undefined,
            borderLeft: t.id === selectedId ? "3px solid var(--blue-primary)" : "3px solid transparent",
          }}>
            <div style={{ fontWeight:500, fontSize:13 }}>{t.name}</div>
            <div style={{ fontSize:11, color:"var(--gray-400)" }}>{t.updated_at?.slice(0,10)}</div>
          </div>
        ))}
      </div>

      <div className="card card-body" style={{ display:"flex", flexDirection:"column", gap:12 }}>
        <div style={{ fontWeight:700, fontSize:13, color:"var(--gray-800)" }}>
          {selectedId ? "Edit Template" : "New SG Template"}
        </div>
        <FormField label="Template Name" required>
          <input className="form-input" placeholder='e.g. "Web Server Public"' value={editorName}
            onChange={e => setEditorName(e.target.value)} />
        </FormField>
        <FormField label="Description">
          <input className="form-input" placeholder="Brief description" value={editorDesc}
            onChange={e => setEditorDesc(e.target.value)} />
        </FormField>

        <div style={{ display:"flex", gap:6 }}>
          {SG_PRESETS.map(p => (
            <button key={p.label} className="btn btn-secondary btn-sm" style={{ fontSize:11 }}
              onClick={() => setEditorRules(p.rules)}>{p.label}</button>
          ))}
        </div>

        <div style={{ fontWeight:600, fontSize:12, color:"var(--gray-700)" }}>Rules</div>
        {editorRules.map((r, i) => (
          <RuleRow key={i} r={r}
            onChange={(k, v) => setEditorRules(editorRules.map((rl, idx) => idx !== i ? rl : { ...rl, [k]: v }))}
            onRemove={() => setEditorRules(editorRules.filter((_, idx) => idx !== i))} />
        ))}
        <button className="btn btn-secondary btn-sm" onClick={addRule}
          style={{ display:"flex", alignItems:"center", gap:5 }}>
          <Plus size={12} /> Add Rule
        </button>

        <div style={{ display:"flex", gap:8, marginTop:4, alignItems:"center" }}>
          <button className="btn btn-primary" disabled={!editorName || saveMut.isPending} onClick={() => saveMut.mutate()}>
            {flash ? "Saved ✓" : selectedId ? "Update Template" : "Save Template"}
          </button>
          {selectedId && (
            <button className="btn btn-secondary" disabled={deleteMut.isPending}
              onClick={() => { if (window.confirm(`Delete "${editorName}"?`)) deleteMut.mutate(); }}
              style={{ display:"flex", alignItems:"center", gap:4, color:"var(--red)" }}>
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
