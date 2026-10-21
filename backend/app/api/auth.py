"""Log in with your PCD account (APPLIANCE_STANDARD §7.1–7.3).

PCD Ops is an admin appliance: login is scoped to the install project and needs the admin
role there. The user's token stays in a server-side session (memory only).
"""
import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.appliance import connection as pcd
from app.appliance import keystone, web_auth
from app.services import openstack as os_service

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str
    domain: str = "Default"


@router.post("/login")
async def login(body: LoginRequest, request: Request):
    """Authenticate against PCD Keystone and start a session (5 failed attempts a minute per IP)."""
    ip = web_auth.client_ip(request)
    if web_auth.login_limiter.blocked(ip):
        raise HTTPException(429, detail="Too many failed logins. Wait a minute and try again.")
    conn = pcd.load()
    if not conn.configured:
        return JSONResponse({"detail": "PCD Ops doesn't know which PCD to use yet.",
                             "connection_required": True}, status_code=409)
    try:
        tok = await asyncio.to_thread(
            keystone.login, conn.auth_url, body.username, body.password, body.domain,
            conn.project_id or None, project_name=conn.project_name,
            project_domain=conn.project_domain)
        keystone.require_admin(tok, conn.project_label)
    except keystone.AuthError as e:
        web_auth.login_limiter.fail(ip)
        raise HTTPException(401, detail=str(e)) from None
    resp = JSONResponse({"user": tok.user_name, "project": tok.project_name or conn.project_label,
                         "setup_required": not os_service.setup_complete()})
    web_auth.set_session_cookie(request, resp, web_auth.sessions.create(tok))
    return resp


@router.post("/logout")
async def logout(request: Request):
    """End the session."""
    web_auth.sessions.drop(request.cookies.get(web_auth.COOKIE))
    resp = JSONResponse({"status": "logged_out"})
    resp.delete_cookie(web_auth.COOKIE, path="/")
    return resp


@router.get("/session")
async def session(request: Request):
    """Who is logged in, and what the UI should show next (login, setup or the app)."""
    conn = pcd.load()
    s = web_auth.sessions.get(request.cookies.get(web_auth.COOKIE))
    if s is None:
        return {"authenticated": False, "connection_configured": conn.configured}
    tok: keystone.Token = s["token"]
    return {
        "authenticated": True,
        "connection_configured": conn.configured,
        "user": tok.user_name,
        "project": tok.project_name or conn.project_label,
        "setup_required": not os_service.setup_complete(),
        "background": os_service.background_status()["state"],
    }
