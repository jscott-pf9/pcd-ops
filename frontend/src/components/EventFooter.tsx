import { useEffect, useState } from "react";
import { ChevronUp } from "lucide-react";
import { type AppEvent, useEvents } from "../api/events";
import "./EventFooter.css";

type Filter = "all" | "error" | "warning" | "info" | "success" | "running";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all",     label: "All"     },
  { key: "error",   label: "Error"   },
  { key: "warning", label: "Warning" },
  { key: "info",    label: "Info"    },
  { key: "success", label: "Success" },
];

function formatTs(iso: string) {
  try {
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yr = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yr}-${mo}-${dd} ${hh}:${mm}:${ss}`;
  } catch {
    return iso;
  }
}

function LevelBadge({ level }: { level: string }) {
  const l = level as Filter;
  const label = l === "running" ? "Running"
    : l === "success" ? "Success"
    : l === "error"   ? "Error"
    : l === "warning" ? "Warning"
    : "Info";
  return (
    <span className={`ef-badge ${l}`}>
      <span className="ef-dot" />
      {label}
    </span>
  );
}

export default function EventFooter() {
  const [expanded, setExpanded]     = useState(false);
  const [filter,   setFilter]       = useState<Filter>("all");
  const { data: events = [] }       = useEvents();

  // Toggle body padding so page content doesn't hide behind footer
  useEffect(() => {
    document.body.classList.toggle("footer-expanded", expanded);
  }, [expanded]);

  const errCount  = events.filter(e => e.level === "error").length;
  const warnCount = events.filter(e => e.level === "warning").length;

  const visible: AppEvent[] = filter === "all"
    ? events
    : events.filter(e => e.level === filter);

  const latest = events[0];

  return (
    <div className="event-footer">
      {/* ── Header bar ───────────────────────────────────────────────────── */}
      <div
        className="ef-header"
        onClick={() => setExpanded(x => !x)}
        role="button"
        aria-expanded={expanded}
      >
        <ChevronUp size={13} className={`ef-chevron${expanded ? " open" : ""}`} />

        <span className="ef-title">Events &amp; Logs</span>

        {errCount  > 0 && <span className="ef-chip error">  ● {errCount}  {errCount  === 1 ? "error"   : "errors"}  </span>}
        {warnCount > 0 && <span className="ef-chip warning">⚠ {warnCount} {warnCount === 1 ? "warning" : "warnings"}</span>}

        {latest && !expanded && (
          <span className="ef-preview">
            {latest.component && <>{latest.component} — </>}
            {latest.title}
            {latest.detail && ` — ${latest.detail}`}
          </span>
        )}

        {expanded && (
          <div className="ef-filters" onClick={e => e.stopPropagation()}>
            {FILTERS.map(f => (
              <button
                key={f.key}
                className={`ef-filter-btn${filter === f.key ? " active" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Body table ───────────────────────────────────────────────────── */}
      {expanded && (
        <div className="ef-body">
          <table className="ef-table">
            <colgroup>
              <col className="ef-col-ts" />
              <col className="ef-col-level" />
              <col className="ef-col-msg" />
              <col className="ef-col-component" />
              <col className="ef-col-tenant" />
            </colgroup>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Level</th>
                <th>Message</th>
                <th>Component</th>
                <th>Tenant</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={5} className="ef-empty">No events</td></tr>
              ) : (
                visible.map(ev => (
                  <tr key={ev.id}>
                    <td><span className="ef-ts">{formatTs(ev.timestamp)}</span></td>
                    <td><LevelBadge level={ev.level} /></td>
                    <td title={ev.detail ?? undefined}>
                      {ev.title}
                      {ev.detail && <span style={{ color: "var(--gray-600)", marginLeft: 6 }}>— {ev.detail}</span>}
                    </td>
                    <td><span className="ef-component">{ev.component ?? "—"}</span></td>
                    <td><span className="ef-tenant">{ev.tenant ?? "—"}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
