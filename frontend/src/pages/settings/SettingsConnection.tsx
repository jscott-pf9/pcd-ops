import { useSettings } from "./useSettings";

export default function SettingsConnection() {
  const { form, set, status, error, save } = useSettings();

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>PCD &amp; Metrics</h1>
      <form onSubmit={save}>
        <Fieldset title="PCD Connection">
          <Field label="Auth URL"      value={form.os_auth_url}            onChange={v => set("os_auth_url", v)}            placeholder="https://…/keystone/v3" />
          <Field label="Username"      value={form.os_username}            onChange={v => set("os_username", v)}            placeholder="user@example.com" />
          <Field label="Password"      value={form.os_password}            onChange={v => set("os_password", v)}            secret placeholder="leave blank to keep" />
          <Field label="Project Name"  value={form.os_project_name}        onChange={v => set("os_project_name", v)}        placeholder="service" />
          <Row>
            <Field label="User Domain"    value={form.os_user_domain_name}    onChange={v => set("os_user_domain_name", v)} />
            <Field label="Project Domain" value={form.os_project_domain_name} onChange={v => set("os_project_domain_name", v)} />
            <Field label="Region"         value={form.os_region_name}         onChange={v => set("os_region_name", v)}         placeholder="RegionOne" />
          </Row>
        </Fieldset>

        <Fieldset title="Grafana / Prometheus">
          <Field label="Prometheus URL" value={form.prometheus_url} onChange={v => set("prometheus_url", v)} placeholder="https://…/grafana/api/datasources/proxy/1" />
          <Field label="Grafana URL"    value={form.grafana_url}    onChange={v => set("grafana_url", v)}    placeholder="https://…/grafana/" />
          <Field label="Grafana Token"  value={form.grafana_token}  onChange={v => set("grafana_token", v)}  secret placeholder="glsa_… (leave blank to keep)" />
        </Fieldset>

        <Fieldset title="Hypervisor SSH (log collection)">
          <Row>
            <Field label="SSH User" value={form.hypervisor_ssh_user ?? "root"} onChange={v => set("hypervisor_ssh_user" as any, v)} placeholder="root" />
            <Field label="Private Key Path" value={form.hypervisor_ssh_key_path ?? ""} onChange={v => set("hypervisor_ssh_key_path" as any, v)} placeholder="~/.ssh/id_rsa" />
          </Row>
          <Field label="SSH Password (fallback)" value={form.hypervisor_ssh_password ?? ""} onChange={v => set("hypervisor_ssh_password" as any, v)} secret placeholder="leave blank to use key-based auth" />
        </Fieldset>

        <SaveRow status={status} error={error} />
      </form>
    </div>
  );
}

// ── Shared form helpers ────────────────────────────────────────────────────────

export function Fieldset({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid var(--gray-200)", borderRadius: "var(--radius)", padding: "0.75rem 1rem", marginBottom: "1rem" }}>
      <legend style={{ fontWeight: 600, color: "var(--gray-800)", padding: "0 0.4rem", fontSize: 12 }}>{title}</legend>
      {children}
    </fieldset>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: "0.75rem" }}>{children}</div>;
}

export function Field({ label, value, onChange, placeholder, secret }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean;
}) {
  return (
    <div style={{ flex: 1, marginBottom: "0.6rem" }}>
      <label className="form-label">{label}</label>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="form-input"
        autoComplete={secret ? "new-password" : undefined}
      />
    </div>
  );
}

export function SaveRow({ status, error }: { status: string; error: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.75rem" }}>
      <button type="submit" disabled={status === "saving"} className="btn btn-primary">
        {status === "saving" ? "Saving…" : "Save"}
      </button>
      {status === "saved" && <span className="text-success">Saved</span>}
      {status === "error"  && <span className="text-danger">{error}</span>}
    </div>
  );
}
