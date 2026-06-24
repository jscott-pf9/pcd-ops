import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import agent, anomaly, capacity, deployments, events, feedback, generate, inventory, jobs, logs, reclamation, reports, rightsizing, settings, snapshots, system
from app.services.db import init_db

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    from app.agent.runner import scheduler_loop
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="PCD Ops", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    inventory.router,
    reclamation.router,
    feedback.router,
    capacity.router,
    snapshots.router,
    rightsizing.router,
    anomaly.router,
    logs.router,
    settings.router,
    system.router,
    agent.router,
    jobs.router,
    reports.router,
    generate.router,
    deployments.router,
    events.router,
):
    app.include_router(router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
