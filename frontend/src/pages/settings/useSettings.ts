import { useEffect, useState } from "react";
import { type AppSettings, getSettings, saveSettings } from "../../api/settings";

const EMPTY: AppSettings = {
  prometheus_url: "", grafana_url: "", grafana_token: "",
  ai_backend: "ollama", ai_url: "", ai_model: "", ai_api_key: "", ai_private_api_key: "",
  ai_rightsizing_enabled: true, ai_anomaly_enabled: true,
  ai_logs_enabled: true, ai_capacity_enabled: true,
  ai_rightsizing_schedule: "daily@02:00", ai_anomaly_schedule: "hourly",
  job_run_retention_days: 30, report_retention_days: 30,
  metrics_local_enabled: true, metrics_scrape_interval: "60s", metrics_retention_days: 90,
  metrics_keep_all_series: false,
  hypervisor_ssh_user: "root", hypervisor_ssh_key_path: "", hypervisor_ssh_password: "",
  smtp_host: "", smtp_port: "587", smtp_user: "", smtp_password: "",
  smtp_from: "", alert_email_to: "", webhook_url: "",
};

/** One Settings tab's form. Save sends only `fields`, so tabs don't overwrite each other. */
export function useSettings(fields: (keyof AppSettings)[]) {
  const [form, setForm] = useState<AppSettings>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings().then(s => { setForm(s); setLoaded(true); }).catch(() => {});
  }, []);

  function set(field: keyof AppSettings, value: string | boolean | number) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (status !== "idle") setStatus("idle");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError("");
    try {
      await saveSettings(Object.fromEntries(fields.map(f => [f, form[f]])));
      setStatus("saved");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  return { form, set, loaded, status, error, save };
}
