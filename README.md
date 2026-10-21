<img src="logo.svg" alt="PCD Ops" width="72" height="72">

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

**Access:** you log in with your own **PCD account** (username, password, domain); you need the **admin** role in the project PCD Ops was installed into. PCD Ops never stores a PCD password. The appliance serves **plain HTTP**, so put it on a management network or behind an HTTPS proxy; its session cookie is `HttpOnly` and `SameSite=Lax` but not `Secure`.

---

### Method 1 — PCD App Catalog (Extensions)

In the PCD admin UI, open **Extensions**, pick **PCD Ops**, and install. The catalog imports the release image, opens port 80, and waits for `/api/health`. It writes `/etc/pcd-app/config.env` with the Keystone URL, region and install project (`PCD_AUTH_URL`, `PCD_REGION`, `PCD_PROJECT_ID`, `PCD_PROJECT_NAME`), which PCD Ops shows read-only, plus the AI backend, URL and model from **Advanced Configuration**, which become the appliance's defaults (anything saved on the Settings page wins). Secrets (Grafana token, Claude API key) are only ever entered on the Settings page.

Each release carries the catalog's [manifest.json](manifest.json) as an asset, with the image's tag, file name and checksum filled in.

---

### Method 2 — Prebuilt image

No build tools required. Download the image, upload it to PCD, and launch a VM.

**1. Download**

Download the latest `pcd-ops-<version>.qcow2` from [Releases](https://github.com/jscott-pf9/pcd-ops/releases) and check it with `sha256sum -c pcd-ops-<version>.qcow2.sha256`. The image boots under both BIOS (SeaBIOS) and UEFI, so no firmware properties are needed.

**2. Upload to PCD**

```bash
pcdctl image create --insecure \
  --container-format bare \
  --disk-format qcow2 \
  --property os_type=Linux \
  --public \
  --file pcd-ops-<version>.qcow2 \
  pcd-ops
```

**3. Launch the VM**

In the PCD dashboard, create a new instance from the `pcd-ops` image:
- Flavor: 2 vCPU / 4 GB RAM or larger
- Network: your management network
- Security group: allow inbound port 80

Or use `pcdctl server create` if you prefer the CLI.

---

### Method 3 — Build from source

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

./deploy/build-image.sh
# Output: deploy/packer/alpine/output/<tag>/pcd-ops-<version>.qcow2 (+ .sha256, manifest.json)
# Build time: ~5 minutes with KVM acceleration
```

Packer clones the **current branch from GitHub** inside the build VM, so push your changes first. The build fails if the image doesn't pass Nova's format-inspector safety check.

To boot the result locally the way Nova does (config drive with catalog-style user-data, port 80 forwarded to `127.0.0.1:8180`):

```bash
build/test-local.sh                 # UEFI (q35 + OVMF)
FIRMWARE=bios build/test-local.sh   # SeaBIOS
```

It reports when `/api/health` answers, the AI settings the app picked up, the cloud-init datasource, and the guest's `/etc/pcd-app/config.env`.

**2. Upload to PCD**

```bash
pcdctl image create --insecure \
  --container-format bare \
  --disk-format qcow2 \
  --property os_type=Linux \
  --public \
  --file deploy/packer/alpine/output/<tag>/pcd-ops-<version>.qcow2 \
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

### Releasing

Every GitHub release attaches three assets in the PCD App Catalog's format; the tag keeps its `v`, the file names don't:

| Asset | Contents |
|---|---|
| `pcd-ops-<version>.qcow2` | the appliance image |
| `pcd-ops-<version>.qcow2.sha256` | `<hash>  <file>` (sha256sum format) |
| `manifest.json` | the repo's [manifest.json](manifest.json) with `version`, `image.source.tag`, `asset` and `checksum` filled in |

1. Bump the version in `backend/pyproject.toml`, `frontend/package.json` and `manifest.json` (`version`, `image.source.tag`, `image.source.asset`); commit.
2. `git tag v<version> && git push origin main v<version>`
3. `./deploy/release.sh --preflight` — builds from the tag (Nova safety check, the three assets), boots it under UEFI and BIOS with `build/test-local.sh`, and validates the manifest with the catalog's validator (`CATALOG_DIR`, default `../pcd-app-catalog`). Publishes nothing.
4. `./deploy/release.sh --skip-build [notes.md]` — runs the same checks, creates the GitHub release, checks the assets download anonymously (Glance imports them without credentials, so the repo must stay public), and opens a PR adding the manifest to the extension index, [jscott-pf9/pcd-extensions](https://github.com/jscott-pf9/pcd-extensions). PCD's catalog offers the new version once that PR is merged.
5. Copy the release's `manifest.json` over the repo's and commit, so the repo root matches the latest release.

---

### First Login and Setup

Open the appliance's IP in a browser:

1. **Log in with your PCD account.** Username, password and domain (usually `Default`). You need the `admin` role in the install project; anyone else is refused.
2. **Finish setting up PCD Ops.** The first admin to log in sees the Keystone URL, region and project (read-only) and clicks **Authorize background access**. Until then every page leads here.
3. Go to **Settings → PCD & Metrics** and enter the Grafana details; go to **Settings → AI Backend** for the Claude API key if you use Claude.
4. On **Settings → System Status**, click **Test Connections**, then **Collect Now**.

An appliance that didn't come from the catalog (Terraform, manual image upload) has no `config.env`, so its first page asks for the Keystone URL, project and region once, before anyone logs in.

**Grafana / Prometheus:** In PCD, Prometheus (VictoriaMetrics) is only reachable via the Grafana datasource proxy:
- `GRAFANA_URL` → `https://your-pcd-host/grafana/`
- `GRAFANA_TOKEN` → a Grafana service account token (`glsa_...`)
- `PROMETHEUS_URL` → `https://your-pcd-host/grafana/api/datasources/proxy/1`

---

### How PCD Ops talks to PCD

| Work | Runs as |
|---|---|
| Anything a person does: Collect Now, Run job now, deleting a server/volume/floating IP/snapshot, App Deployments (Terraform) | **That person's** PCD token, so PCD's own RBAC and audit apply |
| Unattended: the 15-minute/hourly/daily collectors and scheduled jobs (including capacity reports) | The **background application credential** |

**Background access** is a Keystone [application credential](https://docs.openstack.org/keystone/latest/user/application_credentials.html) created from the authorizing admin's token: scoped to the install project, role `admin` only, `unrestricted: false`, named `pcd-ops-<instance>-<yyyymmdd-hhmm>`. Its secret is stored Fernet-encrypted in `/var/lib/pcd-ops/` (key and record both mode 0600, created at first use, never in the image).

- **Settings → PCD & Metrics → Background access** shows its owner, project, created and last-used times, with **Re-authorize** (create a new one from your token, switch to it, delete the old one) and **Revoke** (delete it in PCD, then forget it).
- It belongs to the admin who created it. If that account is deleted or loses the admin role, PCD refuses it: collection stops, `/api/health` reports `setup_required: true`, and every page shows a **Re-authorize** banner.
- **Reset setup** in the VM console (Advanced) forgets it locally and logs everyone out; delete the credential in PCD as its owner.

### Upgrading from 0.4.x

0.4.x kept a PCD service account (username and password) in `settings.json`. After upgrading:
- Background collection keeps using that account, so nothing stops.
- The next admin to log in (using the Keystone URL and project from the old settings) is taken to setup. **Authorize background access** switches background work to an application credential and deletes the stored username and password from `settings.json`.

---

### VM Console

Open the VM console (VNC) in the PCD dashboard for appliance management — no SSH needed. The console shows service status, the web UI URL, and a menu:

- **Main:** Restart app · Reboot · Shutdown · Advanced options
- **Advanced:** Force update · Patch OS · View logs · Network info · Reset setup · Emergency shell

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

# Which PCD to log in to, in the format the catalog writes to config.env (gitignored):
printf "%s\n" "PCD_AUTH_URL='https://your-pcd-host/keystone/v3'" \
  "PCD_REGION='RegionOne'" "PCD_PROJECT_NAME='service'" > ../dev.config.env

PCD_APP_CONFIG=../dev.config.env PCD_OPS_STATE_DIR=./data uvicorn app.main:app --reload
# API at http://localhost:8000; log in through the UI with your PCD account
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
cd frontend && npm test -- --run && npm run build
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
│   ├── api/          # One router per feature domain (auth.py: login; access.py: setup)
│   ├── appliance/    # APPLIANCE_STANDARD §8: config.env, Keystone login, sessions,
│   │                 #   application credentials, the PCD connection
│   ├── services/     # PCD connections (user token / background), Prometheus, AI
│   ├── agent/        # Background job runner
│   └── main.py
├── build/            # test-local.sh: boot the image the way Nova does
├── frontend/src/
│   ├── api/          # Fetch wrappers per domain
│   ├── pages/        # One page per feature domain
│   └── components/   # Shared UI
└── deploy/
    ├── packer/alpine/ # Alpine VM image build
    ├── terraform/     # VM deployment (used with Method 2)
    ├── nginx/
    ├── openrc/
    ├── release.sh     # build → boot test → validate → GitHub release → index PR
    └── scripts/       # update.sh, appliance-console*.sh, reset-setup.sh
```
