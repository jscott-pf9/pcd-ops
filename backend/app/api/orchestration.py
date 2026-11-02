"""App Builder, App Catalog and App Deployments moved to PCD App Builder, a separate appliance in
the PCD App Catalog. This exports what an install that used them still holds, for its
Settings → Import: the saved-config library (roles, security-group templates, app profiles) and
every deployment with its Terraform state, so deployments can be managed and destroyed there.
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
    body = {
        "format": FORMAT,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "saved_configs": db.saved_configs_export(),
        "deployments": db.deployments_export(),
    }
    db.event_log("orchestration_export", "App Builder data exported for PCD App Builder",
                 detail=f"{len(body['saved_configs'])} saved configs, "
                        f"{len(body['deployments'])} deployments",
                 component="App Builder")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return JSONResponse(body, headers={
        "Content-Disposition": f'attachment; filename="pcd-ops-app-builder-{stamp}.json"'})
