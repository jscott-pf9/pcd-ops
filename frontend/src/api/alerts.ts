import { apiFetch } from "./client";
import type { Severity } from "./settings";

export type Channel = "email" | "webhook" | "slack";

/** An alert as recorded: results are null where sent, else why not. */
export interface AlertRecord {
  id: number; at: string; source: string; key: string; severity: Severity; title: string;
  body: string; results: Partial<Record<Channel, string | null>>; suppressed: boolean;
}

export const listAlerts = (limit = 50) =>
  apiFetch<{ alerts: AlertRecord[]; channels: Channel[] }>(`/alerts?limit=${limit}`);

export const testAlert = (channel?: Channel) =>
  apiFetch<Partial<Record<Channel, string | null>>>("/alerts/test", {
    method: "POST", body: JSON.stringify({ channel: channel ?? null }),
  });
