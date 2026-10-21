const BASE = "/api";

// Sent on every request; the backend refuses writes without it (CSRF protection —
// a cross-site form can't set custom headers).
export const CSRF_HEADERS = { "X-Requested-With": "pcd-ops" };

/** Only same-site paths, so ?next= can't send the user elsewhere. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    && !next.startsWith("/login") ? next : "/";
}

/** Send the browser to /login (no session) or /setup (setup unfinished), remembering where it was. */
export function redirectForAuth(status: number, body: string): boolean {
  const here = window.location.pathname + window.location.search;
  if (status === 401 && !here.startsWith("/login")) {
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
    return true;
  }
  if (status === 409 && body.includes("setup_required") && !here.startsWith("/setup")) {
    window.location.assign("/setup");
    return true;
  }
  return false;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...CSRF_HEADERS, ...options?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    redirectForAuth(res.status, text);
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as unknown as T;
  }
  return res.json() as Promise<T>;
}

/** The `detail` message from a FastAPI error thrown by apiFetch, for showing to the user. */
export function errorDetail(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err);
  const json = msg.slice(msg.indexOf("{"));
  try {
    const detail = JSON.parse(json).detail;
    if (typeof detail === "string") return detail;
  } catch {
    // not JSON
  }
  return msg;
}
