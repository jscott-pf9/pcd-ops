import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { getSession, login } from "../api/auth";
import { errorDetail, safeNext } from "../api/client";
import PcdOpsMark from "../assets/PcdOpsMark";

export function AuthPage({ title, children, width = 380 }: {
  title: string; children: React.ReactNode; width?: number;
}) {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--gray-50)", padding: "1rem",
    }}>
      <div className="card" style={{ width, maxWidth: "100%", boxShadow: "var(--shadow-md)" }}>
        <div className="card-body" style={{ padding: "1.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1.25rem" }}>
            <PcdOpsMark size={32} />
            <span style={{ fontWeight: 600, fontSize: 16 }}>PCD Ops</span>
          </div>
          <h1 style={{ fontSize: 18, margin: "0 0 1rem" }}>{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const next = safeNext(params.get("next"));
  const { data: session } = useQuery({ queryKey: ["session"], queryFn: getSession });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("Default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (session?.authenticated) return <Navigate to={next} replace />;
  if (session && !session.connection_configured) return <Navigate to="/setup" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await login(username, password, domain);
      setPassword("");
      await qc.invalidateQueries();
      navigate(res.setup_required ? "/setup" : next, { replace: true });
    } catch (err) {
      setError(errorDetail(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPage title="Log in with your PCD account">
      <form onSubmit={submit}>
        <div className="form-group" style={{ marginBottom: "0.75rem" }}>
          <label className="form-label" htmlFor="login-user">Username</label>
          <input id="login-user" className="form-input" autoComplete="username" autoFocus
                 value={username} onChange={e => setUsername(e.target.value)} required />
        </div>
        <div className="form-group" style={{ marginBottom: "0.75rem" }}>
          <label className="form-label" htmlFor="login-pass">Password</label>
          <input id="login-pass" className="form-input" type="password" autoComplete="current-password"
                 value={password} onChange={e => setPassword(e.target.value)} required />
        </div>
        <div className="form-group" style={{ marginBottom: "1rem" }}>
          <label className="form-label" htmlFor="login-domain">Domain</label>
          <input id="login-domain" className="form-input"
                 value={domain} onChange={e => setDomain(e.target.value)} />
        </div>
        {error && <p className="text-danger" style={{ fontSize: 13, margin: "0 0 0.75rem" }}>{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%" }}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        <p className="text-muted" style={{ fontSize: 12, margin: "0.9rem 0 0" }}>
          You need the admin role in the project PCD Ops was installed into.
        </p>
      </form>
    </AuthPage>
  );
}
