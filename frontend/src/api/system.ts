import { apiFetch } from "./client";

export interface VersionInfo {
  commit: string;
  branch: string;
  tag: string | null;
}

export interface UpdateCheck {
  up_to_date: boolean;
  local: string;
  remote: string;
}

export const getVersion = () => apiFetch<VersionInfo>("/system/version");

export const checkForUpdate = () => apiFetch<UpdateCheck>("/system/update/check");

export const triggerUpdate = () =>
  apiFetch<{ status: string }>("/system/update", { method: "POST" });

export const getUpdateLog = () => apiFetch<{ log: string }>("/system/update/log");

export const restartService = () =>
  apiFetch<{ status: string }>("/system/restart", { method: "POST" });

export const rebootAppliance = () =>
  apiFetch<{ status: string }>("/system/reboot", { method: "POST" });
