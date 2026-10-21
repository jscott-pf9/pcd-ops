import { apiFetch } from "./client";

export interface Session {
  authenticated: boolean;
  connection_configured: boolean;
  user?: string;
  project?: string;
  setup_required?: boolean;
  background?: BackgroundState;
}

/** authorized: application credential in use. failed: Keystone refused it (re-authorize).
 *  legacy: a 0.4.x service account, until setup completes. none: nothing authorized. */
export type BackgroundState = "authorized" | "failed" | "legacy" | "none";

export interface PcdConnection {
  auth_url: string;
  region: string;
  project_id: string;
  project_name: string;
  project_domain: string;
  instance_name: string;
  from_config_env: boolean;
  configured: boolean;
}

export interface BackgroundCredential {
  id: string;
  name: string;
  owner: string;
  project_id: string;
  created: number;
  last_used: number | null;
  failed_at?: number | null;
  error?: string | null;
}

export interface AccessStatus {
  connection: PcdConnection;
  background: { state: BackgroundState; credential: BackgroundCredential | null };
  setup_required: boolean;
}

export const getSession = () => apiFetch<Session>("/auth/session");

export const login = (username: string, password: string, domain: string) =>
  apiFetch<{ user: string; setup_required: boolean }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, domain }),
  });

export const logout = () => apiFetch<{ status: string }>("/auth/logout", { method: "POST" });

export const getAccess = () => apiFetch<AccessStatus>("/access");

export const authorizeBackground = () =>
  apiFetch<{ status: string; warning: string | null }>("/access/authorize", { method: "POST" });

export const revokeBackground = () =>
  apiFetch<{ status: string }>("/access/revoke", { method: "POST" });

export const saveConnection = (body: {
  auth_url: string; project_name: string; region: string; project_domain: string;
}) => apiFetch<{ status: string }>("/access/connection", {
  method: "POST",
  body: JSON.stringify(body),
});
