# PCD Ops

An operations dashboard for [Platform9 Private Cloud Director (PCD)](https://platform9.com/private-cloud-director/). Provides day-to-day operational visibility and automated actions across your PCD environment.

## Features

| Feature | Description |
|---|---|
| **Resource Reclamation** | Identify idle VMs, unused floating IPs, orphaned volumes, and stale snapshots |
| **Capacity Planning** | Cluster-level vCPU / RAM / storage headroom with what-if analysis |
| **Inventory** | Searchable, filterable view of all resources across projects |
| **Snapshot Management** | List, age, and delete snapshots with bulk operations |
| **VM Right-Sizing** | AI-assisted recommendations based on actual utilization from Prometheus |
| **Anomaly & Drift Detection** | Alert on metric anomalies and configuration drift |
| **Log Analysis** | AI-assisted log triage and pattern detection |
| **Scheduled Jobs** | Background data collection with job history and status |

---

## Deployment

PCD Ops runs as a dedicated appliance VM in your PCD environment — no Kubernetes, no containers.

**VM requirements:** 2 vCPU, 4 GB RAM, 20 GB disk. Needs outbound internet access for self-updates.

**Ports:** Only **port 80** (HTTP) needs to be open. The appliance does not run sshd — management is via the VM console (VNC) or the web UI.

---

### Method 1 — Prebuilt image (recommended)

No build tools required. Download the image, upload it to PCD, and launch a VM.

**1. Download**

Download the latest `pcd-ops-alpine.qcow2` from [Releases](https://github.com/jscott-pf9/pcd-ops/releases).

**2. Upload to PCD**

```bash
pcdctl image create --insecure \
  --container-format bare \
  --disk-format qcow2 \
  --property os_type=Linux \
  --public \
  --file pcd-ops-alpine.qcow2 \
  pcd-ops
```

**3. Launch the VM**

In the PCD dashboard, create a new instance from the `pcd-ops` image:
- Flavor: 2 vCPU / 4 GB RAM or larger
- Network: your management network
- Security group: allow inbound port 80

Or use `pcdctl server create` if you prefer the CLI.

---

### Method 2 — Build from source

For contributors or custom builds. Requires Packer and QEMU/KVM on the build host.

**Prerequisites**

```bash
# Install Packer
# https://developer.hashicorp.com/packer/install

# Install QEMU (Ubuntu/Debian)
apt install qemu-system-x86 qemu-utils
```

**1. Clone and build**

```bash
git clone https://github.com/jscott-pf9/pcd-ops.git
cd pcd-ops

./deploy/build-image-alpine.sh
# Output: deploy/packer/alpine/output/pcd-ops-alpine.qcow2
# Build time: ~5 minutes with KVM acceleration
```

**2. Upload to PCD**

```bash
pcdctl image create --insecure \
  --container-format bare \
  --disk-format qcow2 \
  --property os_type=Linux \
  --public \
  --file deploy/packer/alpine/output/pcd-ops-alpine.qcow2 \
  pcd-ops
```

**3. Deploy with Terraform**

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set auth_url, credentials, network_name, flavor_name
./deploy.sh -auto-approve
```

The VM IP is printed on completion: `app_url = "http://192.168.1.50"`

---

### Initial Setup

After the VM is running, open its IP in a browser:

1. The app opens to **Settings → System Status**
2. Go to **Settings → PCD & Metrics** — enter your PCD and Grafana credentials, click **Save**
3. Back on **System Status**, click **Test Connections** to verify
4. Click **Collect Now** to run the first data collection (~1–2 minutes)
5. Navigate to **Inventory** — data is now populated

**Grafana / Prometheus:** In PCD, Prometheus (VictoriaMetrics) is only reachable via the Grafana datasource proxy:
- `GRAFANA_URL` → `https://your-pcd-host/grafana/`
- `GRAFANA_TOKEN` → a Grafana service account token (`glsa_...`)
- `PROMETHEUS_URL` → `https://your-pcd-host/grafana/api/datasources/proxy/1`

---

### VM Console

Open the VM console (VNC) in the PCD dashboard for appliance management — no SSH needed. The console shows service status, the web UI URL, and a menu:

- **Main:** Restart app · Reboot · Shutdown · Advanced options
- **Advanced:** Force update · View logs · Network info · Emergency shell

---

### Self-Update

**From the web UI:** Settings → Software → **Check for Updates** → **Update & Restart**

**From the VM console:** `A` (Advanced) → `U` (Force update)

Both pull the latest code from GitHub, rebuild the frontend, and restart the service (~2 minutes).

---

## Local Development

### Prerequisites

- Python 3.10+, Node.js 18+
- Access to a PCD environment + Grafana

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp ../.env.example ../.env
# Edit .env with your PCD + Grafana credentials

uvicorn app.main:app --reload
# API at http://localhost:8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# UI at http://localhost:5173 (proxies /api/* to :8000)
```

### Tests & Lint

```bash
# Backend
cd backend && pytest
ruff check . && ruff format .

# Frontend
cd frontend && npm test && npm run lint
```

---

## Stack

- **Frontend** — React 18 + TypeScript, Vite, TanStack Query, Recharts, React Flow
- **Backend** — Python 3.10+, FastAPI, openstacksdk, prometheus-api-client
- **AI** — Pluggable provider: Claude (Anthropic) or Ollama
- **Data Sources** — PCD APIs + Prometheus/VictoriaMetrics via Grafana proxy

## Project Structure

```
pcd-ops/
├── backend/app/
│   ├── api/          # One router per feature domain
│   ├── services/     # PCD, Prometheus, AI providers
│   ├── agent/        # Background job runner
│   └── main.py
├── frontend/src/
│   ├── api/          # Fetch wrappers per domain
│   ├── pages/        # One page per feature domain
│   └── components/   # Shared UI
└── deploy/
    ├── packer/alpine/ # Alpine VM image build
    ├── terraform/     # VM deployment (used with Method 2)
    ├── nginx/
    ├── openrc/
    └── scripts/       # update.sh, appliance-console.sh
```
