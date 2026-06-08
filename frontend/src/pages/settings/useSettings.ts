import { useEffect, useState } from "react";
import { type AppSettings, getSettings, saveSettings } from "../../api/settings";

const EMPTY: AppSettings = {
  os_auth_url: "", os_username: "", os_password: "",
  os_project_name: "", os_user_domain_name: "Default",
  os_project_domain_name: "Default", os_region_name: "",
  prometheus_url: "", grafana_url: "", grafana_token: "",
  ai_backend: "ollama", ai_url: "", ai_model: "", ai_api_key: "",
  ai_rightsizing_enabled: true, ai_anomaly_enabled: true,
  ai_logs_enabled: true, ai_capacity_enabled: true,
  ai_rightsizing_schedule: "daily@02:00", ai_anomaly_schedule: "hourly",
  job_run_retention_days: 30, report_retention_days: 30,
  hypervisor_ssh_user: "root", hypervisor_ssh_key_path: "", hypervisor_ssh_password: "",
  smtp_host: "", smtp_port: "587", smtp_user: "", smtp_password: "",
  smtp_from: "", alert_email_to: "", webhook_url: "",
};

export function useSettings() {
  const [form, setForm] = useState<AppSettings>(EMPTY);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings().then(setForm).catch(() => {});
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
      await saveSettings(form);
      setStatus("saved");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  return { form, set, status, error, save };
}
