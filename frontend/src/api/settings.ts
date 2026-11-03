import { apiFetch } from "./client";

// App settings only — PCD credentials are never settings (login and background access
// replace them; see api/auth.ts).
export interface AppSettings {
  // Blank grafana_url means grafana_url_default (https://<PCD host>/grafana); blank
  // prometheus_url means the data source PCD Ops finds through Grafana.
  prometheus_url: string;
  grafana_url: string;
  grafana_token: string;
  /** "ollama" is Private AI (Ollama or any OpenAI-compatible server). */
  ai_backend: string;
  ai_url: string;
  ai_model: string;
  ai_api_key: string;
  ai_private_api_key: string;
  // PCD Ops' own metrics store (scrapes the hypervisors' exporters)
  metrics_local_enabled?: boolean;
  metrics_scrape_interval?: string;
  metrics_retention_days?: number;
  metrics_keep_all_series?: boolean;
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
  /** Read-only. */
  grafana_url_default?: string;
}

export const getSettings = () => apiFetch<AppSettings>("/settings");

/** Saves only the fields given; a secret sent blank or as "***" keeps the saved value. */
export const saveSettings = (payload: Partial<AppSettings>) =>
  apiFetch<{ status: string }>("/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export interface AIRequest { ai_backend: string; ai_url: string; ai_model: string; api_key: string }

export const listAIModels = (body: AIRequest) =>
  apiFetch<{ models: string[] }>("/settings/ai/models", { method: "POST", body: JSON.stringify(body) });

export const testAI = (body: AIRequest) =>
  apiFetch<{ ok: boolean; models?: string[]; model?: string; reply?: string; error?: string }>(
    "/settings/ai/test", { method: "POST", body: JSON.stringify(body) });

export const testMetrics = (body: { grafana_url: string; grafana_token: string; prometheus_url: string }) =>
  apiFetch<{ ok: boolean; grafana_url: string; datasource?: string; prometheus_url?: string; error?: string }>(
    "/settings/metrics/test", { method: "POST", body: JSON.stringify(body) });

export interface SSHKey { path: string; public_key: string | null; generated: boolean }

export const getSSHKey = () => apiFetch<SSHKey>("/settings/ssh/key");

/** Makes a key pair on the appliance and uses it for the hypervisors; returns its public key. */
export const generateSSHKey = (replace: boolean) =>
  apiFetch<SSHKey>("/settings/ssh/key", { method: "POST", body: JSON.stringify({ replace }) });
