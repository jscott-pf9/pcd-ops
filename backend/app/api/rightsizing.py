import asyncio

import openstack.connection
import openstack.exceptions
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agent.collector import _clean_analysis
from app.agent.runner import RIGHTSIZING_ERROR
from app.services import db, rightsizing
from app.services.db import cache_get
from app.services.openstack import user_connection

router = APIRouter(prefix="/rightsizing", tags=["rightsizing"])


def _recs() -> tuple[list[dict], str | None]:
    """The last run's recommendations and when it ran; 503 no_data before the first."""
    data, at = cache_get("rightsizing:recommendations")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "rightsizing:recommendations",
                                         "error": _last_error()})
    return data, at


def _rec(data: list[dict], server_id: str) -> dict:
    rec = next((r for r in data if r.get("server_id") == server_id), None)
    if rec is None:
        raise HTTPException(404, detail="This VM isn't in the last right-sizing run")
    return rec


def _last_error() -> str | None:
    """Why the last right-sizing run failed, if it did."""
    for run in db.get_runs(50):
        if (run.get("error") or "").startswith(RIGHTSIZING_ERROR):
            return run["error"][len(RIGHTSIZING_ERROR):]
    return None


@router.get("/recommendations")
async def rightsizing_recommendations(series: bool = True):
    """VM right-sizing recommendations: CPU, RAM and IOPS use and AI analysis. A suggested
    flavor carries `fit`: whether a host in the VM's cluster has room for it now (fits,
    same_host, no_room, unknown). `series=false` leaves out the per-VM series (the list doesn't
    draw them). 503 no_data until the first run succeeds; `error` says why the last one
    failed."""
    data, _ = _recs()
    for rec in data:
        if rec.get("analysis"):
            rec["analysis"] = _clean_analysis(rec["analysis"])
        if not series:
            for key in ("cpu_series", "mem_series", "io_series"):
                rec[key] = []
    return rightsizing.with_fit(data, cache_get("capacity:overcommit")[0],
                                cache_get("inventory:clusters")[0])


@router.get("/recommendations/{server_id}")
async def rightsizing_detail(server_id: str):
    """One VM's recommendation in detail: why it has its class (`reasons`), what the suggested
    flavor had to have (`basis`), the VM's CPU and RAM projected onto it (`projected`, with
    `warnings` when its busiest hours would run it hot), other flavors that would do
    (`alternatives`, each with its fit), and every host in its cluster with its free room for
    the suggested flavor, or the shaped one when there's none (`hosts`). `custom` is a flavor
    shaped for it when the catalog has no good match, with its
    projection and fit. `thresholds` are the classification rules."""
    data, at = _recs()
    rec = _rec(data, server_id)
    overcommit, clusters = cache_get("capacity:overcommit")[0], cache_get("inventory:clusters")[0]
    hosts = (overcommit or {}).get("hosts") or []
    [rec] = rightsizing.with_fit([rec], overcommit, clusters)
    if rec.get("analysis"):
        rec["analysis"] = _clean_analysis(rec["analysis"])
    cur, sug = rec.get("current_flavor") or {}, rec.get("suggested_flavor")
    flavors = rightsizing.usable(
        [f for f in cache_get("inventory:flavors")[0] or [] if not f.get("disabled")],
        cache_get("rightsizing:flavor_access")[0] or {}, rec.get("project_id"))
    alts = rightsizing.alternatives(rec, flavors)
    for a in alts:
        full = next((f for f in flavors if f["id"] == a["flavor"]["id"]), a["flavor"])
        a["fit"] = rightsizing.flavor_fit(full, cur, rec.get("hypervisor_id"), hosts,
                                          clusters or [])
    custom = rec.get("custom_flavor")
    if custom:
        custom = {**custom, "projected": rightsizing.project(cur, custom, rec.get("stats")),
                  "fit": rightsizing.flavor_fit(custom, cur, rec.get("hypervisor_id"), hosts,
                                                clusters or [])}
    return {
        **rec,
        "collected_at": at,
        "reasons": rightsizing.reasons(rec),
        "basis": rightsizing.basis(rec),
        "projected": rightsizing.project(cur, sug, rec.get("stats")) if sug else None,
        "alternatives": alts,
        "custom": custom,
        # For the suggested flavor, else the shaped one
        "hosts": rightsizing.host_room(sug or custom, cur, rec.get("hypervisor_id"), hosts,
                                       clusters or []) if sug or custom else [],
        "thresholds": {"cpu_low": rightsizing.CPU_LOW, "cpu_high": rightsizing.CPU_HIGH,
                       "mem_low": rightsizing.MEM_LOW, "mem_high": rightsizing.MEM_HIGH,
                       "risk_high": rightsizing.RISK_HIGH, "busy_warn": rightsizing.BUSY_WARN},
    }


class FlavorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


def _shape(f) -> dict:
    return {"vcpus": f.vcpus, "ram_mb": f.ram, "disk_gb": f.disk or 0,
            "ephemeral_gb": f.ephemeral or 0, "swap_mb": f.swap or 0}


@router.post("/recommendations/{server_id}/flavor")
async def create_custom_flavor(
    server_id: str,
    body: FlavorCreate,
    conn: openstack.connection.Connection = Depends(user_connection),
):
    """Create the flavor shaped for this VM (`custom_flavor` of the last run) as a private
    flavor its tenant can use, with the current flavor's extra specs. Only the name comes from
    the request. It becomes the VM's suggested flavor at once. 409 when the name is taken or a
    flavor the tenant can already use has this shape (`existing` names it)."""
    data, at = _recs()
    rec = _rec(data, server_id)
    custom, project_id = rec.get("custom_flavor"), rec.get("project_id")
    if not custom or not project_id:
        raise HTTPException(409, detail="No custom flavor is suggested for this VM")
    name, tenant = body.name.strip(), rec.get("tenant_name") or project_id
    if not name:
        raise HTTPException(422, detail="The flavor needs a name")

    existing = await asyncio.to_thread(lambda: list(conn.compute.flavors()))
    if any(f.name == name for f in existing):
        raise HTTPException(409, detail={"error": f"A flavor named {name} already exists",
                                         "existing": name})
    for f in existing:
        if f.is_disabled or not rightsizing.same_shape(_shape(f), custom):
            continue
        if f.is_public is False:
            access = await asyncio.to_thread(conn.compute.get_flavor_access, f.id)
            if project_id not in {a["tenant_id"] for a in access}:
                continue
        raise HTTPException(409, detail={
            "error": f"{f.name} already has this shape and {tenant} can use it",
            "existing": f.name})

    try:
        fl = await asyncio.to_thread(lambda: conn.compute.create_flavor(
            name=name, vcpus=custom["vcpus"], ram=custom["ram_mb"], disk=custom["disk_gb"],
            ephemeral=custom["ephemeral_gb"], swap=custom["swap_mb"], is_public=False,
            description=f"PCD Ops right-sizing: {rec.get('server_name')} in {tenant}"))
    except openstack.exceptions.ConflictException as e:
        raise HTTPException(409, detail={"error": str(e), "existing": name}) from e
    except Exception as e:
        db.event_log("flavor_create", f"Flavor create failed: {name}", level="error",
                     detail=str(e), component="Right-Sizing", tenant=tenant)
        raise HTTPException(502, detail=f"Nova couldn't create the flavor: {e}") from e
    try:
        await asyncio.to_thread(conn.compute.flavor_add_tenant_access, fl.id, project_id)
        if custom.get("extra_specs"):
            await asyncio.to_thread(conn.compute.create_flavor_extra_specs, fl.id,
                                    custom["extra_specs"])
    except Exception as e:
        # Don't leave a half-made flavor behind
        try:
            await asyncio.to_thread(conn.compute.delete_flavor, fl.id, True)
        except Exception:
            pass
        db.event_log("flavor_create", f"Flavor create failed: {name}", level="error",
                     detail=str(e), component="Right-Sizing", tenant=tenant)
        raise HTTPException(
            502, detail=f"Nova couldn't set up the flavor (removed it): {e}") from e

    new = {"id": fl.id, "name": name, "public": False,
           **{k: custom[k] for k in ("vcpus", "ram_mb", "disk_gb", "ephemeral_gb", "swap_mb",
                                     "extra_specs")}}
    # Suggest it now, so the drill-down and the resize job use it before the next run
    data, at = cache_get("rightsizing:recommendations")
    for r in data or []:
        if r.get("server_id") == server_id:
            r["suggested_flavor"], r["custom_flavor"] = new, None
    if data is not None:
        db.cache_set("rightsizing:recommendations", data, collected_at=at)
    access, at = cache_get("rightsizing:flavor_access")
    db.cache_set("rightsizing:flavor_access", {**(access or {}), fl.id: [project_id]},
                 collected_at=at)
    db.event_log("flavor_create", f"Created private flavor {name} for {tenant}", level="success",
                 detail=f"{rightsizing.flavor_label(new)} for {rec.get('server_name')}",
                 component="Right-Sizing", tenant=tenant)
    return new
