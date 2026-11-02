"""OpenStack connections (APPLIANCE_STANDARD §7.4, §7.5).

- Interactive work, meaning anything a logged-in person triggers, runs as that person: their
  Keystone token, so PCD's own RBAC and audit apply. Routes take `user_connection` as a
  dependency, or wrap the work in `acting_as(...)` so collectors and jobs started from a
  request pick it up through get_connection().
- Background work (the scheduler's collectors and scheduled jobs) uses the application
  credential an admin authorized in /setup.

All features call get_connection(); never openstack.connect() elsewhere.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

import openstack
from fastapi import Request

from app.appliance import app_credentials, keystone
from app.appliance import connection as pcd

logger = logging.getLogger(__name__)

_user_conn: ContextVar[openstack.connection.Connection | None] = ContextVar(
    "pcd_user_conn", default=None)

_bg_conn: openstack.connection.Connection | None = None
_lock = threading.Lock()


class BackgroundAccessError(RuntimeError):
    """No usable background credential: setup isn't finished, or the credential stopped working."""


# ── Interactive ──────────────────────────────────────────────────────────────

def connection_for_session(session: dict) -> openstack.connection.Connection:
    """The logged-in user's connection, cached on their server-side session."""
    if session.get("conn") is None:
        conn_info = pcd.load()
        session["conn"] = keystone.user_connection(conn_info.auth_url, session["token"],
                                                   conn_info.region)
    return session["conn"]


def user_connection(request: Request) -> openstack.connection.Connection:
    """FastAPI dependency: act as the logged-in user."""
    return connection_for_session(request.state.session)


@contextmanager
def acting_as(conn: openstack.connection.Connection) -> Iterator[None]:
    """get_connection() returns `conn` inside this block, and in tasks created inside it."""
    token = _user_conn.set(conn)
    try:
        yield
    finally:
        _user_conn.reset(token)


def is_interactive() -> bool:
    return _user_conn.get() is not None


def get_connection() -> openstack.connection.Connection:
    """The user's connection inside acting_as(); the background connection otherwise."""
    conn = _user_conn.get()
    return conn if conn is not None else background_connection()


# ── Background ───────────────────────────────────────────────────────────────

def background_status() -> dict:
    """What background work runs as: {"state": "authorized"|"failed"|"none", ...}."""
    record = app_credentials.load_record()
    if record:
        public = {k: record.get(k) for k in
                  ("id", "name", "owner", "owner_id", "project_id", "created", "last_used",
                   "failed_at", "error")}
        state = "failed" if record.get("failed_at") else "authorized"
        return {"state": state, "credential": public}
    return {"state": "none", "credential": None}


def setup_complete() -> bool:
    """An admin has authorized background access (even if it has since stopped working)."""
    return app_credentials.load_record() is not None


def background_available() -> bool:
    return background_status()["state"] == "authorized"


def reset_connection() -> None:
    """Drop the cached background connection; the next get_connection() reconnects."""
    global _bg_conn
    with _lock:
        if _bg_conn is not None:
            try:
                _bg_conn.close()
            except Exception:
                pass
        _bg_conn = None


def background_connection() -> openstack.connection.Connection:
    global _bg_conn
    with _lock:
        record = app_credentials.load_record()
        if _bg_conn is None:
            if not record or record.get("failed_at"):
                raise BackgroundAccessError(
                    "Background access to PCD isn't authorized. An admin needs to authorize it "
                    "in PCD Ops (Settings › Connection).")
            conn_info = pcd.load()
            _bg_conn = app_credentials.connection(conn_info.auth_url, record, conn_info.region)
        if record and _stale(record.get("last_used")):
            record["last_used"] = int(time.time())
            app_credentials.save_record(record)
        return _bg_conn


def _stale(ts: int | None) -> bool:
    return ts is None or time.time() - ts > 300


def is_auth_failure(exc: BaseException | None) -> bool:
    """True if exc (or anything it wraps) is Keystone refusing the credential. A deleted
    application credential gets 404 "Could not find Application Credential" from
    POST /auth/tokens, not 401, so any 401/404 from the token endpoint counts."""
    from keystoneauth1 import exceptions as ksa_exc

    seen = 0
    while exc is not None and seen < 10:
        if isinstance(exc, (ksa_exc.Unauthorized, ksa_exc.AuthorizationFailure)):
            return True
        if (isinstance(exc, ksa_exc.HttpError) and exc.http_status in (401, 404)
                and (exc.url or "").rstrip("/").endswith("/auth/tokens")):
            return True
        if isinstance(exc, openstack.exceptions.HttpException) and exc.status_code == 401:
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def report_background_failure(exc: BaseException) -> bool:
    """Call with an exception from background work. If Keystone refused the application
    credential, mark it failed so /api/health reports setup_required and the UI shows the
    re-authorize banner. Returns True if it did."""
    if is_interactive() or not is_auth_failure(exc):
        return False
    record = app_credentials.load_record()
    if not record or record.get("failed_at"):
        return False
    record["failed_at"] = int(time.time())
    record["error"] = str(exc)[:300]
    app_credentials.save_record(record)
    reset_connection()
    logger.error("Background access to PCD was refused (application credential %s); "
                 "an admin needs to re-authorize it.", record.get("id"))
    from app.services import db
    db.event_log("background_access", "Background access to PCD stopped working",
                 level="error", detail=record["error"], component="Setup")
    return True
