import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorDetail } from "../../api/client";
import {
  CERT_URL, covers, createCsr, CSR_URL, discardCsr, getTls, parseNames, selfSigned, setRedirect, type TlsStatus,
  uploadCert,
} from "../../api/tls";
import { Facts } from "../../components/DetailPage";
import { Fieldset, Help } from "./form";

type Dialog = "self-signed" | "upload" | "csr" | null;

/** Settings → HTTPS: the certificate nginx serves, whether plain HTTP redirects to it, and
 *  ways to replace it: a new self-signed one, an uploaded one, or one signed from a CSR. */
export default function SettingsHttps() {
  const qc = useQueryClient();
  const { data: s, error, isLoading } = useQuery({ queryKey: ["tls"], queryFn: getTls });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [result, setResult] = useState<TlsStatus | null>(null);
  // After a change; the banner only when the certificate in use changed (not for a CSR)
  const done = (r: TlsStatus, changed = true) => {
    qc.setQueryData(["tls"], r);
    setResult(changed ? r : null);
    setDialog(null);
  };
  // The box changes at once; the real state comes back from the server, or is refetched if
  // saving fails
  const redirect = useMutation({
    mutationFn: setRedirect,
    onSuccess: r => qc.setQueryData(["tls"], r),
    onError: () => qc.invalidateQueries({ queryKey: ["tls"] }),
  });
  const toggleRedirect = (on: boolean) => {
    qc.setQueryData<TlsStatus>(["tls"], old => old && { ...old, redirect: on });
    redirect.mutate(on);
  };
  const discard = useMutation({ mutationFn: discardCsr, onSuccess: r => qc.setQueryData(["tls"], r) });

  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (error || !s) return <p className="text-danger">{errorDetail(error)}</p>;

  const host = window.location.hostname;
  const onHttps = window.location.protocol === "https:";
  const cert = s.certificate;

  return (
    <div style={{ maxWidth: 820 }}>
      {dialog === "self-signed" && <SelfSignedDialog s={s} host={host} onDone={done} onClose={() => setDialog(null)} />}
      {dialog === "upload" && <UploadDialog s={s} onDone={done} onClose={() => setDialog(null)} />}
      {dialog === "csr" && <CsrDialog s={s} host={host} onDone={r => done(r, false)} onClose={() => setDialog(null)} />}

      <Fieldset title="HTTPS">
        {!s.https_enabled ? (
          <Note color="yellow">
            <strong>HTTPS isn't set up on this appliance yet.</strong> It was installed before PCD Ops served HTTPS.
            In the VM's console in PCD, choose <strong>Advanced Options → HTTPS → Enable HTTPS</strong>; it makes a
            self-signed certificate and serves the web UI on port 443. Then allow TCP 443 in the VM's security group.
          </Note>
        ) : (
          <>
            <p style={{ fontSize: 13, margin: "0 0 8px" }}>
              The web UI is served at <strong>https://{host}/</strong>.{" "}
              {!onHttps && <a href={`https://${window.location.host}${window.location.pathname}${window.location.search}`}>Open it over HTTPS</a>}
            </p>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={s.redirect} disabled={redirect.isPending}
                onChange={e => toggleRedirect(e.target.checked)} />
              Redirect plain HTTP to HTTPS
            </label>
            <Help>
              /api/health stays on HTTP either way, for the catalog's health check. Port 443 has to be allowed in the
              VM's security group in PCD.
            </Help>
            {redirect.error && <p className="text-danger" style={{ fontSize: 12 }}>{errorDetail(redirect.error)}</p>}
          </>
        )}
      </Fieldset>

      {result && (
        <Note color={result.served === false || result.warnings.length ? "yellow" : "green"} onClose={() => setResult(null)}>
          <strong>
            {result.served === false ? "Saved, but nginx isn't serving it yet." : result.served ? "nginx is serving the new certificate." : "Saved."}
          </strong>
          {onHttps && result.served && " Reload the page to use it in this browser."}
          {result.warnings.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul>
          )}
        </Note>
      )}

      <Fieldset title="Certificate">
        {cert ? (
          <>
            <Facts rows={[
              ["Subject", cert.subject],
              ["Covers", cert.names.join(", ") || "—"],
              ["Issuer", <>{cert.issuer}{cert.self_signed && <span className="badge badge-warn" style={{ marginLeft: 6 }}>self-signed</span>}</>],
              ["Valid", <>{fmtDate(cert.not_before)} – {fmtDate(cert.not_after)}{" "}
                <span style={{ color: cert.expired || cert.days_left <= 7 ? "var(--red)" : cert.days_left <= 30 ? "var(--yellow)" : "var(--gray-500)", fontWeight: cert.days_left <= 30 ? 600 : 400 }}>
                  ({cert.expired ? "expired" : `${cert.days_left} days left`})
                </span></>],
              ["Key", cert.key],
              ["Chain", cert.chain ? `${cert.chain} issuing certificate${cert.chain === 1 ? "" : "s"}` : "none"],
              ["SHA-256", <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}>{cert.fingerprint_sha256}</span>],
            ]} />
            {!covers(cert.names, host) && (
              <Note color="yellow">
                It doesn't cover <strong>{host}</strong>, the address you're using, so browsers will warn. Make a new
                self-signed certificate that includes it, or upload one that does.
              </Note>
            )}
            {cert.self_signed && (
              <Help>
                Browsers warn about a self-signed certificate until it's trusted. To stop the warning on a computer,
                download it and add it as trusted (macOS: Keychain Access, set it to Always Trust; Windows: Trusted Root
                Certification Authorities). Or upload one from your own CA.
              </Help>
            )}
          </>
        ) : (
          <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>No certificate yet.</p>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {cert && <a className="btn btn-secondary btn-sm" href={CERT_URL} download="pcd-ops.crt">Download certificate</a>}
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog("upload")}>Upload certificate…</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog("csr")}>Create CSR…</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog("self-signed")}>New self-signed…</button>
        </div>
      </Fieldset>

      {s.pending_csr && (
        <Fieldset title="Certificate signing request">
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            Waiting for its certificate: <strong>{s.pending_csr.subject}</strong>
            {s.pending_csr.names.length > 1 && <> (also {s.pending_csr.names.slice(1).join(", ")})</>}, made{" "}
            {fmtDate(s.pending_csr.created)}. Have your CA sign it, then use <strong>Upload certificate</strong> with no
            key: its key never leaves the appliance.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <a className="btn btn-secondary btn-sm" href={CSR_URL} download="pcd-ops.csr">Download CSR</a>
            <button className="btn btn-secondary btn-sm" disabled={discard.isPending} onClick={() => discard.mutate()}>Discard</button>
          </div>
        </Fieldset>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Note({ color, onClose, children }: { color: "yellow" | "green"; onClose?: () => void; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, margin: "0 0 12px", padding: "8px 12px", borderLeft: `3px solid var(--${color})`,
      background: `var(--${color}-light)`, borderRadius: 4, display: "flex", gap: 8 }}>
      <div style={{ flex: 1, lineHeight: 1.5 }}>{children}</div>
      {onClose && <button className="btn btn-sm" style={{ background: "none", border: "none", alignSelf: "flex-start" }}
        aria-label="Dismiss" onClick={onClose}>✕</button>}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000, display: "flex",
      alignItems: "center", justifyContent: "center", padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card card-body" style={{ width: 560, maxWidth: "100%", maxHeight: "100%", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Actions({ busy, label, disabled, error, onClose, onSubmit }: {
  busy: boolean; label: string; disabled?: boolean; error: unknown; onClose: () => void; onSubmit: () => void;
}) {
  return (
    <>
      {!!error && <div style={{ fontSize: 12, color: "var(--red)" }}>{errorDetail(error)}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || disabled} onClick={onSubmit}>{busy ? "Working…" : label}</button>
      </div>
    </>
  );
}

/** Names to start from: the current certificate's or the appliance's, plus the address in
 *  use if it isn't among them. */
function startNames(s: TlsStatus, host: string): string {
  const names = [...(s.certificate?.names.length ? s.certificate.names : s.default_names)];
  if (host && !names.includes(host.toLowerCase())) names.push(host.toLowerCase());
  return names.join("\n");
}

function NamesField({ value, onChange, s }: { value: string; onChange: (v: string) => void; s: TlsStatus }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="form-label">Names and addresses</label>
      <textarea className="form-input" rows={5} value={value} onChange={e => onChange(e.target.value)}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12 }} />
      <Help>
        One per line: DNS names (a wildcard like *.example.com is allowed) and IP addresses, including any floating IP
        people use. The first is the common name. This appliance: {s.default_names.join(", ") || "—"}.
      </Help>
    </div>
  );
}

function SelfSignedDialog({ s, host, onDone, onClose }: {
  s: TlsStatus; host: string; onDone: (r: TlsStatus) => void; onClose: () => void;
}) {
  const [names, setNames] = useState(() => startNames(s, host));
  const m = useMutation({ mutationFn: () => selfSigned(parseNames(names)), onSuccess: onDone });
  return (
    <Modal title="New self-signed certificate" onClose={onClose}>
      <NamesField value={names} onChange={setNames} s={s} />
      <Help>Valid for 2 years. It replaces the current certificate{s.certificate && !s.certificate.self_signed && ", including the one from your CA"}.</Help>
      <Actions busy={m.isPending} label="Make and use it" disabled={!parseNames(names).length} error={m.error}
        onClose={onClose} onSubmit={() => m.mutate()} />
    </Modal>
  );
}

function CsrDialog({ s, host, onDone, onClose }: {
  s: TlsStatus; host: string; onDone: (r: TlsStatus) => void; onClose: () => void;
}) {
  const [names, setNames] = useState(() => startNames(s, host));
  const [org, setOrg] = useState("");
  const m = useMutation({ mutationFn: () => createCsr(parseNames(names), org), onSuccess: onDone });
  return (
    <Modal title="Create a certificate signing request" onClose={onClose}>
      <NamesField value={names} onChange={setNames} s={s} />
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label">Organization (optional)</label>
        <input className="form-input" value={org} onChange={e => setOrg(e.target.value)} />
      </div>
      <Help>
        The appliance makes a new key and keeps it; you download the CSR for your CA to sign. The current certificate
        stays in use until you upload the signed one.{s.pending_csr && " This replaces the CSR that's waiting."}
      </Help>
      <Actions busy={m.isPending} label="Create CSR" disabled={!parseNames(names).length} error={m.error}
        onClose={onClose} onSubmit={() => m.mutate()} />
    </Modal>
  );
}

function UploadDialog({ s, onDone, onClose }: { s: TlsStatus; onDone: (r: TlsStatus) => void; onClose: () => void }) {
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const m = useMutation({ mutationFn: () => uploadCert(cert, key.trim() || null), onSuccess: onDone });
  return (
    <Modal title="Upload a certificate" onClose={onClose}>
      <PemField label="Certificate (PEM)" value={cert} onChange={setCert}
        help="The certificate first, then the certificates that issued it (the chain), as one file." />
      <PemField label={s.pending_csr ? "Private key (leave empty to use the pending CSR's key)" : "Private key (PEM, without a passphrase)"}
        value={key} onChange={setKey}
        help="Stored on the appliance only (mode 0600), and never shown or downloaded again." />
      <Actions busy={m.isPending} label="Check and use it" disabled={!cert.trim() || (!key.trim() && !s.pending_csr)}
        error={m.error} onClose={onClose} onSubmit={() => m.mutate()} />
    </Modal>
  );
}

function PemField({ label, value, onChange, help }: { label: string; value: string; onChange: (v: string) => void; help: string }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="form-label" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        {label}
        <input type="file" accept=".pem,.crt,.cer,.key,.txt" style={{ fontSize: 11, maxWidth: 190 }}
          onChange={async e => { const f = e.target.files?.[0]; if (f) onChange(await f.text()); }} />
      </label>
      <textarea className="form-input" rows={6} value={value} onChange={e => onChange(e.target.value)} spellCheck={false}
        placeholder="-----BEGIN …-----" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} />
      <Help>{help}</Help>
    </div>
  );
}
