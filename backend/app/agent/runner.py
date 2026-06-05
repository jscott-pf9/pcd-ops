"""
Agent runner — orchestrates collection across all domains and logs each run.

Fast domains (inventory, reclamation, capacity, snapshots) run every FAST_INTERVAL.
Slow domains (rightsizing, anomaly — both require AI) run every SLOW_INTERVAL.
"""

import asyncio
import logging

from app.services import db
from app.agent import collector
from app.agent import jobs as job_executor

logger = logging.getLogger(__name__)

FAST_INTERVAL = 15 * 60   # 15 minutes
SLOW_INTERVAL = 60 * 60   # 1 hour

_is_running = False


async def run_fast() -> None:
    """Collect infrastructure data (no AI). Fast, runs frequently."""
    global _is_running
    if _is_running:
        logger.info("Agent already running — skipping.")
        return

    _is_running = True
    run_id = db.run_start()
    try:
        await asyncio.gather(
            collector.collect_inventory(),
            collector.collect_reclamation(),
            collector.collect_capacity(),
            collector.collect_snapshots(),
            collector.collect_logs(),
        )
        db.run_finish(run_id, "success")
        logger.info("Fast collection run complete (run_id=%d).", run_id)
    except Exception as e:
        db.run_finish(run_id, "error", str(e))
        logger.exception("Fast collection run failed (run_id=%d).", run_id)
    finally:
        _is_running = False


async def run_slow() -> None:
    """Collect AI-powered analysis. Slow, runs less frequently."""
    global _is_running
    if _is_running:
        logger.info("Agent already running — skipping slow run.")
        return

    _is_running = True
    run_id = db.run_start()
    try:
        await asyncio.gather(
            collector.collect_rightsizing(),
            collector.collect_anomaly(),
            collector.collect_capacity_trends(),
        )
        db.run_finish(run_id, "success")
        logger.info("Slow collection run complete (run_id=%d).", run_id)
    except Exception as e:
        db.run_finish(run_id, "error", str(e))
        logger.exception("Slow collection run failed (run_id=%d).", run_id)
    finally:
        _is_running = False


async def run_all() -> None:
    """Run both fast and slow collectors sequentially. Used for on-demand triggers."""
    await run_fast()
    await run_slow()


async def is_running() -> bool:
    return _is_running


async def scheduler_loop() -> None:
    """
    Background loop started at app startup.
    Runs fast collection every FAST_INTERVAL, slow every SLOW_INTERVAL.
    Also runs an initial fast collection on startup so the UI has data immediately.
    """
    logger.info("Agent scheduler starting. Fast=%ds, Slow=%ds", FAST_INTERVAL, SLOW_INTERVAL)

    # Initial fast run on startup
    await run_fast()

    slow_countdown    = SLOW_INTERVAL
    job_check_interval = 5 * 60       # check jobs every 5 minutes
    cleanup_interval   = 24 * 60 * 60 # run retention cleanup daily
    job_countdown     = job_check_interval
    cleanup_countdown = cleanup_interval

    while True:
        await asyncio.sleep(FAST_INTERVAL)
        await run_fast()
        slow_countdown    -= FAST_INTERVAL
        job_countdown     -= FAST_INTERVAL
        cleanup_countdown -= FAST_INTERVAL
        if slow_countdown <= 0:
            await run_slow()
            slow_countdown = SLOW_INTERVAL
        if job_countdown <= 0:
            await _run_due_jobs()
            job_countdown = job_check_interval
        if cleanup_countdown <= 0:
            await _run_retention_cleanup()
            cleanup_countdown = cleanup_interval


async def _run_due_jobs() -> None:
    """Check all enabled jobs and run any that are due."""
    for job in db.job_list():
        if job_executor.is_due(job):
            logger.info("Triggering scheduled job %d (%s)", job["id"], job["name"])
            asyncio.create_task(job_executor.execute_job(job))


async def _run_retention_cleanup() -> None:
    """Auto-purge old job runs and reports based on configured retention periods."""
    from app.config import settings
    runs_days    = settings.job_run_retention_days
    reports_days = settings.report_retention_days
    if runs_days > 0:
        n = db.purge_job_runs(runs_days)
        if n:
            logger.info("Retention cleanup: removed %d job runs older than %dd.", n, runs_days)
    if reports_days > 0:
        n = db.purge_reports(reports_days)
        if n:
            logger.info("Retention cleanup: removed %d capacity reports older than %dd.", n, reports_days)
