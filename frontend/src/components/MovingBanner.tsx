import { useState } from "react";
import { CSRF_HEADERS } from "../api/client";

/** App Builder, App Catalog and App Deployments are moving to PCD App Builder, a separate
 *  appliance in the PCD App Catalog. Export downloads everything they hold for its
 *  Settings → Import, Terraform state included. */
export default function MovingBanner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function exportAll() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/orchestration/export", { headers: CSRF_HEADERS, credentials: "same-origin" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1]
        ?? "pcd-ops-app-builder.json";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="note" style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16,
      padding: "10px 14px", borderRadius: 6, fontSize: 13,
      background: "var(--blue-light)", color: "var(--blue-dark)", border: "1px solid var(--gray-200)",
    }}>
      <span style={{ flex: 1, minWidth: 260 }}>
        <strong>App Builder is moving to its own appliance, PCD App Builder</strong>, in the PCD App
        Catalog. Install it, then export here and choose the file under its Settings → Import. Your
        profiles, roles, templates and deployments (with their Terraform state) come across.
        A later PCD Ops release removes these pages.
      </span>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={exportAll}>
        {busy ? "Exporting…" : "Export"}
      </button>
      {error && <span className="text-danger" style={{ width: "100%" }}>{error}</span>}
    </div>
  );
}
