import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { type LocalTarget, getMetricsStatus } from "../../api/metrics";
import { formatBytes } from "../../components/format";
import { Fieldset, Help, SaveRow } from "./form";
import { useSettings } from "./useSettings";

const RETENTION = [
  { days: 30, label: "30 days" }, { days: 90, label: "90 days" }, { days: 180, label: "6 months" },
  { days: 365, label: "1 year" }, { days: 730, label: "2 years" },
];

export default function SettingsMetrics() {
  const queryClient = useQueryClient();
  const { form, set, status, error, save } = useSettings([
    "metrics_local_enabled", "metrics_scrape_interval", "metrics_retention_days", "metrics_keep_all_series",
  ]);
  const { data: st } = useQuery({
    queryKey: ["metrics", "status"], queryFn: getMetricsStatus, refetchInterval: 30_000,
  });
  const local = st?.local;
  const perDay = local?.bytes_per_day;
  const disk = local?.disk;
  // Space the store may use: what it has now plus what's free, less the 2 GB it always leaves.
  const room = disk ? disk.used_bytes + Math.max(0, disk.free_bytes - 2e9) : undefined;

  async function onSave(e: React.FormEvent) {
    await save(e);
    queryClient.invalidateQueries({ queryKey: ["metrics"] });
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <p className="text-muted" style={{ fontSize: 13, marginTop: 0 }}>
        PCD Ops scrapes node-exporter (:9388) and libvirt-exporter (:9177) on every hypervisor and keeps
        the data itself, at full resolution and for as long as you choose here. PCD's Grafana keeps
        only 14 days of a reduced set; PCD Ops uses it only where its own store has no data.
      </p>

      <form onSubmit={onSave}>
        <Fieldset title="Collection">
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 10 }}>
            <input type="checkbox" checked={form.metrics_local_enabled ?? true}
              onChange={e => set("metrics_local_enabled", e.target.checked)} />
            Scrape the hypervisors
          </label>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label className="form-label">Scrape every</label>
              <select className="form-select" value={form.metrics_scrape_interval ?? "60s"}
                onChange={e => set("metrics_scrape_interval", e.target.value)} style={{ width: 140 }}>
                <option value="60s">60 seconds</option>
                <option value="30s">30 seconds</option>
              </select>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, paddingBottom: 8 }}>
              <input type="checkbox" checked={form.metrics_keep_all_series ?? false}
                onChange={e => set("metrics_keep_all_series", e.target.checked)} />
              Keep every series the exporters serve
            </label>
          </div>
          <Help>30 seconds doubles the disk use. By default PCD Ops keeps only the series it shows and
            analyses (about 300 per host and 30–60 per VM); keeping everything takes about three times as much.</Help>
        </Fieldset>

        <Fieldset title="Retention">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {RETENTION.map(r => {
              const need = perDay != null ? perDay * r.days : undefined;
              const tooBig = need != null && room != null && need > room;
              return (
                <label key={r.days} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input type="radio" name="retention" checked={(form.metrics_retention_days ?? 90) === r.days}
                    onChange={() => set("metrics_retention_days", r.days)} />
                  <span style={{ width: 80 }}>{r.label}</span>
                  {need != null && (
                    <span className={tooBig ? "text-danger" : "text-muted"} style={{ fontSize: 12 }}>
                      about {formatBytes(need)}{tooBig ? " — more than the disk has room for" : ""}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <Help>
            {perDay != null
              ? <>Estimates use the rate so far: {formatBytes(perDay)} a day. </>
              : <>Estimates appear after the first hour of collection. </>}
            Older data is removed automatically. Changing retention restarts the metrics store (a few seconds without scraping).
          </Help>
        </Fieldset>

        <SaveRow status={status} error={error} />
      </form>

      {local && (
        <Fieldset title="Metrics store">
          {!local.available ? (
            <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
              The metrics store isn't installed here (local development). The views use PCD's Grafana.
            </p>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                {local.running
                  ? <span className="text-success">● Running</span>
                  : <span className="text-danger">● Not running. Restart it from the appliance console (Advanced Options → Metrics Store).</span>}
                {local.series != null && <span className="text-muted"> · {local.series.toLocaleString()} series</span>}
                {local.collecting_since && <span className="text-muted"> · collecting since {new Date(local.collecting_since * 1000).toLocaleDateString()}</span>}
              </div>
              {local.restart_error && (
                <div className="text-danger" style={{ fontSize: 12, marginBottom: 8 }}>
                  The new retention is saved but the metrics store couldn't be restarted to apply it:
                  {" "}{local.restart_error}. It applies at the next restart (appliance console → Advanced Options → Metrics Store).
                </div>
              )}
              {disk && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, marginBottom: 3 }}>
                    Disk: {formatBytes(disk.used_bytes)} of metrics · {formatBytes(disk.free_bytes)} free of {formatBytes(disk.total_bytes)}
                    {local.projected_bytes != null && <> · {formatBytes(local.projected_bytes)} expected at {local.retention_days} days</>}
                  </div>
                  <div style={{ height: 6, background: "var(--gray-100)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", borderRadius: 3, background: "var(--blue-primary)",
                      width: `${Math.min(100, 100 * (disk.total_bytes - disk.free_bytes) / disk.total_bytes)}%` }} />
                  </div>
                </div>
              )}
              <TargetTable targets={local.targets} />
            </>
          )}
          <Help>
            Can't reach a host? Check from here with <Link to="/">Inventory → Hypervisors → Probe exporters</Link>.
            Views currently use: <strong>{st?.source === "local" ? "this store" : st?.source === "pcd" ? "PCD's Grafana" : "no source yet"}</strong>.
          </Help>
        </Fieldset>
      )}
    </div>
  );
}

/** One row per hypervisor: is each exporter being scraped. */
function TargetTable({ targets }: { targets: LocalTarget[] }) {
  if (!targets.length) {
    return <p className="text-muted" style={{ fontSize: 12 }}>No hypervisors to scrape yet: they're added after the next inventory collection.</p>;
  }
  const hosts = new Map<string, { name: string; node?: LocalTarget; libvirt?: LocalTarget }>();
  for (const t of targets) {
    const h = hosts.get(t.hypervisor_id) ?? { name: t.hypervisor };
    h[t.job] = t;
    hosts.set(t.hypervisor_id, h);
  }
  const cell = (t?: LocalTarget) => !t ? <span className="text-muted">—</span> : (
    <span title={t.last_error ?? t.url} style={{ color: t.health === "up" ? "var(--green)" : "var(--red)" }}>
      ● {t.health}{t.last_error ? <span className="text-muted" style={{ fontSize: 11 }}> {t.last_error.slice(0, 60)}</span> : null}
    </span>
  );
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Hypervisor</th><th>node-exporter</th><th>libvirt-exporter</th></tr></thead>
        <tbody>
          {[...hosts.entries()].map(([id, h]) => (
            <tr key={id}><td>{h.name}</td><td>{cell(h.node)}</td><td>{cell(h.libvirt)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
