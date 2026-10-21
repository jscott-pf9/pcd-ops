import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AccessStatus, type BackgroundCredential, type PcdConnection,
  authorizeBackground, revokeBackground,
} from "../api/auth";
import { errorDetail } from "../api/client";

// Shared by /setup and Settings › PCD & Metrics (APPLIANCE_STANDARD §7.7, §7.8).

function fmtTime(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleString() : "never";
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: "0.75rem", padding: "0.3rem 0", fontSize: 13 }}>
      <span style={{ width: 150, flexShrink: 0, color: "var(--gray-500)" }}>{label}</span>
      <span className={mono ? "text-mono" : undefined} style={{ wordBreak: "break-all" }}>
        {value || "—"}
      </span>
    </div>
  );
}

/** Read-only: the Keystone URL, region and install project come from config.env. */
export function ConnectionCard({ connection }: { connection: PcdConnection }) {
  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-header"><span className="card-title">Connection</span></div>
      <div className="card-body">
        <Row label="Keystone URL" value={connection.auth_url} mono />
        <Row label="Region" value={connection.region} />
        <Row label="Install project" value={connection.project_name || connection.project_id} />
        {connection.project_id && connection.project_name && (
          <Row label="Project ID" value={connection.project_id} mono />
        )}
        <Row label="Instance" value={connection.instance_name} />
        <p className="text-muted" style={{ fontSize: 12, margin: "0.5rem 0 0" }}>
          {connection.from_config_env
            ? "Set by the PCD App Catalog at install. To change it, redeploy PCD Ops."
            : "Entered at first-run setup. To change it, use Reset setup in the appliance console."}
        </p>
      </div>
    </div>
  );
}

/** What "Authorize background access" creates, in plain terms. */
export function AuthorizeExplainer({ project }: { project: string }) {
  return (
    <p style={{ fontSize: 13, color: "var(--gray-700)", margin: "0 0 0.75rem" }}>
      PCD Ops collects inventory, metrics and logs, and runs scheduled jobs, while nobody is
      logged in. Authorizing creates a PCD <strong>application credential</strong> owned by
      you, in project <strong>{project}</strong>, with the <strong>admin</strong> role only
      and no permission to create further credentials. PCD Ops stores it encrypted and never
      sees your password. If your account loses the admin role there, background work stops
      until an admin re-authorizes it.
    </p>
  );
}

function CredentialRows({ cred }: { cred: BackgroundCredential }) {
  return (
    <>
      <Row label="Credential" value={cred.name} mono />
      <Row label="Owner" value={cred.owner} />
      <Row label="Project ID" value={cred.project_id} mono />
      <Row label="Created" value={fmtTime(cred.created)} />
      <Row label="Last used" value={fmtTime(cred.last_used)} />
    </>
  );
}

/** Settings: owner, created and last used, with Re-authorize and Revoke. */
export function BackgroundAccessCard({ access }: { access: AccessStatus }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"" | "authorize" | "revoke">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { state, credential } = access.background;
  const project = access.connection.project_name || access.connection.project_id;

  async function run(kind: "authorize" | "revoke") {
    if (kind === "revoke" && !window.confirm(
      "Revoke background access? The credential is deleted in PCD, and collection and " +
      "scheduled jobs stop until an admin authorizes it again.")) return;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      if (kind === "authorize") {
        const res = await authorizeBackground();
        setNotice(res.warning ?? "Background access re-authorized with your account.");
      } else {
        await revokeBackground();
      }
      await qc.invalidateQueries({ queryKey: ["access"] });
      await qc.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(errorDetail(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-header">
        <span className="card-title">Background access</span>
        {state === "authorized" && <span className="badge badge-ok">Authorized</span>}
        {state === "failed" && <span className="badge badge-error">Stopped working</span>}
        {state === "legacy" && <span className="badge badge-warn">0.4 service account</span>}
        {state === "none" && <span className="badge badge-neutral">Not authorized</span>}
      </div>
      <div className="card-body">
        {credential && <CredentialRows cred={credential} />}
        {state === "failed" && (
          <p className="text-danger" style={{ fontSize: 13 }}>
            PCD refused this credential{credential?.failed_at ? ` on ${fmtTime(credential.failed_at)}` : ""}.
            Its owner may have been deleted or lost the admin role. Re-authorize with your account.
          </p>
        )}
        {state === "legacy" && (
          <p style={{ fontSize: 13 }}>
            Background work still uses the service account saved by PCD Ops 0.4. Authorize
            background access to replace it; the stored password is then deleted.
          </p>
        )}
        {(state === "none" || state === "legacy") && <AuthorizeExplainer project={project} />}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center" }}>
          <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run("authorize")}>
            {busy === "authorize" ? "Authorizing…"
              : credential ? "Re-authorize" : "Authorize background access"}
          </button>
          {credential && (
            <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => run("revoke")}>
              {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
          )}
          {notice && <span className="text-success" style={{ fontSize: 12 }}>{notice}</span>}
          {error && <span className="text-danger" style={{ fontSize: 12 }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}
