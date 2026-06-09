# PCD Ops



**Version:** 0.1.0  
**Base URL:** `/api`  
**Auth:** None (internal service — restrict at the network layer)

---

## Common Patterns

### Cache-backed reads

Most `GET` endpoints serve data from an in-memory cache populated by a background
collector. If the cache is empty (first boot or collector not yet run), the endpoint
returns **503** with body `{"code": "no_data", "key": "<cache-key>"}`.
Trigger a manual collection with `POST /api/agent/trigger` to populate it.

### Streaming endpoints (Server-Sent Events)

Terraform operations (`POST /api/generate/deploy`, `POST /api/deployments/{id}/redeploy`,
`POST /api/deployments/{id}/destroy`) return `text/event-stream`. Each event is a JSON
object on a `data:` line:

| `type` | Fields | Meaning |
|--------|--------|---------|
| `started` | `deployment_id` | Deployment record created |
| `log` | `line` | Terraform output line |
| `done` | `outputs` | Operation succeeded; outputs is a key→value map |
| `error` | `message` | Operation failed |

### Error responses

| Status | Meaning |
|--------|---------|
| 400 | Bad request (invalid parameters or unparseable input) |
| 404 | Resource not found |
| 409 | Conflict (operation in progress or invalid state transition) |
| 422 | Validation error (FastAPI request model mismatch) |
| 503 | Cache miss — collector not yet run, or AI feature disabled |

---

## Table of Contents

- [Agent](#agent)
- [Anomaly](#anomaly)
- [Capacity](#capacity)
- [Deployments](#deployments)
- [Generate](#generate)
- [Inventory](#inventory)
- [Jobs](#jobs)
- [Logs](#logs)
- [Misc](#misc)
- [Reclamation](#reclamation)
- [Reports](#reports)
- [Rightsizing](#rightsizing)
- [Snapshots](#snapshots)
- [System](#system)

---

## Agent

### **GET** `/api/agent/status`

Return agent runner status, domain cache metadata, and recent runs.

**Response:** 200 — Successful Response  

---

### **POST** `/api/agent/trigger`

Trigger an on-demand collection run.

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

## Anomaly

### **GET** `/api/anomaly/`

Return the latest anomaly detection results (metric drift and outlier analysis).

**Response:** 200 — Successful Response  

---

## Capacity

### **GET** `/api/capacity/summary`

Return current capacity summary: vCPU, RAM, and storage totals with used/free/percent.

**Response:** 200 — Successful Response  

---

### **GET** `/api/capacity/trends`

Return capacity trend data over a rolling window with per-resource time series and AI analysis.

**Response:** 200 — Successful Response  

---

### **POST** `/api/capacity/what-if`

Simulate the impact of adding resources; returns current vs projected utilization and whether it fits.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `additional_vcpus` | number | no | `0` | Additional Vcpus |
| `additional_ram_gb` | number | no | `0` | Additional Ram Gb |
| `additional_storage_gb` | number | no | `0` | Additional Storage Gb |
| `additional_vdisks` | integer | no | `0` | Additional Vdisks |

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

List capacity plans, each annotated with a live what-if simulation against current capacity.

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

## Deployments

### **GET** `/api/deployments/`

List all deployments, optionally filtered by app profile ID.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `profile_id` | query | string | no | — |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/deployments/{dep_id}`

Get a deployment by ID including HCL, Terraform outputs, and current status.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `dep_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/deployments/{dep_id}`

Delete a deployment record (only allowed when status is 'destroyed' or 'error').

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `dep_id` | path | string | yes | — |  |

**Response:** 204 No Content  

---

### **POST** `/api/deployments/{dep_id}/redeploy`

Re-run terraform init + apply for a deployment, streaming SSE progress and final outputs.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `dep_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **POST** `/api/deployments/{dep_id}/destroy`

Run terraform destroy for a deployment, streaming SSE progress lines.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `dep_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **POST** `/api/deployments/{dep_id}/stop`

Shelve all VMs belonging to this deployment via OpenStack API.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `dep_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

### **GET** `/api/deployments/{dep_id}/status`

Refresh deployment status by querying OpenStack for VM states.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `dep_id` | path | string | yes | — |  |

**Response:** 200 — Successful Response  

---

## Generate

### **POST** `/api/generate/terraform`

Generate OpenStack Terraform HCL for a single VM using AI.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `flavor_name` | string | yes | — | Flavor Name |
| `flavor_vcpus` | integer | no | `0` | Flavor Vcpus |
| `flavor_ram_mb` | integer | no | `0` | Flavor Ram Mb |
| `network_name` | string | no | `""` | Network Name |
| `image_name` | string | no | `""` | Image Name |
| `tenant_name` | string | no | `""` | Tenant Name |
| `key_pair` | string | no | `""` | Key Pair |
| `user_data` | string | no | `""` | User Data |
| `count` | integer | no | `1` | Count |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/cloud-init`

Generate cloud-init YAML for a server role using AI.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `role` | string | yes | — | Role |
| `hostname` | string | no | `""` | Hostname |
| `packages` | array | no | `[]` | Packages |
| `users` | array | no | `[]` | Users |
| `extra_notes` | string | no | `""` | Extra Notes |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/cloud-init-refine`

Refine an existing cloud-init YAML based on a natural language instruction.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `current_yaml` | string | yes | — | Current Yaml |
| `instruction` | string | yes | — | Instruction |

**Response:** 200 — Successful Response  

---

### **GET** `/api/generate/flavors`

Return available flavors with vcpus, ram_mb, and disk_gb for the config generator.

**Response:** 200 — Successful Response  

---

### **GET** `/api/generate/images`

Return public and shared VM images available for deployment.

**Response:** 200 — Successful Response  

---

### **GET** `/api/generate/networks`

Return all networks with name, id, and whether they are external.

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/combined`

Generate a single Terraform main.tf with multiple VM profiles, each with embedded cloud-init.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `profiles` | array | yes | — | Profiles |
| `network_name` | string | no | `""` | Network Name |
| `image_name` | string | no | `""` | Image Name |
| `tenant_name` | string | no | `""` | Tenant Name |
| `key_pair` | string | no | `""` | Key Pair |
| `extra_notes` | string | no | `""` | Extra Notes |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/security-group`

Generate Terraform HCL for an OpenStack Neutron security group with rules using AI.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `description` | string | no | `""` | Description |
| `tenant_name` | string | no | `""` | Tenant Name |
| `rules` | array | no | `[]` | Rules |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/load-balancer`

Generate Terraform HCL for an Octavia load balancer with pool, listeners, and health monitor using AI.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `network_name` | string | no | `""` | Network Name |
| `protocol` | string | no | `"HTTP"` | Protocol |
| `port` | integer | no | `80` | Port |
| `members` | array | no | `[]` | Members |
| `health_monitor` | string | no | `"HTTP"` | Health Monitor |
| `tls_termination` | boolean | no | `false` | Tls Termination |
| `tenant_name` | string | no | `""` | Tenant Name |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/from-prompt`

Generate infrastructure config (Terraform, cloud-init, security group, or LB) from a natural language description.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | string | yes | — | Description |
| `type` | string | no | `"terraform"` | Type |

**Response:** 200 — Successful Response  

---

### **GET** `/api/generate/saved`

List all saved configs (Terraform snippets, cloud-init templates, and role library entries).

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/saved`

Save a new config to the library (type: terraform | cloud-init | role | app-profile).

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `type` | string | yes | — | Type |
| `content` | object | yes | — | Content |

**Response:** 200 — Successful Response  

---

### **GET** `/api/generate/saved/{config_id}`

Get a saved config by ID.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `config_id` | path | integer | yes | — |  |

**Response:** 200 — Successful Response  

---

### **PUT** `/api/generate/saved/{config_id}`

Update a saved config's name or content.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `config_id` | path | integer | yes | — |  |

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | no | — | Name |
| `content` | object | no | — | Content |

**Response:** 200 — Successful Response  

---

### **DELETE** `/api/generate/saved/{config_id}`

Delete a saved config.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `config_id` | path | integer | yes | — |  |

**Response:** 204 No Content  

---

### **POST** `/api/generate/app-profile`

Generate a complete multi-tier Terraform plan using AI (VMs, security groups, optional LB).

Images are baked into each VM profile; tenant, network, and key_pair are Terraform variables set at deploy time.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `description` | string | no | `""` | Description |
| `key_pair` | string | no | `""` | Key Pair |
| `networks` | array | no | `[]` | Networks |
| `vm_profiles` | array | yes | — | Vm Profiles |
| `security_groups` | array | no | `[]` | Security Groups |
| `load_balancer` | $ref | no | — |  |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/app-profile-from-description`

Convert a natural language app description into structured JSON to pre-fill the App Builder form.

Returns vm_profiles, networks, security_groups, and load_balancer — no HCL is generated.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | string | yes | — | Description |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/app-profile-terraform`

Deterministic Terraform HCL generation — no AI, instant.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Name |
| `description` | string | no | `""` | Description |
| `key_pair` | string | no | `""` | Key Pair |
| `networks` | array | no | `[]` | Networks |
| `vm_profiles` | array | yes | — | Vm Profiles |
| `security_groups` | array | no | `[]` | Security Groups |
| `load_balancer` | $ref | no | — |  |

**Response:** 200 — Successful Response  

---

### **POST** `/api/generate/deploy`

Create a deployment record then run terraform init + apply, streaming SSE.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `hcl` | string | yes | — | Hcl |
| `tenant_name` | string | yes | — | Tenant Name |
| `network_name` | string | no | `""` | Network Name |
| `key_pair` | string | no | `""` | Key Pair |
| `app_name` | string | no | `"pcd-app"` | App Name |
| `profile_id` | integer | no | — | Profile Id |
| `extra_vars` | object | no | `{}` | Extra Vars |

**Response:** 200 — Successful Response  

---

## Inventory

### **GET** `/api/inventory/servers`

Return all compute instances with status, flavor, hypervisor, and project info.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/hypervisors`

Return all hypervisors with CPU/RAM/disk capacity and current utilization.

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

Return all projects/tenants (admin and service tenants excluded).

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

Return PCD cluster names and metadata.

**Response:** 200 — Successful Response  

---

### **GET** `/api/inventory/keypairs`

Return all SSH key pairs registered in Nova.

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

Trigger a job to run immediately, regardless of its schedule.

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

## Misc

### **GET** `/api/settings`

Return all runtime settings; password, token, and API key fields are masked with '***'.

**Response:** 200 — Successful Response  

---

### **PUT** `/api/settings`

Update runtime settings; fields with value '***' or '' for secrets are preserved from the current config.

**Request body** (`application/json`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `os_auth_url` | string | no | `""` | Os Auth Url |
| `os_username` | string | no | `""` | Os Username |
| `os_password` | string | no | `""` | Os Password |
| `os_project_name` | string | no | `""` | Os Project Name |
| `os_user_domain_name` | string | no | `"Default"` | Os User Domain Name |
| `os_project_domain_name` | string | no | `"Default"` | Os Project Domain Name |
| `os_region_name` | string | no | `""` | Os Region Name |
| `prometheus_url` | string | no | `""` | Prometheus Url |
| `grafana_url` | string | no | `""` | Grafana Url |
| `grafana_token` | string | no | `""` | Grafana Token |
| `ai_backend` | string | no | `"ollama"` | Ai Backend |
| `ai_url` | string | no | `""` | Ai Url |
| `ai_model` | string | no | `""` | Ai Model |
| `ai_api_key` | string | no | `""` | Ai Api Key |
| `ai_rightsizing_enabled` | boolean | no | `true` | Ai Rightsizing Enabled |
| `ai_anomaly_enabled` | boolean | no | `true` | Ai Anomaly Enabled |
| `ai_logs_enabled` | boolean | no | `true` | Ai Logs Enabled |
| `ai_capacity_enabled` | boolean | no | `true` | Ai Capacity Enabled |
| `ai_rightsizing_schedule` | string | no | `"daily@02:00"` | Ai Rightsizing Schedule |
| `ai_anomaly_schedule` | string | no | `"hourly"` | Ai Anomaly Schedule |

**Response:** 200 — Successful Response  

---

### **GET** `/api/health`

Health

**Response:** 200 — Successful Response  

---

## Reclamation

### **GET** `/api/reclamation/candidates`

Return idle VMs (stopped/shelved), unattached volumes, and unused floating IPs eligible for reclamation.

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

## Reports

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

### **DELETE** `/api/reports/purge`

Delete capacity reports older than N days.

**Parameters**

| Name | In | Type | Required | Default | Description |
|------|----|------|----------|---------|-------------|
| `older_than_days` | query | integer | no | `30` |  |

**Response:** 200 — Successful Response  

---

## Rightsizing

### **GET** `/api/rightsizing/recommendations`

Return VM right-sizing recommendations with CPU/memory usage metrics and AI-generated analysis.

**Response:** 200 — Successful Response  

---

## Snapshots

### **GET** `/api/snapshots/`

Return all volume snapshots with size, status, and creation time.

**Response:** 200 — Successful Response  

---

### **POST** `/api/snapshots/`

Create a snapshot of a server's volumes by calling the Nova createImage action.

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

Return current git commit (short), branch name, and tag (if on an exact tag).

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

### **POST** `/api/system/update`

Trigger a self-update: runs deploy/scripts/update.sh detached (git pull + pip install + npm build + service restart).

**Response:** 200 — Successful Response  

---

