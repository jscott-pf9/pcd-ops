# PCD Ops — Roadmap

> Last updated: 2026-11-09 · Latest release: 0.6.1 · Setup and deployment: [README.md](../README.md) · Architecture and conventions: [CLAUDE.md](../CLAUDE.md) · API: [API.md](API.md) · Tests: [testing-plan.md](testing-plan.md)

**Legend:** ✅ done · 🧪 built, needs lab/field validation · 🔄 partly done · ⏸ on hold · ⬜ not started

**Where the code is:** `main` is 0.7.0 (Phase 6), merged but not tagged or released. Phases 7 and 9 are on `feature/phase7` (15 commits ahead of `main`, version files still 0.7.0), mirrored to `feature/phase6-metrics`, which the lab appliance updates from. Phase 7 ships as 0.7.x and Phase 9 as 0.8.x; the version bump, merge, tag and release haven't been done.

| Phase | Theme | Status |
|---|---|---|
| 1 | Foundation: collectors and the operations pages | ✅ Done |
| 2 | Jobs and the event log | ✅ Done |
| 3 | Appliance | ✅ Done |
| 4 | Extension catalog and PCD login | ✅ Done |
| 5 | Correctness, install and settings experience, App Builder moves out (0.6.0) | 🧪 |
| 6 | Host and VM metrics, scraped and kept by PCD Ops (0.7.0, on `main`, not released) | 🧪 |
| 7 | Reclamation & warnings, CPU and memory overcommit, idle VMs, capacity, right-sizing (0.7.x) | 🧪 |
| 8 | Hypervisor lifecycle: OS updates, maintenance mode, live migration, rolling upgrades | ⏸ |
| 9 | Anomaly, config changes and alerting (0.8.x) | 🔄 |
| 10 | Reports and exports | 🔄 |
| 11 | Log analysis | 🔄 |
| 12 | Local metrics only: PCD's Grafana becomes an optional fallback | ⬜ |
| 13 | Hardening for 1.0 | 🔄 |

**Features first, then hardening.** Phase 5 fixed the settings and jobs that later phases build on. Phases 6–12 are in pickup order, not strict dependencies; Phase 8 is on hold and Phase 9 was done first. Phase 12 (local metrics only) comes before hardening. Phase 6 feeds 7 and 8. Phase 8 also needs the SSH settings fix (Phase 5) and pinned host keys (Phase 11).

**App building has left this app.** App Builder, App Catalog and App Deployments (the Orchestration nav section) moved to a new appliance, **pcd-app-builder**. PCD Ops observes and maintains the cloud; building and deploying applications on it belongs to the new app.

---

## Phase 1 — Foundation: collectors and the operations pages ✅

FastAPI + React app. A background agent fills a SQLite cache from openstacksdk (every 15 min, hourly with AI, daily for right-sizing). Usage and trends come from Prometheus (VictoriaMetrics) through the Grafana proxy.

- ✅ **Inventory:**
  - eight resource types: servers, hypervisors, volumes, networks, floating IPs, images, security groups, clusters;
  - sortable columns, tenant filter, CSV and XLSX export, detail drawer, flavor distribution chart;
  - security-group audit (flags `0.0.0.0/0` ingress);
  - hypervisor drill-down with hosted VMs; NIC count, RAM, OS version and pending patches over SSH.
- ✅ **Topology:** tenant filter; stopped VMs and unattached volumes highlighted.
- ✅ **Reclamation:** stopped VMs (SHUTOFF, ERROR, SHELVED_OFFLOADED), unattached volumes, unused floating IPs; single and bulk delete with confirmation. Grown into Reclamation & Warnings in Phase 7.
- ✅ **Snapshots:** list and delete Cinder snapshots; create/rotate policies (run as jobs).
- ✅ **Capacity:** summary, 7-day trend, straight-line forecast of days to 80/90/100%, AI commentary. **Forecast Plans:** what-if plans written in plain English, saved and simulated.
- ✅ **Right-sizing:** 7 days of `pcd:vm_*` metrics, 20%/80% thresholds, suggested smaller flavor, AI commentary. Collects even when AI is off (0.4.0).
- ✅ **Anomaly:** AI review of each VM's 24-hour peaks for CPU, memory and IOPS.
- ✅ **Logs:** SSH tail of 8 hypervisor log files (pf9 hostagent, nova-compute, cinder, glance, syslog); natural-language queries; paste-and-analyze.
- ✅ **AI providers:** Claude and Ollama behind `AIProvider` (`services/ai/`).
- ✅ Feedback form that opens a GitHub issue (0.4.0).

## Phase 2 — Jobs and the event log ✅

- ✅ Six job types: `snapshot-create`, `snapshot-rotate`, `snapshot-cleanup`, `resource-reclamation`, `capacity-report`, `rightsizing-resize`. Each has a schedule, dry-run and run history.
- ✅ Event log and the event footer (0.2.0)
- ✅ System Status page: connection tests, agent controls, Collect Now (0.2.0)
- ✅ App Builder, App Catalog and App Deployments (Terraform) (0.2.0), seeded with sample roles and security-group templates (0.4.0). **Moved to pcd-app-builder in 0.6.0.**

## Phase 3 — Appliance ✅

- ✅ Alpine qcow2 built with Packer; nginx + OpenRC + Python venv; versioned from the git tag (0.2.0)
- ✅ No sshd. A tty1 console TUI (gum, with a plain fallback) handles restart, reboot, shutdown, force update, OS patch, logs, network info and an emergency shell (0.2.0–0.3.0)
- ✅ Self-update from Settings → Software or the console: `git pull`, rebuild, restart (0.2.0)
- ✅ Passes Nova's image safety checks: UEFI/GPT (0.3.0), hybrid BIOS+UEFI (0.4.2)

## Phase 4 — Extension catalog and PCD login ✅

- ✅ Reads `/etc/pcd-app/config.env` from the PCD App Catalog; fixed cloud-init's config-drive datasource on Alpine; empty values mean unset (0.4.3)
- ✅ `manifest.json` in the catalog's format; `build/test-local.sh` boots the image the way Nova does (config drive, UEFI and BIOS) (0.4.3)
- ✅ **PCD login** with the admin's own account, admin role in the install project; server-side sessions; CSRF header; only failed logins are rate-limited (0.5.0)
- ✅ **Background access** through an application credential minted at first-run setup, stored Fernet-encrypted in `/var/lib/pcd-ops`. No PCD password stored anywhere; the 0.4.x service account is deleted once setup completes (0.5.0)
- ✅ Anything a person triggers runs with their own token (`user_connection`, `acting_as`); unattended work uses the background credential (0.5.0)
- ✅ Console **Reset setup** (0.5.0)
- ✅ `deploy/release.sh`: build, UEFI and BIOS boot tests, manifest validation, GitHub release, anonymous download check, PR to the extension index (0.5.0)

## Phase 5 — Correctness, install and settings experience, App Builder moves out 🧪 (0.6.0)

Built and covered by tests; needs a pass against a lab PCD (Grafana lookup, Private AI, Claude).

**Things that looked done but didn't work**
- ✅ Settings from the Alerts, Connection (SSH) and Software (retention) tabs are saved. `PUT /api/settings` takes any subset of the fields, so each tab saves only its own (`backend/app/api/settings.py`).
- ✅ Changing the AI backend or Prometheus/Grafana settings applies at once: `get_ai_provider()` is built per call and the Prometheus client reads the settings on each query. `settings.json` moved to the state dir (mode 0600).
- ✅ `DELETE /reports/purge` is declared before `DELETE /reports/{report_id}`.
- ✅ The scheduler wakes every minute: jobs are checked every 5 minutes, and right-sizing hourly against its schedule (`agent/runner.py`).
- ✅ The capacity-report job emails the job's `email_to` (comma-separated), and records a recipient only when the email went out.
- ✅ Claude uses the Model setting when it's a Claude model, else `claude-opus-5-5`, with server-side refusal fallbacks.
- ✅ "OpenAI-compatible" is part of **Private AI**: Ollama's own API when the server is Ollama, the OpenAI-compatible API otherwise.
- ✅ Capacity: the AI prompt states the real window (7 days); the trend analysis respects `ai_capacity_enabled`.
- ✅ Snapshots: `POST /snapshots/` creates Cinder snapshots of the server's attached volumes; the policy form offers age-based cleanup.
- ✅ `rightsizing-resize` counts a failed VM once.

**Install and settings experience**
- ✅ **First-run setup screen:** "Finish installing PCD Ops", one line on background access, and a **Complete install** button (APPLIANCE_STANDARD §7.7). The 0.4.x service-account path is gone, since no 0.4.x install needs it.
- ✅ **Settings is one page with underline tabs** (Status, Connection, AI, Alerts, Software) and a single sidebar entry; the tab is in the URL (`?tab=`), and old `/settings/<page>` links redirect.
- 🧪 **Grafana URL derived from the PCD URL** (`https://<host of PCD_AUTH_URL>/grafana`), editable. The Prometheus data source is found through Grafana's `/api/frontend/settings`, so only the token is typed. **Test connection** runs a query through it.
- ✅ **Inline help** under each URL and token field: where to find it, how to create the `glsa_` token (Viewer role), what a valid value looks like.
- 🧪 **AI tab:** **Private AI** or **Claude**; the Model field is a dropdown of the models the endpoint serves, with "Other…" for a typed name; **Test connection** lists the models and asks the chosen one for a reply.

**App Builder moves to pcd-app-builder**
- ✅ Removed from PCD Ops: `api/generate.py`, `api/deployments.py`, the three pages and their nav, the deployment rows in the event feed, the seeded roles and templates. No export step: no installed appliance used them.
- 🧪 pcd-app-builder is a separate repo with its own roadmap; it ships to the extension catalog on its own schedule.

## Phase 6 — Host and VM metrics, kept by PCD Ops 🧪 (0.7.0)

PCD hypervisors run node-exporter (`<host-ip>:9388`) and libvirt-exporter (`<host-ip>:9177`) ([PCD metrics reference](https://docs.platform9.com/private-cloud-director/monitoring-and-observability/monitoring/pcd-metrics-reference)). A host agent sends a reduced set of `pcd:` series from them to PCD's Grafana every 5 minutes. That Grafana is SaaS and keeps 14 days. The appliance runs on-premises next to the hypervisors, so PCD Ops scrapes the exporters itself and keeps the data as long as Settings says.

**Probe**
- 🧪 **Probe exporters** (Inventory → Hypervisors; `services/exporters.py`, `POST /api/inventory/hypervisors/probe-exporters`): from the appliance, can each exporter be reached, is TLS or a login needed, and what does it serve.
- 🧪 **Lab check** (2026-11-03, jscott-lab, 3 hypervisors). **Probe exporters** on Inventory → Hypervisors does this from the appliance (`services/exporters.py`).
  - Both exporters answer on every host: plain http, no authentication. Checked from a workstation on the hypervisor network; still to confirm from the appliance's own network.
  - libvirt-exporter: `domain` is the Nova server UUID. `libvirt_domain_info_meta` adds `instance_name`, `project_uuid`, `project_name` and `flavor`. Disk and network series are per `target_device`; vCPU series per `vcpu`.
  - node-exporter: CPU per core and mode, about 60 `node_memory_*` families, filesystems by `fstype` and `mountpoint`, disks, network per device (`bond0`, VLANs, taps), vmstat, systemd unit states.
  - Size: about 1,100 node-exporter and 300–850 libvirt-exporter lines per host. With an allowlist, roughly 300 series per host plus 30–60 per VM.
  - Nova's compute service `host` is a UUID per hypervisor, presumably the PCD host ID used by the `host` label on `pcd:*` series.

**Store** (decided: VictoriaMetrics single-node on the appliance, on a bigger root disk)
- 🧪 Image: VictoriaMetrics v1.154.1 (sha256-pinned), OpenRC service `pcd-ops-metrics` on `127.0.0.1:8428` only, data in `/var/lib/pcd-ops/metrics`, stops writing with 2 GB left. The manifest asks for a 60 GB disk; cloud-init grows the root filesystem to it.
- 🧪 PCD Ops writes the scrape config, the targets (one per hypervisor, labelled `hypervisor_id`, `hypervisor` and `host_ip` from Nova, refreshed after every inventory run) and the retention (`services/local_metrics.py`). An allowlist keeps the series PCD Ops uses: about 300 per host and 30–60 per VM.
- 🧪 Settings → Metrics: scrape on/off, every 30 or 60 s, keep every series, retention 30 days / 90 days (default) / 6 months / 1 year / 2 years with a disk estimate per choice; the store's state, disk use and per-host scrape health. Console: Advanced Options → Metrics Store.

**Views**
- 🧪 Inventory → Hypervisors: CPU, memory and disk bars, network in/out, stale badge. Servers: CPU and memory bars.
- 🧪 Every Inventory row opens a full detail page (`/inventory/<kind>/<id>`, replacing the side drawer) with links to related items: a VM's host, volumes, server group, security groups and floating IPs; a host's VMs and aggregates; a backend's pools, types and volumes. Hovering a row shows a card of its facts (no requests). Tab, filter and tenant are in the URL, so Back returns to them.
- 🧪 Host page: CPU, memory, disk space, disk I/O and network over 24h to 2 years. VM page: CPU with CPU wait (steal), memory, disk IOPS and latency, network. Hovering one chart moves the cursor and tooltip on all of them to the same time.
- 🧪 Every metrics chart (host, VM, cluster, storage backend, volume and right-sizing pages; added on `feature/phase7`) opens larger in a pop-out, and copies as a PNG titled with the item, chart and range, with a legend. Browsers allow copying images only over HTTPS or on localhost; elsewhere (the appliance on plain HTTP) the button saves the PNG instead. Ranges of days have one date tick per day. Each chart's corner value is labelled "now" with its unit (IOPS, VMs); the pop-out and the image add what it's of (VM, tenant, host and flavor; a host's aggregates; a volume's tenant, backend and VM), the period, the point spacing and the source, and each series' latest, min, average, p95 and max with when the max was.
- 🧪 **Memory charts** (PCD Ops' store): a VM's in use and with disk cache, its size (flavor, what the guest sees, in use, disk cache) and page-ins (major faults); a host's or cluster's used and with page cache, swap used, swapping in and out, OOM kills per hour, and hugepages where configured. Each chart's title explains it. Guest swap needs an agent in the guest, the balloon always equals the flavor (Nova doesn't use it) and libvirt-exporter's host RSS reads 0, so none of those are shown.
- 🧪 Topology: CPU and RAM bars on each hypervisor, and "Open details" to its page.
- 🧪 Hypervisor hardware: CPU model and topology from `lscpu` and installed RAM from `dmidecode` over SSH; otherwise from Nova at microversion 2.87, the last one that returns `cpu_info` and `memory_mb`.

**Storage, server groups, aggregates** (Inventory tabs, each with CSV and in Export All)
- 🧪 Storage Backends: Cinder pools grouped by backend (`services/storage.py`). A backend whose pools all report the same total and free space is one shared store (an NFS export on every host) and counts once. Capacity, used, free, provisioned volume size against capacity × oversubscription, volumes, types. Capacity history: each inventory run writes `pcd_ops_storage_*` into the local store, graphed on the backend's page.
- 🧪 Storage Types: backend, default, public, QoS, encryption, project access, volumes.
- 🧪 Server Groups: policy, rules, members and their hosts, and whether placement satisfies the policy (`services/server_groups.py`: violated for affinity / anti-affinity, not satisfied for the soft variants).
- 🧪 Clusters & Aggregates (was Clusters): every host aggregate, PCD clusters marked; hosts by name, VMs, vCPU and RAM allocation.
- 🧪 Cluster page: CPU, memory, disk, disk I/O and network over all its hosts, plus vCPU and RAM allocation and VM count over time (each inventory run writes `pcd_ops_cluster_*`).
- 🧪 Volume page: throughput, IOPS, latency and allocated space from libvirt's stats for the VM disk it is attached as (`device` from Cinder = libvirt `target_device`). Backend page: the same I/O summed over its attached volumes, joined through `pcd_ops_volume_disk`, which each inventory run writes. How full a filesystem inside a volume is needs a guest agent; not available.
- 🧪 Flavors tab and page: vCPUs, RAM, disks, extra specs, VMs using it.
- 🧪 Images & Snapshots: Glance snapshots (Nova `image_type=snapshot`, or a `block_device_mapping` for volume-backed VMs) are marked and filterable; a volume-backed snapshot's page lists its Cinder snapshots.
- 🧪 VM, image, flavor, volume type and volume pages show every property PCD reports (metadata, image properties, extra specs), fetched live with the signed-in user's token; image store locations are never shown. VM pages list interfaces (network, IPs, MAC).
- 🧪 Security group page: ingress and egress rules separately, with remote groups linked.
- 🧪 Right-Sizing uses the local store once it has a week of data and then looks back 30 days instead of 7; Anomaly uses it once it has a day.

**Sources** (`services/metrics_catalog.py`): each host and VM metric is defined for the local store (raw exporter series) and for PCD's Grafana (`pcd:*`). Local data is used when it exists; Grafana otherwise, and always for the `openstack_*` series only PCD has (Capacity). VMs join on `domain` = the Nova server UUID in both. Through Grafana, hosts join on Nova's compute service host, the PCD host UUID.

- ⬜ Confirm on the lab appliance: exporters reachable from its network, root filesystem at 60 GB, values match PCD's host dashboards.
- ⬜ Later: export or back up the store (with Phase 13's backup and restore).

## Phase 7 — Reclamation, overcommit, idle VMs, capacity, right-sizing 🧪 (0.7.x, branch `feature/phase7`)

Builds on Phase 6: real host load and up to 2 years of history from PCD Ops' own store (`services/metrics_catalog.py`), so idle detection and trends can use long windows. All built: reclamation and warnings (0.7.1), overcommit (0.7.2), capacity and right-sizing (0.7.3). The right-sizing list, drill-down and shaped flavors came later (2026-11-06 and 09, after Phase 9's 0.8.x work) and ship with the next release. What's left is checking it on the lab appliance and a release.

**Reclamation & warnings** (0.7.1; rules in `services/reclamation.py`, page in `pages/reclamation/`)
- 🧪 One page, tabs Overview · Compute · Storage · Network · Tenants; tab, tenant, minimum age and filter in the URL. The overview totals what could be freed (vCPU, RAM, volume and image storage, IP addresses) and lists warnings. **Export All** on the overview downloads one workbook: a summary sheet and a sheet per category, with the filters applied. Single and bulk delete where it's safe.
- 🧪 **Compute:** stopped VMs; idle VMs (below); empty server groups (delete). **Orphaned VMs** (warning, report only):
  - unknown to PCD: a host runs a libvirt domain Nova has no server for;
  - missing from host: Nova places a VM on a host that doesn't run it, or runs it elsewhere (only hosts whose libvirt exporter answered; VMs mid-task skipped);
  - owner deleted: its project or user is gone from Keystone.
  - Host comparisons need PCD Ops' metrics store. A VM is listed only if it still looks wrong at the next collection, so migrations and deletes in progress don't raise warnings.
- 🧪 **Storage:** unattached volumes; unused images and snapshots (no VM, no volume made from it, no libvirt root disk; protected ones can't be deleted). Volumes Glance's Cinder store keeps image data in (`glance_image_id` metadata) are never listed while their image exists; a store volume whose image is gone is listed as leaked. The old page listed every store volume as unattached.
- 🧪 **Network:** unused floating IPs; orphaned ports (unbound, VM gone, router gone; VIPs, which are another port's allowed address, excluded); unused routers (no interfaces, or only to networks with no VMs, and no floating IPs; delete detaches interfaces and clears the gateway first); tenant networks with no VMs (delete takes their subnets; 409 names the ports in use).
- 🧪 **Tenants:** projects that own nothing (servers, volumes, snapshots, networks, ports, routers, floating IPs, images, non-default security groups), with their role assignments. Report only. `admin`, PCD's hidden background tenant, is never listed; `service` and domain projects only on request.
- 🧪 **Ages:** each candidate's "for N days" is the earlier of when PCD Ops first saw it in that category (`reclamation_seen`) and PCD's own timestamp of the change (a stop, a detach, a port update). History starts at 0.7.1.
- 🧪 The `resource-reclamation` job selects with the same rules; a volume's age is how long it has been unattached, no longer how old it is, and Glance store volumes are never deleted.
- 🧪 Inventory: images used only by volumes made from them no longer show as unused; tenant names show for `service` resources too; floating IPs find their VM in every availability zone (VM ports are `compute:<AZ>`).
- 🧪 **Savings:** monthly prices per vCPU, GB of RAM, GB of volume, GB of image and IP address (Settings, set from the Reclamation overview; 0 = not counted, so nothing shows until one is set) give each category and the total what reclaiming saves a month; Export All's summary sheet has it too.
- 🧪 **Job:** the `resource-reclamation` job also releases unused floating IPs and deletes orphaned ports, empty server groups and unused private images (never public, community, shared or protected ones), each after its own number of days, 0 (the default) leaving them alone, so existing jobs do what they did. An item is deleted only if it is a candidate both now, checked against PCD as the job runs, and at the last collection, which gives its age and the full rules (an image a host boots from that Nova doesn't know about is in use).
- 🧪 Lab check (2026-11-06): 3 stopped VMs, 2 empty server groups, 1 leaked image store volume, 23 unused images and snapshots, 3 unbound ports left by earlier App Catalog deploys (the LINSTOR NFS VIP correctly excluded), 1 network with no VMs, no empty tenants, no orphaned VMs. Hiding a VM from Nova's list made it show as unknown to PCD after the second collection. Deletes, on throwaway `pcdops-test-*` resources: a network still in use answered 409 naming its router interface and port; the port, the router (its interface detached first), the network with its subnet and a server group were deleted; a second delete answered 404; each logged an event.

**CPU and memory overcommit** (0.7.2; rules in `services/overcommit.py`, page Capacity Planning → **Overcommit**)
- 🧪 Per host and per cluster, from Placement (each compute node's resource provider, whose UUID is the Nova hypervisor id): host CPUs or memory, reserved, the allocation ratio, what that allows, what is allocated, and the effective ratio (allocated ÷ host CPUs or memory). Read every 15 minutes.
- 🧪 Against real load: the 95th percentile over 7 days of host CPU %, memory used %, swap-in (pages/s, PCD Ops' store only) and each VM's CPU wait (steal), averaged over the host's VMs by vCPUs, with the worst VM named. Worked out at most hourly, from PCD Ops' store or PCD's Grafana; until 7 days are collected it uses what there is and says so. Without either, hosts are judged on allocation alone.
- 🧪 **CPU:** *contended* (more vCPUs than host CPUs in use, and VMs wait ≥ 5 % for a CPU or the host is ≥ 85 % busy); *busy* (the same without overcommit, so the ratio isn't the cause); *nearly full* (≥ 80 % of what the ratio allows); *room to raise* (nearly full but under 50 % busy, with a suggested ratio sized for 70 % load, in 0.5 steps, at most double; an estimate).
- 🧪 **Memory:** *pressure* (swapping in ≥ 10 pages/s, or more allocated than the host has and ≥ 90 % used); *high usage* (≥ 90 % used without overcommit); *nearly full*.
- 🧪 Clusters take their worst host's status and show how many hosts have each. CPU and memory views and a status filter in the URL. `GET /capacity/overcommit`.
- 🧪 Lab check (2026-11-06): 3 hosts at 2:1 CPU and 1:1 memory; pf9hyp01 84 % of its CPU ratio allocated at 8 % load (room to raise) and 84 % of its memory (nearly full); the others OK. A synthetic overloaded host showed as contended and under memory pressure.

**Idle VM detection** (0.7.1)
- 🧪 Running VMs whose 95th-percentile CPU, network and disk IOPS over a window are all under thresholds (defaults: 14 days, 5 %, 10 KB/s, 1 IOPS; changed on the Reclamation page, saved in Settings). VMs younger than the window are left out. Worked out at most hourly with one `quantile_over_time` subquery per metric.
- 🧪 Shown on Reclamation as **Idle VMs**. Right-Sizing's `idle` class is now the same set of VMs (it was its own 20 % rule).
- ⬜ Needs a full window of data: 14 days in PCD Ops' store, or PCD's Grafana (14 days kept). Until then the category says why it's empty.

**Capacity and right-sizing** (0.7.3; `services/capacity.py`, `services/rightsizing.py`)
- 🧪 **Physical capacity.** Capacity Planning's totals are what the cloud can allocate, not the sum of tenant quotas: vCPUs and RAM from Placement (host CPUs or memory, less reserved, times the allocation ratio; the hypervisors' own counts at 1:1 without it), storage as GB written against the size of Cinder's backends, a shared store counted once. Provisioned volume GB, and what thin backends let Cinder provision, are shown beside it: the lab's 7 TB NFS share would otherwise count as 148 TB at its 20× oversubscription, and other data on it fills it too. Each card says what its total is made of. Works without Prometheus or Grafana.
- 🧪 **Trends** come from PCD Ops' metrics store, which keeps the totals each collection (`pcd_ops_capacity_used` / `_total`), over up to 30 days; until it has history the section says so. The tenant-quota series from PCD's Grafana are no longer used. Also fixed: the memory and storage charts filled grey (a gradient id with spaces).
- 🧪 **What-if** on the Capacity page (vCPUs, RAM, volume GB, vDisks, optional tenant), and in Forecast Plans: a tenant plan is also checked against the tenant's Nova and Cinder quotas (cores, RAM, volume GB, and vDisks against the volumes quota), read with the user's token; it fits only if both allow it.
- 🧪 **Right-sizing:** VMs under CPU or memory pressure get a bigger flavor (the smallest that runs the pressured resource at 70 % CPU or 75 % RAM, no smaller in the other); over-provisioned and idle ones a smaller flavor as before. Enabled flavors only: public ones, and private ones the VM's tenant has access to. Each suggestion says whether it fits now: a host in the VM's cluster with room under its allocation ratio, matching the flavor's `aggregate_instance_extra_specs` (*fits*, *same host only*, *no room*). The resize job can act on pressure classes too and skips a VM whose flavor doesn't fit. The suggested flavor is the formula's, and the job no longer says "AI-suggested".
- 🧪 **Right-sizing drill-down** (`/rightsizing/<vm id>`, from the list): why the VM has its class, in words and against the thresholds; average, busiest hours (95th percentile of hourly averages), peak hour and share of hours at pressure for CPU and RAM, and IOPS; current against suggested flavor with the VM's projected use on it, and a warning when its busiest hours would run it at 90 % or more; the other flavors that would do, each with its fit; every host in its cluster with its free vCPUs and RAM and whether the flavor fits there or why not; the AI insight and its full metric history.
- 🧪 **Right-sizing keeps the root disk:** an image-backed VM is only offered flavors with at least its root and ephemeral disk (Nova can't shrink a local disk or resize to a flavor without one), so the lab's VMs are no longer told to move to `pf9.unknown`. Volume-backed VMs are unaffected.
- 🧪 **Right-sizing list:** a sortable table (VM, tenant, class and risk, flavor, suggestion and its fit, CPU and RAM average with busiest hours, IOPS, host) in place of the cards, which repeated the drill-down. Filters by class, tenant and search, all in the URL; worst class first; 200 rows at a time. The list asks for no per-VM series (`?series=false`).
- 🧪 **A flavor shaped for the VM:** when no catalog flavor fits the need, or the closest has more than 50 % and at least 2 vCPUs or 4 GB to spare (flavors usually grow CPU and RAM together), the drill-down offers one: the vCPUs and RAM it needs (whole GB), the current flavor's disks, swap and extra specs, with projected use and fit. **Create private flavor…** creates it with the user's token, private to the VM's tenant, and makes it the VM's suggested flavor at once (the resize job can use it). It refuses a name already taken or a shape the tenant can already use, and logs an event.
- 🧪 Lab check (2026-11-09, read-only): 20 VMs. The private `s1.medium` (storage-tenant) is now a candidate for that tenant's VMs. Shaped flavors offered: vjailbreak-01 1 vCPU / 5 GB (m1.large had 3 vCPUs to spare); provider-gw-01 and -02 1 vCPU / 1 GB keeping their 80 GB disk, and linbit-sat-3 1 vCPU / 2 GB keeping its 120 GB, where no catalog flavor qualified. Flavor creation was tried only against a stand-in for Nova.
- 🧪 **RAM that counts cache:** PCD's Grafana counts a guest's disk cache as used RAM, so linbit-sat-1 read 95 % there against 22 % in use (61 % is cache). Right-sizing now takes RAM from PCD Ops' store once it has a day of data, even while CPU and disk still come from Grafana, and never calls Grafana's RAM memory pressure on its own; the list marks it "counts cache" and the reasons say why.
- ⬜ Create a shaped flavor on the lab appliance, resize a VM to it with the resize job, and check the next run keeps suggesting it.

## Phase 8 — Hypervisor lifecycle ⏸ (on hold since 2026-11-06)

The flow is ported from `pcd-lcm`, an Ansible prototype that cycles hosts one at a time: preflight → disable scheduling → live-migrate VMs off → `apt` upgrade → reboot if needed → wait healthy → re-enable.

Here:
- Nova and Placement calls go through openstacksdk, not `pcdctl`.
- Host-level steps use SSH, as Logs and Inventory already do.
- Work a person starts runs with their token; scheduled windows use the background credential.

**Hypervisor OS Update view**
- 🔄 Pending-package counts per host over SSH (Inventory → Hypervisors)
- ⬜ Per host:
  - pending security vs regular updates;
  - kernel update or reboot required;
  - last patched;
  - PCD host-agent version.
- ⬜ A cluster rollup.

**Maintenance mode**
- ⬜ Enter: disable nova-compute scheduling with a reason. Exit: re-enable it.
- ⬜ The state shows on Inventory and Topology.

**Live migration**
- ⬜ Migrate one VM, to a host Nova picks or one chosen by hand.
- ⬜ **Evacuate host:** live-migrate every VM off. Shared-storage or block migration is picked per VM, with retry and per-VM progress.
- ⬜ **Preflight** before evacuating:
  - the remaining hosts have the CPU and memory headroom (Phase 7 overcommit math);
  - no VM is pinned or PCI-bound so it can't move;
  - the cluster stays above its minimum host count.

**Rolling cluster upgrades**
- ⬜ One host at a time: preflight → maintenance mode → evacuate → `apt` upgrade of installed packages only (never a dist upgrade) → reboot if needed → wait healthy (nova-compute up, exporters back) → exit maintenance → next host.
- ⬜ Dry-run plan first. Pause, resume and abort. Stops on the first failure and leaves that host in maintenance.

**Schedule**
- ⬜ Maintenance windows per cluster or aggregate, as a new job type `rolling-patch`.
- ⬜ Notifications when a window starts, after each host, and at the end (Phase 9).

**Later**
- ⬜ Rolling upgrades of the PCD host software, not only the OS. This depends on how PCD upgrades its host agents.

## Phase 9 — Anomaly, config changes and alerting 🔄 (0.8.x, on `feature/phase7`)

Phase 8 is on hold; Phase 9 ships after Phase 7 as 0.8.1 (alerting), 0.8.2 (config change log), 0.8.3 (statistical anomalies). Drift is a change log only: no approved baseline to compare against.

- 🧪 **Alerts** (0.8.1; `services/alerts.py`): anomalies, config changes and jobs raise alerts, each source on or off with a minimum severity; the same alert again within the cooldown (60 minutes) is recorded but not sent unless it got more severe. Sent to every configured channel: email, the generic webhook (its JSON keeps its old keys and adds the alert's source, key, fields and link) and **Slack** (incoming webhook, Block Kit, colored by severity, with a link to the page when the appliance's address is set). Settings → Alerts: the rules, a test button per channel, and the recent alerts with what each channel did. Jobs: a failed run alerts high, a run with items that failed (a snapshot, a resize, a delete) medium, success only if asked. Alerts also go to the event log; SMTP no longer blocks the server while it sends.
- 🧪 **Config change log** (0.8.2; `services/drift.py`, page Infrastructure → **Config Changes**): every collection snapshots flavors (with extra specs), security groups (rules compared by what they allow, so order doesn't matter), aggregates (metadata, hosts), hosts (state, enabled, hypervisor and OS version, CPU, memory, Placement allocation ratios and reserved) and each tenant's Nova, Cinder and Neutron quotas (never `admin`), and records what was added, removed or changed since the last one, field by field. It shows what and when, not who (PCD doesn't record it). A source that can't be read keeps its last snapshot, so a failure isn't logged as everything removed. High: security group rules added or removed, a host down, disabled or gone, an aggregate losing a host; the rest medium. Each kind with changes raises one alert per collection. Filters and kind in the URL, export to a workbook, kept 180 days (`drift_retention_days`). Lab check (2026-11-06): 16 flavors, 36 security groups, 1 aggregate, 3 hosts and 7 tenants' quotas tracked; a second run recorded nothing; one simulated edit per kind was each recorded and alerted.
- 🧪 **Statistical anomaly detection** (0.8.3; `services/anomaly.py`): every 15 minutes each VM's CPU, memory, network, disk IOPS, CPU wait and disk latency, and each host's CPU, memory, network and swap-in, as hourly means over 8 days; the last hour against the same hour on earlier days once there are 5 days (so a nightly backup isn't an anomaly), else the whole window, and nothing under a day. A finding is ≥ 3σ (4.5 high, 6 critical) and a real change (CPU 15 points, memory 10, network 1 MB/s per VM, …); memory, CPU wait, latency and swap-in only count when they rise. Each has now, usual, deviation, how long, and a 48-hour sparkline; the Anomaly page filters by severity and VM/host in the URL, and an alert's link opens its finding. New or more severe findings alert. The AI only explains the findings, on its schedule; nothing is parsed out of its answer any more. Lab check (2026-11-06): queries run on PCD Ops' store over 20 VMs and 3 hosts; with 2 hours of data the page says it needs 24.
- ⬜ Send a real Slack alert and an email from the lab appliance (tested against local sinks only).
- ⬜ Microsoft Teams and PagerDuty (Slack done in 0.8.1).
- ⬜ Notifications on maintenance windows (job success and failure done in 0.8.1).

## Phase 10 — Reports and exports 🔄

- ✅ Inventory exports CSV and XLSX (`pages/Inventory.tsx`).
- 🔄 That export becomes shared (`components/workbook.ts`, one workbook with a sheet per table): ✅ Inventory Export All, ✅ Reclamation (0.7.1), ✅ Config Changes (0.8.2). ⬜ Snapshots, Right-Sizing, Capacity (including overcommit), Anomaly, Events and OS Updates.
- ⬜ **Scheduled exports:** a new job type `export`. Pick tables, CSV or XLSX, and a schedule; the file is built on the server, emailed and/or kept for download, with retention.
- ⬜ A Reports page of its own. Capacity reports live inside Jobs today.

## Phase 11 — Log analysis 🔄

- ✅ SSH tail of hypervisor logs; natural-language queries (Phase 1)
- ⬜ **Pin SSH host keys.** Today they're accepted automatically; Phase 8 needs this before it touches hosts.
- 🧪 **Hypervisor SSH key from the web UI:** Settings → Connection → **Generate key** makes an ed25519 key pair in the state dir and shows the public key to add to each host's `authorized_keys`; the private key never leaves the appliance (0.6.1).
- ⬜ Time-range queries and kept history. Today there's one snapshot of the last 100–300 lines per file every 15 minutes.
- ⬜ Control-plane logs, from wherever PCD exposes them.

## Phase 12 — Local metrics only: PCD's Grafana becomes an optional fallback ⬜

Plan: [plans/local-metrics-only.md](plans/local-metrics-only.md). Since Phase 6, PCD Ops scrapes the hypervisors' exporters itself, so PCD's Grafana (SaaS, 14 days, reduced `pcd:*` series) adds little and costs a token at setup, WAN traffic for every metric query, and a second set of definitions that don't agree (its VM RAM counts disk cache). Picked up before Hardening for 1.0.

- ⬜ **Capacity report without Grafana:** each tenant's usage from Nova's and Cinder's quota APIs, the trend from per-tenant samples PCD Ops writes into its own store. It's the last feature on the `openstack_*` series.
- ⬜ **One source:** the local store whenever it works, no switching at 7 days. Right-sizing, idle detection, overcommit and anomaly use the history the store has and say how much ("collecting: 3 of 14 days").
- ⬜ **Grafana as a fallback** only for appliances that can't reach the exporters: its settings move from Connection to a collapsed section under Settings → Metrics, pointed to when the exporter probe fails; with the store working, Settings offers to remove the token.
- ⬜ **Setup and docs:** no Grafana token in the setup path, the manifest's post-install notes (also still saying plain HTTP), the README and CLAUDE.md.
- ⬜ **Verify:** the lab appliance with the token removed, every page working and no requests to PCD's Grafana; the fallback with the exporters blocked.

## Phase 13 — Hardening for 1.0 🔄

- 🔄 **Tests:**
  - 163 backend tests (pytest; Keystone and OpenStack mocked): login, setup, config.env, and now most feature APIs, collectors, rules and jobs. 53 frontend tests (vitest) on the page models and chart helpers.
  - ⬜ A CI workflow.
  - ⬜ Playwright in the repo. UI checks so far are scripts against a local harness with lab data, not committed.
  - ⬜ Refresh [testing-plan.md](testing-plan.md), which still says no tests exist.
- 🧪 **HTTPS** (APPLIANCE_STANDARD §7.9; `appliance/tls.py`, Settings → **HTTPS**, on `feature/phase7`):
  - A self-signed certificate at first boot (OpenRC `pcd-ops-tls`, before nginx; the host name, instance name and addresses), served on 443. Plain HTTP redirects to HTTPS except `/api/health`; Settings can turn the redirect off. The session cookie gets `Secure`, and the charts' Copy button works (browsers allow copying images only in a secure context; a self-signed certificate counts once accepted, checked in Chrome).
  - Settings shows the certificate (names, issuer, validity, fingerprint, chain) and warns when it doesn't cover the address in use. **Download** it to trust it on a computer; **New self-signed** for other names or a floating IP; **Create CSR** (the key stays on the appliance; upload the signed certificate without a key); **Upload** a certificate, chain and key, checked first (key matches, valid now, chain order). Each change reloads nginx and checks it serves the new certificate, and is logged.
  - Console → Advanced → **HTTPS**: show and regenerate; **Enable HTTPS** for appliances built before it (installs the nginx config and the boot service). The manifest and Terraform open 443.
  - Alerts 30 and 7 days before the certificate expires, and once it has.
  - Checked on Alpine 3.21 with nginx in a container: Enable HTTPS from the old config, the redirect and `/api/health` on HTTP, a certificate installed by the app as `pcd-ops` through sudo, console regenerate, the openssl fallback.
- ⬜ HTTPS on the lab appliance: Enable HTTPS from the console, allow 443, then upload a CA-signed certificate. And a new image's first boot (`deploy/release.sh --preflight`).
- ⬜ **Versioned upgrades with rollback** instead of `git pull` of `main` on the appliance. Today that `git pull` also needs GitHub and npm access from the VM. The standard puts upgrades in the catalog.
- ⬜ **Data:**
  - The SQLite database moves from `/opt/pcd-ops/backend/data` to `/var/lib/pcd-ops`.
  - Retention for `app_events`, `agent_runs` and `cache`. Purged today: job runs, alerts (with job runs), reports, and the config change log (`drift_retention_days`).
  - Backup and restore of settings and the database.
- ⬜ **Audit log of every write.** Event log entries today: reclamation deletes, snapshots, background access, flavor creation and alerts; settings changes and job edits aren't logged. This matters more once Phase 8 can migrate VMs and reboot hosts.
- ⬜ `/api/health` returns 503 `starting` until the app is ready.
- ⬜ **Scale testing.** Every page has only been tried on the lab: 3 hypervisors, a few dozen VMs and volumes, a handful of networks. Clouds with thousands of VMs and volumes and hundreds of networks and hypervisors will break some layouts and some loading. Test against a large cloud, or a synthetic inventory of that size, then fix what breaks. Known weak spots:
  - **Inventory tables** render every row, with no pagination or virtual scrolling. Sorting, filtering and the hover card all work on the full list in the browser.
  - **Detail pages** find their item, and the items related to it, in whole inventory lists. A VM's page loads eight of them (VMs, hypervisors, volumes, floating IPs, security groups, server groups, images, flavors). Related tables are unbounded: a backend's volumes, a flavor's or security group's VMs, a cluster's hosts and VMs. These need server-side lookups, and related tables need limits with a link to the filtered tab.
  - **Tenant dropdown and tab bar:** the dropdown lists every tenant, and 12 tabs wrap on narrow screens.
  - **Topology:** draws every hypervisor and VM; the 8-network limit is already a workaround.
  - **Cluster graphs** select hosts with a regex of every host ID in the PromQL query. Hundreds of hosts make it long, and it may hit query-length limits.
  - **Backend I/O** joins libvirt disk stats to `pcd_ops_volume_disk`. With thousands of volumes the join is heavy, and every inventory run writes a series per attached volume.
  - **Metrics store:** about 300 series per host and 30–60 per VM. That's roughly 100k active series at 200 hosts and 1,000 VMs. Check the scrape load on the appliance, the 60 GB disk estimate at each retention, and query times on 1-year ranges.
  - **Export All** fetches every list and builds the workbook in the browser.
  - **Right-Sizing:** the list is a table showing 200 rows at a time without per-VM series, but the API still returns every VM, filtering and sorting happen in the browser, and the drill-down scans the whole cached list. The collector makes one AI call per VM that needs attention, in turn. Needs server-side paging and filters, and batched or capped AI insights.
  - **Backend:** one inventory run collects everything at once. Large responses go out unpaginated, and requests make live OpenStack calls (14 call sites today).
- ⬜ A read-only role alongside admin.
- ⬜ A full in-app help panel. Phase 5 adds only field-level help.

---

## Backlog (unscheduled)

- Topology: link VMs to networks by their real ports (today by project); lift the 8-network limit when no tenant filter is set
- Layered topology (i.e. Region views, availability zone views, clusters).  Drill down.  Maybe layered on top of geographic views.
- Keypairs view (collected, not shown)
- Integrate Grafana dashboards into the application?

## Decisions and principles

- **No PCD password anywhere.** People act with their own token; unattended work uses the background application credential (APPLIANCE_STANDARD §7).
- **Read-only by default.** Writes are explicit and confirmed; jobs, bulk actions and host maintenance all have a dry-run.
- **Host maintenance goes one host at a time** and stops on the first failure.
- **Every feature works without AI.** AI explains and summarizes; it doesn't decide.
- **PCD Ops keeps its own host and VM metrics.** It scrapes the hypervisors' exporters into VictoriaMetrics on the appliance (Phase 6). PCD's Grafana is used for the `openstack_*` series only PCD has, and as a fallback.
- **Anything merged to `main` ships to installed appliances.** Unreleased work stays on a branch.
- **PCD Ops observes and maintains; pcd-app-builder builds and deploys.**
- **Settings is one tabbed page** (ARCHITECTURE_GUIDE).

## Open questions

- **Overlap with sibling projects:** `pcd-reports` (chargeback vs capacity reports), `pcd-backup-manager` (snapshot policies), `pcd-grafana-dashboards`, `pcd-mcp`. Which owns what?
  -- pcd-reports will remain a separate project focused on chargeback/showback, not capacity management.
  -- the other projects are incomplete and non-functional for now.
- **Does `pcd-lcm` retire** once Phase 8 ships?
- **Hypervisor exporters:** reachable from the appliance's own network on every install? (Plain http with no login on the lab, from a workstation.)
- **Host software:** how does PCD upgrade its host agents, and can a rolling upgrade drive it?
- **Upgrades:** keep in-app self-update, or move to catalog-driven upgrades?
- **Control-plane logs:** where do they come from in PCD?
- **Private AI:** does it later point at a PCD Private AI service?
