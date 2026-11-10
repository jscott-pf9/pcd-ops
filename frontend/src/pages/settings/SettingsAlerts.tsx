import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type AlertRecord, type Channel, listAlerts, testAlert } from "../../api/alerts";
import { errorDetail } from "../../api/client";
import type { Severity } from "../../api/settings";
import { useSettings } from "./useSettings";
import { Field, Fieldset, Row, SaveRow, TestResult } from "./form";

const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const SEV_BADGE: Record<string, string> = { low: "badge-neutral", medium: "badge-warn", high: "badge-error", critical: "badge-error" };
const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", webhook: "Webhook", slack: "Slack" };

export default function SettingsAlerts() {
  const { form, set, status, error, save } = useSettings([
    "smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_from", "alert_email_to", "webhook_url",
    "slack_webhook_url", "alert_base_url", "alert_cooldown_min",
    "alert_anomaly_enabled", "alert_anomaly_min", "alert_drift_enabled", "alert_drift_min",
    "alert_jobs_enabled", "alert_jobs_success",
  ]);
  const qc = useQueryClient();
  const onSave = async (e: React.FormEvent) => {
    await save(e);
    qc.invalidateQueries({ queryKey: ["alerts"] });
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <form onSubmit={onSave}>
        <Fieldset title="What sends an alert">
          <SourceRule label="Anomalies" help="A VM or host far from its usual load (Anomaly page)."
            on={form.alert_anomaly_enabled ?? true} min={form.alert_anomaly_min ?? "high"}
            onOn={v => set("alert_anomaly_enabled", v)} onMin={v => set("alert_anomaly_min", v)} />
          <SourceRule label="Config changes" help="Flavors, security groups, quotas, aggregates or hosts changed (Config Changes page)."
            on={form.alert_drift_enabled ?? true} min={form.alert_drift_min ?? "medium"}
            onOn={v => set("alert_drift_enabled", v)} onMin={v => set("alert_drift_min", v)} />
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "4px 0 10px" }}>
            <Check label="Jobs" checked={form.alert_jobs_enabled ?? true} onChange={v => set("alert_jobs_enabled", v)} />
            <span className="text-muted" style={{ fontSize: 12 }}>A job that fails (high) or has items that fail (medium).</span>
            <Check label="Also when a job succeeds" checked={form.alert_jobs_success ?? false}
              onChange={v => set("alert_jobs_success", v)} disabled={!(form.alert_jobs_enabled ?? true)} />
          </div>
          <Row>
            <Field label="Cooldown (minutes)" value={String(form.alert_cooldown_min ?? 60)}
              onChange={v => set("alert_cooldown_min", Math.max(0, Number(v) || 0))}
              help="The same alert again within this is recorded but not sent, unless it got more severe." />
            <Field label="PCD Ops address" value={form.alert_base_url ?? ""} onChange={v => set("alert_base_url", v)}
              placeholder="http://pcd-ops.example.com"
              help="How people reach this appliance; alerts link to the page they're about. Blank: no links." />
          </Row>
        </Fieldset>

        <Fieldset title="Slack">
          <Field label="Incoming webhook URL" value={form.slack_webhook_url ?? ""} onChange={v => set("slack_webhook_url", v)}
            secret placeholder="https://hooks.slack.com/services/… (blank keeps the saved one)"
            help="In your Slack app's settings: Incoming Webhooks → Add New Webhook to Workspace, pick the channel." />
          <TestButton channel="slack" />
        </Fieldset>

        <Fieldset title="Email (SMTP)">
          <Row>
            <Field label="SMTP host" value={form.smtp_host ?? ""} onChange={v => set("smtp_host", v)} placeholder="smtp.example.com"
              help="Your mail relay, reachable from the appliance." />
            <Field label="Port" value={form.smtp_port ?? "587"} onChange={v => set("smtp_port", v)} placeholder="587"
              help="587 uses STARTTLS; 25 sends without TLS." />
          </Row>
          <Row>
            <Field label="Username" value={form.smtp_user ?? ""} onChange={v => set("smtp_user", v)} placeholder="alerts@example.com"
              help="Leave blank if the relay doesn't need a login." />
            <Field label="Password" value={form.smtp_password ?? ""} onChange={v => set("smtp_password", v)} secret placeholder="leave blank to keep" />
          </Row>
          <Field label="From address" value={form.smtp_from ?? ""} onChange={v => set("smtp_from", v)} placeholder="pcd-ops@example.com"
            help="Defaults to the username." />
          <Field label="Alert recipients" value={form.alert_email_to ?? ""} onChange={v => set("alert_email_to", v)} placeholder="oncall@example.com"
            help="Comma-separated. Capacity reports go to the addresses set on each report job." />
          <TestButton channel="email" />
        </Fieldset>

        <Fieldset title="Webhook">
          <Field label="Webhook URL" value={form.webhook_url ?? ""} onChange={v => set("webhook_url", v)}
            placeholder="https://your-endpoint/alerts"
            help={<>PCD Ops POSTs JSON: <code>{`{"source":"pcd-ops","severity":"high","subject":"…","body":"…","alert_source":"job","key":"job:3","fields":[…],"link":"…"}`}</code>.
              For Slack, use the Slack section above.</>} />
          <TestButton channel="webhook" />
        </Fieldset>

        <SaveRow status={status} error={error}>
          <span className="text-muted" style={{ fontSize: 12 }}>Save before testing a channel you just changed.</span>
        </SaveRow>
      </form>

      <RecentAlerts />
    </div>
  );
}

function Check({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function SourceRule({ label, help, on, min, onOn, onMin }: {
  label: string; help: string; on: boolean; min: Severity;
  onOn: (v: boolean) => void; onMin: (v: Severity) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
      <div style={{ minWidth: 140 }}><Check label={label} checked={on} onChange={onOn} /></div>
      <label style={{ fontSize: 12, color: "var(--gray-600)", display: "flex", gap: 6, alignItems: "center", opacity: on ? 1 : 0.5 }}>
        at least
        <select className="form-select" value={min} disabled={!on} style={{ width: "auto", padding: "2px 8px" }}
          onChange={e => onMin(e.target.value as Severity)}>
          {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <span className="text-muted" style={{ fontSize: 12, flex: "1 1 260px" }}>{help}</span>
    </div>
  );
}

function TestButton({ channel }: { channel: Channel }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const r = await testAlert(channel);
      const why = r[channel];
      setResult(why ? { ok: false, text: why === "not configured" ? "Not set up: save its settings first." : why } : { ok: true, text: "Sent." });
    } catch (e) {
      setResult({ ok: false, text: errorDetail(e) });
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ["alerts"] });
    }
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={run}>
        {busy ? "Sending…" : `Send test to ${CHANNEL_LABEL[channel]}`}
      </button>
      <TestResult result={result} />
    </div>
  );
}

function RecentAlerts() {
  const { data } = useQuery({ queryKey: ["alerts"], queryFn: () => listAlerts(50), refetchInterval: 60_000 });
  const rows = data?.alerts ?? [];
  return (
    <div className="card" style={{ marginTop: "1.5rem" }}>
      <div className="card-header">
        <span className="card-title">Recent alerts</span>
        <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>
          {data && (data.channels.length
            ? `Sending to ${data.channels.map(c => CHANNEL_LABEL[c]).join(", ")}`
            : "No channel is set up: alerts are only recorded here")}
        </span>
      </div>
      {rows.length === 0
        ? <div className="card-body"><p className="text-muted" style={{ margin: 0 }}>No alerts yet.</p></div>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Source</th><th>Severity</th><th>Alert</th><th>Channels</th></tr></thead>
              <tbody>{rows.map(a => <AlertRow key={a.id} a={a} />)}</tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function AlertRow({ a }: { a: AlertRecord }) {
  const when = new Date(a.at.endsWith("Z") ? a.at : `${a.at}Z`);
  const channels = Object.entries(a.results) as [Channel, string | null][];
  return (
    <tr title={a.body}>
      <td style={{ whiteSpace: "nowrap", fontSize: 12 }}>{when.toLocaleString()}</td>
      <td style={{ fontSize: 12 }}>{a.source}</td>
      <td><span className={`badge ${SEV_BADGE[a.severity] ?? "badge-neutral"}`}>{a.severity}</span></td>
      <td style={{ fontSize: 13 }}>{a.title}</td>
      <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>
        {a.suppressed ? <span className="text-muted" title="The same alert was sent within the cooldown">suppressed (cooldown)</span>
          : channels.length === 0 ? <span className="text-muted">none set up</span>
          : channels.map(([c, why]) => (
              <span key={c} title={why ?? "Sent"} style={{ marginRight: 8, color: why ? "var(--red)" : "var(--green)" }}>
                {why ? "✗" : "✓"} {CHANNEL_LABEL[c]}
              </span>
            ))}
      </td>
    </tr>
  );
}
