import { apiFetch } from "./client";

// HTTPS on the appliance: the certificate nginx serves, port 80's redirect, a pending CSR.
export interface CertInfo {
  subject: string; issuer: string; names: string[]; self_signed: boolean;
  not_before: string; not_after: string; days_left: number; expired: boolean;
  fingerprint_sha256: string; chain: number; key: string;
}

export interface TlsStatus {
  /** nginx serves HTTPS (new images; the console's Enable HTTPS on older ones). */
  https_enabled: boolean;
  /** Plain HTTP redirects to HTTPS (/api/health stays on HTTP). */
  redirect: boolean;
  certificate: CertInfo | null;
  pending_csr: { subject: string; names: string[]; created: string } | null;
  /** What a new self-signed certificate covers by default. */
  default_names: string[];
  /** After a change: anything to know about the new certificate. */
  warnings: string[];
  /** After a change: whether nginx was seen serving it. */
  served: boolean | null;
}

const post = (path: string, body: unknown) => apiFetch<TlsStatus>(path, { method: "POST", body: JSON.stringify(body) });

export const getTls = () => apiFetch<TlsStatus>("/tls");
export const selfSigned = (names: string[]) => post("/tls/self-signed", { names });
export const uploadCert = (certificate: string, key: string | null) => post("/tls/certificate", { certificate, key: key || null });
export const createCsr = (names: string[], organization: string) => post("/tls/csr", { names, organization });
export const discardCsr = () => apiFetch<TlsStatus>("/tls/csr", { method: "DELETE" });
export const setRedirect = (redirect: boolean) =>
  apiFetch<TlsStatus>("/tls/redirect", { method: "PUT", body: JSON.stringify({ redirect }) });
export const CERT_URL = "/api/tls/certificate.pem";
export const CSR_URL = "/api/tls/csr.pem";

/** Whether a certificate for `names` is valid for `host`: exact, or a one-label wildcard. */
export function covers(names: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return names.some(n => {
    const name = n.toLowerCase();
    if (name === h) return true;
    if (!name.startsWith("*.")) return false;
    const dot = h.indexOf(".");
    return dot > 0 && h.slice(dot + 1) === name.slice(2);
  });
}

/** One name or address per line (or comma separated), trimmed, without repeats. */
export function parseNames(text: string): string[] {
  const out: string[] = [];
  for (const n of text.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}
