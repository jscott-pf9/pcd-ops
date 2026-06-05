import { useSettings } from "./useSettings";
import { Fieldset, Row, Field, SaveRow } from "./SettingsConnection";

export default function SettingsAlerts() {
  const { form, set, status, error, save } = useSettings();

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Alerts</h1>
      <form onSubmit={save}>
        <Fieldset title="Email (SMTP)">
          <Row>
            <Field label="SMTP Host" value={form.smtp_host ?? ""} onChange={v => set("smtp_host" as any, v)} placeholder="smtp.example.com" />
            <Field label="Port"      value={form.smtp_port ?? "587"} onChange={v => set("smtp_port" as any, v)} placeholder="587" />
          </Row>
          <Row>
            <Field label="Username" value={form.smtp_user ?? ""} onChange={v => set("smtp_user" as any, v)} placeholder="alerts@example.com" />
            <Field label="Password" value={form.smtp_password ?? ""} onChange={v => set("smtp_password" as any, v)} secret placeholder="leave blank to keep" />
          </Row>
          <Field label="From address" value={form.smtp_from ?? ""} onChange={v => set("smtp_from" as any, v)} placeholder="pcd-ops@example.com" />
          <Field label="Alert recipient" value={form.alert_email_to ?? ""} onChange={v => set("alert_email_to" as any, v)} placeholder="oncall@example.com" />
        </Fieldset>

        <Fieldset title="Webhook">
          <Field label="Webhook URL" value={form.webhook_url ?? ""} onChange={v => set("webhook_url" as any, v)}
            placeholder="https://hooks.slack.com/services/… or https://your-endpoint/alerts" />
          <div className="card card-body" style={{ fontSize: 12, color: "var(--gray-600)", marginTop: 4 }}>
            PCD Ops will POST JSON: <code>{`{"source":"pcd-ops","severity":"high","subject":"…","findings":[…]}`}</code>
          </div>
        </Fieldset>

        <SaveRow status={status} error={error} />
      </form>
    </div>
  );
}
