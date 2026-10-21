"""First-run setup and background access (APPLIANCE_STANDARD §7.5, §7.7, §7.8).

- GET  /access              connection (read-only) and background-access status
- POST /access/connection   before the first login, only when no Keystone URL is known
                            (an install that didn't come from the catalog)
- POST /access/authorize    "Authorize background access" / "Re-authorize": mint an application
                            credential from the logged-in admin's token
- POST /access/revoke       delete it in Keystone, then wipe the local copy
"""
import asyncio
import logging
import time

import requests
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.appliance import app_credentials, keystone
from app.appliance import connection as pcd
from app.services import db
from app.services import openstack as os_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/access", tags=["access"])


def _token(request: Request) -> keystone.Token:
    return request.state.session["token"]


def _http_detail(e: requests.HTTPError) -> str:
    try:
        return e.response.json()["error"]["message"]
    except Exception:
        return f"HTTP {e.response.status_code}" if e.response is not None else str(e)


@router.get("")
async def status():
    """Connection (from config.env, read-only), background access and setup state."""
    conn = pcd.load()
    return {
        "connection": conn.public(),
        "background": os_service.background_status(),
        "setup_required": not os_service.setup_complete(),
    }


class ConnectionRequest(BaseModel):
    auth_url: str
    project_name: str
    region: str = ""
    project_domain: str = "Default"


@router.post("/connection")
async def set_connection(body: ConnectionRequest):
    """Only for installs without config.env: tell PCD Ops which PCD to log in to. Refused
    once a Keystone URL is known; change it by redeploying, or reset setup from the console."""
    if pcd.load().auth_url:
        raise HTTPException(409, detail="The PCD connection is already configured.")
    auth_url = body.auth_url.strip().rstrip("/")
    if not auth_url.startswith(("https://", "http://")) or not body.project_name.strip():
        raise HTTPException(400, detail="Enter the Keystone v3 URL and the project name.")
    try:
        r = await asyncio.to_thread(requests.get, auth_url, timeout=keystone.TIMEOUT_S)
        r.raise_for_status()
        if "version" not in r.json():
            raise ValueError("not a Keystone v3 endpoint")
    except Exception as e:
        raise HTTPException(400, detail=f"{auth_url} doesn't look like Keystone v3: {e}") from None
    pcd.save(auth_url=auth_url, project_name=body.project_name.strip(),
             region=body.region.strip(), project_domain=body.project_domain.strip() or "Default")
    return {"status": "saved"}


@router.post("/authorize")
async def authorize(request: Request):
    """Mint an application credential from the logged-in admin's token (install project,
    roles [admin], unrestricted false), store it encrypted and switch background work to it.
    Any previous credential is then deleted in Keystone."""
    tok = _token(request)
    conn = pcd.load()
    old = app_credentials.load_record()
    try:
        record = await asyncio.to_thread(app_credentials.mint, conn.auth_url, tok, conn.app_id,
                                         conn.instance_name)
    except requests.HTTPError as e:
        raise HTTPException(
            502, detail=f"PCD refused to create the application credential: {_http_detail(e)}"
        ) from None
    app_credentials.save_record(record)

    # 0.4.x carry-over: keep the non-secret connection details, then delete the service account.
    if not conn.from_config_env:
        pcd.save(auth_url=conn.auth_url, region=conn.region, project_id=tok.project_id,
                 project_name=tok.project_name or conn.project_name,
                 project_domain=conn.project_domain)
    pcd.forget_legacy()
    os_service.reset_connection()

    warning = None
    if old and old.get("id") != record["id"]:
        try:
            await asyncio.to_thread(app_credentials.revoke, conn.auth_url, tok, old)
        except requests.RequestException as e:
            detail = _http_detail(e) if isinstance(e, requests.HTTPError) else str(e)
            warning = (f"The previous credential ({old.get('name')}, owned by {old.get('owner')}) "
                       f"couldn't be deleted in PCD: {detail}. It's no longer used; its owner "
                       "can delete it in PCD.")
    db.event_log("background_access", f"Background access authorized by {tok.user_name}",
                 level="success", component="Setup")
    return {"status": "authorized", "background": os_service.background_status(),
            "warning": warning}


@router.post("/revoke")
async def revoke(request: Request):
    """Delete the application credential in Keystone with the current admin's token, then
    wipe the local copy. Background work stops until someone authorizes it again."""
    tok = _token(request)
    record = app_credentials.load_record()
    if not record:
        raise HTTPException(404, detail="No background credential is stored.")
    try:
        await asyncio.to_thread(app_credentials.revoke, pcd.load().auth_url, tok, record)
    except requests.HTTPError as e:
        raise HTTPException(
            502, detail=f"PCD refused to delete {record.get('name')}: {_http_detail(e)}. It's "
                        f"still active. Its owner ({record.get('owner')}) can revoke it here, or "
                        "use Reset setup in the appliance console."
        ) from None
    app_credentials.clear_record()
    os_service.reset_connection()
    db.event_log("background_access", f"Background access revoked by {tok.user_name}",
                 level="warning", component="Setup")
    return {"status": "revoked", "revoked_at": int(time.time())}
