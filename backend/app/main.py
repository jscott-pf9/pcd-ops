import asyncio
import logging
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    access,
    agent,
    alerts,
    anomaly,
    auth,
    capacity,
    events,
    feedback,
    inventory,
    jobs,
    logs,
    metrics,
    reclamation,
    reports,
    rightsizing,
    settings,
    snapshots,
    system,
)
from app.appliance import web_auth
from app.services import local_metrics
from app.services import openstack as os_service
from app.services.db import init_db

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # The metrics store reads its scrape config and retention from files PCD Ops writes.
    try:
        await asyncio.to_thread(local_metrics.apply_settings)
    except OSError:
        logging.getLogger(__name__).exception("Couldn't write the metrics store's config")
    from app.agent.runner import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def _app_version() -> str:
    try:
        return version("pcd-ops")
    except PackageNotFoundError:
        return "unknown"


APP_VERSION = _app_version()

app = FastAPI(title="PCD Ops", version=APP_VERSION, lifespan=lifespan)

# Every /api/ route needs a PCD login, and setup to be finished (APPLIANCE_STANDARD §7).
web_auth.install(app, setup_required=lambda: not os_service.setup_complete())

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    auth.router,
    access.router,
    inventory.router,
    reclamation.router,
    feedback.router,
    capacity.router,
    snapshots.router,
    rightsizing.router,
    anomaly.router,
    logs.router,
    metrics.router,
    settings.router,
    system.router,
    agent.router,
    jobs.router,
    reports.router,
    events.router,
    alerts.router,
):
    app.include_router(router, prefix="/api")


@app.get("/api/health")
async def health():
    """Unauthenticated and cheap (no PCD calls), for the catalog's probe (APPLIANCE_STANDARD §6).
    setup_required: no admin has authorized background access, or it stopped working."""
    return {
        "status": "ok",
        "version": APP_VERSION,
        "setup_required": os_service.background_status()["state"] not in ("authorized",),
    }
