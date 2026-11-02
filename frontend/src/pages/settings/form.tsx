// Shared form pieces for the Settings tabs.

export function Fieldset({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid var(--gray-200)", borderRadius: "var(--radius)", padding: "0.75rem 1rem", marginBottom: "1rem" }}>
      <legend style={{ fontWeight: 600, color: "var(--gray-800)", padding: "0 0.4rem", fontSize: 12 }}>{title}</legend>
      {children}
    </fieldset>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: "0.75rem" }}>{children}</div>;
}

/** Where to find a value, shown under its field. */
export function Help({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--gray-500)", marginTop: 4, lineHeight: 1.45 }}>{children}</div>;
}

export function Field({ label, value, onChange, placeholder, secret, help }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean;
  help?: React.ReactNode;
}) {
  return (
    <div style={{ flex: 1, marginBottom: "0.75rem" }}>
      <label className="form-label">{label}</label>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="form-input"
        autoComplete={secret ? "new-password" : undefined}
      />
      {help && <Help>{help}</Help>}
    </div>
  );
}

export function SaveRow({ status, error, children }: {
  status: string; error: string; children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
      <button type="submit" disabled={status === "saving"} className="btn btn-primary">
        {status === "saving" ? "Saving…" : "Save"}
      </button>
      {children}
      {status === "saved" && <span className="text-success">Saved</span>}
      {status === "error"  && <span className="text-danger">{error}</span>}
    </div>
  );
}

/** The result of a Test button: green on success, red with the reason otherwise. */
export function TestResult({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return <span className={result.ok ? "text-success" : "text-danger"} style={{ fontSize: 13 }}>{result.text}</span>;
}
