# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose
PCD Ops is an operations dashboard for Platform9 Private Cloud Director (PCD). It provides day-to-day operational visibility and automated actions across: resource reclamation, capacity planning with what-if analysis, inventory management, snapshot management, VM right-sizing with AI analysis, anomaly/drift detection, and log analysis.

## Stack
- **Frontend**: React + TypeScript (Vite), TanStack Query, Recharts, shadcn/ui
- **Backend**: Python FastAPI + openstacksdk + prometheus-api-client
- **AI**: Pluggable provider abstraction — Claude (Anthropic) or Private AI (Ollama or any OpenAI-compatible server)
- **Data Sources**: OpenStack APIs (full suite via openstacksdk) + Prometheus metrics

## Development Commands

### Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
# Which PCD to log in to, in config.env format (gitignored): PCD_AUTH_URL, PCD_REGION, PCD_PROJECT_NAME
PCD_APP_CONFIG=../dev.config.env PCD_OPS_STATE_DIR=./data uvicorn app.main:app --reload   # :8000
pytest                                # all tests (no auth bypass; Keystone is mocked)
ruff check . && ruff format .        # lint + format
```

### Frontend
```bash
cd frontend
npm install
npm run dev      # dev server on :5173 (proxies /api/* to :8000)
npm run build
npm test         # vitest
```

### Appliance image
```bash
./deploy/build-image.sh                 # Packer clones the current branch FROM GITHUB: push first
build/test-local.sh                     # boot like Nova (config drive + sample config.env), UEFI
FIRMWARE=bios build/test-local.sh       # same under SeaBIOS
./deploy/release.sh --preflight         # build + boot tests + manifest validation; publishes nothing
```

## Configuration
PCD Ops follows `../APPLIANCE_STANDARD.md` (§5 config.env, §7 authentication). **There is no PCD username or password anywhere** — no `OS_*` settings, env vars or Settings fields. Never add one.

**PCD connection** — from `/etc/pcd-app/config.env`, written by the PCD App Catalog at first boot (path overridable with `PCD_APP_CONFIG`), read by `app/appliance/connection.py` and shown read-only in the UI:

| Variable | Description |
|---|---|
| `PCD_AUTH_URL` | Keystone v3 URL, used for login and every PCD call |
| `PCD_REGION` | Region for every PCD API call |
| `PCD_PROJECT_ID`, `PCD_PROJECT_NAME` | The install project: login is scoped to it (admin role required) and the background credential lives in it |
| `PCD_INSTANCE_NAME`, `PCD_APP_ID`, `PCD_APP_VERSION` | Instance and app identity |

Installs without config.env get the connection from first-run setup (saved in `connection.json` in the state dir).

**App settings** — env vars (catalog values in config.env are initial values; anything saved on the Settings page, in `settings.json` in the state dir, wins and applies without a restart). An empty value means unset:

| Variable | Description |
|---|---|
| `GRAFANA_URL` | Grafana base URL. Empty: `https://<host of PCD_AUTH_URL>/grafana` |
| `GRAFANA_TOKEN` | Grafana service account token (`glsa_...`) |
| `PROMETHEUS_URL` | Empty (normal): the Prometheus data source is found through Grafana's `/api/frontend/settings`. Set only to force one: `<GRAFANA_URL>/api/datasources/proxy/<id>` |
| `METRICS_LOCAL_ENABLED` | PCD Ops' own metrics store scrapes the hypervisors (default on) |
| `METRICS_SCRAPE_INTERVAL` | `60s` (default) or `30s` |
| `METRICS_RETENTION_DAYS` | 30, 90 (default), 180, 365 or 730 |
| `METRICS_KEEP_ALL_SERIES` | Keep every exporter series, not just the allowlist (default off) |
| `AI_BACKEND` | `ollama` (default; shown as **Private AI**) or `claude` |
| `AI_URL` | Private AI: Ollama base URL or OpenAI-compatible endpoint (with or without `/v1`) |
| `AI_MODEL` | Model name (e.g. `llama3.1:8b`) |
| `AI_API_KEY` | Required when `AI_BACKEND=claude` (Settings page only; never in config.env) |
| `AI_PRIVATE_API_KEY` | Optional bearer token for Private AI (Settings page only) |
| `PCD_OPS_STATE_DIR` | Per-install state: Fernet key, encrypted application credential, `settings.json`, `connection.json`. Default `/var/lib/pcd-ops`, else `backend/data` (local development) |

## Authentication and PCD access
- **Login** (`api/auth.py`): PCD username/password/domain against `PCD_AUTH_URL`, scoped to the install project, `admin` role required. Server-side sessions in memory (`appliance/web_auth.py`): 8 h idle, 12 h max; HttpOnly SameSite=Lax cookie; 5 failed logins/min per IP.
- **Gate** (`appliance/web_auth.py`): every `/api/` route needs a session except `/api/health`, `/api/auth/*` and `/api/access/connection` (only before a Keystone URL is known). Until setup is done, the rest return 409 `{"setup_required": true}`. Writes need the `X-Requested-With` header (`CSRF_HEADERS` in `frontend/src/api/client.ts`). The SPA renders `/login` and `/setup` (nginx proxies only `/api/`).
- **Which identity a PCD call uses** (`services/openstack.py`):
  - Anything a person triggers runs with **their token**: take `Depends(user_connection)`, or wrap work started from a request in `with acting_as(conn):` so collectors/jobs it spawns pick it up via `get_connection()`.
  - Unattended work (scheduler collectors, scheduled jobs) uses the **background application credential** minted at `/setup` (`api/access.py`, `appliance/app_credentials.py`).
  - Call `report_background_failure(exc)` on errors from background work: Keystone rejecting the credential (401, or 404 from `/auth/tokens` when it was deleted) marks it failed → re-authorize banner + `setup_required` in `/api/health`.
- **Console TUI** "Reset setup" (`deploy/scripts/reset-setup.sh`) forgets the credential and logs everyone out.

### Metrics: PCD Ops' own store, and PCD's Grafana
- **Own store (host and VM metrics):** VictoriaMetrics single-node on the appliance (`pcd-ops-metrics`, `127.0.0.1:8428`) scrapes node-exporter (`:9388`) and libvirt-exporter (`:9177`) on every hypervisor. `services/local_metrics.py` writes its scrape config, targets (labelled `hypervisor_id`, `hypervisor`, `host_ip`) and retention in the state dir. `services/exporters.py` probes the exporters (Inventory → Hypervisors → Probe exporters).
- **PCD's Grafana (SaaS, 14 days, reduced `pcd:*` series):** PCD's Prometheus is VictoriaMetrics inside the PCD cluster, reachable only through the Grafana data source proxy. `PrometheusClient` in `services/prometheus.py` adds `Authorization: Bearer <GRAFANA_TOKEN>` and resolves the data source from the current settings. Used for the `openstack_*` series only PCD has, and as a fallback.
- **Query host and VM metrics through `services/metrics_catalog.py`**, not with raw PromQL: each metric is defined for both sources, and `source()` picks local when it has data. VMs join on `domain` = Nova server UUID; hosts on `hypervisor_id` locally, or `host` = Nova compute service host (PCD host UUID) in Grafana.

## Architecture

### Backend (`backend/app/`)
- `main.py` — FastAPI app factory, mounts all routers
- `config.py` — App settings via Pydantic BaseSettings (env, then `settings.json` overrides). Read `settings.<field>` when the work runs, never at import, so saved changes apply at once
- `dependencies.py` — FastAPI dependency injection: OpenStack connection, Prometheus client, AI provider
- `api/` — One router per feature domain (see table below)
- `appliance/` — APPLIANCE_STANDARD §8 modules: `config_env.py`, `keystone.py` (login), `web_auth.py` (sessions + gate), `app_credentials.py` (background credential), `connection.py` (PCD connection), `state.py` (state dir)
- `services/openstack.py` — Wraps `openstacksdk`; all features import from here, never instantiate `openstack.connect()` elsewhere. `get_connection()` returns the user's connection inside `acting_as()`, else the background one
- `services/prometheus.py` — Prometheus HTTP query client; derives the Grafana URL and finds the data source
- `services/local_metrics.py`, `services/metrics_catalog.py`, `services/exporters.py` — PCD Ops' own metrics store (`push()` writes samples PCD Ops computes, such as storage capacity), host/VM/storage metric definitions, the exporter probe
- `services/storage.py`, `services/server_groups.py` — Cinder pools grouped into backends (a shared store counted once) and the volume → VM disk series that joins libvirt disk stats to volumes and backends; whether a server group's placement meets its policy
- `services/capacity.py`, `services/rightsizing.py` — what the cloud can allocate (Placement for vCPUs and RAM, Cinder backends' written GB for storage; not quota sums) and what-if with a tenant's quotas; the suggested flavor (smaller or bigger) and whether a host in the VM's cluster has room for it
- `services/overcommit.py` — CPU and memory overcommit (pure functions): Placement's allocation per host (resource provider UUID = Nova hypervisor id) against the 95th percentile of host load and VM CPU wait; a status and reason per host, summed per cluster
- `services/reclamation.py` — Reclamation & Warnings rules (pure functions over records): stopped, idle and orphaned VMs, unused images, orphaned ports, unused routers and networks, empty tenants. The collector, the `resource-reclamation` job and Right-Sizing's idle class all use them. PCD's `admin` project is never shown as a tenant
- `services/anomaly.py` — statistical anomaly detection: each VM's and host's last hour against its usual (same hour on earlier days, z-score, minimum real change); the AI only explains the findings (`collector.explain_anomalies`)
- `services/drift.py` — config change log: snapshots of flavors, security groups, aggregates, hosts and tenant quotas, diffed each collection (`drift_changes` table)
- `services/alerts.py`, `services/notifications.py` — what raises an alert (anomalies, config changes, jobs: on/off and minimum severity in Settings), the cooldown, and delivery to email, the generic webhook and Slack; every alert is recorded (`alerts` table, `GET /api/alerts`)
- `services/settings_store.py` — Persists runtime settings overrides to `settings.json` in the state dir (0600)
- `services/ai/base.py` — `AIProvider` abstract base class with `analyze(prompt, context) -> str` and `models() -> list[str]`
- `services/ai/claude.py` — Anthropic Claude implementation
- `services/ai/private.py` — Private AI: Ollama's API, or the OpenAI-compatible API for other servers
- `models/` — Pydantic models shared between API layer and services

### Frontend (`frontend/src/`)
- `main.tsx` — React entry point
- `App.tsx` — Router setup (React Router), layout shell with sidebar nav
- `api/client.ts` — Base fetch wrapper; all API calls use this (sends the CSRF header; redirects 401 → `/login`, setup 409 → `/setup`). Raw `fetch` POSTs must add `CSRF_HEADERS`
- `api/auth.ts` — Session, login/logout, setup and background-access calls
- `pages/Login.tsx`, `pages/Setup.tsx` — rendered outside the shell; `AuthGate` in `App.tsx` guards everything else
- `pages/` — One page component per feature domain
- `components/` — Shared UI (charts, data tables, stat cards)

### Feature Domains
Each feature has a backend router and a frontend page:

| Domain | Backend | Frontend |
|---|---|---|
| Reclamation & Warnings | `api/reclamation.py` (rules in `services/reclamation.py`) | `pages/reclamation/` (`model.ts` categories, `columns.tsx`, `Reclamation.tsx`) |
| Capacity Planning | `api/capacity.py` (overcommit rules in `services/overcommit.py`) | `pages/Capacity.tsx`, `pages/overcommit/` (Overcommit), `pages/CapacityPlans.tsx` |
| Inventory | `api/inventory.py` | `pages/Inventory.tsx` (tabs), `pages/inventory/` (`kinds.ts` registry, `tables/`, `details/` pages at `/inventory/<kind>/<id>`, `exports.ts` for CSV and Export All; live properties from `GET /inventory/{kind}/{id}/details` with the user's token) |
| Snapshot Management | `api/snapshots.py` | `pages/Snapshots.tsx` |
| Right-Sizing | `api/rightsizing.py` | `pages/RightSizing.tsx` |
| Anomaly Detection | `api/anomaly.py` (`services/anomaly.py`) | `pages/Anomaly.tsx`, `pages/anomaly.ts` |
| Log Analysis | `api/logs.py` | `pages/Logs.tsx` |
| Login | `api/auth.py` | `pages/Login.tsx` |
| Setup / background access | `api/access.py` | `pages/Setup.tsx`, `components/PcdAccess.tsx` |
| Host, VM and storage metrics | `api/metrics.py` (+ `metrics` merged into `/inventory/hypervisors` and `/inventory/servers`) | Inventory detail pages (`components/MetricsCharts.tsx`, synced `TimeChart`s), `pages/settings/SettingsMetrics.tsx` |
| Config Changes | `api/drift.py` (`services/drift.py`) | `pages/drift/` (`ChangeLog.tsx`, `model.ts`) |
| Alerts | `api/alerts.py` (`services/alerts.py`) | `pages/settings/SettingsAlerts.tsx` |
| Settings | `api/settings.py` | `pages/settings/Settings.tsx` (one page, tabs in `?tab=`), `pages/settings/*.tsx` |
| System (version/update) | `api/system.py` | `pages/settings/SettingsUpdates.tsx` |

### Available Prometheus Metrics (openstack-exporter)
Key metric families confirmed live in this environment:

| Domain | Metrics |
|---|---|
| Nova / Compute | `openstack_nova_limits_vcpus_max/used`, `openstack_nova_limits_memory_max/used`, `openstack_nova_server_status`, `openstack_nova_total_vms`, `openstack_nova_flavor`, `openstack_nova_agent_state` |
| Placement | `openstack_placement_resource_total/usage/allocation_ratio/reserved` |
| Cinder / Storage | `openstack_cinder_limits_volume_max/used_gb`, `openstack_cinder_pool_capacity_free/total_gb`, `openstack_cinder_volume_status`, `openstack_cinder_snapshots`, `openstack_cinder_volumes` |
| Neutron | `openstack_neutron_floating_ips`, `openstack_neutron_floating_ips_associated_not_active`, `openstack_neutron_routers_not_active`, `openstack_neutron_ports_no_ips`, `openstack_neutron_agent_state` |
| Glance | `openstack_glance_images`, `openstack_glance_image_bytes` |
| Identity | `openstack_identity_projects`, `openstack_identity_users` |
| Watcher | `openstack_heat_stack_status_counter` |

### AI Provider Pattern
`services/ai/base.py` defines the `AIProvider` ABC. Implementations live in `services/ai/`. `get_ai_provider()` in `dependencies.py` builds the provider from the current settings on every call (no caching, so a saved change applies at once). Claude uses `ai_model` when it's a Claude model, else `claude-opus-5-5`. When adding a new provider: subclass `AIProvider`, register it in `make_ai_provider()`.

### Deployment (`deploy/`)
Production runs as a dedicated Alpine Linux appliance VM. The image is a qcow2 built with Packer, uploaded to PCD via `pcdctl`, and deployed via Terraform or the PCD UI.

**Build image:** `deploy/build-image.sh` — runs Packer (`deploy/packer/alpine/pcd-ops-alpine.pkr.hcl`) to produce `deploy/packer/alpine/output/<tag>/pcd-ops-<version>.qcow2` plus `.sha256` and a filled-in `manifest.json`. Provisions nginx + OpenRC + Python venv + built frontend into the image, adds the cloud-init ConfigDrive datasource fix, and fails if credentials or per-install state end up in the image or Nova's safety check rejects it.

**Install:** from the PCD App Catalog (Extensions), described by `manifest.json`. Alternatively `cd deploy/terraform && ./deploy.sh` or the PCD UI after `pcdctl image create`; without config.env, the first page asks for the Keystone URL and project.

**Release:** `deploy/release.sh` — build → boot tests (UEFI + BIOS) → manifest validation → GitHub release (three assets, public) → anonymous download check → PR to the extension index `jscott-pf9/pcd-extensions`. Don't publish or open the index PR without Jeff's approval.

**Runtime on VM:**
- nginx on port 80 — serves `frontend/dist/` and proxies `/api/` to uvicorn
- OpenRC service `pcd-ops` — uvicorn on `127.0.0.1:8000`
- OpenRC service `pcd-ops-metrics` — VictoriaMetrics on `127.0.0.1:8428` (`deploy/openrc/run-metrics.sh`), data in `/var/lib/pcd-ops/metrics`
- `/etc/pcd-app/config.env` then `/opt/pcd-ops/.env`, sourced by `deploy/openrc/run-uvicorn.sh`
- `/var/lib/pcd-ops/` (0700, pcd-ops) — Fernet key, encrypted application credential, `settings.json`, the metrics store's config and data

**Self-update:** Settings → Software → "Check for Updates" / "Update & Restart". Backend calls `deploy/scripts/update.sh` (`git pull` + `pip install` + `npm build` + service restart). The script runs detached so it survives the service restart. Because appliances pull `main`, **anything merged to main ships to installed appliances** — keep unreleased work on a branch.

**Appliance management principle:** The Alpine image does **not** run sshd. All VM-level operations (restart service, force update, view logs, network info, reset setup, emergency shell, reboot, shutdown) are accessible through the TUI console at `deploy/scripts/appliance-console-gum.sh` (plain fallback: `appliance-console.sh`), which runs on tty1 in place of the standard getty. When adding any operation that would previously require SSH, add it to the TUI instead — either in the main menu or under Advanced Options.
