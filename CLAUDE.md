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
uvicorn app.main:app --reload        # dev server on :8000
pytest                                # all tests
ruff check . && ruff format .        # lint + format
```

### Frontend
```bash
cd frontend
npm install
npm run dev      # dev server on :5173 (proxies /api/* to :8000)
npm run build
npm run lint
npm test         # vitest
```

## Configuration
All runtime config is via environment variables. Copy `.env.example` to `.env`:

| Variable | Description |
|---|---|
| `OS_AUTH_URL` | OpenStack Keystone endpoint |
| `OS_USERNAME` | OpenStack username |
| `OS_PASSWORD` | OpenStack password |
| `OS_PROJECT_NAME` | OpenStack project/tenant |
| `OS_USER_DOMAIN_NAME` | Usually `Default` |
| `OS_PROJECT_DOMAIN_NAME` | Usually `Default` |
| `GRAFANA_URL` | Grafana base URL |
| `GRAFANA_TOKEN` | Grafana service account token (`glsa_...`) |
| `PROMETHEUS_URL` | Set to `<GRAFANA_URL>/api/datasources/proxy/1` — Prometheus (VictoriaMetrics) is only reachable via Grafana proxy in PCD |
| `AI_BACKEND` | `ollama` (default) or `claude` |
| `AI_URL` | Ollama base URL or OpenAI-compatible endpoint |
| `AI_MODEL` | Model name (e.g. `llama3.1:8b`) |
| `AI_API_KEY` | Required when `AI_BACKEND=claude` |

### Prometheus / Grafana note
In PCD, Prometheus is actually VictoriaMetrics (`victoria-metrics-cluster-vmselect:8481`) running inside the cluster — not directly reachable. All metric queries must go through the Grafana datasource proxy. The `PrometheusClient` in `services/prometheus.py` automatically adds the `Authorization: Bearer <GRAFANA_TOKEN>` header.

## Architecture

### Backend (`backend/app/`)
- `main.py` — FastAPI app factory, mounts all routers
- `config.py` — Settings via Pydantic BaseSettings (reads `.env`)
- `dependencies.py` — FastAPI dependency injection: OpenStack connection, Prometheus client, AI provider
- `api/` — One router per feature domain (see table below)
- `services/openstack.py` — Wraps `openstacksdk`; all features import from here, never instantiate `openstack.connect()` elsewhere
- `services/prometheus.py` — Prometheus HTTP query client
- `services/settings_store.py` — Persists runtime settings overrides to `settings.json`
- `services/ai/base.py` — `AIProvider` abstract base class with `analyze(prompt, context) -> str`
- `services/ai/claude.py` — Anthropic Claude implementation
- `services/ai/ollama.py` — Ollama HTTP implementation
- `models/` — Pydantic models shared between API layer and services

### Frontend (`frontend/src/`)
- `main.tsx` — React entry point
- `App.tsx` — Router setup (React Router), layout shell with sidebar nav
- `api/client.ts` — Base fetch wrapper; all API calls use this
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
| Settings | `api/settings.py` | `pages/Settings.tsx` |
| System (version/update) | `api/system.py` | `pages/Settings.tsx` (Software section) |

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
Production runs on a dedicated VM (no Docker). The image is a qcow2 built with Packer, uploaded to Glance, then deployed via Terraform or `deploy.sh`.

**Build image:** `deploy/build-image.sh` — runs Packer (`deploy/packer/pcd-ops.pkr.hcl`) to produce `deploy/packer/output/pcd-ops.qcow2`. Provisions nginx + systemd + Python venv + built frontend into the image.

**Deploy VM:** `cd deploy/terraform && ./deploy.sh` (Terraform) or `deploy/deploy.sh` (OpenStack CLI). Boots from the `pcd-ops` Glance image. Cloud-init writes an empty `.env`; operator fills in credentials via the Settings page.

**Runtime on VM:**
- nginx on port 80 — serves `frontend/dist/` and proxies `/api/` to uvicorn
- systemd unit `pcd-ops` — uvicorn on `127.0.0.1:8000`
- `.env` at `/opt/pcd-ops/.env`, loaded by the systemd `EnvironmentFile`

**Self-update:** Settings → Software → "Check for Updates" / "Update & Restart". Backend calls `deploy/scripts/update.sh` (`git pull` + `pip install` + `npm build` + `systemctl restart`). The script runs detached so it survives the service restart.
