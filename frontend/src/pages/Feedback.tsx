import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { apiFetch } from "../api/client";

type FeedbackType = "bug" | "feature";

interface SubmitResult {
  url: string;
  number: number;
}

export default function Feedback() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [type, setType] = useState<FeedbackType>("feature");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ configured: boolean }>("/feedback/configured")
      .then(d => setConfigured(d.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setStatus("submitting");
    setError("");
    try {
      const res = await apiFetch<SubmitResult>("/feedback", {
        method: "POST",
        body: JSON.stringify({ type, title, description, name, email }),
      });
      setResult(res);
      setStatus("success");
    } catch (err: any) {
      setError(err.message ?? "Submission failed");
      setStatus("error");
    }
  }

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("idle");
    setResult(null);
    setError("");
  }

  if (configured === null) return null;

  if (!configured) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1>Feedback</h1>
        <div className="alert alert-warning" style={{ marginTop: "1rem" }}>
          GitHub feedback is not configured. Set <code>GITHUB_TOKEN</code> and{" "}
          <code>GITHUB_REPO</code> in your <code>.env</code> to enable this feature.
        </div>
      </div>
    );
  }

  if (status === "success" && result) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1>Feedback</h1>
        <div style={{
          marginTop: "1.5rem",
          padding: "1.25rem 1.5rem",
          border: "1px solid var(--green-200, #bbf7d0)",
          borderRadius: "var(--radius)",
          background: "var(--green-50, #f0fdf4)",
        }}>
          <p style={{ fontWeight: 600, color: "var(--gray-900)", marginBottom: "0.4rem" }}>
            Thanks — issue #{result.number} filed.
          </p>
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--blue-primary)" }}
          >
            View on GitHub <ExternalLink size={12} />
          </a>
        </div>
        <button
          onClick={reset}
          className="btn btn-secondary"
          style={{ marginTop: "1rem" }}
        >
          Submit another
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Feedback</h1>
      <p style={{ color: "var(--gray-500)", marginBottom: "1.5rem", fontSize: 13 }}>
        Report a bug or request a feature. This creates a GitHub issue directly.
      </p>

      <form onSubmit={handleSubmit}>
        {/* Type toggle */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem" }}>
          {(["feature", "bug"] as FeedbackType[]).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`btn ${type === t ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: 13 }}
            >
              {t === "feature" ? "Feature Request" : "Bug Report"}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label className="form-label">Title <span style={{ color: "var(--red-500, #ef4444)" }}>*</span></label>
          <input
            className="form-input"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={type === "bug" ? "Brief summary of the bug" : "What would you like to see?"}
            required
          />
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label className="form-label">
            Description <span style={{ color: "var(--red-500, #ef4444)" }}>*</span>
          </label>
          <textarea
            className="form-input"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={
              type === "bug"
                ? "Steps to reproduce, what you expected vs. what happened…"
                : "Describe the feature and why it would be useful…"
            }
            rows={6}
            required
            style={{ resize: "vertical", fontFamily: "inherit" }}
          />
        </div>

        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem" }}>
          <div style={{ flex: 1 }}>
            <label className="form-label">Your name</label>
            <input
              className="form-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="form-label">Email</label>
            <input
              className="form-input"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button
            type="submit"
            disabled={status === "submitting" || !title.trim() || !description.trim()}
            className="btn btn-primary"
          >
            {status === "submitting" ? "Submitting…" : "Submit"}
          </button>
          {status === "error" && (
            <span style={{ fontSize: 13, color: "var(--red-500, #ef4444)" }}>{error}</span>
          )}
        </div>
      </form>
    </div>
  );
}
