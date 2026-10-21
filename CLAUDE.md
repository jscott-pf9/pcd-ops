# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose
PCD Ops is an operations dashboard for Platform9 Private Cloud Director (PCD). It provides day-to-day operational visibility and automated actions across: resource reclamation, capacity planning with what-if analysis, inventory management, snapshot management, VM right-sizing with AI analysis, anomaly/drift detection, and log analysis.

## Stack
- **Frontend**: React + TypeScript (Vite), TanStack Query, Recharts, shadcn/ui
- **Backend**: Python FastAPI + openstacksdk + prometheus-api-client
- **AI**: Pluggable provider abstraction — Claude (Anthropic), Ollama, or other backends
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

Installs without config.env get the connection from first-run setup (saved in `connection.json` in the state dir), or from a 0.4.x `settings.json` until setup completes.

**App settings** — env vars (catalog values in config.env are initial values; anything saved on the Settings page, in `settings.json`, wins). An empty value means unset:

| Variable | Description |
|---|---|
| `GRAFANA_URL` | Grafana base URL |
| `GRAFANA_TOKEN` | Grafana service account token (`glsa_...`) |
| `PROMETHEUS_URL` | Set to `<GRAFANA_URL>/api/datasources/proxy/1` — Prometheus (VictoriaMetrics) is only reachable via Grafana proxy in PCD |
| `AI_BACKEND` | `ollama` (default) or `claude` |
| `AI_URL` | Ollama base URL or OpenAI-compatible endpoint |
| `AI_MODEL` | Model name (e.g. `llama3.1:8b`) |
| `AI_API_KEY` | Required when `AI_BACKEND=claude` (Settings page only; never in config.env) |
| `PCD_OPS_STATE_DIR` | Per-install secrets: Fernet key + encrypted application credential. Default `/var/lib/pcd-ops`, else `backend/data` (0.4.x upgrades) |

## Authentication and PCD access
- **Login** (`api/auth.py`): PCD username/password/domain against `PCD_AUTH_URL`, scoped to the install project, `admin` role required. Server-side sessions in memory (`appliance/web_auth.py`): 8 h idle, 12 h max; HttpOnly SameSite=Lax cookie; 5 failed logins/min per IP.
- **Gate** (`appliance/web_auth.py`): every `/api/` route needs a session except `/api/health`, `/api/auth/*` and `/api/access/connection` (only before a Keystone URL is known). Until setup is done, the rest return 409 `{"setup_required": true}`. Writes need the `X-Requested-With` header (`CSRF_HEADERS` in `frontend/src/api/client.ts`). The SPA renders `/login` and `/setup` (nginx proxies only `/api/`).
- **Which identity a PCD call uses** (`services/openstack.py`):
  - Anything a person triggers runs with **their token**: take `Depends(user_connection)`, or wrap work started from a request in `with acting_as(conn):` so collectors/jobs it spawns pick it up via `get_connection()`.
  - Unattended work (scheduler collectors, scheduled jobs) uses the **background application credential** minted at `/setup` (`api/access.py`, `appliance/app_credentials.py`). Before setup, a 0.4.x `settings.json` service account is used; it's deleted when setup completes.
  - Call `report_background_failure(exc)` on errors from background work: Keystone rejecting the credential (401, or 404 from `/auth/tokens` when it was deleted) marks it failed → re-authorize banner + `setup_required` in `/api/health`.
- **Console TUI** "Reset setup" (`deploy/scripts/reset-setup.sh`) forgets the credential and logs everyone out.

### Prometheus / Grafana note
In PCD, Prometheus is actually VictoriaMetrics (`victoria-metrics-cluster-vmselect:8481`) running inside the cluster — not directly reachable. All metric queries must go through the Grafana datasource proxy. The `PrometheusClient` in `services/prometheus.py` automatically adds the `Authorization: Bearer <GRAFANA_TOKEN>` header.

## Architecture

### Backend (`backend/app/`)
- `main.py` — FastAPI app factory, mounts all routers
- `config.py` — App settings via Pydantic BaseSettings (env, then `settings.json` overrides)
- `dependencies.py` — FastAPI dependency injection: OpenStack connection, Prometheus client, AI provider
- `api/` — One router per feature domain (see table below)
- `appliance/` — APPLIANCE_STANDARD §8 modules: `config_env.py`, `keystone.py` (login), `web_auth.py` (sessions + gate), `app_credentials.py` (background credential), `connection.py` (PCD connection), `state.py` (state dir)
- `services/openstack.py` — Wraps `openstacksdk`; all features import from here, never instantiate `openstack.connect()` elsewhere. `get_connection()` returns the user's connection inside `acting_as()`, else the background one
- `services/prometheus.py` — Prometheus HTTP query client
- `services/settings_store.py` — Persists runtime settings overrides to `settings.json`
- `services/ai/base.py` — `AIProvider` abstract base class with `analyze(prompt, context) -> str`
- `services/ai/claude.py` — Anthropic Claude implementation
- `services/ai/ollama.py` — Ollama HTTP implementation
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
| Resource Reclamation | `api/reclamation.py` | `pages/Reclamation.tsx` |
| Capacity Planning | `api/capacity.py` | `pages/Capacity.tsx` |
| Inventory | `api/inventory.py` | `pages/Inventory.tsx` |
| Snapshot Management | `api/snapshots.py` | `pages/Snapshots.tsx` |
| Right-Sizing | `api/rightsizing.py` | `pages/RightSizing.tsx` |
| Anomaly Detection | `api/anomaly.py` | `pages/Anomaly.tsx` |
| Log Analysis | `api/logs.py` | `pages/Logs.tsx` |
| Login | `api/auth.py` | `pages/Login.tsx` |
| Setup / background access | `api/access.py` | `pages/Setup.tsx`, `components/PcdAccess.tsx` |
| Settings | `api/settings.py` | `pages/settings/*.tsx` |
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
`services/ai/base.py` defines the `AIProvider` ABC. Implementations live in `services/ai/`. The active provider is resolved at startup from the `AI_BACKEND` env var and injected via `dependencies.py`. When adding a new provider: subclass `AIProvider`, register it in `dependencies.py`.

### Deployment (`deploy/`)
Production runs as a dedicated Alpine Linux appliance VM. The image is a qcow2 built with Packer, uploaded to PCD via `pcdctl`, and deployed via Terraform or the PCD UI.

**Build image:** `deploy/build-image.sh` — runs Packer (`deploy/packer/alpine/pcd-ops-alpine.pkr.hcl`) to produce `deploy/packer/alpine/output/<tag>/pcd-ops-<version>.qcow2` plus `.sha256` and a filled-in `manifest.json`. Provisions nginx + OpenRC + Python venv + built frontend into the image, adds the cloud-init ConfigDrive datasource fix, and fails if credentials or per-install state end up in the image or Nova's safety check rejects it.

**Install:** from the PCD App Catalog (Extensions), described by `manifest.json`. Alternatively `cd deploy/terraform && ./deploy.sh` or the PCD UI after `pcdctl image create`; without config.env, the first page asks for the Keystone URL and project.

**Release:** `deploy/release.sh` — build → boot tests (UEFI + BIOS) → manifest validation → GitHub release (three assets, public) → anonymous download check → PR to the extension index `jscott-pf9/pcd-extensions`. Don't publish or open the index PR without Jeff's approval.

**Runtime on VM:**
- nginx on port 80 — serves `frontend/dist/` and proxies `/api/` to uvicorn
- OpenRC service `pcd-ops` — uvicorn on `127.0.0.1:8000`
- `/etc/pcd-app/config.env` then `/opt/pcd-ops/.env`, sourced by `deploy/openrc/run-uvicorn.sh`
- `/var/lib/pcd-ops/` (0700, pcd-ops) — Fernet key and encrypted application credential

**Self-update:** Settings → Software → "Check for Updates" / "Update & Restart". Backend calls `deploy/scripts/update.sh` (`git pull` + `pip install` + `npm build` + service restart). The script runs detached so it survives the service restart. Because appliances pull `main`, **anything merged to main ships to installed appliances** — keep unreleased work on a branch.

**Appliance management principle:** The Alpine image does **not** run sshd. All VM-level operations (restart service, force update, view logs, network info, reset setup, emergency shell, reboot, shutdown) are accessible through the TUI console at `deploy/scripts/appliance-console-gum.sh` (plain fallback: `appliance-console.sh`), which runs on tty1 in place of the standard getty. When adding any operation that would previously require SSH, add it to the TUI instead — either in the main menu or under Advanced Options.
