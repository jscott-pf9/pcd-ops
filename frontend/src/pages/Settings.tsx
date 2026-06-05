import { useEffect, useRef, useState } from "react";
import { type AppSettings, getSettings, saveSettings } from "../api/settings";
import { checkForUpdate, getUpdateLog, getVersion, triggerUpdate, type UpdateCheck, type VersionInfo } from "../api/system";

const EMPTY: AppSettings = {
  os_auth_url: "",
  os_username: "",
  os_password: "",
  os_project_name: "",
  os_user_domain_name: "Default",
  os_project_domain_name: "Default",
  os_region_name: "",
  prometheus_url: "",
  grafana_url: "",
  grafana_token: "",
  ai_backend: "ollama",
  ai_url: "",
  ai_model: "",
  ai_api_key: "",
};

export default function Settings() {
  const [form, setForm] = useState<AppSettings>(EMPTY);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updatePhase, setUpdatePhase] = useState<"idle" | "checking" | "updating" | "restarting" | "done" | "error">("idle");
  const [updateLog, setUpdateLog] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getSettings()
      .then((data) => setForm(data))
      .catch(() => {/* backend not ready yet, use empty form */});
    getVersion()
      .then(setVersion)
      .catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function set(field: keyof AppSettings, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (status !== "idle") setStatus("idle");
  }

  async function handleCheckUpdate() {
    setUpdatePhase("checking");
    setUpdateCheck(null);
    try {
      const result = await checkForUpdate();
      setUpdateCheck(result);
      setUpdatePhase("idle");
    } catch (err) {
      setUpdateLog(String(err));
      setUpdatePhase("error");
    }
  }

  async function handleUpdate() {
    setUpdatePhase("updating");
    setUpdateLog("");
    try {
      await triggerUpdate();
    } catch (err) {
      setUpdateLog(String(err));
      setUpdatePhase("error");
      return;
    }

    // Poll log while update runs, then poll /api/health once service restarts
    setUpdatePhase("restarting");
    let logInterval = setInterval(async () => {
      try { setUpdateLog((await getUpdateLog()).log); } catch (_) {}
    }, 1500);

    // Wait for the service to go down then come back
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    clearInterval(logInterval);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const v = await getVersion();
          setVersion(v);
          setUpdateCheck(null);
          setUpdatePhase("done");
        }
      } catch (_) { /* server not up yet */ }
    }, 2000);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError("");
    try {
      await saveSettings(form);
      setStatus("saved");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <h1>Settings</h1>
      <p className="page-subtitle">
        Configure credentials for OpenStack, Grafana, and the AI backend. Changes take effect
        immediately without restarting the server.
      </p>

      <form onSubmit={handleSave}>
        <Section title="OpenStack / PCD">
          <Field label="Auth URL"      value={form.os_auth_url}            onChange={(v) => set("os_auth_url", v)}            placeholder="https://…/keystone/v3" />
          <Field label="Username"      value={form.os_username}            onChange={(v) => set("os_username", v)}            placeholder="user@example.com" />
          <Field label="Password"      value={form.os_password}            onChange={(v) => set("os_password", v)}            secret placeholder="leave blank to keep existing" />
          <Field label="Project Name"  value={form.os_project_name}        onChange={(v) => set("os_project_name", v)}        placeholder="service" />
          <Row>
            <Field label="User Domain"    value={form.os_user_domain_name}    onChange={(v) => set("os_user_domain_name", v)} />
            <Field label="Project Domain" value={form.os_project_domain_name} onChange={(v) => set("os_project_domain_name", v)} />
            <Field label="Region"         value={form.os_region_name}         onChange={(v) => set("os_region_name", v)}         placeholder="RegionOne" />
          </Row>
        </Section>

        <Section title="Grafana / Prometheus">
          <Field label="Prometheus URL" value={form.prometheus_url} onChange={(v) => set("prometheus_url", v)} placeholder="https://…/grafana/api/datasources/proxy/1" />
          <Field label="Grafana URL"    value={form.grafana_url}    onChange={(v) => set("grafana_url", v)}    placeholder="https://…/grafana/" />
          <Field label="Grafana Token"  value={form.grafana_token}  onChange={(v) => set("grafana_token", v)}  secret placeholder="glsa_… (leave blank to keep existing)" />
        </Section>

        <Section title="AI Backend">
          <div className="form-group">
            <label className="form-label">Backend</label>
            <select
              value={form.ai_backend}
              onChange={(e) => set("ai_backend", e.target.value)}
              className="form-select"
              style={{ width: "auto" }}
            >
              <option value="ollama">Ollama</option>
              <option value="claude">Claude (Anthropic)</option>
            </select>
          </div>
          <Row>
            <Field label="URL"   value={form.ai_url}   onChange={(v) => set("ai_url", v)}   placeholder="http://localhost:11434" />
            <Field label="Model" value={form.ai_model} onChange={(v) => set("ai_model", v)} placeholder="llama3.1:8b" />
          </Row>
          {form.ai_backend === "claude" && (
            <Field label="API Key" value={form.ai_api_key} onChange={(v) => set("ai_api_key", v)} secret placeholder="sk-ant-… (leave blank to keep existing)" />
          )}
        </Section>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "1.5rem" }}>
          <button type="submit" disabled={status === "saving"} className="btn btn-primary">
            {status === "saving" ? "Saving…" : "Save Settings"}
          </button>
          {status === "saved" && <span className="text-success">Saved successfully</span>}
          {status === "error" && <span className="text-danger">{error}</span>}
        </div>
      </form>

      <Section title="Software">
        <div style={{ marginBottom: "0.75rem", fontSize: 13, color: "var(--gray-600)" }}>
          {version ? (
            <span>
              {version.tag ?? version.branch} &nbsp;·&nbsp;
              <code style={{ fontFamily: "monospace" }}>{version.commit}</code>
            </span>
          ) : (
            <span>Loading version…</span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={updatePhase === "checking" || updatePhase === "updating" || updatePhase === "restarting"}
            onClick={handleCheckUpdate}
          >
            {updatePhase === "checking" ? "Checking…" : "Check for Updates"}
          </button>

          {updateCheck && (
            updateCheck.up_to_date
              ? <span className="text-success">Up to date</span>
              : <span style={{ color: "var(--gray-700)" }}>
                  Update available &nbsp;
                  <code style={{ fontFamily: "monospace" }}>{updateCheck.local}</code>
                  {" → "}
                  <code style={{ fontFamily: "monospace" }}>{updateCheck.remote}</code>
                </span>
          )}

          {updateCheck && !updateCheck.up_to_date && updatePhase === "idle" && (
            <button type="button" className="btn btn-primary" onClick={handleUpdate}>
              Update &amp; Restart
            </button>
          )}

          {updatePhase === "updating" && <span style={{ color: "var(--gray-600)" }}>Building…</span>}
          {updatePhase === "restarting" && <span style={{ color: "var(--gray-600)" }}>Restarting service…</span>}
          {updatePhase === "done" && <span className="text-success">Updated successfully</span>}
          {updatePhase === "error" && <span className="text-danger">Update failed</span>}
        </div>

        {(updatePhase === "updating" || updatePhase === "restarting" || updatePhase === "error") && updateLog && (
          <pre style={{
            marginTop: "0.75rem", padding: "0.75rem",
            background: "var(--gray-50)", border: "1px solid var(--gray-200)",
            borderRadius: "var(--radius)", fontSize: 12,
            fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto",
          }}>
            {updateLog}
          </pre>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid var(--gray-200)", borderRadius: "var(--radius)", padding: "1rem 1.25rem", marginBottom: "1.25rem" }}>
      <legend style={{ fontWeight: 600, color: "var(--gray-800)", padding: "0 0.5rem", fontSize: 13 }}>{title}</legend>
      {children}
    </fieldset>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: "1rem" }}>{children}</div>;
}

function Field({
  label, value, onChange, placeholder, secret,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean;
}) {
  return (
    <div style={{ flex: 1, marginBottom: "0.75rem" }}>
      <label className="form-label">{label}</label>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="form-input"
        autoComplete={secret ? "new-password" : undefined}
      />
    </div>
  );
}
