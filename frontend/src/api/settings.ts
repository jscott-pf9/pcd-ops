import { apiFetch } from "./client";

export interface AppSettings {
  os_auth_url: string;
  os_username: string;
  os_password: string;
  os_project_name: string;
  os_user_domain_name: string;
  os_project_domain_name: string;
  os_region_name: string;
  prometheus_url: string;
  grafana_url: string;
  grafana_token: string;
  ai_backend: string;
  ai_url: string;
  ai_model: string;
  ai_api_key: string;
  // SSH (hypervisor log collection)
  hypervisor_ssh_user?: string;
  hypervisor_ssh_key_path?: string;
  hypervisor_ssh_password?: string;
  // Data retention
  job_run_retention_days?: number;
  report_retention_days?: number;
  // Alerts
  smtp_host?: string;
  smtp_port?: string;
  smtp_user?: string;
  smtp_password?: string;
  smtp_from?: string;
  alert_email_to?: string;
  webhook_url?: string;
  // AI feature toggles
  ai_rightsizing_enabled?: boolean;
  ai_anomaly_enabled?: boolean;
  ai_logs_enabled?: boolean;
  ai_capacity_enabled?: boolean;
  // AI analysis schedules
  ai_rightsizing_schedule?: string;
  ai_anomaly_schedule?: string;
}

export const getSettings = () => apiFetch<AppSettings>("/settings");

export const saveSettings = (payload: AppSettings) =>
  apiFetch<{ status: string }>("/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
