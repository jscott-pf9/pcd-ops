"""
AI-powered config generation — Terraform HCL, cloud-init YAML, security groups,
load balancers, combined profiles, natural language, and saved config CRUD.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_ai_provider
from app.services.ai.base import AIProvider
from app.services import db
from app.services.db import cache_get

router = APIRouter(prefix="/generate", tags=["generate"])


# ── Request models ─────────────────────────────────────────────────────────────

class TerraformRequest(BaseModel):
    name: str
    flavor_name: str
    flavor_vcpus: int = 0
    flavor_ram_mb: int = 0
    network_name: str = ""
    image_name: str = ""
    tenant_name: str = ""
    key_pair: str = ""
    user_data: str = ""
    count: int = 1


class CloudInitRequest(BaseModel):
    role: str
    hostname: str = ""
    packages: list[str] = []
    users: list[str] = []
    extra_notes: str = ""


class ProfileEntry(BaseModel):
    name: str
    flavor_name: str
    count: int = 1
    role: str = ""              # display label / cloud-init role description
    image_name: str = ""        # locked per-profile (baked into App Profile)
    cloud_init_yaml: str = ""   # actual YAML content from saved role library
    security_groups: list[str] = []  # SG names explicitly assigned to this tier
    network_name: str = ""           # which AppNetwork this tier attaches to


class CombinedRequest(BaseModel):
    profiles: list[ProfileEntry]
    network_name: str = ""
    image_name: str = ""
    tenant_name: str = ""
    key_pair: str = ""
    extra_notes: str = ""


class SecurityGroupRequest(BaseModel):
    name: str
    description: str = ""
    tenant_name: str = ""
    rules: list[dict] = []   # [{direction, protocol, port_min, port_max, cidr}]


class LoadBalancerRequest(BaseModel):
    name: str
    network_name: str = ""
    protocol: str = "HTTP"        # HTTP | HTTPS | TCP
    port: int = 80
    members: list[dict] = []      # [{address, port}]
    health_monitor: str = "HTTP"  # HTTP | TCP | PING
    tls_termination: bool = False
    tenant_name: str = ""


class CloudInitRefineRequest(BaseModel):
    current_yaml: str
    instruction: str


class NLRequest(BaseModel):
    description: str
    type: str = "terraform"   # terraform | cloud-init | combined | security-group | load-balancer


class AppSecurityGroup(BaseModel):
    name: str
    description: str = ""
    rules: list[dict] = []  # [{direction, protocol, port_min, port_max, cidr}]


class AppNetwork(BaseModel):
    name: str
    cidr: str = "192.168.100.0/24"
    dns: list[str] = ["8.8.8.8", "8.8.4.4"]


class LbListener(BaseModel):
    protocol: str = "HTTP"   # HTTP | HTTPS | TCP
    port: int = 80
    tls: bool = False        # if True → TERMINATED_HTTPS listener


class AppLoadBalancer(BaseModel):
    name: str
    backend_profile: str = ""
    health_monitor: str = "HTTP"
    listeners: list[LbListener] = []


class AppProfileRequest(BaseModel):
    name: str
    description: str = ""
    key_pair: str = ""
    networks: list[AppNetwork] = []
    vm_profiles: list[ProfileEntry]
    security_groups: list[AppSecurityGroup] = []
    load_balancer: AppLoadBalancer | None = None


class AppDescriptionRequest(BaseModel):
    description: str


class SaveConfigRequest(BaseModel):
    name: str
    type: str
    content: dict


class UpdateConfigRequest(BaseModel):
    name: str | None = None
    content: dict | None = None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return text.strip()


def _inventory_context() -> dict:
    networks_cache, _ = cache_get("inventory:networks")
    images_cache, _   = cache_get("inventory:images")
    tenants_cache, _  = cache_get("inventory:tenants")
    nets    = [n["name"] for n in (networks_cache or []) if not n.get("external")][:10]
    images  = [i["name"] for i in (images_cache  or []) if i.get("visibility") in ("public", "shared")][:20]
    tenants = [t["name"] for t in (tenants_cache  or [])][:10]
    return {"available_networks": nets, "available_images": images, "available_tenants": tenants}


# ── Existing endpoints (unchanged behaviour) ───────────────────────────────────

@router.post("/terraform")
async def generate_terraform(req: TerraformRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate OpenStack Terraform HCL for a single VM using AI."""
    inv = _inventory_context()
    nets = inv["available_networks"]
    context = {
        "vm_name":  req.name,
        "flavor":   req.flavor_name,
        "vcpus":    req.flavor_vcpus,
        "ram_mb":   req.flavor_ram_mb,
        "network":  req.network_name or (nets[0] if nets else "internal"),
        "image":    req.image_name or "Ubuntu-22.04",
        "tenant":   req.tenant_name,
        "key_pair": req.key_pair,
        "count":    req.count,
        **inv,
    }
    hcl = _strip_fences(await ai.analyze(
        "Generate a complete, production-ready OpenStack Terraform HCL configuration. "
        "Output ONLY valid HCL code — no markdown fences, no explanation. "
        "Include: terraform block with required_providers (hashicorp/openstack), "
        "provider block with variable references for auth_url/username/password/tenant_name, "
        "data sources for flavor/image/network, "
        "openstack_compute_instance_v2 resource with all provided params, "
        "and outputs for instance IDs and IPs. "
        "Use var.* for credentials. If count > 1, use count meta-argument.",
        context,
    ))
    return {"hcl": hcl, "context": context}


@router.post("/cloud-init")
async def generate_cloud_init(req: CloudInitRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate cloud-init YAML for a server role using AI."""
    context = {
        "role":        req.role,
        "hostname":    req.hostname or req.role.lower().replace(" ", "-"),
        "packages":    req.packages,
        "users":       req.users,
        "extra_notes": req.extra_notes,
    }
    yaml_out = _strip_fences(await ai.analyze(
        "Generate a complete cloud-init YAML configuration for the described server role. "
        "Output ONLY valid YAML — no markdown fences, no explanation. "
        "Include: #cloud-config header, package_update: true, package_upgrade: true, "
        "packages list (appropriate for the role), runcmd for service configuration, "
        "write_files for any config files needed, and final_message. "
        "Make it production-ready and secure (disable root SSH, etc.).",
        context,
    ))
    if not yaml_out.startswith("#cloud-config"):
        yaml_out = "#cloud-config\n" + yaml_out
    return {"yaml": yaml_out, "context": context}


@router.post("/cloud-init-refine")
async def refine_cloud_init(req: CloudInitRefineRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Refine an existing cloud-init YAML based on a natural language instruction."""
    yaml_out = _strip_fences(await ai.analyze(
        "You are modifying an existing cloud-init YAML configuration. "
        "Output ONLY the complete updated YAML — no markdown fences, no explanation. "
        "Preserve everything that already works. Apply the requested change faithfully. "
        "Keep the #cloud-config header on the first line.",
        {"current_yaml": req.current_yaml, "instruction": req.instruction},
    )).strip()
    if not yaml_out.startswith("#cloud-config"):
        yaml_out = "#cloud-config\n" + yaml_out
    return {"yaml": yaml_out}


@router.get("/flavors")
async def list_flavors_for_gen():
    """Return available flavors with vcpus, ram_mb, and disk_gb for the config generator."""
    flavors, _ = cache_get("inventory:flavors")
    if flavors:
        return flavors  # includes disk_gb — preferred source
    # Fallback: derive from server list (disk_gb unknown, set to -1 as sentinel)
    servers, _ = cache_get("inventory:servers")
    if not servers:
        return []
    seen = {}
    for s in servers:
        fname = s.get("flavor_name")
        if fname and fname not in seen:
            seen[fname] = {"name": fname, "vcpus": s.get("flavor_vcpus", 0),
                           "ram_mb": s.get("flavor_ram_mb", 0), "disk_gb": -1}
    return sorted(seen.values(), key=lambda f: (f["vcpus"], f["ram_mb"]))


# ── New: inventory helpers ─────────────────────────────────────────────────────

@router.get("/images")
async def list_images_for_gen():
    """Return public and shared VM images available for deployment."""
    images, _ = cache_get("inventory:images")
    if not images:
        return []
    return [{"name": i["name"], "id": i.get("id"), "size_gb": i.get("size_gb")}
            for i in images if i.get("visibility") in ("public", "shared", "community", None)]


@router.get("/networks")
async def list_networks_for_gen():
    """Return all networks with name, id, and whether they are external."""
    networks, _ = cache_get("inventory:networks")
    if not networks:
        return []
    return [{"name": n["name"], "id": n.get("id"), "external": n.get("external", False)}
            for n in networks]


# ── New: Combined HCL + cloud-init ────────────────────────────────────────────

@router.post("/combined")
async def generate_combined(req: CombinedRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate a single Terraform main.tf with multiple VM profiles, each with embedded cloud-init."""
    inv = _inventory_context()
    nets = inv["available_networks"]

    profiles_desc = [
        {"name": p.name, "flavor": p.flavor_name, "count": p.count, "role": p.role or p.name}
        for p in req.profiles
    ]

    context = {
        "profiles":    profiles_desc,
        "network":     req.network_name or (nets[0] if nets else "internal"),
        "image":       req.image_name or "Ubuntu-22.04",
        "tenant":      req.tenant_name,
        "key_pair":    req.key_pair,
        "extra_notes": req.extra_notes,
        **inv,
    }

    hcl = _strip_fences(await ai.analyze(
        "Generate a complete, production-ready OpenStack Terraform HCL configuration in a single main.tf. "
        "Output ONLY valid HCL — no markdown fences, no explanation. "
        "For each profile in 'profiles', create one openstack_compute_instance_v2 resource block. "
        "Use count meta-argument for each. "
        "For each profile that has a 'role', generate an appropriate cloud-init YAML inline "
        "as user_data = base64encode(<<-CLOUD_INIT ... CLOUD_INIT) within that resource block. "
        "The cloud-init should install and configure the role (e.g. nginx, postgresql, etc.). "
        "Include: terraform + provider blocks with var.* credentials, "
        "data sources for image/network shared across all profiles, "
        "and outputs for all instance IPs grouped by profile name.",
        context,
    ))
    return {"hcl": hcl, "profiles": profiles_desc, "context": context}


# ── New: Security Group generation ────────────────────────────────────────────

@router.post("/security-group")
async def generate_security_group(req: SecurityGroupRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate Terraform HCL for an OpenStack Neutron security group with rules using AI."""
    context = {
        "name":        req.name,
        "description": req.description,
        "tenant":      req.tenant_name,
        "rules":       req.rules,
    }
    hcl = _strip_fences(await ai.analyze(
        "Generate a complete OpenStack Terraform HCL configuration for a security group. "
        "Output ONLY valid HCL — no markdown fences, no explanation. "
        "Include: openstack_networking_secgroup_v2 resource, "
        "one openstack_networking_secgroup_rule_v2 resource per rule in 'rules', "
        "and outputs for the security group ID and name. "
        "Use descriptive resource names based on the security group name.",
        context,
    ))
    return {"hcl": hcl, "context": context}


# ── New: Load Balancer generation ─────────────────────────────────────────────

@router.post("/load-balancer")
async def generate_load_balancer(req: LoadBalancerRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate Terraform HCL for an Octavia load balancer with pool, listeners, and health monitor using AI."""
    inv = _inventory_context()
    context = {
        "name":            req.name,
        "network":         req.network_name,
        "protocol":        req.protocol,
        "port":            req.port,
        "members":         req.members,
        "health_monitor":  req.health_monitor,
        "tls_termination": req.tls_termination,
        "tenant":          req.tenant_name,
        **inv,
    }
    hcl = _strip_fences(await ai.analyze(
        "Generate a complete OpenStack Terraform HCL configuration for an Octavia load balancer. "
        "Output ONLY valid HCL — no markdown fences, no explanation. "
        "Include all required resources: "
        "openstack_lb_loadbalancer_v2, openstack_lb_listener_v2, openstack_lb_pool_v2, "
        "one openstack_lb_member_v2 per member in 'members', "
        "openstack_lb_monitor_v2 for health checking. "
        "If tls_termination is true, include the TERMINATED_HTTPS listener configuration. "
        "Use data source for VIP network. Include outputs for LB VIP address and pool ID.",
        context,
    ))
    return {"hcl": hcl, "context": context}


# ── New: Natural language → config ────────────────────────────────────────────

@router.post("/from-prompt")
async def generate_from_prompt(req: NLRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate infrastructure config (Terraform, cloud-init, security group, or LB) from a natural language description."""
    inv = _inventory_context()
    type_labels = {
        "terraform":      "OpenStack Terraform HCL (main.tf)",
        "cloud-init":     "cloud-init YAML (#cloud-config)",
        "combined":       "OpenStack Terraform HCL with embedded cloud-init user_data",
        "security-group": "OpenStack Terraform HCL for a security group",
        "load-balancer":  "OpenStack Terraform HCL for an Octavia load balancer",
    }
    output_format = type_labels.get(req.type, "Terraform HCL")

    result = _strip_fences(await ai.analyze(
        f"You are a Platform9 OpenStack infrastructure engineer. "
        f"Generate a {output_format} configuration based on the user's description. "
        f"Output ONLY valid configuration code — no markdown fences, no explanation, no preamble. "
        f"Use the available inventory (networks, images, tenants) when the user references them by name.",
        {"description": req.description, **inv},
    ))

    if req.type == "cloud-init" and not result.startswith("#cloud-config"):
        result = "#cloud-config\n" + result

    key = "hcl" if req.type != "cloud-init" else "yaml"
    return {key: result, "type": req.type}


# ── New: Saved config CRUD ────────────────────────────────────────────────────

@router.get("/saved")
async def list_saved_configs():
    """List all saved configs (Terraform snippets, cloud-init templates, and role library entries)."""
    return db.saved_config_list()


@router.get("/saved/{config_id}")
async def get_saved_config(config_id: int):
    """Get a saved config by ID."""
    cfg = db.saved_config_get(config_id)
    if not cfg:
        raise HTTPException(status_code=404, detail="Config not found")
    return cfg


@router.post("/saved")
async def save_config(req: SaveConfigRequest):
    """Save a new config to the library (type: terraform | cloud-init | role | app-profile)."""
    return db.saved_config_create(req.name, req.type, req.content)


@router.put("/saved/{config_id}")
async def update_saved_config(config_id: int, req: UpdateConfigRequest):
    """Update a saved config's name or content."""
    cfg = db.saved_config_update(config_id, req.name, req.content)
    if not cfg:
        raise HTTPException(status_code=404, detail="Config not found")
    return cfg


@router.delete("/saved/{config_id}", status_code=204)
async def delete_saved_config(config_id: int):
    """Delete a saved config."""
    db.saved_config_delete(config_id)


# ── App Profile generation ─────────────────────────────────────────────────────

@router.post("/app-profile")
async def generate_app_profile(req: AppProfileRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Generate a complete multi-tier Terraform plan using AI (VMs, security groups, optional LB).

    Images are baked into each VM profile; tenant, network, and key_pair are Terraform variables set at deploy time.
    """
    inv = _inventory_context()

    profiles_desc = [
        {
            "name":       p.name,
            "image":      p.image_name or "Ubuntu-22.04",
            "flavor":     p.flavor_name,
            "count":      p.count,
            "role":       p.role or p.name,
        }
        for p in req.vm_profiles
    ]

    sgs_desc = [
        {"name": sg.name, "description": sg.description, "rules": sg.rules}
        for sg in req.security_groups
    ]

    lb_desc = None
    if req.load_balancer:
        lb = req.load_balancer
        lb_desc = {
            "name":            lb.name,
            "protocol":        lb.protocol,
            "port":            lb.port,
            "backend_profile": lb.backend_profile,
            "health_monitor":  lb.health_monitor,
            "tls_termination": lb.tls_termination,
        }

    context = {
        "app_name":       req.name,
        "description":    req.description,
        "vm_profiles":    profiles_desc,
        "security_groups": sgs_desc,
        "load_balancer":  lb_desc,
        **inv,
    }

    hcl = _strip_fences(await ai.analyze(
        "Generate a complete, production-ready OpenStack Terraform HCL configuration for a multi-tier application. "
        "Output ONLY valid HCL — no markdown fences, no explanation. "
        "\n\nCRITICAL RULES:"
        "\n- Tenant name, network name, and key pair MUST be Terraform input variables (var.tenant_name, var.network_name, var.key_pair). "
        "These are deployment-time parameters, NOT hardcoded values."
        "\n- Each VM profile's image name IS hardcoded (baked into the profile) — use a separate data source per profile."
        "\n- Generate cloud-init user_data = base64encode(<<-YAML ... YAML) inline per VM profile based on its role."
        "\n\nInclude in order:"
        "\n1. variable blocks for tenant_name, network_name, key_pair (with descriptions)"
        "\n2. terraform {} and provider {} blocks"
        "\n3. One data source per unique image across VM profiles"
        "\n4. One data source for the network (using var.network_name)"
        "\n5. One openstack_compute_instance_v2 resource per VM profile (with count, cloud-init user_data from role, security_groups references)"
        "\n6. openstack_networking_secgroup_v2 + openstack_networking_secgroup_rule_v2 resources for each security group"
        "\n7. If load_balancer is present: openstack_lb_loadbalancer_v2, openstack_lb_listener_v2, openstack_lb_pool_v2, openstack_lb_member_v2 (members from the backend_profile VMs), openstack_lb_monitor_v2"
        "\n8. output blocks for all VM IPs (grouped by profile) and LB VIP if present",
        context,
    ))

    return {
        "hcl": hcl,
        "app_profile": {
            "name":            req.name,
            "description":     req.description,
            "vm_profiles":     profiles_desc,
            "security_groups": sgs_desc,
            "load_balancer":   lb_desc,
        },
    }


# ── NL description → structured form data (AI) ────────────────────────────────

@router.post("/app-profile-from-description")
async def app_profile_from_description(
    req: AppDescriptionRequest, ai: AIProvider = Depends(get_ai_provider)
):
    """Convert a natural language app description into structured JSON to pre-fill the App Builder form.

    Returns vm_profiles, networks, security_groups, and load_balancer — no HCL is generated.
    """
    inv = _inventory_context()
    flavors_cache, _ = cache_get("inventory:flavors")
    vol_flavors = [f["name"] for f in (flavors_cache or []) if f.get("disk_gb", -1) == 0][:20]

    # Load saved role names only (not YAML — keeps prompt lean)
    from app.services.db import saved_config_list
    saved_roles = [
        {"name": r["name"]}
        for r in saved_config_list()
        if r.get("type") == "role"
    ][:15]

    result_str = await ai.analyze(
        "You are an OpenStack infrastructure planner. Output ONLY a JSON object — "
        "no explanation, no markdown, no HCL. "
        "Use image/flavor names EXACTLY from the available lists. Port numbers must be integers. "
        "Rules: "
        "(1) Define appropriate internal networks (e.g. web-net 192.168.10.0/24, db-net 192.168.20.0/24). "
        "(2) Assign each VM profile to its network via network_name. "
        "(3) Set role to the descriptive name of the server role (e.g. 'NGINX Web Server'). "
        "Prefer names from saved_role_names when they match. Do NOT include cloud_init_yaml. "
        "(4) Add load_balancer with listeners when the app needs one. "
        "Web apps get [{protocol:HTTP,port:80,tls:false},{protocol:HTTPS,port:443,tls:true}]. "
        "Output schema (omit cloud_init_yaml entirely): "
        '{"name":"","description":"",'
        '"networks":[{"name":"web-net","cidr":"192.168.10.0/24","dns":["8.8.8.8"]}],'
        '"vm_profiles":[{"name":"web","image_name":"","flavor_name":"","count":1,'
        '"role":"NGINX Web Server","security_groups":["web-sg"],"network_name":"web-net"}],'
        '"security_groups":[{"name":"web-sg","description":"","rules":[{"direction":"ingress","protocol":"tcp","port_min":80,"port_max":80,"cidr":"0.0.0.0/0"}]}],'
        '"load_balancer":{"name":"web-lb","backend_profile":"web","health_monitor":"HTTP",'
        '"listeners":[{"protocol":"HTTP","port":80,"tls":false},{"protocol":"HTTPS","port":443,"tls":true}]}'
        "}",
        {
            "description": req.description,
            "available_images": inv["available_images"],
            "available_flavors_boot_from_volume": vol_flavors,
            "saved_role_names": [r["name"] for r in saved_roles],
        },
    )

    import json as _json, re as _re
    result_str = result_str.strip()
    if result_str.startswith("```"):
        lines = result_str.split("\n")
        result_str = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    try:
        return _json.loads(result_str)
    except _json.JSONDecodeError:
        m = _re.search(r'\{.*\}', result_str, _re.DOTALL)
        if m:
            return _json.loads(m.group())
        from fastapi import HTTPException
        raise HTTPException(400, detail="AI response could not be parsed as structured JSON")


# ── Deterministic Terraform HCL builder (no AI) ────────────────────────────────

def _slug(s: str) -> str:
    import re as _re
    return _re.sub(r'[^a-z0-9_]', '_', (s or "resource").lower()).strip('_') or "resource"


def _build_deterministic_hcl(req: AppProfileRequest) -> str:  # noqa: C901
    lines: list[str] = []
    has_managed_networks = bool(req.networks)
    has_tls = req.load_balancer and any(l.tls for l in (req.load_balancer.listeners or []))
    app_slug = _slug(req.name or "app")

    # ── Variables ──────────────────────────────────────────────────────────────
    lines += ["# Deployment-time variables — fill in terraform.tfvars before applying"]
    lines.append('variable "tenant_name" { description = "OpenStack tenant/project name" }')
    if has_managed_networks:
        lines.append('variable "external_network_name" { description = "External/provider network for router internet gateway" }')
    else:
        lines.append('variable "network_name" { description = "Network to attach VMs to" }')
    lines.append('variable "key_pair"     { description = "SSH key pair name" }')
    if has_tls:
        lines.append('variable "tls_cert_ref" { description = "Barbican TLS certificate container URI" }')
    lines += [
        "",
        "terraform {",
        "  required_providers {",
        "    openstack = {",
        '      source  = "terraform-provider-openstack/openstack"',
        '      version = "~> 1.54"',
        "    }",
        "  }",
        "}",
        "",
        'provider "openstack" {',
        "  tenant_name = var.tenant_name",
        "}",
        "",
    ]

    # ── Image data sources ─────────────────────────────────────────────────────
    seen_images: dict[str, str] = {}
    for p in req.vm_profiles:
        img = p.image_name or "Ubuntu-22.04"
        if img not in seen_images:
            key = _slug(img)
            seen_images[img] = key
            lines += [f'data "openstack_images_image_v2" "{key}" {{', f'  name = "{img}"', "}", ""]

    # ── Network resources ──────────────────────────────────────────────────────
    # Map: network name → slug (used when resolving VM network references)
    net_slug_map: dict[str, str] = {}

    if has_managed_networks:
        # External net + router
        lines += [
            'data "openstack_networking_network_v2" "external_net" {',
            "  external = true",
            "  name     = var.external_network_name",
            "}", "",
            f'resource "openstack_networking_router_v2" "{app_slug}_router" {{',
            f'  name                = "{req.name}-router"',
            "  admin_state_up      = true",
            "  external_network_id = data.openstack_networking_network_v2.external_net.id",
            "}", "",
        ]
        for net in req.networks:
            nk = _slug(net.name)
            net_slug_map[net.name] = nk
            dns_list = ", ".join(f'"{d.strip()}"' for d in (net.dns if isinstance(net.dns, list) else str(net.dns).split(",")))
            lines += [
                f'resource "openstack_networking_network_v2" "{nk}" {{',
                f'  name           = "{net.name}"',
                "  admin_state_up = true",
                "}", "",
                f'resource "openstack_networking_subnet_v2" "{nk}_subnet" {{',
                f'  name            = "{net.name}-subnet"',
                f"  network_id      = openstack_networking_network_v2.{nk}.id",
                f'  cidr            = "{net.cidr}"',
                "  ip_version      = 4",
                f"  dns_nameservers = [{dns_list}]",
                "}", "",
                f'resource "openstack_networking_router_interface_v2" "{nk}_iface" {{',
                f"  router_id = openstack_networking_router_v2.{app_slug}_router.id",
                f"  subnet_id = openstack_networking_subnet_v2.{nk}_subnet.id",
                "}", "",
            ]
    else:
        lines += [
            'data "openstack_networking_network_v2" "app_network" {',
            "  name = var.network_name",
            "}", "",
        ]

    # ── Data sources for PCD/external networks referenced by VM profiles ──────
    # Any network_name that isn't a managed app network → generate a data source
    seen_pcd_nets: set[str] = set()
    for p in req.vm_profiles:
        nname = p.network_name or ""
        if nname and nname not in net_slug_map and nname not in seen_pcd_nets:
            seen_pcd_nets.add(nname)
            nk = _slug(nname)
            lines += [
                f'data "openstack_networking_network_v2" "{nk}" {{',
                f'  name = "{nname}"',
                "}", "",
            ]

    # ── VM resources ───────────────────────────────────────────────────────────
    def _net_ref(p) -> str:
        nname = p.network_name or ""
        if nname and nname in net_slug_map:
            # Managed network — use resource ref
            return f"openstack_networking_network_v2.{net_slug_map[nname]}.id"
        if nname and nname in seen_pcd_nets:
            # Existing PCD/provider network — use data ref
            return f"data.openstack_networking_network_v2.{_slug(nname)}.id"
        if has_managed_networks and req.networks:
            # Fallback to first managed network
            return f"openstack_networking_network_v2.{_slug(req.networks[0].name)}.id"
        return "data.openstack_networking_network_v2.app_network.id"

    for p in req.vm_profiles:
        pk = _slug(p.name)
        img_key = seen_images.get(p.image_name or "Ubuntu-22.04", "ubuntu_22_04")
        assigned_sgs = [sg for sg in req.security_groups if sg.name in (p.security_groups or [])]
        sg_refs = ", ".join(f'openstack_networking_secgroup_v2.{_slug(sg.name)}.name' for sg in assigned_sgs) or '"default"'

        lines += [
            f'resource "openstack_compute_instance_v2" "{pk}" {{',
            f"  count       = {p.count}",
            f'  name        = "{p.name}-${{count.index + 1}}"',
            f"  image_id    = data.openstack_images_image_v2.{img_key}.id",
            f'  flavor_name = "{p.flavor_name}"',
            "  key_pair    = var.key_pair",
        ]
        yaml = p.cloud_init_yaml.strip() if p.cloud_init_yaml else ""
        if yaml:
            lines.append("  user_data = <<-CLOUDINIT")
            for yl in yaml.split("\n"):
                lines.append(f"    {yl}")
            lines.append("  CLOUDINIT")
        lines += [
            "  network {",
            f"    uuid = {_net_ref(p)}",
            "  }",
            f"  security_groups = [{sg_refs}]",
            "}", "",
        ]

    # ── Security groups ────────────────────────────────────────────────────────
    for sg in req.security_groups:
        sk = _slug(sg.name)
        desc = (sg.description or "").replace('"', "'")
        lines += [
            f'resource "openstack_networking_secgroup_v2" "{sk}" {{',
            f'  name        = "{sg.name}"',
            f'  description = "{desc}"',
            "}", "",
        ]
        for ri, rule in enumerate(sg.rules):
            proto = rule.get("protocol", "tcp"); direction = rule.get("direction", "ingress")
            port_min = rule.get("port_min"); port_max = rule.get("port_max")
            cidr = rule.get("cidr", "0.0.0.0/0")
            lines += [
                f'resource "openstack_networking_secgroup_rule_v2" "{sk}_rule_{ri}" {{',
                f"  security_group_id = openstack_networking_secgroup_v2.{sk}.id",
                f'  direction         = "{direction}"',
                '  ethertype         = "IPv4"',
            ]
            if proto and proto not in ("", "any"):
                lines.append(f'  protocol          = "{proto}"')
            if port_min not in (None, ""):
                lines.append(f"  port_range_min    = {port_min}")
            if port_max not in (None, ""):
                lines.append(f"  port_range_max    = {port_max}")
            lines += [f'  remote_ip_prefix  = "{cidr}"', "}", ""]

    # ── Load balancer (multi-listener) ─────────────────────────────────────────
    if req.load_balancer:
        lb  = req.load_balancer
        lk  = _slug(lb.name)
        bp  = next((p for p in req.vm_profiles if p.name == lb.backend_profile),
                   req.vm_profiles[0] if req.vm_profiles else None)
        bpk = _slug(bp.name) if bp else "app"

        # Choose the vip_subnet_id based on whether we have managed networks
        if has_managed_networks and bp and bp.network_name:
            bp_nk = net_slug_map.get(bp.network_name, _slug(bp.network_name))
            vip_subnet = f"openstack_networking_subnet_v2.{bp_nk}_subnet.id"
        elif has_managed_networks and req.networks:
            first_nk = _slug(req.networks[0].name)
            vip_subnet = f"openstack_networking_subnet_v2.{first_nk}_subnet.id"
        else:
            vip_subnet = "data.openstack_networking_network_v2.app_network.id"

        lines += [
            f'resource "openstack_lb_loadbalancer_v2" "{lk}" {{',
            f'  name          = "{lb.name}"',
            f"  vip_subnet_id = {vip_subnet}",
            "}", "",
        ]

        listeners = lb.listeners if lb.listeners else [LbListener(protocol="HTTP", port=80)]
        for listener in listeners:
            proto_tf = "TERMINATED_HTTPS" if listener.tls else listener.protocol
            port_s = str(listener.port)
            lines += [
                f'resource "openstack_lb_listener_v2" "{lk}_{port_s}" {{',
                f'  name            = "{lb.name}-{listener.port}"',
                f'  protocol        = "{proto_tf}"',
                f"  protocol_port   = {listener.port}",
                f"  loadbalancer_id = openstack_lb_loadbalancer_v2.{lk}.id",
            ]
            if listener.tls:
                lines.append("  default_tls_container_ref = var.tls_cert_ref")
            lines += ["}", ""]

            pool_proto = "HTTP" if listener.tls else listener.protocol
            lines += [
                f'resource "openstack_lb_pool_v2" "{lk}_{port_s}_pool" {{',
                f'  name        = "{lb.name}-{listener.port}-pool"',
                f'  protocol    = "{pool_proto}"',
                '  lb_method   = "ROUND_ROBIN"',
                f"  listener_id = openstack_lb_listener_v2.{lk}_{port_s}.id",
                "}", "",
                f'resource "openstack_lb_monitor_v2" "{lk}_{port_s}_monitor" {{',
                f"  pool_id     = openstack_lb_pool_v2.{lk}_{port_s}_pool.id",
                f'  type        = "{lb.health_monitor}"',
                "  delay       = 5", "  timeout     = 3", "  max_retries = 3",
                "}", "",
            ]
            if bp:
                lines += [
                    f'resource "openstack_lb_member_v2" "{lk}_{port_s}_members" {{',
                    f"  count         = {bp.count}",
                    f"  pool_id       = openstack_lb_pool_v2.{lk}_{port_s}_pool.id",
                    f"  address       = openstack_compute_instance_v2.{bpk}[count.index].access_ip_v4",
                    f"  protocol_port = {listener.port}",
                    "}", "",
                ]

        lines += [
            f'output "{lk}_vip_address" {{',
            f"  value       = openstack_lb_loadbalancer_v2.{lk}.vip_address",
            '  description = "Load balancer VIP IP"',
            "}", "",
        ]

    # ── VM outputs ─────────────────────────────────────────────────────────────
    for p in req.vm_profiles:
        pk = _slug(p.name)
        lines += [
            f'output "{pk}_ips" {{',
            f"  value       = openstack_compute_instance_v2.{pk}[*].access_ip_v4",
            f'  description = "{p.name} instance IP addresses"',
            "}", "",
        ]

    return "\n".join(lines)


@router.post("/app-profile-terraform")
async def generate_app_profile_terraform(req: AppProfileRequest):
    """Deterministic Terraform HCL generation — no AI, instant."""
    return {"hcl": _build_deterministic_hcl(req)}



# ── Terraform deploy runner ────────────────────────────────────────────────────

class DeployRequest(BaseModel):
    hcl: str
    tenant_name: str
    network_name: str = ""
    key_pair: str = ""
    app_name: str = "pcd-app"
    profile_id: int | None = None
    extra_vars: dict = {}   # tls_cert_ref, external_network_name, etc.


@router.post("/deploy")
async def deploy_app(req: DeployRequest):
    """Create a deployment record then run terraform init + apply, streaming SSE."""
    from app.services import db as _db
    from app.api.deployments import _tf_operation

    # Create the deployment record before starting
    dep = _db.deployment_create(
        app_name=req.app_name,
        profile_id=req.profile_id,
        tenant_name=req.tenant_name,
        network_name=req.network_name,
        key_pair=req.key_pair,
        hcl=req.hcl,
        extra_vars=req.extra_vars,
    )
    dep_id = dep["id"]

    async def _stream():
        # Emit the deployment_id first so the frontend can track it
        import json as _j
        yield f'data: {_j.dumps({"type":"started","deployment_id":dep_id})}\n\n'
        async for chunk in _tf_operation(dep_id, "apply"):
            yield chunk

    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
