import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_ai_provider
from app.services.ai.base import AIProvider
from app.services import db
from app.services.db import cache_get

router = APIRouter(prefix="/capacity", tags=["capacity"])


# ── Summary & Trends ───────────────────────────────────────────────────────────

@router.get("/summary")
async def capacity_summary():
    """Return current capacity summary: vCPU, RAM, and storage totals with used/free/percent."""
    data, _ = cache_get("capacity:summary")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:summary"})
    return data


@router.get("/trends")
async def capacity_trends():
    """Return capacity trend data over a rolling window with per-resource time series and AI analysis."""
    data, _ = cache_get("capacity:trends")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:trends"})
    return data


# ── What-If simulation (ad-hoc, not saved) ────────────────────────────────────

class WhatIfRequest(BaseModel):
    additional_vcpus: float = 0
    additional_ram_gb: float = 0
    additional_storage_gb: float = 0
    additional_vdisks: int = 0


def _simulate(summary: dict, req: WhatIfRequest) -> dict:
    def _project(r, delta):
        new_used = r["used"] + delta
        new_free = (r["free"] - delta) if r["free"] is not None else None
        fits = new_free is None or new_free >= 0
        return {**r, "used": round(new_used, 1),
                "free": round(new_free, 1) if new_free is not None else None,
                "fits": fits}

    projected = {
        "vcpus":      _project(summary["vcpus"],      req.additional_vcpus),
        "ram_gb":     _project(summary["ram_gb"],      req.additional_ram_gb),
        "storage_gb": _project(summary["storage_gb"],  req.additional_storage_gb),
    }
    return {"current": summary, "projected": projected,
            "would_fit": all(v["fits"] for v in projected.values())}


@router.post("/what-if")
async def what_if(request: WhatIfRequest):
    """Simulate the impact of adding resources; returns current vs projected utilization and whether it fits."""
    summary, _ = cache_get("capacity:summary")
    if summary is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "capacity:summary"})
    return _simulate(summary, request)


# ── NLP: parse plain-text description into resource numbers ───────────────────

class ParseRequest(BaseModel):
    description: str


@router.post("/plans/parse")
async def parse_description(body: ParseRequest, ai: AIProvider = Depends(get_ai_provider)):
    """Extract structured resource requirements (vCPUs, RAM, storage) from a natural language description."""
    prompt = (
        "Extract OpenStack compute resource requirements from the user's description.\n"
        "Return ONLY a valid JSON object — no markdown fences, no explanation.\n"
        "Fields (all required, use 0 if not mentioned):\n"
        '  "vcpus": total vCPUs (integer) — multiply VMs × vCPUs per VM\n'
        '  "ram_gb": total RAM in GB (number) — multiply VMs × RAM per VM\n'
        '  "storage_gb": total storage in GB (number)\n'
        '  "vdisks": total number of separate volumes/disks (integer)\n'
        '  "summary": one concise line describing what was parsed\n\n'
        "Examples:\n"
        '  "5 VMs, 4 vCPU and 16 GB RAM each, two 100 GB data volumes"\n'
        '  → {"vcpus":20,"ram_gb":80,"storage_gb":200,"vdisks":2,"summary":"5×(4 vCPU, 16 GB RAM) + 2×100 GB volumes"}\n\n'
        '  "a small dev box, 2 cores and 4 gigs"\n'
        '  → {"vcpus":2,"ram_gb":4,"storage_gb":0,"vdisks":0,"summary":"1×(2 vCPU, 4 GB RAM)"}\n\n'
        f"Description:\n{body.description}"
    )
    raw = await ai.analyze(prompt, {})
    # Extract first JSON object from response
    match = re.search(r"\{[^{}]*\}", raw, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group())
            return {
                "vcpus":      float(parsed.get("vcpus", 0)),
                "ram_gb":     float(parsed.get("ram_gb", 0)),
                "storage_gb": float(parsed.get("storage_gb", 0)),
                "vdisks":     int(parsed.get("vdisks", 0)),
                "summary":    str(parsed.get("summary", "")),
            }
        except (json.JSONDecodeError, ValueError):
            pass
    raise HTTPException(422, detail="Could not parse resource requirements from description")


# ── Plans CRUD ─────────────────────────────────────────────────────────────────

class PlanCreate(BaseModel):
    name: str
    tenant_id: str | None = None
    tenant_name: str | None = None
    description: str = ""
    additional_vcpus: float = 0
    additional_ram_gb: float = 0
    additional_storage_gb: float = 0
    additional_vdisks: int = 0


@router.get("/plans")
async def list_plans():
    """List capacity plans, each annotated with a live what-if simulation against current capacity."""
    plans = db.plan_list()
    summary, _ = cache_get("capacity:summary")
    # Annotate each plan with current fit status
    for plan in plans:
        if summary:
            req = WhatIfRequest(
                additional_vcpus=plan["additional_vcpus"],
                additional_ram_gb=plan["additional_ram_gb"],
                additional_storage_gb=plan["additional_storage_gb"],
                additional_vdisks=plan["additional_vdisks"],
            )
            plan["simulation"] = _simulate(summary, req)
        else:
            plan["simulation"] = None
    return plans


@router.post("/plans", status_code=201)
async def create_plan(body: PlanCreate):
    """Create a capacity plan and return it with a what-if simulation."""
    plan = db.plan_create(
        name=body.name,
        tenant_id=body.tenant_id,
        tenant_name=body.tenant_name,
        description=body.description,
        vcpus=body.additional_vcpus,
        ram_gb=body.additional_ram_gb,
        storage_gb=body.additional_storage_gb,
        vdisks=body.additional_vdisks,
    )
    summary, _ = cache_get("capacity:summary")
    if summary:
        req = WhatIfRequest(
            additional_vcpus=plan["additional_vcpus"],
            additional_ram_gb=plan["additional_ram_gb"],
            additional_storage_gb=plan["additional_storage_gb"],
        )
        plan["simulation"] = _simulate(summary, req)
    return plan


@router.delete("/plans/{plan_id}", status_code=204)
async def delete_plan(plan_id: int):
    """Delete a capacity plan."""
    db.plan_delete(plan_id)
