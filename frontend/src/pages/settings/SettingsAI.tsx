import { useEffect, useState } from "react";
import { errorDetail } from "../../api/client";
import { type AppSettings, listAIModels, testAI } from "../../api/settings";
import { Field, Fieldset, Help, Row, SaveRow, TestResult } from "./form";
import { useSettings } from "./useSettings";

// ── Schedule helpers (same format as Jobs) ─────────────────────────────────────

type Interval = "hourly" | "daily" | "weekly";

function parseAiSchedule(s: string | undefined): { interval: Interval; time: string } {
  if (!s) return { interval: "daily", time: "02:00" };
  const [interval, time = "02:00"] = s.split("@");
  return { interval: (interval as Interval) || "daily", time };
}

function buildAiSchedule(interval: Interval, time: string): string {
  if (interval === "hourly") return "hourly";
  return `${interval}@${time}`;
}

// ── Schedule picker sub-component ─────────────────────────────────────────────

function SchedulePicker({ scheduleKey, form, set }: {
  scheduleKey: "ai_rightsizing_schedule" | "ai_anomaly_schedule";
  form: AppSettings;
  set: (field: keyof AppSettings, value: string | boolean | number) => void;
}) {
  const raw = form[scheduleKey] as string | undefined;
  const { interval, time } = parseAiSchedule(raw);

  const [hh, mm] = time.split(":").map(Number);

  function onInterval(v: Interval) {
    set(scheduleKey, buildAiSchedule(v, time));
  }
  function onHour(v: number) {
    const newTime = `${String(v).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    set(scheduleKey, buildAiSchedule(interval, newTime));
  }
  function onMinute(v: number) {
    const newTime = `${String(hh).padStart(2, "0")}:${String(v).padStart(2, "0")}`;
    set(scheduleKey, buildAiSchedule(interval, newTime));
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--gray-500)", minWidth: 60 }}>Frequency:</span>
      <select className="form-select" style={{ width: "auto", fontSize: 12 }}
        value={interval} onChange={e => onInterval(e.target.value as Interval)}>
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </select>

      {interval !== "hourly" && (
        <>
          <span style={{ fontSize: 12, color: "var(--gray-500)" }}>at</span>
          <select className="form-select" style={{ width: "auto", fontSize: 12 }}
            value={hh} onChange={e => onHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>{String(i).padStart(2, "0")}</option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: "var(--gray-400)" }}>:</span>
          <select className="form-select" style={{ width: "auto", fontSize: 12 }}
            value={mm} onChange={e => onMinute(Number(e.target.value))}>
            {[0, 15, 30, 45].map(m => (
              <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: "var(--gray-400)" }}>UTC</span>
        </>
      )}
    </div>
  );
}

// ── Feature rows ───────────────────────────────────────────────────────────────

interface FeatureConfig {
  enableKey: keyof AppSettings;
  scheduleKey?: "ai_rightsizing_schedule" | "ai_anomaly_schedule";
  label: string;
  description: string;
}

const AI_FEATURES: FeatureConfig[] = [
  {
    enableKey: "ai_rightsizing_enabled",
    scheduleKey: "ai_rightsizing_schedule",
    label: "Right-Sizing Insights",
    description: "Generates an AI insight per over-provisioned or idle VM. Runs per the schedule below.",
  },
  {
    enableKey: "ai_anomaly_enabled",
    scheduleKey: "ai_anomaly_schedule",
    label: "Anomaly Explanation",
    description: "Explains the current anomaly findings: what they have in common and what to check. Detection itself is statistical and runs every 15 minutes without AI.",
  },
  {
    enableKey: "ai_logs_enabled",
    label: "Log Analysis (Ask AI)",
    description: "Enables the Ask AI button in Logs. On-demand — no schedule needed.",
  },
  {
    enableKey: "ai_capacity_enabled",
    label: "Capacity Report Narrative",
    description: "Generates the AI narrative section in Capacity Report jobs. Runs when job executes.",
  },
];

// ── Model picker ──────────────────────────────────────────────────────────────

const OTHER = "__other__";

/** The models the backend offers, plus the saved one; "Other…" for a name typed by hand. */
function ModelPicker({ value, onChange, models, loading, defaultLabel }: {
  value: string; onChange: (v: string) => void; models: string[] | null; loading: boolean;
  defaultLabel?: string;
}) {
  const [typing, setTyping] = useState(false);
  const options = models ? [...new Set([...(value ? [value] : []), ...models])].sort() : [];
  if (typing || (!models && !loading)) {
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <input className="form-input" value={value} onChange={e => onChange(e.target.value)}
          placeholder={defaultLabel ?? "model name"} />
        {models && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setTyping(false)}>List</button>}
      </div>
    );
  }
  return (
    <select className="form-select" value={value} disabled={loading}
      onChange={e => e.target.value === OTHER ? setTyping(true) : onChange(e.target.value)}>
      {loading && <option value={value}>Loading models…</option>}
      {defaultLabel !== undefined && <option value="">{defaultLabel}</option>}
      {!loading && defaultLabel === undefined && !value && <option value="">Choose a model</option>}
      {options.map(m => <option key={m} value={m}>{m}</option>)}
      <option value={OTHER}>Other…</option>
    </select>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

const CLAUDE_DEFAULT = "claude-opus-5-5";

export default function SettingsAI() {
  const { form, set, loaded, status, error, save } = useSettings([
    "ai_backend", "ai_url", "ai_model", "ai_api_key", "ai_private_api_key",
    "ai_rightsizing_enabled", "ai_anomaly_enabled", "ai_logs_enabled", "ai_capacity_enabled",
    "ai_rightsizing_schedule", "ai_anomaly_schedule",
  ]);
  const claude = form.ai_backend === "claude";
  const apiKey = claude ? form.ai_api_key : form.ai_private_api_key;
  const request = { ai_backend: claude ? "claude" : "ollama", ai_url: form.ai_url,
                    ai_model: form.ai_model, api_key: apiKey };

  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadModels() {
    setLoadingModels(true);
    setModelsError("");
    try {
      setModels((await listAIModels(request)).models);
    } catch (err) {
      setModels(null);
      setModelsError(errorDetail(err));
    } finally {
      setLoadingModels(false);
    }
  }

  // List the models once the saved settings are in, and again when the backend changes.
  useEffect(() => {
    if (loaded && (claude ? form.ai_api_key : form.ai_url)) loadModels();
    else setModels(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, form.ai_backend]);

  function chooseBackend(backend: string) {
    set("ai_backend", backend);
    // The Model setting is shared; a Private AI model means nothing to Claude and vice versa.
    if ((backend === "claude") !== form.ai_model.startsWith("claude")) set("ai_model", "");
  }

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await testAI(request);
      if (r.models) setModels(r.models);
      setResult(r.ok
        ? { ok: true, text: `Connected. ${r.model} replied “${r.reply}”.` }
        : { ok: false, text: r.error ?? "Failed" });
    } catch (err) {
      setResult({ ok: false, text: errorDetail(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <form onSubmit={save}>
        <Fieldset title="Provider">
          <div className="form-group">
            <label className="form-label">Backend</label>
            <select value={claude ? "claude" : "ollama"} onChange={e => chooseBackend(e.target.value)}
              className="form-select" style={{ width: "auto" }}>
              <option value="ollama">Private AI — a model server on your network</option>
              <option value="claude">Claude — Anthropic API (cloud)</option>
            </select>
          </div>

          {!claude && (
            <Row>
              <Field label="URL" value={form.ai_url} onChange={v => set("ai_url", v)}
                placeholder="http://ollama.example.com:11434"
                help={<>An <strong>Ollama</strong> server (<code>http://host:11434</code>) or any
                  OpenAI-compatible server such as vLLM (<code>http://host:8000/v1</code>). The
                  appliance must be able to reach it.</>} />
              <Field label="API key (optional)" value={form.ai_private_api_key}
                onChange={v => set("ai_private_api_key", v)} secret placeholder="leave blank to keep"
                help="Only if the server asks for a bearer token. Ollama doesn't." />
            </Row>
          )}
          {claude && (
            <Field label="Anthropic API key" value={form.ai_api_key} onChange={v => set("ai_api_key", v)}
              secret placeholder="sk-ant-… (leave blank to keep)"
              help={<>Create one at <a href="https://console.anthropic.com/settings/keys" target="_blank"
                rel="noreferrer">console.anthropic.com → API keys</a>. The appliance needs outbound
                HTTPS to <code>api.anthropic.com</code>.</>} />
          )}

          <div className="form-group" style={{ marginBottom: "0.75rem" }}>
            <label className="form-label">Model</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <ModelPicker value={form.ai_model} onChange={v => set("ai_model", v)}
                  models={models} loading={loadingModels}
                  defaultLabel={claude ? `Default (${CLAUDE_DEFAULT})` : undefined} />
              </div>
              <button type="button" className="btn btn-sm btn-secondary" disabled={loadingModels}
                onClick={loadModels}>Refresh list</button>
            </div>
            <Help>
              {modelsError
                ? <span className="text-danger">{modelsError}</span>
                : claude
                  ? "The default suits PCD Ops; pick a smaller model such as claude-haiku-5-5 to lower cost."
                  : "The models the server has. For Ollama, add one with ollama pull <model> on the server."}
            </Help>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing} onClick={runTest}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <TestResult result={result} />
          </div>
        </Fieldset>

        <Fieldset title="AI Analysis Features">
          <p style={{ fontSize: 13, color: "var(--gray-500)", marginBottom: 12 }}>
            Control which features call the AI model and how often background analysis runs.
          </p>
          {AI_FEATURES.map(f => {
            const isEnabled = form[f.enableKey] !== false;
            return (
              <div key={String(f.enableKey)} style={{
                padding: "12px 0", borderBottom: "1px solid var(--gray-50)",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <input
                    type="checkbox"
                    id={String(f.enableKey)}
                    checked={isEnabled}
                    onChange={e => set(f.enableKey, e.target.checked)}
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <label htmlFor={String(f.enableKey)} style={{ cursor: "pointer", flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-900)", display: "flex", alignItems: "center", gap: 8 }}>
                      {f.label}
                      {!isEnabled && (
                        <span style={{ fontSize: 11, fontWeight: 400, color: "var(--gray-400)",
                          background: "var(--gray-100)", padding: "1px 6px", borderRadius: 99 }}>
                          disabled
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--gray-500)", marginTop: 2 }}>
                      {f.description}
                    </div>
                  </label>
                </div>

                {/* Schedule picker — always visible for schedulable features */}
                {f.scheduleKey && (
                  <div style={{ marginLeft: 28 }}>
                    <SchedulePicker scheduleKey={f.scheduleKey} form={form} set={set} />
                    <div style={{ fontSize: 11, color: "var(--gray-400)", marginTop: 4 }}>
                      Next run: <strong>{describeSchedule(form[f.scheduleKey] as string)}</strong>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Fieldset>

        <SaveRow status={status} error={error} />
      </form>
    </div>
  );
}

function describeSchedule(s: string | undefined): string {
  if (!s) return "—";
  const { interval, time } = parseAiSchedule(s);
  if (interval === "hourly") return "every hour";
  if (interval === "daily") return `daily at ${time} UTC`;
  if (interval === "weekly") return `weekly at ${time} UTC`;
  return s;
}
