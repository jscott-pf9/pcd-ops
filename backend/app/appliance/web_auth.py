"""Server-side sessions and the request gate (APPLIANCE_STANDARD §7.2, §7.7).

Adapted from the standard's §8.4 reference module for a single-page app: nginx serves the
React build (static, public) and proxies only /api/ here, so the gate covers /api/* and the
SPA renders /login and /setup itself. Login/logout are JSON endpoints (app/api/auth.py).

- No session: API calls get 401 {"detail": "login required"}.
- Setup incomplete: API calls get 409 {"setup_required": true}, except the auth and setup
  endpoints.
- Writes need the X-Requested-With header (CSRF; a cross-site form can't set it).
"""
from __future__ import annotations

import secrets
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from . import keystone

COOKIE = "pcd_session"
IDLE_S, MAX_S = 8 * 3600, 12 * 3600
CSRF_HEADER = "x-requested-with"

# No session needed. /api/access/connection refuses itself once a Keystone URL is configured.
OPEN = ("/api/health", "/api/auth/", "/api/access/connection")
# Session needed, but reachable while setup is incomplete.
SETUP_OK = ("/api/auth/", "/api/access", "/api/version")
UNSAFE = ("POST", "PUT", "PATCH", "DELETE")


class Sessions:
    def __init__(self) -> None:
        self._d: dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self, tok: keystone.Token) -> str:
        sid = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._d[sid] = {"token": tok, "created": now, "seen": now}
        return sid

    def get(self, sid: str | None) -> dict | None:
        if not sid:
            return None
        with self._lock:
            s = self._d.get(sid)
            now = time.time()
            if s and (now - s["seen"] > IDLE_S or now - s["created"] > MAX_S
                      or keystone.expired(s["token"])):
                self._d.pop(sid, None)
                s = None
            if s:
                s["seen"] = now
            return s

    def drop(self, sid: str | None) -> None:
        with self._lock:
            self._d.pop(sid or "", None)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


sessions = Sessions()


class RateLimiter:
    """At most `limit` attempts per key in `window_s` seconds (login: 5 a minute per client IP)."""

    def __init__(self, limit: int = 5, window_s: int = 60) -> None:
        self.limit, self.window_s = limit, window_s
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window_s:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


login_limiter = RateLimiter()


def client_ip(request: Request) -> str:
    # uvicorn listens on 127.0.0.1 behind nginx, which sets X-Real-IP to the peer address.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


def is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


def set_session_cookie(request: Request, response: Response, sid: str) -> None:
    response.set_cookie(COOKIE, sid, httponly=True, samesite="lax", secure=is_https(request),
                        max_age=MAX_S, path="/")


def install(app: FastAPI, setup_required: Callable[[], bool]) -> None:
    @app.middleware("http")
    async def gate(request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)       # the SPA's static files
        if request.method in UNSAFE and not request.headers.get(CSRF_HEADER):
            return JSONResponse({"detail": "missing X-Requested-With header"}, status_code=403)
        if path.startswith(OPEN):
            return await call_next(request)
        s = sessions.get(request.cookies.get(COOKIE))
        if s is None:
            return JSONResponse({"detail": "login required"}, status_code=401)
        request.state.session = s
        if not path.startswith(SETUP_OK) and setup_required():
            return JSONResponse({"setup_required": True}, status_code=409)
        return await call_next(request)
