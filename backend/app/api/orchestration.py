"""App Builder, App Catalog and App Deployments are moving to PCD App Builder, a separate
appliance in the PCD App Catalog. This exports everything they hold, for its Settings → Import:
the saved-config library (roles, security-group templates, app profiles) and every deployment
with its Terraform state, so deployments can still be managed and destroyed from there.
"""
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.services import db

router = APIRouter(prefix="/orchestration", tags=["orchestration"])

FORMAT = "pcd-ops-orchestration/v1"


@router.get("/export")
async def export():
    """Download the App Builder library and deployments as one JSON file."""
    configs = [db.saved_config_get(c["id"]) for c in db.saved_config_list()]
    body = {
        "format": FORMAT,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "saved_configs": [c for c in configs if c],
        "deployments": db.deployment_list(),
    }
    db.event_log("orchestration_export", "App Builder data exported for PCD App Builder",
                 detail=f"{len(body['saved_configs'])} saved configs, "
                        f"{len(body['deployments'])} deployments",
                 component="App Builder")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return JSONResponse(body, headers={
        "Content-Disposition": f'attachment; filename="pcd-ops-app-builder-{stamp}.json"'})
