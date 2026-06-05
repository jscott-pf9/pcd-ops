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
    role: str = ""        # cloud-init role for this profile


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


class NLRequest(BaseModel):
    description: str
    type: str = "terraform"   # terraform | cloud-init | combined | security-group | load-balancer


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


@router.get("/flavors")
async def list_flavors_for_gen():
    servers, _ = cache_get("inventory:servers")
    if not servers:
        return []
    seen = {}
    for s in servers:
        fname = s.get("flavor_name")
        if fname and fname not in seen:
            seen[fname] = {"name": fname, "vcpus": s.get("flavor_vcpus", 0), "ram_mb": s.get("flavor_ram_mb", 0)}
    return sorted(seen.values(), key=lambda f: (f["vcpus"], f["ram_mb"]))


# ── New: inventory helpers ─────────────────────────────────────────────────────

@router.get("/images")
async def list_images_for_gen():
    images, _ = cache_get("inventory:images")
    if not images:
        return []
    return [{"name": i["name"], "id": i.get("id"), "size_gb": i.get("size_gb")}
            for i in images if i.get("visibility") in ("public", "shared", "community", None)]


@router.get("/networks")
async def list_networks_for_gen():
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
    return db.saved_config_list()


@router.get("/saved/{config_id}")
async def get_saved_config(config_id: int):
    cfg = db.saved_config_get(config_id)
    if not cfg:
        raise HTTPException(status_code=404, detail="Config not found")
    return cfg


@router.post("/saved")
async def save_config(req: SaveConfigRequest):
    return db.saved_config_create(req.name, req.type, req.content)


@router.put("/saved/{config_id}")
async def update_saved_config(config_id: int, req: UpdateConfigRequest):
    cfg = db.saved_config_update(config_id, req.name, req.content)
    if not cfg:
        raise HTTPException(status_code=404, detail="Config not found")
    return cfg


@router.delete("/saved/{config_id}", status_code=204)
async def delete_saved_config(config_id: int):
    db.saved_config_delete(config_id)
