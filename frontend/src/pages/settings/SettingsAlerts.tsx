import { useSettings } from "./useSettings";
import { Field, Fieldset, Row, SaveRow } from "./form";

export default function SettingsAlerts() {
  const { form, set, status, error, save } = useSettings([
    "smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_from", "alert_email_to", "webhook_url",
  ]);

  return (
    <div style={{ maxWidth: 680 }}>
      <form onSubmit={save}>
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
        </Fieldset>

        <Fieldset title="Webhook">
          <Field label="Webhook URL" value={form.webhook_url ?? ""} onChange={v => set("webhook_url", v)}
            placeholder="https://hooks.slack.com/services/… or https://your-endpoint/alerts"
            help={<>PCD Ops POSTs JSON: <code>{`{"source":"pcd-ops","severity":"high","subject":"…","findings":[…]}`}</code>.
              For Slack, create an incoming webhook in your Slack app's settings.</>} />
        </Fieldset>

        <SaveRow status={status} error={error} />
      </form>
    </div>
  );
}
