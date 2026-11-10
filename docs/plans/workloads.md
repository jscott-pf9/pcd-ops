# Plan: Workloads, application-aware right-sizing and capacity (Phase 13)

> Status: planned, not started (written 2026-11-09). Picked up after Phase 12 (local metrics
> only), whose long, single-source history seasonal and peak sizing need, and before Hardening
> for 1.0 (Phase 14). Version decided when it's picked up.

## Why

PCD Ops knows each VM's metrics, not the application behind them. Right-sizing's AI analysis
reads CPU, RAM and IOPS averages and a class; capacity planning sums allocation and use. Neither
knows what an operator knows:

- **Vendor minimums:** "the app needs 8 GB and 4 vCPUs to be supported". Today right-sizing can
  suggest a flavor below them, and the resize job can apply it.
- **Memory used as cache by design:** LINSTOR satellites (linbit-sat-1: 22 % in use, 61 %
  cache) want their cache. It's not waste, and a smaller flavor would take it away.
- **Seasonal use:** "only used during tax season". Off-season the VM looks idle or
  over-provisioned, so right-sizing downsizes it and Reclamation lists it, right before it
  needs its size.
- **Known spikes:** "must absorb the Super Bowl". Sizing on the average misses the event; the
  spike shows as an anomaly although everyone expected it.

These are facts about an **application** (usually several VMs: linbit-sat-1, -2, -3), and they
matter as much for capacity as for right-sizing. A cluster with room today can lack it when
three seasonal workloads peak together; memory that looks free can be cache a workload needs;
a latency-sensitive workload shouldn't sit on an overcommitted host.

Telling only the AI isn't enough: it explains, the formulas decide. A note "needs 8 GB" read only
by the AI gives a good sentence next to a 4 GB suggestion. So each piece of context is a rule the
formulas honor, text the AI reads, or both.

## Decisions

- **A workload is a saved definition:** a name, an owner or contact, members, rules and notes.
- **Members** are matched by any of: VM ids, Nova metadata (`app=…`), a VM name glob
  (`linbit-sat-*`), an image, a tenant. A VM can belong to several workloads: notes come from
  the most specific (VM, metadata, name, image, tenant), rules take the strictest (highest
  minimums, any hold, the larger peak).
- **Nova metadata can carry the basics** without anyone opening PCD Ops: `pcdops:workload`,
  `pcdops:min_vcpus`, `pcdops:min_ram_gb`, `pcdops:hold`, `pcdops:note`. PCD Ops reads it and
  never writes it. It travels with the VM through rebuilds and migrations.
- **Rules:**

  | Rule | Meaning |
  |---|---|
  | `min_vcpus`, `min_ram_gb`, `min_disk_gb` | Vendor or support minimums: no suggestion goes below |
  | `size_for` | `average` (today's behavior), `busy` (95th percentile of hourly averages) or `peak` |
  | `cache_by_design` | RAM the guest uses as cache is needed, not spare |
  | `busy_periods` | Yearly windows `{from: MM-DD, to: MM-DD, label, peak: ×}`: tax season, year-end |
  | `events` | One-off dated peaks `{date, days, label, peak: ×}`: a launch, the Super Bowl |
  | `growth_pct_year` | Expected growth, for forecasts |
  | `no_overcommit` | Latency-sensitive: shouldn't run where CPU or memory is overcommitted |
  | `hold` | Leave alone: no resize suggestion, not reclaimed |

- **The AI only explains.** It gets the workload's rules and notes with the metrics, so it can
  say "low use is expected off-season; it keeps its 8 GB vendor minimum". Notes go into the
  prompt as data, described as the operators' account of the workload, never as instructions.
- **History is shown, not assumed.** Seasonal sizing needs last season in the store (retention
  365 or 730 days). Until then pages say "last tax season isn't in the history yet" and use the
  declared `peak` multiplier.

## Findings: VM disk and load average (checked on the lab, 2026-11-09)

**VM disk usage.** libvirt-exporter reports, per disk, `libvirt_domain_block_stats_capacity_bytes`
(provisioned), `_allocation` (highest written offset) and `_physicalsize_bytes`. PCD Ops already
keeps all three (`services/local_metrics.py` `KEEP`); only the volume pages use them
(`metrics_catalog.VOLUME`).

- File-backed disks (image-backed qcow2 under `/opt/data/instances`, NFS volumes) report what
  has been written: one lab VM's root disk has 120 GB provisioned, 2.2 GB written.
- Network disks (RBD volumes, `libvirt_domain_block_meta{disk_type="network"}`) report
  allocation 0 and physical size = capacity: their usage isn't known to the hypervisor.
- There is no guest filesystem usage (free space inside the guest). That needs the qemu guest
  agent in each guest and an exporter that reads it.
- "Written" is the host's view: files the guest deleted still count until it trims (the lab's
  disks have `discard=unmap`, so `fstrim` in the guest gives the space back).
- Nova can't shrink a root or ephemeral disk and Cinder can't shrink a volume. Disk right-sizing
  is therefore a warning before a disk fills and a report of provisioned against written, never a
  suggestion to shrink.
- The exporter also reports IO limits (`block_stats_limit_*`, from a flavor's `quota:disk_*`
  extra specs).

**Load average.** Not available.

- Hosts: PCD's node-exporter runs only the cpu, diskstats, filesystem, meminfo, netdev, systemd
  and vmstat collectors (`node_scrape_collector_success`): no `loadavg`, no `pressure` (PSI).
  `node_load1/5/15` are already on the allowlist, so they'd appear if PCD enabled the collector.
  PSI (CPU, memory and IO pressure) would be the better signal.
- VMs: load average is the guest OS's own figure; the hypervisor can't see it.
- What PCD Ops has instead: each VM's CPU wait (`vcpu_delay`, time a vCPU was ready but had no
  host CPU, already charted), host iowait (`node_cpu_seconds_total{mode="iowait"}`, kept, not
  charted), and a load-like figure per host: what its VMs asked of the CPUs (CPU time plus ready
  time) per host core.

## Steps

### 1. Store and API (`services/db.py`, new `services/workload.py`, new `api/workloads.py`)
- A `workloads` table: name, owner, `match` (JSON), the rules above, notes, created and updated
  by and at.
- `GET/POST/PUT/DELETE /workloads`, and `POST /workloads/preview` (the VMs a match selects).
  Every change writes an `app_events` entry with the user.
- `services/workload.py`, pure: `members(workload, vms)`, `effective(vm, workloads, metadata)`
  → the merged rules, each with where it came from (which workload, or Nova metadata).
- The inventory collector keeps each server's metadata, so matching needs no extra calls.

### 2. Right-sizing (`services/rightsizing.py`, `collect_rightsizing` in `agent/collector.py`)
- `size_for`: classify and size against the busy-hours figure or the peak from
  `_rightsizing_stats` instead of the average.
- Minimums: floors in `smaller_flavor`, `larger_flavor` and `custom_flavor`; the reasons say
  "vendor minimum 8 GB (workload LINSTOR)".
- `cache_by_design`: the RAM a VM needs is what it uses including cache (`mem_incl_cache_pct`).
- Busy periods and events: outside one, no smaller flavor and not idle; a **Seasonal** pill.
  When the store has the last busy period, size against its busy-hours figure; else use the
  declared multiplier and say so.
- `hold`: no suggestion. The `rightsizing-resize` job (`agent/jobs.py`) skips the VM, and
  Reclamation's idle VMs (`services/reclamation.idle_servers`) leave it out.
- AI: the prompt gets a `workload` block (names, rules, notes) and the disk figures (step 8).
  VMs with notes are analysed even when right-sized. **Re-analyse**
  (`POST /rightsizing/recommendations/{id}/reanalyze`) reapplies the rules to the cached stats
  and asks the AI again after a note changes.

### 3. Capacity planning (`services/capacity.py`, `pages/Capacity.tsx`, `pages/CapacityPlans.tsx`)
- **Demand by workload:** each workload's allocated vCPUs, RAM and storage, and its use on
  average and at peak.
- **Headroom at peak:** each cluster's headroom is checked against what its workloads need in
  each busy period and event, not only today's use. Overlapping periods add up (tax season and
  year-end together): "Feb–Apr: cluster A needs +48 vCPUs at peak; it has 30 free".
- **Calendar:** busy periods and events over the next 12 months, with the projected demand on
  each cluster.
- **What-if from a workload:** "at its peak", "grows X %", "N more VMs like it". Forecast Plans
  (`whatif_plans`) gain an optional workload and a date, and dated plans show on the calendar.
- **Reclaimable capacity that holds up:** right-sizing's savings leave out held workloads,
  respect minimums and keep seasonal VMs at their peak size.
- **Growth:** the 30-day trend plus each workload's declared growth gives the forecast and the
  months until each cluster is full.

### 4. Overcommit (`services/overcommit.py`)
- `no_overcommit` workloads are flagged where they run on a host or cluster whose CPU or memory
  allocation ratio is above 1:1, and their allocation is left out of the room for raising it.
- `cache_by_design` RAM counts as needed, so memory that only looks free isn't offered for
  overcommit.
- `suggest_ratio` uses the coming busy period's peak, not the last 7 days, on hosts that run
  seasonal workloads.

### 5. Anomaly detection and alerts (`services/anomaly.py`, `services/alerts.py`)
- Inside a busy period or event, a workload's VMs are compared with last season when the store
  has it, or marked **expected** instead of raised as anomalies.
- New alert source `workload`: "Tax season starts in 14 days: cluster A lacks 18 vCPUs for its
  peak", once per period, with the usual on/off and minimum severity in Settings.

### 6. UI
- **Workloads page:** the list (members, rules, notes, demand now and at peak, next busy period)
  and an editor with a live preview of the members. "Make a workload from these VMs" from the
  Right-Sizing list's current filter.
- A **Workload** card on the right-sizing drill-down and on VM detail pages: which workloads
  apply and why, the effective rules, notes, "Note for this VM".
- Pills and a workload filter on Right-Sizing and Capacity.

### 7. VM disk (`services/metrics_catalog.py`, `api/metrics.py`, `components/MetricsCharts.tsx`)
- Catalog: `disk_provisioned_bytes`, `disk_written_bytes` (file-backed disks only, joined on
  `block_meta`), `disk_written_pct`.
- A **Disk space** chart on VM pages and a per-disk table: device, root disk or volume, type,
  provisioned, written (or "not reported" for network disks), growth per day, days until full.

### 8. Disk in right-sizing and capacity
- **Disk nearly full:** a file-backed disk written ≥ 85 %, or full within 30 days at its growth
  rate. The suggestion: a shape with a bigger root disk for an image-backed VM, or "extend the
  volume". Report only.
- Provisioned against written on the drill-down, as information; never a shrink suggestion.
- **IO limited:** busy-hours IOPS at ≥ 90 % of the disk's libvirt limit, when one is set.
- Capacity's storage view: written against provisioned per backend and per workload, which is
  what thin provisioning will actually use.

### 9. Load
- Host charts: **iowait %** and **VM CPU demand per core**.
- The right-sizing drill-down shows CPU wait next to CPU.
- Settings → Metrics says load average and pressure need node-exporter's `loadavg` and
  `pressure` collectors on PCD's hosts.

## Tests
- Matching and merging: each match kind, specificity for notes, strictest rule wins, Nova
  metadata.
- Right-sizing: each rule's effect on class, suggestion and reasons; the hold in the resize job
  and in Reclamation's idle VMs; the prompt's workload block.
- Capacity: overlapping busy periods summed per cluster; what-if from a workload; growth.
- Overcommit with `no_overcommit` and `cache_by_design`.
- Anomaly suppression inside a busy period; the pre-season alert, once.
- Disk catalog with file and network disks; days until full; the nearly-full risk.

## Verification
1. **Lab, read-only:** a LINSTOR workload (`linbit-sat-*`, `cache_by_design`) changes
   linbit-sat-1's analysis and the overcommit memory view; a synthetic tax-season workload shows
   on the calendar and in cluster headroom and raises the pre-season alert at a test date; the
   disk charts and table for an image-backed VM and an RBD-backed one.
2. **UI harness:** Playwright drivers for the Workloads page and editor, the Workload card, the
   pills and filter, the disk and load charts, at desktop and phone width.

## Open questions
- Retention: seasonal sizing wants 365 or 730 days. Should defining a busy period suggest
  raising it?
- Importing workloads in bulk from a CMDB or from tags.
- Asking PCD to enable node-exporter's `loadavg` and `pressure` collectors, and a guest-agent
  filesystem collector.
- Placement: should workloads later drive where VMs go (server groups, aggregates)?
