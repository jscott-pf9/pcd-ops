import { apiFetch } from "./client";

/** One exporter on one hypervisor, as the probe found it. */
export interface ExporterResult {
  status: "ok" | "tls" | "auth" | "refused" | "timeout" | "http" | "error";
  url: string;
  series?: number;
  families?: Record<string, number>;
  http_status?: number;
  error?: string;
}

export interface ExporterHost {
  hypervisor_id: string;
  hostname: string;
  host_ip: string;
  node: ExporterResult;
  libvirt: ExporterResult;
}

export interface ExporterProbe { probed_at: string; hosts: ExporterHost[] }

export const getExporterProbe = () => apiFetch<ExporterProbe>("/inventory/hypervisors/exporters");

export const probeExporters = () =>
  apiFetch<ExporterProbe>("/inventory/hypervisors/probe-exporters", { method: "POST" });

/** What a probe status means, for people. */
export const EXPORTER_STATUS: Record<ExporterResult["status"], { label: string; ok: boolean }> = {
  ok:      { label: "reachable",        ok: true },
  tls:     { label: "reachable (TLS)",  ok: true },
  auth:    { label: "needs credentials", ok: false },
  refused: { label: "connection refused", ok: false },
  timeout: { label: "no answer (timeout)", ok: false },
  http:    { label: "HTTP error",       ok: false },
  error:   { label: "error",            ok: false },
};
