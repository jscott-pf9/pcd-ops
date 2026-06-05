import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Save, Trash2, FolderOpen, Sparkles, X } from "lucide-react";
import { apiFetch } from "../api/client";
import { useTenants } from "../api/tenants";

interface Flavor    { name: string; vcpus: number; ram_mb: number; }
interface NetItem   { name: string; id: string; external: boolean; }
interface ImageItem { name: string; id: string; size_gb: number; }
interface SavedCfg  { id: number; name: string; type: string; created_at: string; updated_at: string; content?: any; }

type TabType = "terraform" | "cloud-init" | "combined" | "security-group" | "load-balancer" | "saved";

export default function Generate() {
  const [tab, setTab] = useState<TabType>("terraform");
  const TABS: { id: TabType; label: string }[] = [
    { id: "terraform",       label: "Terraform HCL" },
    { id: "cloud-init",      label: "cloud-init YAML" },
    { id: "combined",        label: "Combined" },
    { id: "security-group",  label: "Security Groups" },
    { id: "load-balancer",   label: "Load Balancer" },
    { id: "saved",           label: "Saved Configs" },
  ];

  return (
    <div>
      <h1>Config Generator</h1>
      <p className="page-subtitle">AI-generated Terraform and cloud-init configs for PCD VMs.</p>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "terraform"      && <TerraformGen />}
      {tab === "cloud-init"     && <CloudInitGen />}
      {tab === "combined"       && <CombinedGen />}
      {tab === "security-group" && <SecurityGroupGen />}
      {tab === "load-balancer"  && <LoadBalancerGen />}
      {tab === "saved"          && <SavedConfigs />}
    </div>
  );
}

// ── Shared hooks & helpers ─────────────────────────────────────────────────────

function useInventory() {
  const { data: flavors = [] } = useQuery<Flavor[]>({
    queryKey: ["generate", "flavors"],
    queryFn: () => apiFetch("/generate/flavors"),
    staleTime: 5 * 60_000,
  });
  const { data: networks = [] } = useQuery<NetItem[]>({
    queryKey: ["generate", "networks"],
    queryFn: () => apiFetch("/generate/networks"),
    staleTime: 5 * 60_000,
  });
  const { data: images = [] } = useQuery<ImageItem[]>({
    queryKey: ["generate", "images"],
    queryFn: () => apiFetch("/generate/images"),
    staleTime: 5 * 60_000,
  });
  return { flavors, networks, images };
}

function FormField({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="form-label">{label}{required && <span style={{ color: "var(--red)" }}> *</span>}</label>
      {children}
    </div>
  );
}

function CodeOutput({ title, code, filename, onSave }: {
  title?: string; code: string; filename: string; onSave?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="card-header">
        <span className="card-title" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {title || filename}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {onSave && (
            <button className="btn btn-secondary btn-sm" onClick={onSave}
              style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Save size={12} /> Save
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={copy}
            style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Copy size={12} />{copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <pre style={{
        padding: "14px 16px", margin: 0, overflow: "auto", maxHeight: "calc(100vh - 320px)",
        fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--gray-800)",
        background: "var(--gray-50)", lineHeight: 1.6,
      }}>{code}</pre>
    </div>
  );
}

function EmptyOutput({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty" style={{ padding: "48px 24px" }}>
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
    </div>
  );
}

function NLPromptBar({ type, onResult }: { type: string; onResult: (code: string, key: string) => void }) {
  const [desc, setDesc] = useState("");
  const mut = useMutation({
    mutationFn: () => apiFetch<any>("/generate/from-prompt", {
      method: "POST", body: JSON.stringify({ description: desc, type }),
    }),
    onSuccess: (d) => {
      const key = type === "cloud-init" ? "yaml" : "hcl";
      onResult(d[key] ?? "", key);
    },
  });
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "flex-end" }}>
      <div style={{ flex: 1 }}>
        <label className="form-label" style={{ fontSize: 11, color: "var(--purple)", fontWeight: 600 }}>
          <Sparkles size={11} style={{ display: "inline", marginRight: 4 }} />Describe what you want (AI)
        </label>
        <input className="form-input" value={desc} onChange={e => setDesc(e.target.value)}
          placeholder='e.g. "3 nginx web servers on the internal network using Ubuntu 22.04"'
          style={{ fontSize: 12 }}
          onKeyDown={e => e.key === "Enter" && desc.trim() && mut.mutate()} />
      </div>
      <button className="btn btn-primary" disabled={!desc.trim() || mut.isPending}
        style={{ display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}
        onClick={() => mut.mutate()}>
        <Sparkles size={12} /> {mut.isPending ? "Generating…" : "Generate from description"}
      </button>
    </div>
  );
}

function SaveModal({ onSave, onCancel }: { onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div className="card card-body" style={{ width: 360 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Save Config</div>
        <input className="form-input" placeholder="Config name" autoFocus
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && name.trim() && onSave(name.trim())} />
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Terraform tab ──────────────────────────────────────────────────────────────

function TerraformGen() {
  const tenants = useTenants();
  const { flavors, networks, images } = useInventory();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "", flavor_name: "", flavor_vcpus: 0, flavor_ram_mb: 0,
    network_name: "", image_name: "", tenant_name: "", key_pair: "", count: 1,
  });
  const [hcl, setHcl] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  const tenantList = Array.from(tenants.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const internalNets = networks.filter(n => !n.external);

  const genMut = useMutation({
    mutationFn: () => apiFetch<{ hcl: string }>("/generate/terraform", {
      method: "POST", body: JSON.stringify(form),
    }),
    onSuccess: d => setHcl(d.hcl),
  });

  const saveMut = useMutation({
    mutationFn: (name: string) => apiFetch("/generate/saved", {
      method: "POST", body: JSON.stringify({ name, type: "terraform", content: { hcl, params: form } }),
    }),
    onSuccess: () => { setSaving(false); qc.invalidateQueries({ queryKey: ["generate", "saved"] }); },
  });

  return (
    <>
      {saving && <SaveModal onSave={name => saveMut.mutate(name)} onCancel={() => setSaving(false)} />}
      <NLPromptBar type="terraform" onResult={code => setHcl(code)} />
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FormField label="VM Name" required>
            <input className="form-input" placeholder="my-vm" value={form.name} onChange={e => set("name", e.target.value)} />
          </FormField>
          <FormField label="Flavor">
            <select className="form-select" value={form.flavor_name}
              onChange={e => {
                const f = flavors.find(fl => fl.name === e.target.value);
                set("flavor_name", e.target.value);
                if (f) { set("flavor_vcpus", f.vcpus); set("flavor_ram_mb", f.ram_mb); }
              }}>
              <option value="">— choose —</option>
              {flavors.map(f => (
                <option key={f.name} value={f.name}>{f.name} ({f.vcpus}v · {Math.round(f.ram_mb/1024)}GB)</option>
              ))}
            </select>
          </FormField>
          <FormField label="Image">
            <select className="form-select" value={form.image_name} onChange={e => set("image_name", e.target.value)}>
              <option value="">— choose —</option>
              {images.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}
            </select>
          </FormField>
          <FormField label="Network">
            <select className="form-select" value={form.network_name} onChange={e => set("network_name", e.target.value)}>
              <option value="">— choose —</option>
              {internalNets.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
            </select>
          </FormField>
          <FormField label="Tenant">
            <select className="form-select" value={form.tenant_name} onChange={e => set("tenant_name", e.target.value)}>
              <option value="">— choose —</option>
              {tenantList.map(([, name]) => <option key={name} value={name}>{name}</option>)}
            </select>
          </FormField>
          <FormField label="Key Pair">
            <input className="form-input" placeholder="my-key" value={form.key_pair} onChange={e => set("key_pair", e.target.value)} />
          </FormField>
          <FormField label="Count">
            <input type="number" min={1} max={20} className="form-input" value={form.count}
              onChange={e => set("count", Number(e.target.value))} />
          </FormField>
          <button className="btn btn-primary" disabled={!form.name || genMut.isPending}
            onClick={() => genMut.mutate()} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={13} /> {genMut.isPending ? "Generating…" : "Generate HCL"}
          </button>
        </div>
        <div>
          {!hcl && !genMut.isPending && <EmptyOutput title="Configure and generate" body="Fill in the form or describe your VM above and click Generate." />}
          {genMut.isPending && <p className="text-muted">AI is generating your Terraform config…</p>}
          {hcl && <CodeOutput code={hcl} filename="main.tf" onSave={() => setSaving(true)} />}
        </div>
      </div>
    </>
  );
}

// ── cloud-init tab ─────────────────────────────────────────────────────────────

const ROLE_PRESETS = [
  "NGINX web server", "PostgreSQL database", "Redis cache",
  "Docker host", "Kubernetes node", "Monitoring (Prometheus + Grafana)",
  "CI/CD runner", "VPN gateway",
];

function CloudInitGen() {
  const qc = useQueryClient();
  const [role, setRole] = useState("");
  const [hostname, setHostname] = useState("");
  const [extra, setExtra] = useState("");
  const [yaml, setYaml] = useState("");
  const [saving, setSaving] = useState(false);

  const genMut = useMutation({
    mutationFn: () => apiFetch<{ yaml: string }>("/generate/cloud-init", {
      method: "POST", body: JSON.stringify({ role, hostname, extra_notes: extra }),
    }),
    onSuccess: d => setYaml(d.yaml),
  });

  const saveMut = useMutation({
    mutationFn: (name: string) => apiFetch("/generate/saved", {
      method: "POST", body: JSON.stringify({ name, type: "cloud-init", content: { yaml, params: { role, hostname, extra } } }),
    }),
    onSuccess: () => { setSaving(false); qc.invalidateQueries({ queryKey: ["generate", "saved"] }); },
  });

  return (
    <>
      {saving && <SaveModal onSave={name => saveMut.mutate(name)} onCancel={() => setSaving(false)} />}
      <NLPromptBar type="cloud-init" onResult={code => setYaml(code)} />
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FormField label="Server Role" required>
            <input className="form-input" placeholder="e.g. nginx web server"
              value={role} onChange={e => setRole(e.target.value)} />
          </FormField>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {ROLE_PRESETS.map(p => (
              <button key={p} className="btn btn-secondary btn-sm"
                style={{ fontSize: 11, padding: "3px 7px" }} onClick={() => setRole(p)}>{p}</button>
            ))}
          </div>
          <FormField label="Hostname (optional)">
            <input className="form-input" placeholder="web-01" value={hostname} onChange={e => setHostname(e.target.value)} />
          </FormField>
          <FormField label="Extra notes (optional)">
            <textarea className="form-input" rows={3}
              placeholder="e.g. enable SSL, use port 8080, add monitoring user"
              value={extra} onChange={e => setExtra(e.target.value)}
              style={{ resize: "vertical", fontFamily: "var(--font)" }} />
          </FormField>
          <button className="btn btn-primary" disabled={!role.trim() || genMut.isPending}
            onClick={() => genMut.mutate()} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={13} /> {genMut.isPending ? "Generating…" : "Generate YAML"}
          </button>
        </div>
        <div>
          {!yaml && !genMut.isPending && <EmptyOutput title="Describe your server" body="Enter a role (or pick a preset) and generate cloud-init YAML." />}
          {genMut.isPending && <p className="text-muted">AI is generating your cloud-init config…</p>}
          {yaml && <CodeOutput code={yaml} filename="cloud-init.yaml" onSave={() => setSaving(true)} />}
        </div>
      </div>
    </>
  );
}

// ── Combined tab ───────────────────────────────────────────────────────────────

interface Profile { name: string; flavor_name: string; count: number; role: string; }

function CombinedGen() {
  const tenants = useTenants();
  const { flavors, networks, images } = useInventory();
  const qc = useQueryClient();
  const [profiles, setProfiles] = useState<Profile[]>([
    { name: "web", flavor_name: "", count: 2, role: "NGINX web server" },
  ]);
  const [network_name, setNetwork] = useState("");
  const [image_name, setImage] = useState("");
  const [tenant_name, setTenant] = useState("");
  const [key_pair, setKeyPair] = useState("");
  const [hcl, setHcl] = useState("");
  const [saving, setSaving] = useState(false);

  const tenantList = Array.from(tenants.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const internalNets = networks.filter(n => !n.external);

  const addProfile = () => setProfiles(p => [...p, { name: "", flavor_name: "", count: 1, role: "" }]);
  const removeProfile = (i: number) => setProfiles(p => p.filter((_, idx) => idx !== i));
  const setProfile = (i: number, k: keyof Profile, v: any) =>
    setProfiles(p => p.map((pr, idx) => idx === i ? { ...pr, [k]: v } : pr));

  const genMut = useMutation({
    mutationFn: () => apiFetch<{ hcl: string }>("/generate/combined", {
      method: "POST", body: JSON.stringify({ profiles, network_name, image_name, tenant_name, key_pair }),
    }),
    onSuccess: d => setHcl(d.hcl),
  });

  const saveMut = useMutation({
    mutationFn: (name: string) => apiFetch("/generate/saved", {
      method: "POST", body: JSON.stringify({ name, type: "combined", content: { hcl, params: { profiles, network_name, image_name, tenant_name } } }),
    }),
    onSuccess: () => { setSaving(false); qc.invalidateQueries({ queryKey: ["generate", "saved"] }); },
  });

  return (
    <>
      {saving && <SaveModal onSave={name => saveMut.mutate(name)} onCancel={() => setSaving(false)} />}
      <NLPromptBar type="combined" onResult={code => setHcl(code)} />
      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Global settings */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Image">
              <select className="form-select" value={image_name} onChange={e => setImage(e.target.value)}>
                <option value="">— choose —</option>
                {images.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}
              </select>
            </FormField>
            <FormField label="Network">
              <select className="form-select" value={network_name} onChange={e => setNetwork(e.target.value)}>
                <option value="">— choose —</option>
                {internalNets.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
              </select>
            </FormField>
            <FormField label="Tenant">
              <select className="form-select" value={tenant_name} onChange={e => setTenant(e.target.value)}>
                <option value="">— choose —</option>
                {tenantList.map(([, name]) => <option key={name} value={name}>{name}</option>)}
              </select>
            </FormField>
            <FormField label="Key Pair">
              <input className="form-input" placeholder="my-key" value={key_pair} onChange={e => setKeyPair(e.target.value)} />
            </FormField>
          </div>

          {/* Profile rows */}
          <div style={{ fontWeight: 600, fontSize: 12, color: "var(--gray-700)", marginTop: 4 }}>VM Profiles</div>
          {profiles.map((pr, i) => (
            <div key={i} style={{ border: "1px solid var(--gray-100)", borderRadius: 6, padding: 10, position: "relative" }}>
              {profiles.length > 1 && (
                <button onClick={() => removeProfile(i)}
                  style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", cursor: "pointer", color: "var(--gray-400)", padding: 2 }}>
                  <X size={13} />
                </button>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <FormField label="Profile Name">
                  <input className="form-input" placeholder="web" value={pr.name} onChange={e => setProfile(i, "name", e.target.value)} />
                </FormField>
                <FormField label="Count">
                  <input type="number" min={1} max={20} className="form-input" value={pr.count}
                    onChange={e => setProfile(i, "count", Number(e.target.value))} />
                </FormField>
                <FormField label="Flavor">
                  <select className="form-select" value={pr.flavor_name} onChange={e => setProfile(i, "flavor_name", e.target.value)}>
                    <option value="">— choose —</option>
                    {flavors.map(f => <option key={f.name} value={f.name}>{f.name} ({f.vcpus}v · {Math.round(f.ram_mb/1024)}GB)</option>)}
                  </select>
                </FormField>
                <FormField label="Role (cloud-init)">
                  <input className="form-input" placeholder="nginx web server" value={pr.role}
                    onChange={e => setProfile(i, "role", e.target.value)} />
                </FormField>
              </div>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={addProfile}
            style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Plus size={12} /> Add Profile
          </button>

          <button className="btn btn-primary"
            disabled={profiles.some(p => !p.name) || genMut.isPending}
            onClick={() => genMut.mutate()}
            style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <Sparkles size={13} /> {genMut.isPending ? "Generating…" : "Generate Combined Plan"}
          </button>
        </div>
        <div>
          {!hcl && !genMut.isPending && <EmptyOutput title="Multi-profile deployment" body="Define VM profiles with roles — generates one main.tf with embedded cloud-init per profile." />}
          {genMut.isPending && <p className="text-muted">AI is generating your combined Terraform plan…</p>}
          {hcl && <CodeOutput code={hcl} filename="main.tf" onSave={() => setSaving(true)} />}
        </div>
      </div>
    </>
  );
}

// ── Security Group tab ─────────────────────────────────────────────────────────

interface SgRule { direction: string; protocol: string; port_min: number | ""; port_max: number | ""; cidr: string; }

const SG_PRESETS: { label: string; rules: SgRule[] }[] = [
  { label: "Web Server", rules: [
    { direction: "ingress", protocol: "tcp", port_min: 80,  port_max: 80,  cidr: "0.0.0.0/0" },
    { direction: "ingress", protocol: "tcp", port_min: 443, port_max: 443, cidr: "0.0.0.0/0" },
  ]},
  { label: "SSH Jump", rules: [
    { direction: "ingress", protocol: "tcp", port_min: 22, port_max: 22, cidr: "0.0.0.0/0" },
  ]},
  { label: "Database", rules: [
    { direction: "ingress", protocol: "tcp", port_min: 5432, port_max: 5432, cidr: "10.0.0.0/8" },
    { direction: "ingress", protocol: "tcp", port_min: 3306, port_max: 3306, cidr: "10.0.0.0/8" },
  ]},
];

function SecurityGroupGen() {
  const tenants = useTenants();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tenant_name, setTenant] = useState("");
  const [rules, setRules] = useState<SgRule[]>([
    { direction: "ingress", protocol: "tcp", port_min: "", port_max: "", cidr: "0.0.0.0/0" },
  ]);
  const [hcl, setHcl] = useState("");
  const [saving, setSaving] = useState(false);

  const tenantList = Array.from(tenants.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const addRule = () => setRules(r => [...r, { direction: "ingress", protocol: "tcp", port_min: "", port_max: "", cidr: "0.0.0.0/0" }]);
  const setRule = (i: number, k: keyof SgRule, v: any) => setRules(r => r.map((rl, idx) => idx === i ? { ...rl, [k]: v } : rl));

  const genMut = useMutation({
    mutationFn: () => apiFetch<{ hcl: string }>("/generate/security-group", {
      method: "POST", body: JSON.stringify({ name, description, tenant_name, rules }),
    }),
    onSuccess: d => setHcl(d.hcl),
  });

  const saveMut = useMutation({
    mutationFn: (n: string) => apiFetch("/generate/saved", {
      method: "POST", body: JSON.stringify({ name: n, type: "security-group", content: { hcl, params: { name, description, tenant_name, rules } } }),
    }),
    onSuccess: () => { setSaving(false); qc.invalidateQueries({ queryKey: ["generate", "saved"] }); },
  });

  return (
    <>
      {saving && <SaveModal onSave={n => saveMut.mutate(n)} onCancel={() => setSaving(false)} />}
      <NLPromptBar type="security-group" onResult={code => setHcl(code)} />
      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FormField label="Group Name" required>
            <input className="form-input" placeholder="my-sg" value={name} onChange={e => setName(e.target.value)} />
          </FormField>
          <FormField label="Description">
            <input className="form-input" placeholder="Security group description" value={description} onChange={e => setDescription(e.target.value)} />
          </FormField>
          <FormField label="Tenant">
            <select className="form-select" value={tenant_name} onChange={e => setTenant(e.target.value)}>
              <option value="">— choose —</option>
              {tenantList.map(([, n]) => <option key={n} value={n}>{n}</option>)}
            </select>
          </FormField>

          {/* Presets */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SG_PRESETS.map(p => (
              <button key={p.label} className="btn btn-secondary btn-sm"
                style={{ fontSize: 11 }}
                onClick={() => setRules(p.rules)}>{p.label}</button>
            ))}
          </div>

          {/* Rules */}
          <div style={{ fontWeight: 600, fontSize: 12, color: "var(--gray-700)" }}>Rules</div>
          {rules.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 60px 60px 1fr auto", gap: 4, alignItems: "end" }}>
              <select className="form-select" style={{ fontSize: 11 }} value={r.direction} onChange={e => setRule(i, "direction", e.target.value)}>
                <option value="ingress">Ingress</option>
                <option value="egress">Egress</option>
              </select>
              <select className="form-select" style={{ fontSize: 11 }} value={r.protocol} onChange={e => setRule(i, "protocol", e.target.value)}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="icmp">ICMP</option>
                <option value="">Any</option>
              </select>
              <input className="form-input" style={{ fontSize: 11 }} placeholder="From" type="number" value={r.port_min}
                onChange={e => setRule(i, "port_min", e.target.value === "" ? "" : Number(e.target.value))} />
              <input className="form-input" style={{ fontSize: 11 }} placeholder="To" type="number" value={r.port_max}
                onChange={e => setRule(i, "port_max", e.target.value === "" ? "" : Number(e.target.value))} />
              <input className="form-input" style={{ fontSize: 11 }} placeholder="CIDR" value={r.cidr}
                onChange={e => setRule(i, "cidr", e.target.value)} />
              <button onClick={() => setRules(rs => rs.filter((_, idx) => idx !== i))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gray-400)", padding: 4 }}>
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={addRule}
            style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Plus size={12} /> Add Rule
          </button>

          <button className="btn btn-primary" disabled={!name || genMut.isPending}
            onClick={() => genMut.mutate()} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <Sparkles size={13} /> {genMut.isPending ? "Generating…" : "Generate Security Group HCL"}
          </button>
        </div>
        <div>
          {!hcl && !genMut.isPending && <EmptyOutput title="Security group config" body="Define rules and click Generate for Terraform HCL." />}
          {genMut.isPending && <p className="text-muted">Generating security group Terraform…</p>}
          {hcl && <CodeOutput code={hcl} filename="secgroup.tf" onSave={() => setSaving(true)} />}
        </div>
      </div>
    </>
  );
}

// ── Load Balancer tab ──────────────────────────────────────────────────────────

interface LbMember { address: string; port: number | ""; }

function LoadBalancerGen() {
  const tenants = useTenants();
  const { networks } = useInventory();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [network_name, setNetwork] = useState("");
  const [protocol, setProtocol] = useState("HTTP");
  const [port, setPort] = useState<number>(80);
  const [health_monitor, setHealthMonitor] = useState("HTTP");
  const [tls_termination, setTls] = useState(false);
  const [tenant_name, setTenant] = useState("");
  const [members, setMembers] = useState<LbMember[]>([{ address: "", port: 8080 }]);
  const [hcl, setHcl] = useState("");
  const [saving, setSaving] = useState(false);

  const tenantList = Array.from(tenants.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const internalNets = networks.filter(n => !n.external);
  const addMember = () => setMembers(m => [...m, { address: "", port: 8080 }]);
  const setMember = (i: number, k: keyof LbMember, v: any) =>
    setMembers(m => m.map((mb, idx) => idx === i ? { ...mb, [k]: v } : mb));

  const genMut = useMutation({
    mutationFn: () => apiFetch<{ hcl: string }>("/generate/load-balancer", {
      method: "POST", body: JSON.stringify({ name, network_name, protocol, port, health_monitor, tls_termination, tenant_name, members }),
    }),
    onSuccess: d => setHcl(d.hcl),
  });

  const saveMut = useMutation({
    mutationFn: (n: string) => apiFetch("/generate/saved", {
      method: "POST", body: JSON.stringify({ name: n, type: "load-balancer", content: { hcl, params: { name, network_name, protocol, port, members } } }),
    }),
    onSuccess: () => { setSaving(false); qc.invalidateQueries({ queryKey: ["generate", "saved"] }); },
  });

  return (
    <>
      {saving && <SaveModal onSave={n => saveMut.mutate(n)} onCancel={() => setSaving(false)} />}
      <NLPromptBar type="load-balancer" onResult={code => setHcl(code)} />
      <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FormField label="LB Name" required>
            <input className="form-input" placeholder="my-lb" value={name} onChange={e => setName(e.target.value)} />
          </FormField>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Protocol">
              <select className="form-select" value={protocol} onChange={e => setProtocol(e.target.value)}>
                <option>HTTP</option><option>HTTPS</option><option>TCP</option>
              </select>
            </FormField>
            <FormField label="Port">
              <input type="number" className="form-input" value={port} onChange={e => setPort(Number(e.target.value))} />
            </FormField>
            <FormField label="VIP Network">
              <select className="form-select" value={network_name} onChange={e => setNetwork(e.target.value)}>
                <option value="">— choose —</option>
                {internalNets.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
              </select>
            </FormField>
            <FormField label="Health Monitor">
              <select className="form-select" value={health_monitor} onChange={e => setHealthMonitor(e.target.value)}>
                <option>HTTP</option><option>TCP</option><option>PING</option>
              </select>
            </FormField>
            <FormField label="Tenant">
              <select className="form-select" value={tenant_name} onChange={e => setTenant(e.target.value)}>
                <option value="">— choose —</option>
                {tenantList.map(([, n]) => <option key={n} value={n}>{n}</option>)}
              </select>
            </FormField>
            <FormField label="TLS Termination">
              <div style={{ paddingTop: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={tls_termination} onChange={e => setTls(e.target.checked)} />
                  Enable TLS
                </label>
              </div>
            </FormField>
          </div>

          <div style={{ fontWeight: 600, fontSize: 12, color: "var(--gray-700)" }}>Backend Members</div>
          {members.map((m, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px auto", gap: 6, alignItems: "end" }}>
              <input className="form-input" style={{ fontSize: 12 }} placeholder="IP address" value={m.address}
                onChange={e => setMember(i, "address", e.target.value)} />
              <input type="number" className="form-input" style={{ fontSize: 12 }} placeholder="Port" value={m.port}
                onChange={e => setMember(i, "port", e.target.value === "" ? "" : Number(e.target.value))} />
              <button onClick={() => setMembers(ms => ms.filter((_, idx) => idx !== i))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gray-400)", padding: 4 }}>
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={addMember}
            style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Plus size={12} /> Add Member
          </button>

          <button className="btn btn-primary" disabled={!name || genMut.isPending}
            onClick={() => genMut.mutate()} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <Sparkles size={13} /> {genMut.isPending ? "Generating…" : "Generate Load Balancer HCL"}
          </button>
        </div>
        <div>
          {!hcl && !genMut.isPending && <EmptyOutput title="Load balancer config" body="Configure your LB and click Generate for Terraform HCL." />}
          {genMut.isPending && <p className="text-muted">Generating load balancer Terraform…</p>}
          {hcl && <CodeOutput code={hcl} filename="loadbalancer.tf" onSave={() => setSaving(true)} />}
        </div>
      </div>
    </>
  );
}

// ── Saved Configs tab ──────────────────────────────────────────────────────────

function SavedConfigs() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<SavedCfg | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: configs = [], isLoading } = useQuery<SavedCfg[]>({
    queryKey: ["generate", "saved"],
    queryFn: () => apiFetch("/generate/saved"),
  });

  const { data: detail } = useQuery<SavedCfg>({
    queryKey: ["generate", "saved", selected?.id],
    queryFn: () => apiFetch(`/generate/saved/${selected!.id}`),
    enabled: !!selected,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/generate/saved/${id}`, { method: "DELETE" }),
    onSuccess: () => { setSelected(null); qc.invalidateQueries({ queryKey: ["generate", "saved"] }); },
  });

  const code = detail?.content?.hcl || detail?.content?.yaml || "";
  const filename = detail?.type === "cloud-init" ? "cloud-init.yaml" : "main.tf";

  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const TYPE_LABELS: Record<string, string> = {
    "terraform": "Terraform HCL", "cloud-init": "cloud-init YAML",
    "combined": "Combined", "security-group": "Security Group", "load-balancer": "Load Balancer",
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: "1rem", alignItems: "start" }}>
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-header"><span className="card-title">Saved Configs</span></div>
        {isLoading && <p className="text-muted" style={{ padding: "12px 16px" }}>Loading…</p>}
        {!isLoading && configs.length === 0 && (
          <p className="text-muted" style={{ padding: "16px", fontSize: 13 }}>
            No saved configs yet. Generate a config and click Save.
          </p>
        )}
        {configs.map(cfg => (
          <div key={cfg.id}
            onClick={() => setSelected(cfg)}
            style={{
              padding: "10px 16px", cursor: "pointer", borderBottom: "1px solid var(--gray-50)",
              background: selected?.id === cfg.id ? "var(--gray-50)" : undefined,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{cfg.name}</div>
              <div style={{ fontSize: 11, color: "var(--gray-500)" }}>{TYPE_LABELS[cfg.type] || cfg.type}</div>
            </div>
            <button onClick={e => { e.stopPropagation(); deleteMut.mutate(cfg.id); }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gray-300)", padding: 4 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <div>
        {!selected && (
          <div className="empty" style={{ padding: "48px 24px" }}>
            <FolderOpen size={32} style={{ color: "var(--gray-300)", marginBottom: 12 }} />
            <div className="empty-title">Select a saved config</div>
            <div className="empty-body">Click a config from the list to view its content.</div>
          </div>
        )}
        {selected && detail && code && (
          <div className="card" style={{ overflow: "hidden" }}>
            <div className="card-header">
              <span className="card-title" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{filename}</span>
              <button className="btn btn-secondary btn-sm" onClick={copy}
                style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Copy size={12} />{copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre style={{
              padding: "14px 16px", margin: 0, overflow: "auto", maxHeight: "calc(100vh - 280px)",
              fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--gray-800)",
              background: "var(--gray-50)", lineHeight: 1.6,
            }}>{code}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
