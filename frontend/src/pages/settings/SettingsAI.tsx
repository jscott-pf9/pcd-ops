import { useSettings } from "./useSettings";
import { Fieldset, Row, Field, SaveRow } from "./SettingsConnection";
import type { AppSettings } from "../../api/settings";

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
    label: "Anomaly Detection",
    description: "Analyzes cluster metrics for unusual patterns and flags findings.",
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

// ── Page ───────────────────────────────────────────────────────────────────────

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
            <span>Ollama runs locally — no API key needed. Recommended: <code>gemma4:31b</code> or <code>llama3.1:8b</code>.</span>
          )}
          {form.ai_backend === "claude" && (
            <span>Claude uses the Anthropic API. Set URL to <code>https://api.anthropic.com</code> and model to e.g. <code>claude-haiku-4-5-20251001</code>.</span>
          )}
          {form.ai_backend === "openai" && (
            <span>Any OpenAI-compatible endpoint (Groq, Together, local vLLM). Set URL to the base API URL.</span>
          )}
        </div>

        <Fieldset title="AI Analysis Features">
          <p style={{ fontSize: 13, color: "var(--gray-500)", marginBottom: 12 }}>
            Control which features call the AI model and how often background analysis runs.
            App Builder generation is always available on-demand.
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
