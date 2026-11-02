import { useSearchParams } from "react-router-dom";
import SettingsAI from "./SettingsAI";
import SettingsAlerts from "./SettingsAlerts";
import SettingsConnection from "./SettingsConnection";
import SettingsStatus from "./SettingsStatus";
import SettingsUpdates from "./SettingsUpdates";

// One Settings page with underline tabs; the tab is in the URL (?tab=), so links and reloads
// land on it (ARCHITECTURE_GUIDE, Settings page).
export const SETTINGS_TABS = [
  { id: "status",     label: "Status",     Page: SettingsStatus },
  { id: "connection", label: "Connection", Page: SettingsConnection },
  { id: "ai",         label: "AI",         Page: SettingsAI },
  { id: "alerts",     label: "Alerts",     Page: SettingsAlerts },
  { id: "software",   label: "Software",   Page: SettingsUpdates },
] as const;

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const active = SETTINGS_TABS.find(t => t.id === params.get("tab")) ?? SETTINGS_TABS[0];

  return (
    <div>
      <h1>Settings</h1>
      <div className="tabs" role="tablist" style={{ marginBottom: "1.25rem" }}>
        {SETTINGS_TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={t.id === active.id}
            className={`tab${t.id === active.id ? " active" : ""}`}
            onClick={() => setParams({ tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      <active.Page key={active.id} />
    </div>
  );
}
