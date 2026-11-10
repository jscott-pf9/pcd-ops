import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, errorDetail } from "../../api/client";
import { useTenants } from "../../api/tenants";
import { DetailPage, Facts, ItemLink, Section } from "../../components/DetailPage";
import MetricsCharts from "../../components/MetricsCharts";
import { detailPath } from "../inventory/kinds";
import { StatCard } from "../inventory/shared";
import {
  CC, type CustomFlavor, type Detail, FIT, type Flavor, flavorText, isUpsize, type Projected, pctText, projColor, ramText,
  type Stat, windowText,
} from "./model";

const SOURCE: Record<string, string> = { local: "PCD Ops' metrics store", pcd: "PCD's Grafana" };

/** One VM's right-sizing in detail: why it has its class, its busy hours as well as its
 *  average, what the suggested flavor would do to it, other flavors, and which hosts have room. */
export default function RightSizingDetail() {
  const { id = "" } = useParams();
  const tenants = useTenants();
  const { data: d, isLoading, error } = useQuery<Detail>({
    queryKey: ["rightsizing", id],
    queryFn: () => apiFetch(`/rightsizing/recommendations/${id}`),
    retry: false,
  });

  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (error || !d) {
    return (
      <div>
        <p className="text-muted">{error ? errorDetail(error) : "Not found"}</p>
        <Link to="/rightsizing">Back to Right-Sizing</Link>
      </div>
    );
  }

  const cls = CC[d.classification];
  const th = d.thresholds;
  const tenant = tenants.get(d.project_id) ?? d.tenant_name ?? null;
  const sug = d.suggested_flavor;
  const fit = d.fit && FIT[d.fit.status];
  const cpu = d.stats?.cpu ?? {}, mem = d.stats?.mem ?? {}, io = d.stats?.io ?? {};

  return (
    <DetailPage
      root={{ label: "Right-Sizing", to: "/rightsizing" }}
      section={cls.label} sectionTo={`/rightsizing?class=${d.classification}`}
      kindLabel="VM" title={d.server_name} id={d.server_id}
      badges={<>
        <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: cls.bg, color: cls.color }}>
          {cls.label}
        </span>
        {d.risk === "high" && <span className="badge badge-error">High Risk</span>}
        {d.risk === "medium" && <span className="badge badge-warn">Medium Risk</span>}
      </>}
      subtitle={<>
        {tenant && <span>{tenant}</span>}
        {d.hypervisor && <span>on {d.hypervisor}</span>}
        <span>{d.server_status}</span>
      </>}
      stats={<>
        <StatCard label="CPU average" value={pctText(d.cpu_avg_pct)}
          sub={`busiest hours ${pctText(cpu.p95)} · peak ${pctText(cpu.peak)}`} accent={usageAccent(d.cpu_avg_pct, th.cpu_low, th.cpu_high)} />
        <StatCard label="RAM average" value={pctText(d.mem_avg_pct)}
          sub={`busiest hours ${pctText(mem.p95)} · peak ${pctText(mem.peak)}`} accent={usageAccent(d.mem_avg_pct, th.mem_low, th.mem_high)} />
        <StatCard label="Disk IOPS average" value={iopsText(d.io_avg_iops)}
          sub={`busiest hours ${iopsText(io.p95)} · peak ${iopsText(io.peak)}`} accent="var(--purple)" />
        <StatCard label={sug ? (isUpsize(d.current_flavor, sug) ? "Upsize to" : "Downsize to") : "Flavor"}
          value={sug ? sug.name : d.current_flavor.name}
          sub={sug ? `from ${d.current_flavor.name}${fit ? ` · ${fit.label}` : ""}` : flavorText(d.current_flavor)}
          accent={sug ? (fit?.color ?? "var(--gray-400)") : "var(--green)"} />
      </>}
    >
      <Section title={`Why ${cls.label}`} full
        aside={`Over ${windowText(d.window_days)}${d.source ? ` · ${SOURCE[d.source] ?? d.source}` : ""}${
          d.mem_source && d.source && d.mem_source !== d.source ? ` · RAM from ${SOURCE[d.mem_source] ?? d.mem_source}` : ""}`}>
        <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          {d.reasons.map(r => <li key={r}>{r}</li>)}
        </ul>
        <UsageTable d={d} />
        <p className="text-muted" style={{ fontSize: 11, margin: "10px 0 0" }}>
          The class comes from the averages. Busiest hours is the 95th percentile of hourly averages: 1 hour in 20 was
          busier. Under {th.cpu_low}% CPU and {th.mem_low}% RAM is spare; at {th.cpu_high}% or more is pressure, and {th.risk_high}% or
          more is high risk.
        </p>
      </Section>

      <Section title="Suggested flavor">
        <SuggestedFlavor d={d} />
      </Section>

      {d.custom && (
        <Section title="A flavor shaped for it" aside="not in the catalog yet">
          <Custom d={d} custom={d.custom} tenant={tenant ?? d.project_id} />
        </Section>
      )}

      <Section title="Where it can run" aside={sug ? `for ${sug.name}` : d.custom ? `for the shaped ${d.custom.name}` : undefined}>
        <HostTable d={d} />
      </Section>

      {d.alternatives.length > 0 && (
        <Section title="Flavors that would do" full aside="Smallest first; each meets the same need">
          <Alternatives d={d} />
        </Section>
      )}

      {d.analysis && (
        <Section title="AI insight">
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--gray-700)" }}>{d.analysis}</div>
        </Section>
      )}

      <Section title="Details">
        <Facts rows={[
          ["Status", d.server_status],
          ["Tenant", tenant ?? d.project_id],
          ["Host", d.hypervisor_id
            ? <ItemLink to={detailPath("hypervisors", d.hypervisor_id)}>{d.hypervisor ?? d.hypervisor_id}</ItemLink>
            : d.hypervisor ?? "—"],
          ["Flavor", <>{d.current_flavor.name} <span className="text-muted">({flavorText(d.current_flavor)})</span></>],
          d.current_flavor.image_backed != null && ["Boots from", d.current_flavor.image_backed
            ? `local disk (${d.current_flavor.disk_gb} GB root)` : "a volume"],
          ["Inventory", <ItemLink to={detailPath("servers", d.server_id)}>Open the VM's page</ItemLink>],
          !!d.collected_at && ["Analysed", new Date(`${d.collected_at}Z`).toLocaleString()],
        ]} />
      </Section>

      <Section title="History" full>
        <MetricsCharts kind="vm" id={d.server_id} context={[["VM", d.server_name], ["Tenant", tenant ?? d.project_id], ["Host", d.hypervisor], ["Flavor", d.current_flavor.name]]} initialRange={(d.window_days ?? 7) >= 30 ? "30d" : "7d"} />
      </Section>
    </DetailPage>
  );
}

function usageAccent(v: number | null | undefined, low: number, high: number): string {
  if (v == null) return "var(--gray-300)";
  if (v >= high) return "var(--red)";
  if (v < low) return "var(--yellow)";
  return "var(--green)";
}

function iopsText(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 1 : 0);
}

/** Average, busiest hours, peak and time at the pressure threshold per metric, with a band
 *  showing where they sit against the spare and pressure zones. */
function UsageTable({ d }: { d: Detail }) {
  const th = d.thresholds;
  const rows: [string, Stat, number, number][] = [
    ["CPU", { ...d.stats?.cpu, avg: d.cpu_avg_pct }, th.cpu_low, th.cpu_high],
    ["RAM", { ...d.stats?.mem, avg: d.mem_avg_pct }, th.mem_low, th.mem_high],
  ];
  const io = { ...d.stats?.io, avg: d.io_avg_iops };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Metric</th><th style={{ textAlign: "right" }}>Average</th><th style={{ textAlign: "right" }}>Busiest hours (p95)</th>
            <th style={{ textAlign: "right" }}>Peak hour</th><th style={{ textAlign: "right" }}>Hours at pressure</th><th style={{ width: "32%" }}>Against the thresholds</th></tr>
        </thead>
        <tbody>
          {rows.map(([label, s, low, high]) => (
            <tr key={label}>
              <td><strong>{label}</strong></td>
              <td style={{ textAlign: "right", fontWeight: 600 }}>{pctText(s.avg)}</td>
              <td style={{ textAlign: "right" }}>{pctText(s.p95)}</td>
              <td style={{ textAlign: "right" }}>{pctText(s.peak)}</td>
              <td style={{ textAlign: "right" }} title={`Share of hours at or above ${high}%`}>{pctText(s.hours_high_pct)}</td>
              <td><Band s={s} low={low} high={high} /></td>
            </tr>
          ))}
          <tr>
            <td><strong>Disk IOPS</strong></td>
            <td style={{ textAlign: "right", fontWeight: 600 }}>{iopsText(io.avg)}</td>
            <td style={{ textAlign: "right" }}>{iopsText(io.p95)}</td>
            <td style={{ textAlign: "right" }}>{iopsText(io.peak)}</td>
            <td style={{ textAlign: "right" }} className="text-muted">—</td>
            <td className="text-muted" style={{ fontSize: 11 }}>not part of the class; idle uses it</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 0–100 % track: spare zone, pressure zone, a bar from average to busiest hours and a tick
 *  at the peak. */
function Band({ s, low, high }: { s: Stat; low: number; high: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  if (s.avg == null) return <span className="text-muted">—</span>;
  const from = clamp(s.avg), to = clamp(s.p95 ?? s.avg);
  return (
    <div style={{ position: "relative", height: 14 }}
      title={`Average ${pctText(s.avg)}, busiest hours ${pctText(s.p95)}, peak ${pctText(s.peak)}`}>
      <div style={{ position: "absolute", inset: "5px 0", background: "var(--gray-100)", borderRadius: 2 }} />
      <div style={{ position: "absolute", top: 5, bottom: 5, left: 0, width: `${low}%`, background: "var(--yellow-light)" }} />
      <div style={{ position: "absolute", top: 5, bottom: 5, left: `${high}%`, right: 0, background: "var(--red-light)" }} />
      <div style={{ position: "absolute", top: 3, bottom: 3, left: `${from}%`, width: `${Math.max(1, to - from)}%`,
        background: "var(--blue-primary)", opacity: 0.45, borderRadius: 2 }} />
      <div style={{ position: "absolute", top: 1, bottom: 1, left: `calc(${from}% - 1px)`, width: 3, background: "var(--blue-primary)", borderRadius: 1 }} />
      {s.peak != null && (
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `calc(${clamp(s.peak)}% - 1px)`, width: 2, background: "var(--gray-700)" }} />
      )}
    </div>
  );
}

function SuggestedFlavor({ d }: { d: Detail }) {
  const sug = d.suggested_flavor;
  if (!sug) {
    const keep = d.classification === "right-sized" || d.classification === "no-data";
    return (
      <p style={{ fontSize: 13, margin: 0 }}>
        {keep
          ? `No change: it stays on ${d.current_flavor.name} (${flavorText(d.current_flavor)}).`
          : <>No flavor its tenant can use meets the need{d.basis && <> of at least {d.basis.vcpus} vCPU{d.basis.vcpus === 1 ? "" : "s"} and {ramText(d.basis.ram_mb)}</>}{" "}
              while being {d.basis?.direction === "up" ? "bigger" : "smaller"} than {d.current_flavor.name}
              {d.current_flavor.image_backed && <> and keeping its {d.current_flavor.disk_gb} GB root disk: it boots from a local
                disk, which Nova can't shrink</>}.</>}
      </p>
    );
  }
  const p = d.projected;
  const th = d.thresholds;
  return (
    <div>
      <table style={{ width: "100%", fontSize: 13, marginBottom: 10 }}>
        <thead>
          <tr><th style={{ textAlign: "left" }} /><th style={{ textAlign: "right" }}>Now: {d.current_flavor.name}</th>
            <th style={{ textAlign: "right" }}>On {sug.name}</th></tr>
        </thead>
        <tbody>
          <CompareRow label="vCPUs" now={String(d.current_flavor.vcpus)} then={String(sug.vcpus)} />
          <CompareRow label="RAM" now={ramText(d.current_flavor.ram_mb)} then={ramText(sug.ram_mb)} />
          {d.current_flavor.image_backed && sug.disk_gb != null && (
            <CompareRow label="Root disk" now={`${d.current_flavor.disk_gb} GB`} then={`${sug.disk_gb} GB`} />
          )}
          {p && <>
            <ProjRow label="CPU average" now={d.cpu_avg_pct} then={p.cpu.avg} high={th.cpu_high} warn={th.busy_warn} />
            <ProjRow label="CPU busiest hours" now={d.stats?.cpu?.p95} then={p.cpu.p95} high={th.cpu_high} warn={th.busy_warn} />
            <ProjRow label="RAM average" now={d.mem_avg_pct} then={p.mem.avg} high={th.mem_high} warn={th.busy_warn} />
            <ProjRow label="RAM busiest hours" now={d.stats?.mem?.p95} then={p.mem.p95} high={th.mem_high} warn={th.busy_warn} />
          </>}
        </tbody>
      </table>
      {d.basis && (
        <p className="text-muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
          Needs at least {d.basis.vcpus} vCPU{d.basis.vcpus === 1 ? "" : "s"} and {ramText(d.basis.ram_mb)}. {d.basis.rule}
          {d.current_flavor.image_backed && <> It boots from a local disk, so only flavors with at least its {d.current_flavor.disk_gb} GB
            root disk qualify.</>}
          {" "}Projected use is the same work on the new size.
        </p>
      )}
      {p?.warnings.map(w => (
        <div key={w} style={{ fontSize: 12, marginBottom: 6, padding: "6px 10px", borderLeft: "3px solid var(--yellow)",
          background: "var(--yellow-light)", borderRadius: 4 }}>{w}</div>
      ))}
      {d.fit && (
        <div style={{ fontSize: 12, color: FIT[d.fit.status].color, fontWeight: 600 }}>
          {FIT[d.fit.status].label}: <span style={{ fontWeight: 400, color: "var(--gray-700)" }}>{d.fit.reason}</span>
        </div>
      )}
    </div>
  );
}

function CompareRow({ label, now, then }: { label: string; now: string; then: string }) {
  return (
    <tr>
      <td className="text-muted">{label}</td>
      <td style={{ textAlign: "right" }}>{now}</td>
      <td style={{ textAlign: "right", fontWeight: 600 }}>{then}</td>
    </tr>
  );
}

function ProjRow({ label, now, then, high, warn }: {
  label: string; now: number | null | undefined; then: number | null | undefined; high: number; warn: number;
}) {
  return (
    <tr>
      <td className="text-muted">{label}</td>
      <td style={{ textAlign: "right" }}>{pctText(now)}</td>
      <td style={{ textAlign: "right", fontWeight: 600, color: projColor(then, high, warn) }}>{pctText(then)}</td>
    </tr>
  );
}

function projCell(p: Projected, key: "cpu" | "mem", high: number, warn: number) {
  return (
    <span>
      <span style={{ color: projColor(p[key].avg, high, warn) }}>{pctText(p[key].avg)}</span>
      <span className="text-muted"> / </span>
      <span style={{ color: projColor(p[key].p95, high, warn) }}>{pctText(p[key].p95)}</span>
    </span>
  );
}

function Alternatives({ d }: { d: Detail }) {
  const th = d.thresholds;
  const same = (f: Flavor) => d.suggested_flavor && (f.id ?? f.name) === (d.suggested_flavor.id ?? d.suggested_flavor.name);
  return (
    <div className="table-wrap" style={{ margin: "-14px" }}>
      <table>
        <thead>
          <tr><th>Flavor</th><th>Size</th><th style={{ textAlign: "right" }}>CPU avg / busiest</th>
            <th style={{ textAlign: "right" }}>RAM avg / busiest</th><th>Room</th></tr>
        </thead>
        <tbody>
          {d.alternatives.map(a => (
            <tr key={a.flavor.id ?? a.flavor.name}>
              <td>
                <strong>{a.flavor.name}</strong>
                {same(a.flavor) && <span className="badge badge-info" style={{ fontSize: 10, marginLeft: 6 }}>suggested</span>}
              </td>
              <td>{flavorText(a.flavor)}</td>
              <td style={{ textAlign: "right" }}>{projCell(a.projected, "cpu", th.cpu_high, th.busy_warn)}</td>
              <td style={{ textAlign: "right" }}>{projCell(a.projected, "mem", th.mem_high, th.busy_warn)}</td>
              <td title={a.fit.reason} style={{ color: FIT[a.fit.status].color, fontSize: 12, fontWeight: 600 }}>{FIT[a.fit.status].label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HostTable({ d }: { d: Detail }) {
  if (!d.suggested_flavor && !d.custom) {
    return <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>No resize suggested.</p>;
  }
  if (!d.hosts.length) {
    const fit = d.suggested_flavor ? d.fit : d.custom?.fit;
    return <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{fit?.reason ?? "No Placement data for the hosts."}</p>;
  }
  return (
    <div>
      <div className="table-wrap" style={{ margin: "-14px -14px 0" }}>
        <table>
          <thead>
            <tr><th>Host</th><th style={{ textAlign: "right" }}>Free vCPUs</th><th style={{ textAlign: "right" }}>Free RAM</th><th>Room</th></tr>
          </thead>
          <tbody>
            {d.hosts.map(h => (
              <tr key={h.id}>
                <td>
                  <ItemLink to={detailPath("hypervisors", h.id)}>{h.hostname}</ItemLink>
                  {h.current && <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>current</span>}
                </td>
                <td style={{ textAlign: "right" }}>{h.cpu_free == null ? "—" : Math.floor(h.cpu_free)}</td>
                <td style={{ textAlign: "right" }}>{ramText(h.mem_free_mb)}</td>
                <td style={{ fontSize: 12 }}>
                  {h.fits
                    ? <span style={{ color: "var(--green)", fontWeight: 600 }}>fits{h.current && " (same host)"}</span>
                    : <span className="text-muted">{h.why}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted" style={{ fontSize: 11, margin: "18px 0 0" }}>
        Free room under Placement's allocation ratio, in the VM's cluster. On its current host the VM's own flavor counts as
        free; Nova resizes there only if it allows resizing to the same host.
      </p>
    </div>
  );
}

/** The flavor shaped for the VM: why the catalog doesn't do, its size and the VM's projected
 *  use on it, where it fits, and a button to create it as a private flavor for the tenant. */
function Custom({ d, custom, tenant }: { d: Detail; custom: NonNullable<Detail["custom"]>; tenant: string }) {
  const [creating, setCreating] = useState(false);
  const th = d.thresholds, p = custom.projected, sug = d.suggested_flavor;
  return (
    <div>
      {creating && <CreateFlavorModal d={d} custom={custom} tenant={tenant} onClose={() => setCreating(false)} />}
      <p style={{ fontSize: 13, margin: "0 0 10px" }}>{custom.reason}</p>
      <table style={{ width: "100%", fontSize: 13, marginBottom: 10 }}>
        <thead>
          <tr><th style={{ textAlign: "left" }} /><th style={{ textAlign: "right" }}>Now</th>
            {sug && <th style={{ textAlign: "right" }}>{sug.name}</th>}
            <th style={{ textAlign: "right" }}>Shaped</th></tr>
        </thead>
        <tbody>
          {([["vCPUs", (f: Flavor) => String(f.vcpus)], ["RAM", (f: Flavor) => ramText(f.ram_mb)],
             // A volume-backed VM's root disk is its volume: the flavor's doesn't matter
             ...(d.current_flavor.image_backed ? [["Root disk", (f: Flavor) => `${f.disk_gb ?? 0} GB`]] : []),
          ] as [string, (f: Flavor) => string][]).map(([label, v]) => (
            <tr key={label}>
              <td className="text-muted">{label}</td>
              <td style={{ textAlign: "right" }}>{v(d.current_flavor)}</td>
              {sug && <td style={{ textAlign: "right" }}>{v(sug)}</td>}
              <td style={{ textAlign: "right", fontWeight: 600 }}>{v(custom)}</td>
            </tr>
          ))}
          {([["CPU average", d.cpu_avg_pct, d.projected?.cpu.avg, p.cpu.avg, th.cpu_high],
             ["CPU busiest hours", d.stats?.cpu?.p95, d.projected?.cpu.p95, p.cpu.p95, th.cpu_high],
             ["RAM average", d.mem_avg_pct, d.projected?.mem.avg, p.mem.avg, th.mem_high],
             ["RAM busiest hours", d.stats?.mem?.p95, d.projected?.mem.p95, p.mem.p95, th.mem_high],
          ] as [string, number | null | undefined, number | null | undefined, number | null, number][]).map(([label, now, onSug, then, high]) => (
            <tr key={label}>
              <td className="text-muted">{label}</td>
              <td style={{ textAlign: "right" }}>{pctText(now)}</td>
              {sug && <td style={{ textAlign: "right", color: projColor(onSug, high, th.busy_warn) }}>{pctText(onSug)}</td>}
              <td style={{ textAlign: "right", fontWeight: 600, color: projColor(then, high, th.busy_warn) }}>{pctText(then)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.warnings.map(w => (
        <div key={w} style={{ fontSize: 12, marginBottom: 6, padding: "6px 10px", borderLeft: "3px solid var(--yellow)",
          background: "var(--yellow-light)", borderRadius: 4 }}>{w}</div>
      ))}
      <div style={{ fontSize: 12, color: FIT[custom.fit.status].color, fontWeight: 600, marginBottom: 12 }}>
        {FIT[custom.fit.status].label}: <span style={{ fontWeight: 400, color: "var(--gray-700)" }}>{custom.fit.reason}</span>
      </div>
      <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>Create private flavor…</button>
    </div>
  );
}

function CreateFlavorModal({ d, custom, tenant, onClose }: {
  d: Detail; custom: CustomFlavor; tenant: string; onClose: () => void;
}) {
  const [name, setName] = useState(custom.name);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => apiFetch<Flavor>(`/rightsizing/recommendations/${d.server_id}/flavor`, {
      method: "POST", body: JSON.stringify({ name: name.trim() }),
    }),
  });
  // Refetch on close: the new flavor replaces this card, which would take the dialog with it
  const close = () => { if (create.isSuccess) qc.invalidateQueries({ queryKey: ["rightsizing"] }); onClose(); };
  const specs = Object.keys(custom.extra_specs ?? {}).length;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 1000, display: "flex",
      alignItems: "center", justifyContent: "center", padding: 16 }} onClick={e => e.target === e.currentTarget && close()}>
      <div className="card card-body" style={{ width: 460, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
        {create.isSuccess ? (
          <>
            <div style={{ fontWeight: 600, color: "var(--green)" }}>✓ Created {create.data.name}</div>
            <p style={{ fontSize: 13, margin: 0 }}>
              It's private to {tenant} and is now {d.server_name}'s suggested flavor. Resize it with a resize job, or from PCD.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={close}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Create private flavor</div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Name</label>
              <input className="form-input" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div style={{ fontSize: 13 }}>
              {flavorText(custom)} · {d.current_flavor.image_backed || custom.disk_gb
                ? `${custom.disk_gb ?? 0} GB root disk` : "boots from a volume"}
              {!!custom.ephemeral_gb && <> · {custom.ephemeral_gb} GB ephemeral</>}
              {!!custom.swap_mb && <> · {custom.swap_mb} MB swap</>}
            </div>
            <ul style={{ fontSize: 12, color: "var(--gray-600)", margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              <li>Private: only <strong>{tenant}</strong> can use it.</li>
              <li>{specs
                ? <>Its {specs} extra spec{specs === 1 ? "" : "s"} are copied from {d.current_flavor.name}, so it runs on the same hosts.</>
                : <>{d.current_flavor.name} has no extra specs to copy.</>}</li>
              <li>This doesn't resize {d.server_name}: a resize job or PCD does that.</li>
            </ul>
            {create.error && <div style={{ fontSize: 12, color: "var(--red)" }}>{errorDetail(create.error)}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Creating…" : "Create flavor"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
