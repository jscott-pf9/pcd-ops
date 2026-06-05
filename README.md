# PCD Ops

An operations dashboard for [Platform9 Private Cloud Director (PCD)](https://platform9.com/private-cloud-director/). Provides day-to-day operational visibility and automated actions across your OpenStack environment.

## Features

| Feature | Description |
|---|---|
| **Resource Reclamation** | Identify idle VMs, unused floating IPs, orphaned volumes, and stale snapshots |
| **Capacity Planning** | Cluster-level vCPU / RAM / storage headroom with what-if analysis |
| **Inventory** | Searchable, filterable view of all OpenStack resources across projects |
| **Snapshot Management** | List, age, and delete snapshots with bulk operations |
| **VM Right-Sizing** | AI-assisted recommendations based on actual utilization from Prometheus |
| **Anomaly & Drift Detection** | Alert on metric anomalies and configuration drift |
| **Log Analysis** | AI-assisted log triage and pattern detection |
| **Scheduled Jobs** | Background data collection with job history and status |

## Stack

- **Frontend** — React 18 + TypeScript, Vite, TanStack Query, Recharts, React Flow
- **Backend** — Python 3.10+, FastAPI, openstacksdk, prometheus-api-client
- **AI** — Pluggable provider: Claude (Anthropic) or Ollama
- **Data Sources** — OpenStack APIs + Prometheus/VictoriaMetrics via Grafana proxy

## Getting Started

### Prerequisites

- Python 3.10+
- Node.js 18+
- Access to a PCD / OpenStack environment
- Grafana with a Prometheus/VictoriaMetrics datasource (PCD default setup)

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp ../.env.example ../.env
# edit .env with your OpenStack + Grafana credentials

uvicorn app.main:app --reload
# API available at http://localhost:8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# UI available at http://localhost:5173 (proxies /api/* to :8000)
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```ini
# OpenStack
OS_AUTH_URL=https://your-pcd-host/keystone/v3
OS_USERNAME=admin
OS_PASSWORD=
OS_PROJECT_NAME=service

# Grafana / Prometheus
# In PCD, Prometheus (VictoriaMetrics) is only reachable via the Grafana proxy
GRAFANA_URL=https://your-pcd-host/grafana/
GRAFANA_TOKEN=glsa_...
PROMETHEUS_URL=https://your-pcd-host/grafana/api/datasources/proxy/1

# AI backend: 'ollama' (default) or 'claude'
AI_BACKEND=ollama
AI_URL=http://localhost:11434
AI_MODEL=llama3.1:8b
# AI_API_KEY=sk-ant-...  # required when AI_BACKEND=claude
```

## Development

```bash
# Backend tests
cd backend && pytest

# Backend lint + format
ruff check . && ruff format .

# Frontend tests
cd frontend && npm test

# Frontend lint
npm run lint
```

## Deployment

Production runs on a dedicated VM (no Docker). The image is a qcow2 built with Packer, uploaded to Glance, and deployed via Terraform.

```bash
# Build the VM image (requires Packer)
deploy/build-image.sh

# Deploy via Terraform
cd deploy/terraform && ./deploy.sh
```

The deployed VM runs:
- **nginx** on port 80 — serves the frontend and proxies `/api/` to uvicorn
- **uvicorn** on `127.0.0.1:8000` — managed by a systemd unit (`pcd-ops`)

Credentials are written to `/opt/pcd-ops/.env` after deploy, or set via the Settings page in the UI.

### Self-Update

Settings → Software → **Check for Updates** / **Update & Restart** triggers a `git pull` + rebuild + service restart, running detached so it survives the process restart.

## Project Structure

```
pcd-ops/
├── backend/
│   ├── app/
│   │   ├── api/          # One router per feature domain
│   │   ├── services/     # OpenStack, Prometheus, AI providers
│   │   ├── models/       # Shared Pydantic models
│   │   ├── agent/        # Background job runner
│   │   ├── config.py
│   │   ├── dependencies.py
│   │   └── main.py
│   └── tests/
├── frontend/
│   └── src/
│       ├── api/          # Fetch wrappers per domain
│       ├── pages/        # One page per feature domain
│       └── components/   # Shared UI components
└── deploy/
    ├── packer/           # VM image build
    ├── terraform/        # Infrastructure-as-code
    ├── nginx/
    ├── systemd/
    └── scripts/
```
