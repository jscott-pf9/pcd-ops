import { useSettings } from "./useSettings";
import { Fieldset, Row, Field, SaveRow } from "./SettingsConnection";

export default function SettingsAI() {
  const { form, set, status, error, save } = useSettings();

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>AI Backend</h1>
      <form onSubmit={save}>
        <Fieldset title="Provider">
          <div className="form-group">
            <label className="form-label">Backend</label>
            <select value={form.ai_backend} onChange={e => set("ai_backend", e.target.value)}
              className="form-select" style={{ width: "auto" }}>
              <option value="ollama">Ollama (local)</option>
              <option value="claude">Claude — Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </div>
          <Row>
            <Field label="URL"   value={form.ai_url}   onChange={v => set("ai_url", v)}   placeholder="http://localhost:11434" />
            <Field label="Model" value={form.ai_model} onChange={v => set("ai_model", v)} placeholder="llama3.1:8b" />
          </Row>
          {(form.ai_backend === "claude" || form.ai_backend === "openai") && (
            <Field label="API Key" value={form.ai_api_key} onChange={v => set("ai_api_key", v)}
              secret placeholder="sk-… or sk-ant-… (leave blank to keep)" />
          )}
        </Fieldset>

        <div className="card card-body" style={{ marginBottom: "1rem", fontSize: 13, color: "var(--gray-600)" }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Provider notes</strong>
          {form.ai_backend === "ollama" && (
            <span>Ollama runs locally — no API key needed. Recommended: <code>llama3.1:8b</code> or <code>mistral:7b</code>.</span>
          )}
          {form.ai_backend === "claude" && (
            <span>Claude uses the Anthropic API. Set URL to <code>https://api.anthropic.com</code> and model to e.g. <code>claude-haiku-4-5-20251001</code>.</span>
          )}
          {form.ai_backend === "openai" && (
            <span>Any OpenAI-compatible endpoint (Groq, Together, local vLLM). Set URL to the base API URL.</span>
          )}
        </div>

        <SaveRow status={status} error={error} />
      </form>
    </div>
  );
}
