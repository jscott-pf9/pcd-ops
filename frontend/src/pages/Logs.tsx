import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, Sparkles } from "lucide-react";
import { apiFetch } from "../api/client";
import DataFreshness from "../components/DataFreshness";

const LATEX_MAP: [RegExp, string][] = [
  [/\$\\rightarrow\$/g,     "→"],
  [/\$\\leftarrow\$/g,      "←"],
  [/\$\\Rightarrow\$/g,     "⇒"],
  [/\$\\Leftarrow\$/g,      "⇐"],
  [/\$\\leftrightarrow\$/g, "↔"],
  [/\$\\times\$/g,          "×"],
  [/\$\\geq\$/g,            "≥"],
  [/\$\\leq\$/g,            "≤"],
  [/\$\\neq\$/g,            "≠"],
  [/\$\\approx\$/g,         "≈"],
  [/\$\\infty\$/g,          "∞"],
  [/\$\\Delta\$/g,          "Δ"],
  [/\$\\alpha\$/g,          "α"],
  [/\$\\beta\$/g,           "β"],
];

function MiniMarkdown({ text }: { text: string }) {
  const normalized = LATEX_MAP.reduce((s, [re, ch]) => s.replace(re, ch), text);
  const lines = normalized.split("\n");
  const els: React.ReactNode[] = [];

  const renderInline = (s: string, key: string) => {
    const parts: React.ReactNode[] = [];
    const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
    let last = 0, m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      if (m[1] !== undefined) parts.push(<strong key={`${key}-b${i++}`}>{m[1]}</strong>);
      else parts.push(<code key={`${key}-c${i++}`} style={{ background: "#ede9fa", borderRadius: 3, padding: "0 3px", fontSize: "0.9em" }}>{m[2]}</code>);
      last = re.lastIndex;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };

  let listItems: React.ReactNode[] = [];
  let listOrdered = false;

  const flushList = () => {
    if (!listItems.length) return;
    const Tag = listOrdered ? "ol" : "ul";
    els.push(<Tag key={`list-${els.length}`} style={{ margin: "4px 0 6px 16px", paddingLeft: 8 }}>{listItems}</Tag>);
    listItems = [];
  };

  lines.forEach((line, idx) => {
    const bullet = /^[\*\-]\s+(.+)/.exec(line);
    const numbered = /^\d+\.\s+(.+)/.exec(line);
    const heading = /^#{1,3}\s+(.+)/.exec(line);

    if (bullet) {
      if (listOrdered) { flushList(); listOrdered = false; }
      listItems.push(<li key={idx} style={{ marginBottom: 2 }}>{renderInline(bullet[1], `li-${idx}`)}</li>);
    } else if (numbered) {
      if (!listOrdered) { flushList(); listOrdered = true; }
      listItems.push(<li key={idx} style={{ marginBottom: 2 }}>{renderInline(numbered[1], `li-${idx}`)}</li>);
    } else {
      flushList();
      if (heading) {
        els.push(<p key={idx} style={{ fontWeight: 700, margin: "8px 0 3px" }}>{renderInline(heading[1], `h-${idx}`)}</p>);
      } else if (line.trim() === "") {
        els.push(<div key={idx} style={{ height: 6 }} />);
      } else {
        els.push(<p key={idx} style={{ margin: "2px 0" }}>{renderInline(line, `p-${idx}`)}</p>);
      }
    }
  });
  flushList();
  return <div style={{ lineHeight: 1.6 }}>{els}</div>;
}

interface LogEntry {
  host: string;
  hostname: string;
  service: string;
  level: string;
  message: string;
}

interface RecentLogs {
  entries: LogEntry[];
  total: number;
  collected_at: string | null;
}

const LEVEL_STYLE: Record<string, { color: string; bg: string }> = {
  ERROR:   { color: "var(--red)",          bg: "var(--red-light)" },
  WARNING: { color: "var(--yellow)",       bg: "var(--yellow-light)" },
  INFO:    { color: "var(--blue-primary)", bg: "var(--blue-light)" },
  DEBUG:   { color: "var(--gray-400)",     bg: "var(--gray-100)" },
};

export default function Logs() {
  const [tab, setTab] = useState<"live" | "analyze">("live");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Logs</h1>
        {tab === "live" && <DataFreshness domainKey="logs:recent" />}
      </div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab${tab === "live" ? " active" : ""}`} onClick={() => setTab("live")}>
          Live Logs
        </button>
        <button className={`tab${tab === "analyze" ? " active" : ""}`} onClick={() => setTab("analyze")}>
          Paste &amp; Analyze
        </button>
      </div>

      {tab === "live"    && <LiveLogs />}
      {tab === "analyze" && <AnalyzeLogs />}
    </div>
  );
}

function LiveLogs() {
  const [host,     setHost]    = useState("");
  const [service,  setService] = useState("");
  const [level,    setLevel]   = useState("");
  const [keyword,  setKeyword] = useState("");
  const [nlQuery,  setNlQuery] = useState("");
  const [nlAnswer, setNlAnswer] = useState("");

  const params = new URLSearchParams();
  if (host)    params.set("host", host);
  if (service) params.set("service", service);
  if (level)   params.set("level", level);
  if (keyword) params.set("keyword", keyword);
  params.set("limit", "400");

  const { data, isLoading, error } = useQuery<RecentLogs>({
    queryKey: ["logs", "recent", host, service, level, keyword],
    queryFn: () => apiFetch(`/logs/recent?${params}`),
    retry: false,
    refetchInterval: 60_000,
  });

  const { data: hosts = [] } = useQuery<{ hostname: string; count: number }[]>({
    queryKey: ["logs", "hosts"],
    queryFn: () => apiFetch("/logs/hosts"),
    retry: false,
  });

  const { data: services = [] } = useQuery<{ service: string; count: number }[]>({
    queryKey: ["logs", "services"],
    queryFn: () => apiFetch("/logs/services"),
    retry: false,
  });

  const nlMut = useMutation({
    mutationFn: (q: string) => apiFetch<{ answer: string; logs_searched: number }>("/logs/query", {
      method: "POST", body: JSON.stringify({ query: q }),
    }),
    onSuccess: (d) => setNlAnswer(d.answer),
  });

  const isNoData = !!(error as any);

  return (
    <div>
      {/* NLP query bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Sparkles size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--purple)" }} />
          <input className="form-input"
            placeholder='Ask the logs: "What errors happened?" or "Why is nova-compute failing?"'
            value={nlQuery} onChange={e => setNlQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && nlQuery.trim() && nlMut.mutate(nlQuery)}
            style={{ paddingLeft: 32 }} />
        </div>
        <button className="btn btn-secondary" disabled={!nlQuery.trim() || nlMut.isPending}
          onClick={() => nlMut.mutate(nlQuery)}>
          {nlMut.isPending ? "Searching…" : "Ask AI"}
        </button>
      </div>

      {nlAnswer && (
        <div className="card card-body" style={{ marginBottom: 12, fontSize: 13, background: "#faf7ff", borderColor: "var(--purple)" }}>
          <div style={{ fontWeight: 600, color: "var(--purple)", marginBottom: 5, display: "flex", alignItems: "center", gap: 5 }}>
            <Sparkles size={12} /> AI Answer
          </div>
          <MiniMarkdown text={nlAnswer} />
        </div>
      )}

      {/* Filter row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select className="form-select" value={host} onChange={e => setHost(e.target.value)}
          style={{ width: "auto", fontSize: 12 }}>
          <option value="">All hosts</option>
          {hosts.map(h => <option key={h.hostname} value={h.hostname}>{h.hostname} ({h.count})</option>)}
        </select>

        <select className="form-select" value={service} onChange={e => setService(e.target.value)}
          style={{ width: "auto", fontSize: 12 }}>
          <option value="">All logs</option>
          {services.map(s => <option key={s.service} value={s.service}>{s.service} ({s.count})</option>)}
        </select>

        <div style={{ display: "flex", gap: 3 }}>
          {["", "ERROR", "WARNING", "INFO", "DEBUG"].map(l => (
            <button key={l} onClick={() => setLevel(l)}
              className={`btn btn-sm ${level === l ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: 11, padding: "3px 8px" }}>
              {l || "All"}
            </button>
          ))}
        </div>

        <div style={{ position: "relative", flex: 1, minWidth: 140 }}>
          <Search size={12} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--gray-400)" }} />
          <input className="form-input" placeholder="Filter keyword…" value={keyword}
            onChange={e => setKeyword(e.target.value)} style={{ paddingLeft: 28, fontSize: 12 }} />
        </div>

        {data && <span className="text-muted" style={{ fontSize: 11 }}>{data.entries.length} / {data.total}</span>}
      </div>

      {isLoading && <p className="text-muted">Loading logs…</p>}
      {isNoData && (
        <div className="empty">
          <div className="empty-title">No log data yet</div>
          <div className="empty-body">Configure SSH credentials in Settings → PCD & Metrics, then click Refresh to collect hypervisor logs.</div>
        </div>
      )}
      {data && data.entries.length === 0 && !isNoData && (
        <div className="empty"><div className="empty-title">No entries match</div></div>
      )}
      {data && data.entries.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 76 }}>Level</th>
                <th style={{ width: 110 }}>Host</th>
                <th style={{ width: 130 }}>Service</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e, i) => {
                const sty = LEVEL_STYLE[e.level] ?? LEVEL_STYLE.INFO;
                return (
                  <tr key={i}>
                    <td>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                        background: sty.bg, color: sty.color }}>{e.level}</span>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--gray-600)", fontFamily: "var(--font-mono)" }}>
                      {e.hostname || e.host}
                    </td>
                    <td style={{ fontSize: 11, color: "var(--gray-600)" }}>{e.service}</td>
                    <td style={{ fontSize: 12, color: "var(--gray-800)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                      {e.message}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AnalyzeLogs() {
  const [raw, setRaw] = useState("");
  const { data, mutate, isPending } = useMutation({
    mutationFn: () => {
      const lines = raw.split("\n").filter(l => l.trim());
      return apiFetch<any>("/logs/analyze", { method: "POST", body: JSON.stringify(lines) });
    },
  });

  return (
    <div>
      <p className="page-subtitle">Paste any log output and get an AI summary of errors and patterns.</p>
      <textarea value={raw} onChange={e => setRaw(e.target.value)}
        placeholder="Paste log lines here…" className="form-input"
        style={{ height: 180, fontFamily: "var(--font-mono)", fontSize: 12, resize: "vertical", marginBottom: "0.75rem" }} />
      <div style={{ marginBottom: "1rem" }}>
        <button onClick={() => mutate()} disabled={isPending || !raw.trim()} className="btn btn-primary">
          {isPending ? "Analyzing…" : "Analyze"}
        </button>
      </div>
      {data && (
        <div className="card card-body">
          <div className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Analyzed {data.lines_analyzed} lines
          </div>
          <div style={{ fontSize: 13, color: "var(--gray-800)", lineHeight: 1.7 }}>{data.analysis}</div>
        </div>
      )}
    </div>
  );
}
