# PCD Ops



**Version:** 0.7.0  
**Base URL:** `/api`  
**Auth:** PCD login (session cookie). See *Authentication* below.

---

## Common Patterns

### Authentication

Every `/api/` endpoint needs a session from `POST /api/auth/login` (a PCD username,
password and domain; the admin role in the install project), except `GET /api/health`,
`/api/auth/*`, and `POST /api/access/connection` before a Keystone URL is known.

- **No session:** **401** `{"detail": "login required"}`.
- **Setup not finished** (no background access authorized): **409**
  `{"setup_required": true}` from everything but `/api/auth/*` and `/api/access*`.
- **Writes** (`POST`, `PUT`, `PATCH`, `DELETE`) need an `X-Requested-With` header, or get **403**.
- **Calls to PCD** made by a request run with the logged-in user's token; the scheduler's
  collectors and scheduled jobs use the background application credential.

### Cache-backed reads

Most `GET` endpoints serve data from an in-memory cache populated by a background
collector. If the cache is empty (first boot or collector not yet run), the endpoint
returns **503** with body `{"code": "no_data", "key": "<cache-key>"}`.
Trigger a manual collection with `POST /api/agent/trigger` to populate it.

### Error responses

| Status | Meaning |
|--------|---------|
| 400 | Bad request (invalid parameters or unparseable input) |
| 404 | Resource not found |
| 401 | Not logged in |
| 403 | Write without the `X-Requested-With` header |
| 409 | Conflict (operation in progress or invalid state transition), or `{"setup_required": true}` |
| 429 | Too many failed logins (5 a minute per client IP) |
| 422 | Validation error (FastAPI request model mismatch) |
| 503 | Cache miss — collector not yet run, or AI feature disabled |

---

## Table of Contents

- [Access](#access)
- [Agent](#agent)
- [Alerts](#alerts)
- [Anomaly](#anomaly)
- [Auth](#auth)
- [Capacity](#capacity)
- [Drift](#drift)
- [Events](#events)
- [Feedback](#feedback)
- [Inventory](#inventory)
- [Jobs](#jobs)
- [Logs](#logs)
- [Metrics](#metrics)
- [Misc](#misc)
- [Reclamation](#reclamation)
- [Reports](#reports)
- [Rightsizing](#rightsizing)
- [Snapshots](#snapshots)
- [System](#system)

---

## Access

### **GET** `/api/access`

Connection (from config.env, read-only), background access and setup state.

**Response:** 200 — Successful Response  

---

### **POST** `/api/access/connection`

Only for installs without config.env: tell PCD Ops which PCD to log in to. Refused

once a Keystone URL is known; change it by redeploying, or reset setup from the console.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `auth_url` | string | yes | — | Auth Url |
| `project_name` | string | yes | — | Project Name |
| `region` | string | no | `""` | Region |
| `project_domain` | string | no | `"Default"` | Project Domain |

**Response:** 200 — Successful Response  

---

### **POST** `/api/access/authorize`

Mint an application credential from the logged-in admin's token (install project,

roles [admin], unrestricted false), store it encrypted and switch background work to it.
Any previous credential is then deleted in Keystone.

**Response:** 200 — Successful Response  

---

### **POST** `/api/access/revoke`

Delete the application credential in Keystone with the current admin's token, then

wipe the local copy. Background work stops until someone authorizes it again.

**Response:** 200 — Successful Response  

---

## Agent

### **GET** `/api/agent/status`

Return agent runner status, domain cache metadata, and recent runs.

**Response:** 200 — Successful Response  

---

### **POST** `/api/agent/trigger`

Trigger an on-demand collection run, as the logged-in user.

?slow=true runs all tiers including AI collectors (anomaly, capacity trends, right-sizing).
Default (slow=false) runs only fast collectors (inventory, snapshots, logs, reclamation).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `slow` | query | boolean | no | `false` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/agent/runs`

Return recent agent run history (most recent first).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `limit` | query | integer | no | `50` |  |

**Response:** 200 — Successful Response  

---

## Alerts

### **GET** `/api/alerts`

Recent alerts, newest first: source, key, severity, title, body, `results` per channel

(null = sent, else why not) and whether the cooldown suppressed it.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `limit` | query | integer | no | `100` |  |

**Response:** 200 — Successful Response  

---

### **POST** `/api/alerts/test`

Send a test alert to one channel (email, webhook, slack) or all of them, whatever the

alert rules say. Returns {channel: null if sent, else why not}.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `channel` | string | no | — | Channel |

**Response:** 200 — Successful Response  

---

## Anomaly

### **GET** `/api/anomaly/`

The latest statistical anomalies: VMs and hosts whose last hour is far from their usual

(z-score against the same hour on earlier days, or the whole window while history is short),
each with now, usual, z, severity, since and a 48-hour sparkline. `explanation` is the AI's
reading of them, when AI is on; `explanation_current` says whether it covers these findings.

**Response:** 200 — Successful Response  

---

## Auth

### **POST** `/api/auth/login`

Authenticate against PCD Keystone and start a session (5 failed attempts a minute per IP).

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `username` | string | yes | — | Username |
| `password` | string | yes | — | Password |
| `domain` | string | no | `"Default"` | Domain |

**Response:** 200 — Successful Response  

---

### **POST** `/api/auth/logout`

End the session.

**Response:** 200 — Successful Response  

---

### **GET** `/api/auth/session`

Who is logged in, and what the UI should show next (login, setup or the app).

**Response:** 200 — Successful Response  

---

## Capacity

### **GET** `/api/capacity/summary`

What the cloud can allocate and what is allocated: vCPUs and RAM from Placement

(host CPUs or memory minus reserved, times the allocation ratio; `physical` and `ratio` say
which), storage from Cinder's backends (GB written against the disks' size; `provisioned` is
volumes' GB, `provisionable` what thin backends let Cinder provision). Not the sum of tenant
quotas.

**Response:** 200 — Successful Response  

---

### **GET** `/api/capacity/trends`

Allocation against capacity over up to 30 days from PCD Ops' metrics store, with a linear

forecast per resource and AI analysis. `note` says why there is none.

**Response:** 200 — Successful Response  

---

### **GET** `/api/capacity/overcommit`

CPU and memory overcommit per host and cluster: Placement's allocation (physical, reserved,

allocation ratio, allocated) against the 95th percentile of real load, with a status and its
reason for each host. Thresholds are in `thresholds`.

**Response:** 200 — Successful Response  

---

### **POST** `/api/capacity/what-if`

Simulate adding resources: current vs projected capacity and whether it fits. With

`tenant_id`, also the tenant's quotas (cores, RAM, volume GB, and vDisks against the volumes
quota), and `would_fit` needs both.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `additional_vcpus` | number | no | `0` | Additional Vcpus |
| `additional_ram_gb` | number | no | `0` | Additional Ram Gb |
| `additional_storage_gb` | number | no | `0` | Additional Storage Gb |
| `additional_vdisks` | integer | no | `0` | Additional Vdisks |
| `tenant_id` | string | no | — | Tenant Id |

**Response:** 200 — Successful Response  

---

### **POST** `/api/capacity/plans/parse`

Extract structured resource requirements (vCPUs, RAM, storage) from a natural language description.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | string | yes | — | Description |

**Response:** 200 — Successful Response  

---

### **GET** `/api/capacity/plans`

List capacity plans, each with a what-if against current capacity (and its tenant's

quotas, for a tenant plan).

**Response:** 200 — Successful Response  

---

### **POST** `/api/capacity/plans`

Create a capacity plan and return it with a what-if simulation.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `tenant_id` | string | no | — | Tenant Id |
| `tenant_name` | string | no | — | Tenant Name |
| `description` | string | no | `""` | Description |
| `additional_vcpus` | number | no | `0` | Additional Vcpus |
| `additional_ram_gb` | number | no | `0` | Additional Ram Gb |
| `additional_storage_gb` | number | no | `0` | Additional Storage Gb |
| `additional_vdisks` | integer | no | `0` | Additional Vdisks |

**Response:** 201 — Successful Response  

---

### **DELETE** `/api/capacity/plans/{plan_id}`

Delete a capacity plan.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `plan_id` | path | integer | yes | — |  |

**Response:** 204 No Content  

---

## Drift

### **GET** `/api/drift/changes`

The config change log, newest first: flavors, security groups, aggregates, hosts and

quotas added, removed or modified between collections, each with its changed fields
({field, op: added|removed|changed, before, after}) and severity. Filter by `kind`, the
last `days`, and `q` (item name or field).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `kind` | query | string | no | — |  |
| `days` | query | string | no | — |  |
| `q` | query | string | no | — |  |
| `limit` | query | integer | no | `500` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/drift/status`

When the change log started, the last collection, items tracked per kind, notes on what

couldn't be read, and changes per kind in the last 24 hours and 7 days.

**Response:** 200 — Successful Response  

---

## Events

### **GET** `/api/events`

List Events

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `limit` | query | integer | no | `100` |  |

**Response:** 200 — Successful Response  

---

## Feedback

### **POST** `/api/feedback`

Submit Feedback

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | yes | — | Type |
| `title` | string | yes | — | Title |
| `description` | string | yes | — | Description |
| `name` | string | yes | — | Name |
| `email` | string | yes | — | Email |

**Response:** 200 — Successful Response  

---

### **GET** `/api/feedback/configured`

Returns whether GitHub feedback is configured so the frontend can show/hide the form.

**Response:** 200 — Successful Response  

---

## Inventory

### **GET** `/api/inventory/servers`

Return all compute instances with status, flavor, hypervisor, security groups, server

group, project, and latest CPU/memory/network/disk (`metrics`, null without data).

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/hypervisors`

Return all hypervisors with CPU/RAM/disk capacity, current utilization, and live load

(`metrics`) from PCD Ops' metrics store or PCD's Grafana.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/hypervisors/exporters`

The last exporter probe: per hypervisor, whether node-exporter (:9388) and

libvirt-exporter (:9177) answered, and what they serve.

**Response:** 200 — Successful Response  

---

### **POST** `/api/inventory/hypervisors/probe-exporters`

Probe the exporters on every hypervisor that is up, from this appliance.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/volumes`

Return all Cinder volumes with size, status, and attachment info.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/networks`

Return all Neutron networks with external/shared flags and project ownership.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/tenants`

Return the projects/tenants to pick from (admin and service excluded). `all=true`: every

project but admin (PCD's hidden background tenant), for showing names.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `all` | query | boolean | no | `false` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/summary`

Return an inventory summary: server counts, volume sizes, floating IP usage, and image count.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/floating_ips`

Return all floating IPs with association status and project info.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/images`

Return all Glance images with visibility, size, and disk format.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/security_groups`

Return all security groups with their rules.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/topology`

Return graph nodes + edges for the topology view.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/clusters`

Return host aggregates (`kind` "cluster" for PCD clusters, which are pf9-managed

aggregates) with their hosts, VM count, and vCPU/RAM totals and allocation.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/storage_backends`

Return Cinder backends: pools grouped by backend (a shared store, reported by every host,

counted once), capacity, free, used, provisioned against oversubscribed capacity, volumes
and the volume types that select each.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/storage_types`

Return volume types: backend, extra specs, QoS, default, encryption, access, volumes.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/server_groups`

Return server groups: policy, rules, members with their hosts, and whether the

placement satisfies the policy (`status`: ok, violated, not_satisfied, empty).

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/keypairs`

Return all SSH key pairs registered in Nova.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/flavors`

Return Nova flavors: vCPUs, RAM, disk, ephemeral, swap, public, extra specs, VM count.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/{kind}/{item_id}/details`

Everything PCD reports for one VM, image, flavor, volume type or volume, fetched now

with the signed-in user's token (metadata, image properties, extra specs, ...).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `kind` | path | string | yes | — |  |
| `item_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

## Jobs

### **GET** `/api/jobs/`

List all scheduled jobs with computed next_run_at and is_due fields.

**Response:** 200 — Successful Response  

---

### **POST** `/api/jobs/`

Create a scheduled job (snapshot-cleanup, snapshot-create, snapshot-rotate, resource-reclamation, capacity-report, rightsizing-resize).

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `type` | string | yes | — | Type |
| `schedule` | string | no | — | Schedule |
| `config` | object | no | `{}` | Config |

**Response:** 201 — Successful Response  

---

### **PUT** `/api/jobs/{job_id}`

Update a job's name, schedule, config, or enabled state.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `job_id` | path | integer | yes | — |  |

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | no | — | Name |
| `schedule` | string | no | — | Schedule |
| `config` | object | no | — | Config |
| `enabled` | boolean | no | — | Enabled |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/jobs/{job_id}`

Delete a job and its run history.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `job_id` | path | integer | yes | — |  |

**Response:** 204 No Content  

---

### **POST** `/api/jobs/{job_id}/run`

Trigger a job to run immediately, regardless of its schedule, as the logged-in user.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `job_id` | path | integer | yes | — |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/jobs/{job_id}/runs`

Return run history for a specific job (most recent first).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `job_id` | path | integer | yes | — |  |
| `limit` | query | integer | no | `20` |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/jobs/{job_id}/runs`

Delete all run history for a specific job.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `job_id` | path | integer | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/jobs/runs/purge`

Delete run history older than N days across all jobs.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `older_than_days` | query | integer | no | `30` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/jobs/types`

Return job type metadata including labels, descriptions, and config_schema for each type.

**Response:** 200 — Successful Response  

---

## Logs

### **GET** `/api/logs/recent`

Return cached hypervisor log entries with optional filtering.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `host` | query | string | no | — |  |
| `service` | query | string | no | — |  |
| `level` | query | string | no | — |  |
| `keyword` | query | string | no | — |  |
| `limit` | query | integer | no | `500` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/logs/hosts`

Return list of hypervisor hostnames that have log data.

**Response:** 200 — Successful Response  

---

### **GET** `/api/logs/services`

Return list of service names that have log data.

**Response:** 200 — Successful Response  

---

### **POST** `/api/logs/query`

NLP: answer a question using compressed log patterns + PCD inventory context.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Query |

**Response:** 200 — Successful Response  

---

### **POST** `/api/logs/analyze`

Paste-and-analyze: accepts raw log lines, returns AI summary.

**Response:** 200 — Successful Response  

---

## Metrics

### **GET** `/api/metrics/status`

PCD Ops' own metrics store (running, targets, disk, projected size) and which source

the host and VM views use: "local", "pcd" (PCD's Grafana, 14 days) or null.

**Response:** 200 — Successful Response  

---

### **GET** `/api/metrics/hosts/{hypervisor_id}`

CPU, memory, disk and network history for one hypervisor. `range` is clamped to what

the source keeps.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `hypervisor_id` | path | string | yes | — |  |
| `range` | query | string | no | `"24h"` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/metrics/vms/{server_id}`

CPU, memory, network, disk and CPU-wait history for one VM.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `server_id` | path | string | yes | — |  |
| `range` | query | string | no | `"24h"` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/metrics/storage/{backend}`

Capacity, used and provisioned history for one Cinder backend. Only PCD Ops' own store

keeps it (written each inventory run), so this is 503 without it.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `backend` | path | string | yes | — |  |
| `range` | query | string | no | `"24h"` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/metrics/clusters/{aggregate_id}`

CPU, memory, disk and network over a cluster's (host aggregate's) hosts, and its vCPU,

RAM and VM allocation over time (PCD Ops' metrics store only).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `aggregate_id` | path | string | yes | — |  |
| `range` | query | string | no | `"24h"` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/metrics/volumes/{volume_id}`

Throughput, IOPS, latency and allocation for one volume: libvirt's stats for the VM disk

it is attached as (PCD Ops' metrics store only; 404 when it isn't attached).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `volume_id` | path | string | yes | — |  |
| `range` | query | string | no | `"24h"` |  |

**Response:** 200 — Successful Response  

---

## Misc

### **GET** `/api/settings`

Return the app settings; secrets are '***' when set. grafana_url_default is the Grafana

URL used while grafana_url is blank.

**Response:** 200 — Successful Response  

---

### **PUT** `/api/settings`

Save the fields sent. A secret sent as '***' or '' keeps the saved value.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prometheus_url` | string | no | — | Prometheus Url |
| `grafana_url` | string | no | — | Grafana Url |
| `grafana_token` | string | no | — | Grafana Token |
| `metrics_local_enabled` | boolean | no | — | Metrics Local Enabled |
| `metrics_scrape_interval` | string | no | — | Metrics Scrape Interval |
| `metrics_retention_days` | integer | no | — | Metrics Retention Days |
| `metrics_keep_all_series` | boolean | no | — | Metrics Keep All Series |
| `ai_backend` | string | no | — | Ai Backend |
| `ai_url` | string | no | — | Ai Url |
| `ai_model` | string | no | — | Ai Model |
| `ai_api_key` | string | no | — | Ai Api Key |
| `ai_private_api_key` | string | no | — | Ai Private Api Key |
| `ai_rightsizing_enabled` | boolean | no | — | Ai Rightsizing Enabled |
| `ai_anomaly_enabled` | boolean | no | — | Ai Anomaly Enabled |
| `ai_logs_enabled` | boolean | no | — | Ai Logs Enabled |
| `ai_capacity_enabled` | boolean | no | — | Ai Capacity Enabled |
| `ai_rightsizing_schedule` | string | no | — | Ai Rightsizing Schedule |
| `ai_anomaly_schedule` | string | no | — | Ai Anomaly Schedule |
| `reclamation_idle_days` | integer | no | — | Reclamation Idle Days |
| `reclamation_idle_cpu_pct` | number | no | — | Reclamation Idle Cpu Pct |
| `reclamation_idle_net_kbps` | number | no | — | Reclamation Idle Net Kbps |
| `reclamation_idle_iops` | number | no | — | Reclamation Idle Iops |
| `reclamation_currency` | string | no | — | Reclamation Currency |
| `reclamation_price_vcpu` | number | no | — | Reclamation Price Vcpu |
| `reclamation_price_ram_gb` | number | no | — | Reclamation Price Ram Gb |
| `reclamation_price_volume_gb` | number | no | — | Reclamation Price Volume Gb |
| `reclamation_price_image_gb` | number | no | — | Reclamation Price Image Gb |
| `reclamation_price_ip` | number | no | — | Reclamation Price Ip |
| `job_run_retention_days` | integer | no | — | Job Run Retention Days |
| `report_retention_days` | integer | no | — | Report Retention Days |
| `drift_retention_days` | integer | no | — | Drift Retention Days |
| `hypervisor_ssh_user` | string | no | — | Hypervisor Ssh User |
| `hypervisor_ssh_key_path` | string | no | — | Hypervisor Ssh Key Path |
| `hypervisor_ssh_password` | string | no | — | Hypervisor Ssh Password |
| `smtp_host` | string | no | — | Smtp Host |
| `smtp_port` | string | no | — | Smtp Port |
| `smtp_user` | string | no | — | Smtp User |
| `smtp_password` | string | no | — | Smtp Password |
| `smtp_from` | string | no | — | Smtp From |
| `alert_email_to` | string | no | — | Alert Email To |
| `webhook_url` | string | no | — | Webhook Url |
| `slack_webhook_url` | string | no | — | Slack Webhook Url |
| `alert_base_url` | string | no | — | Alert Base Url |
| `alert_cooldown_min` | integer | no | — | Alert Cooldown Min |
| `alert_anomaly_enabled` | boolean | no | — | Alert Anomaly Enabled |
| `alert_anomaly_min` | string | no | — | Alert Anomaly Min |
| `alert_drift_enabled` | boolean | no | — | Alert Drift Enabled |
| `alert_drift_min` | string | no | — | Alert Drift Min |
| `alert_jobs_enabled` | boolean | no | — | Alert Jobs Enabled |
| `alert_jobs_success` | boolean | no | — | Alert Jobs Success |

**Response:** 200 — Successful Response  

---

### **POST** `/api/settings/ai/models`

The models the backend offers, for the Model dropdown.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `ai_backend` | string | no | `"ollama"` | Ai Backend |
| `ai_url` | string | no | `""` | Ai Url |
| `ai_model` | string | no | `""` | Ai Model |
| `api_key` | string | no | `""` | Api Key |

**Response:** 200 — Successful Response  

---

### **POST** `/api/settings/ai/test`

List the models, then ask the chosen model for a one-word reply.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `ai_backend` | string | no | `"ollama"` | Ai Backend |
| `ai_url` | string | no | `""` | Ai Url |
| `ai_model` | string | no | `""` | Ai Model |
| `api_key` | string | no | `""` | Api Key |

**Response:** 200 — Successful Response  

---

### **POST** `/api/settings/metrics/test`

Find the Prometheus data source through Grafana (unless a Prometheus URL is given) and

run a query through it.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `grafana_url` | string | no | `""` | Grafana Url |
| `grafana_token` | string | no | `""` | Grafana Token |
| `prometheus_url` | string | no | `""` | Prometheus Url |

**Response:** 200 — Successful Response  

---

### **GET** `/api/settings/ssh/key`

The public key of the configured hypervisor SSH key, to add to authorized_keys.

**Response:** 200 — Successful Response  

---

### **POST** `/api/settings/ssh/key`

Generate an ed25519 key pair on the appliance and use it for the hypervisors. The private

key never leaves the appliance. Replacing a working key needs replace=true.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `replace` | boolean | no | `false` | Replace |

**Response:** 200 — Successful Response  

---

### **GET** `/api/health`

Unauthenticated and cheap (no PCD calls), for the catalog's probe (APPLIANCE_STANDARD §6).

setup_required: no admin has authorized background access, or it stopped working.

**Response:** 200 — Successful Response  

---

## Reclamation

### **GET** `/api/reclamation/candidates`

Everything Reclamation & Warnings lists, by category (services/reclamation.py), with

`notes` saying why a category couldn't be checked, `idle_rule` and `orphan_check`.

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/servers/{server_id}`

Force-delete a server (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `server_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/volumes/{volume_id}`

Delete a Cinder volume (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `volume_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/floating_ips/{fip_id}`

Release an unused floating IP back to the pool (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `fip_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/ports/{port_id}`

Delete an orphaned port, freeing its IP addresses (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `port_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/routers/{router_id}`

Delete a router: detach its interfaces, clear its gateway, then delete it (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `router_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/networks/{network_id}`

Delete a network with its subnets; Neutron removes its DHCP and metadata ports. 409 names

the ports still using it (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `network_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/server_groups/{group_id}`

Delete a server group (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `group_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reclamation/images/{image_id}`

Delete a Glance image or snapshot; 409 if it's protected (irreversible). Deleting a

volume-backed VM's snapshot image leaves its Cinder snapshots.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `image_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

## Reports

### **DELETE** `/api/reports/purge`

Delete capacity reports older than N days.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `older_than_days` | query | integer | no | `30` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/reports/{report_id}`

Get a capacity report by ID including per-tenant data and AI analysis.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `report_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/reports/{report_id}`

Delete a capacity report.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `report_id` | path | string | yes | — |  |

**Response:** 204 No Content  

---

## Rightsizing

### **GET** `/api/rightsizing/recommendations`

VM right-sizing recommendations: CPU, RAM and IOPS use and AI analysis. A suggested

flavor carries `fit`: whether a host in the VM's cluster has room for it now (fits,
same_host, no_room, unknown). `series=false` leaves out the per-VM series (the list doesn't
draw them). 503 no_data until the first run succeeds; `error` says why the last one
failed.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `series` | query | boolean | no | `true` |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/rightsizing/recommendations/{server_id}`

One VM's recommendation in detail: why it has its class (`reasons`), what the suggested

flavor had to have (`basis`), the VM's CPU and RAM projected onto it (`projected`, with
`warnings` when its busiest hours would run it hot), other flavors that would do
(`alternatives`, each with its fit), and every host in its cluster with its free room for
the suggested flavor, or the shaped one when there's none (`hosts`). `custom` is a flavor
shaped for it when the catalog has no good match, with its
projection and fit. `thresholds` are the classification rules.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `server_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **POST** `/api/rightsizing/recommendations/{server_id}/flavor`

Create the flavor shaped for this VM (`custom_flavor` of the last run) as a private

flavor its tenant can use, with the current flavor's extra specs. Only the name comes from
the request. It becomes the VM's suggested flavor at once. 409 when the name is taken or a
flavor the tenant can already use has this shape (`existing` names it).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `server_id` | path | string | yes | — |  |

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |

**Response:** 200 — Successful Response  

---

## Snapshots

### **GET** `/api/snapshots/`

Return all volume snapshots with size, status, and creation time.

**Response:** 200 — Successful Response  

---

### **POST** `/api/snapshots/`

Create a Cinder snapshot of each volume attached to a server (in-use volumes too).

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `server_id` | string | yes | — | Server Id |
| `name` | string | yes | — | Name |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/snapshots/{snapshot_id}`

Delete a Cinder volume snapshot (irreversible).

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `snapshot_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

## System

### **GET** `/api/system/version`

Return version from version file (written at image build time) or git, plus git metadata.

**Response:** 200 — Successful Response  

---

### **GET** `/api/system/update/check`

Check whether a newer version is available by running git fetch and comparing HEAD to upstream.

**Response:** 200 — Successful Response  

---

### **GET** `/api/system/update/log`

Return the stdout/stderr log from the most recent self-update run.

**Response:** 200 — Successful Response  

---

### **GET** `/api/system/connections`

Test live connectivity to OpenStack (background access) and Grafana; ok/error per service.

**Response:** 200 — Successful Response  

---

### **POST** `/api/system/restart`

Restart the pcd-ops backend service without updating code.

**Response:** 200 — Successful Response  

---

### **POST** `/api/system/reboot`

Reboot the appliance VM (response returns before the reboot completes).

**Response:** 200 — Successful Response  

---

### **POST** `/api/system/update`

Trigger a self-update: runs deploy/scripts/update.sh detached (git pull + pip install + npm build + service restart).

**Response:** 200 — Successful Response  

---

