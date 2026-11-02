# PCD Ops — Roadmap

> Last updated: 2026-11-02 · Current release: 0.6.0 · Setup and deployment: [README.md](../README.md) · Architecture and conventions: [CLAUDE.md](../CLAUDE.md) · API: [API.md](API.md) · Tests: [testing-plan.md](testing-plan.md)

**Legend:** ✅ done · 🧪 built, needs lab/field validation · 🔄 partly done · ⬜ not started

| Phase | Theme | Status |
|---|---|---|
| 1 | Foundation: collectors and the operations pages | ✅ Done |
| 2 | Jobs and the event log | ✅ Done |
| 3 | Appliance | ✅ Done |
| 4 | Extension catalog and PCD login | ✅ Done |
| 5 | Correctness, install and settings experience, App Builder moves out (0.6.0) | 🧪 |
| 6 | **Next:** host and VM metrics | ⬜ Next |
| 7 | Capacity: CPU and memory overcommit, idle VMs, right-sizing | ⬜ |
| 8 | Hypervisor lifecycle: OS updates, maintenance mode, live migration, rolling upgrades | 🔄 |
| 9 | Anomaly, drift and alerting | 🔄 |
| 10 | Reports and exports | 🔄 |
| 11 | Log analysis | 🔄 |
| 12 | Hardening for 1.0 | 🔄 |

**Features first, then hardening.** Phase 5 fixed the settings and jobs that later phases build on. Phases 6–11 are in pickup order, not strict dependencies. Phase 6 feeds 7 and 8. Phase 8 also needs the SSH settings fix (Phase 5) and pinned host keys (Phase 11).

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
- ✅ **Reclamation:** stopped VMs (SHUTOFF, ERROR, SHELVED_OFFLOADED), unattached volumes, unused floating IPs; single and bulk delete with confirmation.
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

## Phase 6 — Host and VM metrics ⬜

PCD hypervisors run two exporters ([PCD metrics reference](https://docs.platform9.com/private-cloud-director/monitoring-and-observability/monitoring/pcd-metrics-reference)): node-exporter at `<host-ip>:9388/metrics` (host) and libvirt-exporter at `<host-ip>:9177/metrics` (per VM). An agent on each host turns them into `pcd:` metrics and remote-writes them to PCD every 5 minutes. PCD Ops reads only `pcd:vm_*` and `libvirt_domain_info_meta` today.

**Step 1: the host metrics PCD already has, through Grafana**
- ⬜ Per-host CPU, memory, disk and network on Inventory → Hypervisors and the hypervisor drill-down: `pcd:hyp_cpu_total/usage`, `pcd:hyp_mem_total/usage`, `pcd:hyp_disk_space/usage`, `pcd:hyp_disk_read/write_throughput`, `pcd:hyp_net_rx/tx_throughput`
- ⬜ VM metrics not used yet: `pcd:vm_mem_allocated`, `pcd:vm_rx_bytes/tx_bytes`, `pcd:vm_read/write_latency`, `pcd:vm_cpu_throttling_percentage`

**Step 2: scrape the exporters directly**
- ⬜ **Lab check first:**
  - Are `:9388` and `:9177` reachable from the network the appliance is installed on?
  - Is authentication or TLS needed? The metrics reference doesn't say.
  - Which raw series sit behind the `pcd:` rules?
- ⬜ Discover hypervisors from Nova (`host_ip`). Scrape both exporters on each host, without needing Grafana or a token, and at a finer resolution than the 5-minute remote-write.
- ⬜ **Storage decision:** keep a short in-memory window, or run an embedded VictoriaMetrics single-node on the appliance. This sets the data disk size.
- ⬜ Health: exporter reachable per host. A host whose last sample is older than twice the scrape interval is flagged stale.

## Phase 7 — Capacity: overcommit, idle VMs, right-sizing ⬜

**CPU overcommit analysis**, per host and per aggregate:
- ⬜ For each host, put side by side:
  - vCPUs allocated and physical cores (`openstack_placement_resource_usage` / `_total`, VCPU);
  - the configured `openstack_placement_allocation_ratio`;
  - the effective ratio and the headroom left.
- ⬜ Set against real load (`pcd:hyp_cpu_usage`) and contention (`pcd:vm_cpu_throttling_percentage`).
- ⬜ Flag hosts that are over-allocated *and* contended, and hosts where the ratio could safely go up.

**Memory overcommit analysis**
- ⬜ RAM allocated (Placement MEMORY_MB, `pcd:vm_mem_allocated`) vs physical (`pcd:hyp_mem_total`) vs the allocation ratio and reserved memory.
- ⬜ Compared with real usage (`pcd:hyp_mem_usage`, `pcd:vm_mem_usage`). Flags swap and pressure risk where allocation is above 1:1 and usage is high.

**Idle VM detection**
- ⬜ Running VMs with no meaningful CPU (`pcd:vm_cpu_usage`), network (`pcd:vm_rx_bytes/tx_bytes`) or disk I/O (`pcd:vm_read/write_iops`) over a set window (default 14 days, thresholds in Settings).
- ⬜ Shown on Reclamation as **Idle**, beside the existing power-state rule (stopped VMs), and fed to right-sizing.

**Capacity and right-sizing**
- ⬜ **Physical capacity.** Totals come from Placement and hypervisors, not the sum of tenant quotas (`openstack_nova_limits_*_max`). Today an empty Prometheus means empty totals.
- ⬜ **Forecast Plans:**
  - Per-tenant what-if. Plans store a `tenant_id`, but simulation is cluster-wide.
  - Simulate vDisks.
  - A UI for `/capacity/what-if`.
- ⬜ **Right-sizing:**
  - Recommend upsizing for VMs under CPU or memory pressure.
  - Check that the target flavor fits the host and aggregate before resizing.
  - Call the suggested flavor formula-based: the UI says "AI-suggested", but the AI only comments.
- ⬜ **Reclamation:** measure how long a volume has been unattached, not its age; estimate savings.

## Phase 8 — Hypervisor lifecycle 🔄

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

## Phase 9 — Anomaly, drift and alerting 🔄

- 🔄 **Alerts:** email and a generic webhook exist; their settings save since 0.6.0.
- ⬜ **Statistical detection first:** a baseline per VM and host (z-score or seasonal) finds anomalies, and the AI explains them. Today each VM's 24-hour peaks go to the AI, and findings are pulled from its free-text answer with a regex.
- ⬜ **Config drift:** snapshot flavors, security groups, quotas, aggregates and host config, then diff. Only a docstring today.
- ⬜ Slack, Microsoft Teams and PagerDuty.
- ⬜ Notifications on job success and failure, and on maintenance windows. Selected events routed to alerts.

## Phase 10 — Reports and exports 🔄

- ✅ Inventory exports CSV and XLSX (`pages/Inventory.tsx`).
- ⬜ That export becomes a shared button, added to Reclamation, Snapshots, Right-Sizing, Capacity (including overcommit), Anomaly, Events and OS Updates.
- ⬜ **Scheduled exports:** a new job type `export`. Pick tables, CSV or XLSX, and a schedule; the file is built on the server, emailed and/or kept for download, with retention.
- ⬜ A Reports page of its own. Capacity reports live inside Jobs today.

## Phase 11 — Log analysis 🔄

- ✅ SSH tail of hypervisor logs; natural-language queries (Phase 1)
- ⬜ **Pin SSH host keys.** Today they're accepted automatically; Phase 8 needs this before it touches hosts.
- ⬜ **Hypervisor SSH key from the web UI:** generate a key pair on the appliance and show the public key to install on hosts. Today the key file has to be put on the appliance from the console's emergency shell, or a password used.
- ⬜ Time-range queries and kept history. Today there's one snapshot of the last 100–300 lines per file every 15 minutes.
- ⬜ Control-plane logs, from wherever PCD exposes them.

## Phase 12 — Hardening for 1.0 🔄

- 🔄 **Tests:**
  - 38 backend tests, covering login, setup and config.env only. ⬜ Feature APIs, collectors and jobs.
  - ⬜ A CI workflow.
  - ⬜ Playwright.
  - ⬜ Refresh [testing-plan.md](testing-plan.md), which still says no tests exist.
- ⬜ **HTTPS** (APPLIANCE_STANDARD §7.9): a self-signed certificate at first boot, certificate upload, a redirect from HTTP, and "regenerate" in the console. The session cookie then gets `Secure`.
- ⬜ **Versioned upgrades with rollback** instead of `git pull` of `main` on the appliance. Today that `git pull` also needs GitHub and npm access from the VM. The standard puts upgrades in the catalog.
- ⬜ **Data:**
  - The SQLite database moves from `/opt/pcd-ops/backend/data` to `/var/lib/pcd-ops`.
  - Retention for `app_events`, `agent_runs` and `cache`; only job runs and reports are purged today.
  - Backup and restore of settings and the database.
- ⬜ **Audit log of every write.** Only reclamation, snapshots and access log events today. This matters more once Phase 8 can migrate VMs and reboot hosts.
- ⬜ `/api/health` returns 503 `starting` until the app is ready.
- ⬜ **Scale:** pagination, and fewer live OpenStack calls per request (14 call sites today). Test against a large cloud.
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
- **Metrics come through the Grafana proxy.** From Phase 6, scraping the hypervisor exporters directly is an alternative.
- **Anything merged to `main` ships to installed appliances.** Unreleased work stays on a branch.
- **PCD Ops observes and maintains; pcd-app-builder builds and deploys.**
- **Settings is one tabbed page** (ARCHITECTURE_GUIDE).

## Open questions

- **Overlap with sibling projects:** `pcd-reports` (chargeback vs capacity reports), `pcd-backup-manager` (snapshot policies), `pcd-grafana-dashboards`, `pcd-mcp`. Which owns what?
  -- pcd-reports will remain a separate project focused on chargeback/showback, not capacity management.
  -- the other projects are incomplete and non-functional for now.
- **Does `pcd-lcm` retire** once Phase 8 ships?
- **Hypervisor exporters:** reachable from the appliance? Authenticated? Where are scraped metrics kept?
- **Host software:** how does PCD upgrade its host agents, and can a rolling upgrade drive it?
- **Upgrades:** keep in-app self-update, or move to catalog-driven upgrades?
- **Control-plane logs:** where do they come from in PCD?
- **Private AI:** does it later point at a PCD Private AI service?
