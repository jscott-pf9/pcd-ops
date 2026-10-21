import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router-dom";
import { authorizeBackground, getAccess, getSession, saveConnection } from "../api/auth";
import { errorDetail } from "../api/client";
import { AuthorizeExplainer, ConnectionCard } from "../components/PcdAccess";
import { AuthPage } from "./Login";

// First-run setup (APPLIANCE_STANDARD §7.7). Asks only for what's missing: the PCD connection
// when config.env didn't supply it (before anyone can log in), then background access.

function ConnectForm() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ auth_url: "", project_name: "service", region: "", project_domain: "Default" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await saveConnection(form);
      await qc.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(errorDetail(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof typeof form, label: string, placeholder = "", required = false) => (
    <div className="form-group" style={{ marginBottom: "0.75rem" }}>
      <label className="form-label" htmlFor={`conn-${k}`}>{label}</label>
      <input id={`conn-${k}`} className="form-input" value={form[k]} onChange={set(k)}
             placeholder={placeholder} required={required} />
    </div>
  );

  return (
    <AuthPage title="Connect PCD Ops to PCD" width={460}>
      <p style={{ fontSize: 13, color: "var(--gray-700)", margin: "0 0 1rem" }}>
        This appliance wasn't installed from the PCD App Catalog, so it doesn't know which PCD
        to use. You only need to enter this once.
      </p>
      <form onSubmit={submit}>
        {field("auth_url", "Keystone URL", "https://pcd.example.com/keystone/v3", true)}
        {field("project_name", "Install project", "service", true)}
        {field("region", "Region", "e.g. RegionOne")}
        {field("project_domain", "Project domain", "Default")}
        {error && <p className="text-danger" style={{ fontSize: 13 }}>{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
    </AuthPage>
  );
}

function AuthorizeStep() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: access, error: loadError } = useQuery({ queryKey: ["access"], queryFn: getAccess });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (access && !access.setup_required) return <Navigate to="/" replace />;

  async function authorize() {
    setBusy(true);
    setError("");
    try {
      await authorizeBackground();
      await qc.invalidateQueries();
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorDetail(err));
    } finally {
      setBusy(false);
    }
  }

  const project = access ? (access.connection.project_name || access.connection.project_id) : "";
  return (
    <AuthPage title="Finish setting up PCD Ops" width={560}>
      {loadError && <p className="text-danger">{errorDetail(loadError)}</p>}
      {access && (
        <>
          <ConnectionCard connection={access.connection} />
          <div className="card">
            <div className="card-header"><span className="card-title">Background access</span></div>
            <div className="card-body">
              {access.background.state === "legacy" && (
                <p style={{ fontSize: 13 }}>
                  Until you authorize, background work keeps using the service account PCD Ops
                  0.4 saved in its settings. Authorizing deletes that stored password.
                </p>
              )}
              <AuthorizeExplainer project={project} />
              {error && <p className="text-danger" style={{ fontSize: 13 }}>{error}</p>}
              <button className="btn btn-primary" disabled={busy} onClick={authorize}>
                {busy ? "Authorizing…" : "Authorize background access"}
              </button>
            </div>
          </div>
        </>
      )}
    </AuthPage>
  );
}

export default function Setup() {
  const { data: session } = useQuery({ queryKey: ["session"], queryFn: getSession });
  if (!session) return null;
  if (!session.connection_configured) return <ConnectForm />;
  if (!session.authenticated) return <Navigate to="/login?next=/setup" replace />;
  if (!session.setup_required) return <Navigate to="/" replace />;
  return <AuthorizeStep />;
}
