"""
Agent runner — orchestrates collection across all domains and logs each run.

Fast  (inventory, reclamation, capacity, snapshots, logs): every 15 min.
Slow  (anomaly, capacity trends — 1 AI call each):         every 1 hour.
Daily (right-sizing — 1 AI call per VM):                   every 24 hours.
"""

import asyncio
import logging
from datetime import datetime

from app.services import db
from app.agent import collector
from app.agent import jobs as job_executor

logger = logging.getLogger(__name__)


def _ai_feature_due(cache_key: str, schedule: str, enabled: bool) -> bool:
    """Return True if this AI feature is enabled and due to run per its schedule."""
    if not enabled:
        return False
    from app.agent.jobs import next_run_at
    meta = db.cache_meta()
    last_ran = meta.get(cache_key)          # ISO string or None
    next_run = next_run_at(schedule, last_ran)
    if next_run is None:
        return False
    return datetime.utcnow() >= next_run

FAST_INTERVAL  = 15 * 60        # 15 minutes
SLOW_INTERVAL  = 60 * 60        # 1 hour
DAILY_INTERVAL = 24 * 60 * 60  # 24 hours

_is_running = False


async def _gather_named(tasks: list[tuple[str, object]]) -> list[str]:
    """Run named coroutine tasks concurrently; return a list of 'name: error' strings for any that fail."""
    results = await asyncio.gather(*(coro for _, coro in tasks), return_exceptions=True)
    errors = []
    for (name, _), result in zip(tasks, results):
        if isinstance(result, BaseException):
            logger.error("Collector '%s' failed", name, exc_info=result)
            errors.append(f"{name}: {result}")
    return errors


async def run_fast() -> None:
    """Collect infrastructure data (no AI). Fast, runs frequently."""
    global _is_running
    if _is_running:
        logger.info("Agent already running — skipping.")
        return

    _is_running = True
    run_id = db.run_start()
    try:
        errors = await _gather_named([
            ("inventory",   collector.collect_inventory()),
            ("reclamation", collector.collect_reclamation()),
            ("capacity",    collector.collect_capacity()),
            ("snapshots",   collector.collect_snapshots()),
            ("logs",        collector.collect_logs()),
        ])
        if errors:
            db.run_finish(run_id, "error", "; ".join(errors))
            logger.error("Fast collection run failed (run_id=%d): %s", run_id, errors)
        else:
            db.run_finish(run_id, "success")
            logger.info("Fast collection run complete (run_id=%d).", run_id)
    except Exception as e:
        db.run_finish(run_id, "error", str(e))
        logger.exception("Fast collection run failed (run_id=%d).", run_id)
    finally:
        _is_running = False


async def run_slow() -> None:
    """Collect AI-powered analysis (anomaly, capacity trends). Runs hourly."""
    global _is_running
    if _is_running:
        logger.info("Agent already running — skipping slow run.")
        return

    from app.config import settings
    _is_running = True
    run_id = db.run_start()
    try:
        tasks = [("capacity_trends", collector.collect_capacity_trends())]
        if _ai_feature_due("anomaly:latest", settings.ai_anomaly_schedule, settings.ai_anomaly_enabled):
            tasks.append(("anomaly", collector.collect_anomaly()))
        else:
            logger.info("Anomaly AI skipped (disabled or not yet due per schedule '%s').",
                        settings.ai_anomaly_schedule)
        errors = await _gather_named(tasks)
        if errors:
            db.run_finish(run_id, "error", "; ".join(errors))
            logger.error("Slow collection run failed (run_id=%d): %s", run_id, errors)
        else:
            db.run_finish(run_id, "success")
            logger.info("Slow collection run complete (run_id=%d).", run_id)
    except Exception as e:
        db.run_finish(run_id, "error", str(e))
        logger.exception("Slow collection run failed (run_id=%d).", run_id)
    finally:
        _is_running = False


async def run_daily() -> None:
    """Right-sizing AI analysis — gated by configured schedule."""
    global _is_running
    if _is_running:
        logger.info("Agent already running — skipping daily run.")
        return

    from app.config import settings
    if not _ai_feature_due("rightsizing:recommendations", settings.ai_rightsizing_schedule, True):
        logger.info("Right-sizing collection skipped (not yet due per schedule '%s').",
                    settings.ai_rightsizing_schedule)
        return

    _is_running = True
    run_id = db.run_start()
    try:
        await collector.collect_rightsizing()
        db.run_finish(run_id, "success")
        logger.info("Daily collection run complete (run_id=%d).", run_id)
    except Exception as e:
        db.run_finish(run_id, "error", str(e))
        logger.exception("Daily collection run failed (run_id=%d).", run_id)
    finally:
        _is_running = False


async def run_all() -> None:
    """Run all tiers sequentially. Used for on-demand triggers."""
    await run_fast()
    await run_slow()
    await run_daily()


async def is_running() -> bool:
    return _is_running


async def scheduler_loop() -> None:
    """
    Background loop started at app startup.
    Fast (inventory, reclamation, etc.) every 15 min.
    Slow (anomaly, capacity trends) every 1 hour.
    Daily (right-sizing — N AI calls per VM) every 24 hours.
    """
    logger.info(
        "Agent scheduler starting. Fast=%ds, Slow=%ds, Daily=%ds",
        FAST_INTERVAL, SLOW_INTERVAL, DAILY_INTERVAL,
    )

    # Initial runs on startup so the UI has data immediately
    await run_fast()
    await run_daily()

    slow_countdown    = SLOW_INTERVAL
    daily_countdown   = DAILY_INTERVAL
    job_check_interval = 5 * 60       # check jobs every 5 minutes
    cleanup_interval   = 24 * 60 * 60 # run retention cleanup daily
    job_countdown     = job_check_interval
    cleanup_countdown = cleanup_interval

    while True:
        await asyncio.sleep(FAST_INTERVAL)
        await run_fast()
        slow_countdown    -= FAST_INTERVAL
        daily_countdown   -= FAST_INTERVAL
        job_countdown     -= FAST_INTERVAL
        cleanup_countdown -= FAST_INTERVAL
        if slow_countdown <= 0:
            await run_slow()
            slow_countdown = SLOW_INTERVAL
        if daily_countdown <= 0:
            await run_daily()
            daily_countdown = DAILY_INTERVAL
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
