# Plan: local metrics only, PCD's Grafana optional (Phase 12)

> Status: planned, not started (written 2026-11-09). Picked up after Phase 11 and before
> Hardening for 1.0 (Phase 13). Version decided when it's picked up.

## Why

Since Phase 6, PCD Ops scrapes node-exporter and libvirt-exporter on every hypervisor into its own
VictoriaMetrics. PCD's Grafana (SaaS, 14 days, reduced `pcd:*` series) is still wired in as a
second source, and that now costs more than it gives:

- **Setup is harder than it needs to be.** The first admin has to create a Grafana service
  account token (`glsa_…`, Viewer) and paste it into Settings. The manifest's post-install notes
  and the README still say so.
- **WAN traffic.** Grafana is SaaS, everything else PCD Ops measures is next to it on-premises.
  While a Grafana token is set, metric queries go over the WAN: host and VM values every 15
  minutes, overcommit's and anomaly detection's 7–8-day range queries hourly, right-sizing's per-VM
  range and percentile queries. The PCD API calls (Keystone, Nova, Cinder, …) still go to PCD's
  control plane; the metric queries, the heavy part, would stop.
- **Two sources that don't agree.** Every metric is defined twice, and the definitions differ:
  Grafana's VM RAM counts disk cache as used (linbit-sat-1: 95 % there, 22 % in use), its latency
  series have no documented unit, and it has no swap, cache or page-fault series. Right-sizing
  switches source when the store reaches 7 days, so classifications can flip overnight.
- **More code:** a second query path for every metric, data-source discovery through Grafana's
  `/api/frontend/settings`, source switching, and their tests.

What Grafana still gives:
- **History from day one:** 14 days, so right-sizing, idle detection (14-day window), overcommit
  (7-day p95) and anomaly baselines work the day PCD Ops is installed. Worth two weeks once.
- **A fallback** where the appliance can't reach the exporters (ports 9388, 9177) on a segmented
  network. The only lasting benefit.
- **`openstack_*` series** for the capacity-report job: the last feature that needs Grafana.

Not done: copying Grafana's 14 days into the local store at install. The definitions differ, so
the history would jump where the two sources meet.

## Decisions

- **The local store is the only source** whenever it works (on, running, and scraping at least
  one exporter). No feature needs Grafana.
- **Grafana stays as an optional fallback** for appliances whose store can't scrape the
  hypervisors, set up under Settings → Metrics, not in the setup path.
- **Warm-up is shown, not hidden:** while the store has less history than a feature looks back
  over, the page says how much it has ("collecting: 3 of 14 days") instead of switching source.
- Existing installs with a token keep working: the token is kept and unused while the store
  works, and Settings offers to remove it.

## Steps

### 1. The capacity report without Grafana (`agent/jobs.py`, `services/capacity.py`)
- **Usage now:** each tenant's vCPUs, RAM and volume GB used and allowed, from Nova's
  `os-quota-sets/{project}/detail` and Cinder's `os-quota-sets/{project}?usage=true` with the
  background credential. Reuse the quota fetch `api/capacity._tenant_quota` and the change log
  already have (one shared helper in `services/capacity.py`). `admin` stays hidden.
- **The trend:** each fast collection pushes `pcd_ops_tenant_{vcpus,ram_mb,volume_gb}_used` and
  `_max` (label `project_id`) into the local store with `local_metrics.push`, as capacity totals
  and storage already do. The report reads 7 days from there; until it has them it says how many.
- Remove the `openstack_*` queries and the job's `prometheus_client` import.

### 2. One source (`services/metrics_catalog.py`, `agent/collector.py`, `api/metrics.py`)
- `source()` returns `"local"` when the store works, `"pcd"` only when the store can't scrape any
  exporter **and** a Grafana token is set, else None. The `min_days` argument goes.
- Right-sizing: drop `RS_LOCAL_MIN_DAYS` and `RS_MEM_LOCAL_MIN_DAYS`; look back up to 30 days over
  whatever the store has, and record the days it covered (`window_days`). `mem_source` and the
  "counts cache" rule stay for the fallback.
- Idle detection (14 days), overcommit (7 days), anomaly (24 h minimum, seasonal from 5 days):
  same, each saying how much history it had (several already do; make it uniform).
- A shared warm-up note (`components/`): "PCD Ops has collected N days of metrics; <feature>
  looks at up to M." On Right-Sizing, Reclamation's Idle VMs, Overcommit and Anomaly.

### 3. Grafana as a fallback only (Settings, Status, setup)
- **Settings → Connection** loses the Grafana fields. **Settings → Metrics** gains a collapsed
  "Fallback: PCD's Grafana" section: why it exists (the appliance can't reach the hypervisors'
  exporters), the token and Grafana URL, Test connection.
- When the exporter probe (Inventory → Hypervisors → Probe exporters, `services/exporters.py`)
  finds them unreachable, Settings → Metrics says so and points at the fallback.
- With a token set and the store working: "Not used: PCD Ops scrapes the hypervisors itself"
  and **Remove token**.
- **Status tab:** the Grafana check only when a token is set, labelled as the fallback.
- Inventory, detail pages and charts say which source they show only when it's the fallback.

### 4. Docs and catalog
- `manifest.json`: post-install notes without the Grafana token (and current on HTTPS: a
  self-signed certificate, not plain HTTP); the description without "Prometheus".
- README: setup steps without the token; the Grafana section becomes "Fallback when the
  appliance can't reach the hypervisors".
- CLAUDE.md: the metrics section and the settings table (`GRAFANA_URL`, `GRAFANA_TOKEN`,
  `PROMETHEUS_URL` documented as the fallback).
- ROADMAP: Phase 12 items marked as they land.

## Tests
- `source()`: local when the store scrapes; the fallback only with no exporter up and a token;
  None otherwise.
- Capacity report: usage from fake Nova and Cinder quota APIs, the trend from the store, the
  "not enough history" text, no Prometheus client touched.
- Right-sizing, idle, overcommit and anomaly with 2 days of local data: they run, record the days
  covered, and don't switch source.
- Settings: Grafana fields only under Metrics; Remove token; the probe hint.

## Verification
1. **Lab appliance:** remove the Grafana token. Every page works: Inventory metrics, detail
   charts, Right-Sizing, Reclamation (idle), Overcommit, Anomaly, Capacity, the capacity-report
   job.
2. **WAN:** with the token removed, the appliance makes no requests to `<PCD host>/grafana`
   (nginx and app logs, or a packet capture on the VM's port in PCD). Before and after, count
   the metric queries per hour to show the saving.
3. **Fallback:** on a scratch appliance (or the UI harness), block the exporters (a security
   group without 9388 and 9177 towards the hosts) with a token set: pages work from Grafana and
   say so.
4. **New install:** the setup path never asks for a token; the warm-up notes show on day one.

## Open questions
- Remove the Grafana path entirely once field installs show the exporters are always reachable?
  Decide after a few customer installs (ROADMAP open question "Hypervisor exporters").
- Air-gapped or WAN-restricted sites: with this phase PCD Ops' own traffic to PCD is the API
  calls only. Worth stating in the README once measured.
