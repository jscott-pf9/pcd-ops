"""
SQLite-backed cache and agent-run log.

cache table  — key/value store for collected domain data (JSON blobs).
agent_runs   — audit log of every collection run.
"""

import json
import math
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any


def _sanitize(obj: Any) -> Any:
    """Recursively replace NaN/Inf floats with None for JSON compliance."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj

DB_PATH = Path(__file__).parent.parent.parent / "data" / "pcd_ops.db"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS cache (
                key          TEXT PRIMARY KEY,
                data         TEXT NOT NULL,
                collected_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_runs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at   TEXT NOT NULL,
                completed_at TEXT,
                status       TEXT NOT NULL DEFAULT 'running',
                error        TEXT
            );
            CREATE TABLE IF NOT EXISTS whatif_plans (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT NOT NULL,
                tenant_id           TEXT,
                tenant_name         TEXT,
                description         TEXT,
                additional_vcpus    REAL NOT NULL DEFAULT 0,
                additional_ram_gb   REAL NOT NULL DEFAULT 0,
                additional_storage_gb REAL NOT NULL DEFAULT 0,
                additional_vdisks   INTEGER NOT NULL DEFAULT 0,
                created_at          TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                type         TEXT NOT NULL,
                schedule     TEXT,
                config       TEXT NOT NULL DEFAULT '{}',
                enabled      INTEGER NOT NULL DEFAULT 1,
                last_run_at  TEXT,
                last_status  TEXT,
                created_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS capacity_reports (
                id         TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                data       TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS job_runs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id     INTEGER NOT NULL,
                started_at TEXT NOT NULL,
                ended_at   TEXT,
                status     TEXT NOT NULL DEFAULT 'running',
                result     TEXT,
                error      TEXT
            );
            CREATE TABLE IF NOT EXISTS saved_configs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                type       TEXT NOT NULL,
                content    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        """)


# ── Cache ──────────────────────────────────────────────────────────────────────

def cache_set(key: str, data: Any) -> str:
    collected_at = datetime.utcnow().isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO cache (key, data, collected_at) VALUES (?, ?, ?)",
            (key, json.dumps(_sanitize(data), default=str), collected_at),
        )
    return collected_at


def cache_get(key: str) -> tuple[Any, str | None]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT data, collected_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
    if row is None:
        return None, None
    return json.loads(row["data"]), row["collected_at"]


def cache_meta() -> dict[str, str]:
    """Return {key: collected_at} for every cached domain."""
    with _connect() as conn:
        rows = conn.execute("SELECT key, collected_at FROM cache").fetchall()
    return {row["key"]: row["collected_at"] for row in rows}


# ── Agent run log ──────────────────────────────────────────────────────────────

def run_start() -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO agent_runs (started_at, status) VALUES (?, 'running')",
            (datetime.utcnow().isoformat(),),
        )
        return cur.lastrowid


def run_finish(run_id: int, status: str, error: str | None = None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE agent_runs SET completed_at = ?, status = ?, error = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), status, error, run_id),
        )


# ── What-If Plans ──────────────────────────────────────────────────────────────

def plan_create(name: str, tenant_id: str | None, tenant_name: str | None,
                description: str, vcpus: float, ram_gb: float,
                storage_gb: float, vdisks: int) -> dict:
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO whatif_plans
               (name, tenant_id, tenant_name, description,
                additional_vcpus, additional_ram_gb, additional_storage_gb, additional_vdisks, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (name, tenant_id, tenant_name, description, vcpus, ram_gb, storage_gb, vdisks,
             datetime.utcnow().isoformat()),
        )
        row = conn.execute("SELECT * FROM whatif_plans WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def plan_list() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM whatif_plans ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def plan_delete(plan_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM whatif_plans WHERE id = ?", (plan_id,))


# ── Jobs ───────────────────────────────────────────────────────────────────────

def job_create(name: str, type_: str, schedule: str | None, config: dict) -> dict:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO jobs (name, type, schedule, config, created_at) VALUES (?,?,?,?,?)",
            (name, type_, schedule, json.dumps(config), datetime.utcnow().isoformat()),
        )
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def job_list() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["config"] = json.loads(d["config"] or "{}")
        out.append(d)
    return out


def job_get(job_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["config"] = json.loads(d["config"] or "{}")
    return d


def job_update(job_id: int, **kwargs) -> dict | None:
    if not kwargs:
        return job_get(job_id)
    if "config" in kwargs:
        kwargs["config"] = json.dumps(kwargs["config"])
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [job_id]
    with _connect() as conn:
        conn.execute(f"UPDATE jobs SET {sets} WHERE id = ?", vals)
    return job_get(job_id)


def job_delete(job_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.execute("DELETE FROM job_runs WHERE job_id = ?", (job_id,))


def job_run_start(job_id: int) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO job_runs (job_id, started_at, status) VALUES (?, ?, 'running')",
            (job_id, datetime.utcnow().isoformat()),
        )
        conn.execute("UPDATE jobs SET last_run_at = ?, last_status = 'running' WHERE id = ?",
                     (datetime.utcnow().isoformat(), job_id))
        return cur.lastrowid


def job_run_finish(run_id: int, job_id: int, status: str, result: str | None = None, error: str | None = None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE job_runs SET ended_at = ?, status = ?, result = ?, error = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), status, result, error, run_id),
        )
        conn.execute("UPDATE jobs SET last_status = ? WHERE id = ?", (status, job_id))


def job_runs_list(job_id: int, limit: int = 20) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
            (job_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def get_runs(limit: int = 20) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


# ── Capacity Reports ───────────────────────────────────────────────────────────

def purge_job_runs(older_than_days: int, job_id: int | None = None) -> int:
    """Delete job runs older than N days. Returns number of rows deleted."""
    cutoff = (datetime.utcnow() - timedelta(days=older_than_days)).isoformat()
    with _connect() as conn:
        if job_id is not None:
            cur = conn.execute(
                "DELETE FROM job_runs WHERE job_id = ? AND started_at < ?", (job_id, cutoff)
            )
        else:
            cur = conn.execute("DELETE FROM job_runs WHERE started_at < ?", (cutoff,))
        return cur.rowcount


def clear_job_runs(job_id: int) -> int:
    """Delete all runs for a specific job. Returns number of rows deleted."""
    with _connect() as conn:
        cur = conn.execute("DELETE FROM job_runs WHERE job_id = ?", (job_id,))
        return cur.rowcount


def purge_reports(older_than_days: int) -> int:
    """Delete capacity reports older than N days. Returns number of rows deleted."""
    cutoff = (datetime.utcnow() - timedelta(days=older_than_days)).isoformat()
    with _connect() as conn:
        cur = conn.execute("DELETE FROM capacity_reports WHERE created_at < ?", (cutoff,))
        return cur.rowcount


def delete_report(report_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM capacity_reports WHERE id = ?", (report_id,))


def report_save(report_id: str, data: dict) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO capacity_reports (id, created_at, data) VALUES (?,?,?)",
            (report_id, datetime.utcnow().isoformat(), json.dumps(_sanitize(data), default=str)),
        )


def report_get(report_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT data FROM capacity_reports WHERE id = ?", (report_id,)
        ).fetchone()
    return json.loads(row["data"]) if row else None


# ── Saved Configs ──────────────────────────────────────────────────────────────

def saved_config_list() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, type, created_at, updated_at FROM saved_configs ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def saved_config_get(config_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM saved_configs WHERE id = ?", (config_id,)).fetchone()
    if not row:
        return None
    r = dict(row)
    r["content"] = json.loads(r["content"])
    return r


def saved_config_create(name: str, type_: str, content: dict) -> dict:
    now = datetime.utcnow().isoformat()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO saved_configs (name, type, content, created_at, updated_at) VALUES (?,?,?,?,?)",
            (name, type_, json.dumps(content), now, now),
        )
        row = conn.execute("SELECT * FROM saved_configs WHERE id = ?", (cur.lastrowid,)).fetchone()
    r = dict(row)
    r["content"] = json.loads(r["content"])
    return r


def saved_config_update(config_id: int, name: str | None, content: dict | None) -> dict | None:
    now = datetime.utcnow().isoformat()
    with _connect() as conn:
        if name is not None:
            conn.execute("UPDATE saved_configs SET name = ?, updated_at = ? WHERE id = ?", (name, now, config_id))
        if content is not None:
            conn.execute("UPDATE saved_configs SET content = ?, updated_at = ? WHERE id = ?",
                         (json.dumps(content), now, config_id))
        row = conn.execute("SELECT * FROM saved_configs WHERE id = ?", (config_id,)).fetchone()
    if not row:
        return None
    r = dict(row)
    r["content"] = json.loads(r["content"])
    return r


def saved_config_delete(config_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM saved_configs WHERE id = ?", (config_id,))
