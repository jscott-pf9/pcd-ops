from fastapi import APIRouter, HTTPException

from app.agent.collector import _clean_analysis
from app.agent.runner import RIGHTSIZING_ERROR
from app.services import db, rightsizing
from app.services.db import cache_get

router = APIRouter(prefix="/rightsizing", tags=["rightsizing"])


def _last_error() -> str | None:
    """Why the last right-sizing run failed, if it did."""
    for run in db.get_runs(50):
        if (run.get("error") or "").startswith(RIGHTSIZING_ERROR):
            return run["error"][len(RIGHTSIZING_ERROR):]
    return None


@router.get("/recommendations")
async def rightsizing_recommendations():
    """Return VM right-sizing recommendations with CPU/memory usage metrics and AI-generated analysis.
    A suggested flavor carries `fit`: whether a host in the VM's cluster has room for it now
    (fits, same_host, no_room, unknown). 503 no_data until the first run succeeds; `error` says
    why the last one failed."""
    data, _ = cache_get("rightsizing:recommendations")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "rightsizing:recommendations",
                                         "error": _last_error()})
    for rec in data:
        if rec.get("analysis"):
            rec["analysis"] = _clean_analysis(rec["analysis"])
    return rightsizing.with_fit(data, cache_get("capacity:overcommit")[0],
                                cache_get("inventory:clusters")[0])


@router.get("/recommendations/{server_id}")
async def rightsizing_detail(server_id: str):
    """One VM's recommendation in detail: why it has its class (`reasons`), what the suggested
    flavor had to have (`basis`), the VM's CPU and RAM projected onto it (`projected`, with
    `warnings` when its busiest hours would run it hot), other flavors that would do
    (`alternatives`, each with its fit), and every host in its cluster with its free room
    (`hosts`). `thresholds` are the classification rules."""
    data, at = cache_get("rightsizing:recommendations")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "rightsizing:recommendations",
                                         "error": _last_error()})
    rec = next((r for r in data if r.get("server_id") == server_id), None)
    if rec is None:
        raise HTTPException(404, detail="This VM isn't in the last right-sizing run")
    overcommit, clusters = cache_get("capacity:overcommit")[0], cache_get("inventory:clusters")[0]
    hosts = (overcommit or {}).get("hosts") or []
    [rec] = rightsizing.with_fit([rec], overcommit, clusters)
    if rec.get("analysis"):
        rec["analysis"] = _clean_analysis(rec["analysis"])
    cur, sug = rec.get("current_flavor") or {}, rec.get("suggested_flavor")
    flavors = [f for f in cache_get("inventory:flavors")[0] or []
               if f.get("public") is not False and not f.get("disabled")]
    alts = rightsizing.alternatives(rec, flavors)
    for a in alts:
        full = next((f for f in flavors if f["id"] == a["flavor"]["id"]), a["flavor"])
        a["fit"] = rightsizing.flavor_fit(full, cur, rec.get("hypervisor_id"), hosts,
                                          clusters or [])
    return {
        **rec,
        "collected_at": at,
        "reasons": rightsizing.reasons(rec),
        "basis": rightsizing.basis(rec),
        "projected": rightsizing.project(cur, sug, rec.get("stats")) if sug else None,
        "alternatives": alts,
        "hosts": rightsizing.host_room(sug, cur, rec.get("hypervisor_id"), hosts, clusters or [])
        if sug else [],
        "thresholds": {"cpu_low": rightsizing.CPU_LOW, "cpu_high": rightsizing.CPU_HIGH,
                       "mem_low": rightsizing.MEM_LOW, "mem_high": rightsizing.MEM_HIGH,
                       "risk_high": rightsizing.RISK_HIGH, "busy_warn": rightsizing.BUSY_WARN},
    }
