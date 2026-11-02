import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAccess } from "../../api/auth";
import { errorDetail } from "../../api/client";
import { testMetrics } from "../../api/settings";
import { BackgroundAccessCard, ConnectionCard } from "../../components/PcdAccess";
import { Field, Fieldset, Row, SaveRow, TestResult } from "./form";
import { useSettings } from "./useSettings";

export default function SettingsConnection() {
  const { form, set, status, error, save } = useSettings([
    "grafana_url", "grafana_token", "prometheus_url",
    "hypervisor_ssh_user", "hypervisor_ssh_key_path", "hypervisor_ssh_password",
  ]);
  // PCD: read-only connection from config.env, and background access (APPLIANCE_STANDARD §7.8).
  // There are no PCD credential fields: people log in with their own PCD account.
  const { data: access, error: accessError } = useQuery({ queryKey: ["access"], queryFn: getAccess });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const grafana = (form.grafana_url || form.grafana_url_default || "").replace(/\/$/, "");

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await testMetrics({ grafana_url: form.grafana_url, grafana_token: form.grafana_token,
                                    prometheus_url: form.prometheus_url });
      setResult(r.ok
        ? { ok: true, text: `Connected. Metrics come from ${r.datasource ? `the “${r.datasource}” data source` : r.prometheus_url}.` }
        : { ok: false, text: r.error ?? "Failed" });
    } catch (err) {
      setResult({ ok: false, text: errorDetail(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      {accessError && <p className="text-danger">{errorDetail(accessError)}</p>}
      {access && <ConnectionCard connection={access.connection} />}
      {access && <BackgroundAccessCard access={access} />}

      <form onSubmit={save}>
        <Fieldset title="Metrics (Grafana)">
          <Field label="Grafana URL" value={form.grafana_url} onChange={v => set("grafana_url", v)}
            placeholder={form.grafana_url_default || "https://<PCD host>/grafana"}
            help={<>Leave blank to use <code>{form.grafana_url_default || "https://<PCD host>/grafana"}</code>:
              PCD serves Grafana under <code>/grafana</code> on the host of its Keystone URL. Enter a
              URL only if your Grafana is somewhere else.</>} />
          <Field label="Grafana service account token" value={form.grafana_token}
            onChange={v => set("grafana_token", v)} secret placeholder="glsa_… (leave blank to keep)"
            help={<>In Grafana{grafana && <> (<a href={grafana} target="_blank" rel="noreferrer">{grafana}</a>)</>}, as
              an admin: <strong>Administration → Users and access → Service accounts → Add service
              account</strong>, role <strong>Viewer</strong>; then <strong>Add service account
              token</strong>. Copy the token, which starts with <code>glsa_</code>; Grafana shows it
              only once.</>} />

          {(advanced || form.prometheus_url) ? (
            <Field label="Prometheus URL (optional)" value={form.prometheus_url}
              onChange={v => set("prometheus_url", v)}
              placeholder={grafana ? `${grafana}/api/datasources/proxy/<id>` : ""}
              help={<>Leave blank and PCD Ops finds Grafana's Prometheus data source itself. Set it
                only to use a different data source: <code>&lt;Grafana URL&gt;/api/datasources/proxy/&lt;id&gt;</code>,
                where the ID is in the data source's settings URL in Grafana.</>} />
          ) : (
            <button type="button" className="btn btn-sm btn-secondary" style={{ marginBottom: "0.5rem" }}
              onClick={() => setAdvanced(true)}>Use a specific Prometheus data source…</button>
          )}

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing} onClick={runTest}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <TestResult result={result} />
          </div>
        </Fieldset>

        <Fieldset title="Hypervisor SSH (logs and pending OS updates)">
          <Row>
            <Field label="SSH user" value={form.hypervisor_ssh_user ?? "root"}
              onChange={v => set("hypervisor_ssh_user", v)} placeholder="root"
              help="An account on every hypervisor that can read /var/log and run apt." />
            <Field label="Private key path" value={form.hypervisor_ssh_key_path ?? ""}
              onChange={v => set("hypervisor_ssh_key_path", v)} placeholder="/var/lib/pcd-ops/id_ed25519"
              help="A key file on this appliance, readable by the pcd-ops service." />
          </Row>
          <Field label="SSH password (if no key)" value={form.hypervisor_ssh_password ?? ""}
            onChange={v => set("hypervisor_ssh_password", v)} secret
            placeholder="leave blank to keep, or to use the key" />
        </Fieldset>

        <SaveRow status={status} error={error} />
      </form>
    </div>
  );
}
