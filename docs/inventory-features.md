# Inventory Page Feature Enhancements

## Current State
- Summary cards and four read-only tabs: Servers, Hypervisors, Volumes, Networks
- Client-side search per tab
- Separate Topology view (xyflow, tenant-filtered, node detail panels) — fully implemented
- Reclamation page handles orphaned resources (stopped VMs, unattached volumes, unused floating IPs)

---

## Quick Wins (frontend-only)

### Sortable Columns
- Click any column header to sort ascending/descending
- Most useful: VMs by created date, hypervisors by memory pressure
- No backend changes required

### Tenant / Project Filter for Tables
- Dropdown above the tabs scopes all four tables to a single tenant
- `tenants` endpoint already available
- Topology view already has this filter — brings parity to the main inventory tables
- Store selection in a URL param for shareability

### Export to CSV
- "Export" button in each tab header downloads filtered, visible rows as CSV
- No backend changes required

### Detail Drawer / Side Panel
- Click any row to open a slide-in drawer with the full raw object
- VMs: all IPs, security groups, metadata, full flavor details
- Volumes: bootability, encryption, attachment history
- List endpoints already return full objects — display only

### Flavor Distribution Chart
- Donut or bar chart on Servers tab showing VM count per flavor
- Pure frontend aggregation over already-loaded server data
- Helps ops understand workload composition at a glance

---

## Medium Effort (new backend endpoints required)

### Floating IPs Tab
- Fifth tab: IP address, associated VM name (if any), tenant, network pool
- Unassociated IPs flagged in amber
- Complements Reclamation page — adds tabular context missing there
- New `/api/inventory/floating_ips` endpoint via openstacksdk or `openstack_neutron_floating_ips` metric

### Glance Images Tab
- Image name, visibility (public/private), disk format, size, owner tenant, created date
- Cross-reference with loaded server data to show whether any VM currently uses each image (flag stale/unused images)
- New `/api/inventory/images` endpoint; `openstack_glance_images` metric is live, full detail via openstacksdk

### Security Groups Audit Tab
- List all security groups with their rules
- Flag overly permissive rules: CIDR `0.0.0.0/0`, wide port ranges
- Show which VMs use each group
- Common ops audit need and security posture signal
- New backend endpoint required

### Hypervisor Drill-Down
- Click a hypervisor row → drawer showing all VMs hosted on it (cross-referenced from loaded server data)
- Usage bars: aggregate vCPU/RAM claimed by hosted VMs vs physical capacity
- Topology view already models this relationship — table view needs inline exposure
- No new backend endpoints required

---

## Topology View Enhancements

### Highlight Reclamation Candidates
- In the existing topology view, visually distinguish orphaned resources
- Stopped VMs: gray/dashed border
- Unattached volumes: amber color
- Bridges the topology and reclamation pages — operators see orphaned resources in infrastructure context
- Frontend-only: overlay reclamation data the frontend already fetches; optional backend param `?highlight_orphans=true`

---

## Priority Summary

| Feature | Effort | Backend Change |
|---------|--------|----------------|
| Sortable columns | XS | None |
| Tenant filter for tables | S | None |
| Export CSV | S | None |
| Detail drawer | S | None |
| Flavor distribution chart | S | None |
| Floating IPs tab | M | New endpoint |
| Glance images tab | M | New endpoint |
| Security groups audit tab | M | New endpoint |
| Hypervisor drill-down | M | None |
| Topology: orphan overlay | S–M | Optional param or frontend-only |
