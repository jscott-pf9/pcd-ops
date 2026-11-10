"""
SQLite-backed cache and agent-run log.

cache table  — key/value store for collected domain data (JSON blobs).
agent_runs   — audit log of every collection run.
"""

import json
import math
import sqlite3
from datetime import datetime, timedelta
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
            CREATE TABLE IF NOT EXISTS app_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp  TEXT NOT NULL,
                level      TEXT NOT NULL DEFAULT 'info',
                event_type TEXT NOT NULL,
                title      TEXT NOT NULL,
                detail     TEXT,
                component  TEXT,
                tenant     TEXT
            );
            CREATE TABLE IF NOT EXISTS alerts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at         TEXT NOT NULL,
                source     TEXT NOT NULL,
                key        TEXT NOT NULL,
                severity   TEXT NOT NULL,
                title      TEXT NOT NULL,
                body       TEXT,
                results    TEXT,
                suppressed INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS alerts_key ON alerts (key, at);
            CREATE TABLE IF NOT EXISTS drift_changes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at         TEXT NOT NULL,
                kind       TEXT NOT NULL,
                item_id    TEXT NOT NULL,
                name       TEXT,
                project_id TEXT,
                change     TEXT NOT NULL,
                severity   TEXT NOT NULL,
                fields     TEXT,
                actions    TEXT
            );
            CREATE INDEX IF NOT EXISTS drift_changes_at ON drift_changes (at);
            CREATE TABLE IF NOT EXISTS reclamation_seen (
                kind       TEXT NOT NULL,
                id         TEXT NOT NULL,
                first_seen TEXT NOT NULL,
                last_seen  TEXT NOT NULL,
                PRIMARY KEY (kind, id)
            );
        """)
        # Columns added since the table was first created
        if "actions" not in {r["name"] for r in conn.execute("PRAGMA table_info(drift_changes)")}:
            conn.execute("ALTER TABLE drift_changes ADD COLUMN actions TEXT")


# ── Cache ──────────────────────────────────────────────────────────────────────

def cache_set(key: str, data: Any, collected_at: str | None = None) -> str:
    """Store `data` under `key`, collected now (or at `collected_at`, to edit it in place)."""
    collected_at = collected_at or datetime.utcnow().isoformat()
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


# ── Reclamation first-seen ─────────────────────────────────────────────────────

def seen_update(kind: str, ids: list[str]) -> dict[str, str]:
    """Record that `ids` are the current candidates of `kind`: new ones get first_seen now,
    ones no longer listed are forgotten. Returns {id: first_seen}."""
    now = datetime.utcnow().isoformat()
    with _connect() as conn:
        conn.executemany(
            "INSERT INTO reclamation_seen (kind, id, first_seen, last_seen) VALUES (?, ?, ?, ?)"
            " ON CONFLICT (kind, id) DO UPDATE SET last_seen = excluded.last_seen",
            [(kind, i, now, now) for i in ids],
        )
        conn.execute("DELETE FROM reclamation_seen WHERE kind = ? AND last_seen < ?", (kind, now))
        rows = conn.execute(
            "SELECT id, first_seen FROM reclamation_seen WHERE kind = ?", (kind,)).fetchall()
    return {r["id"]: r["first_seen"] for r in rows}


def seen_get(kind: str) -> dict[str, str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, first_seen FROM reclamation_seen WHERE kind = ?", (kind,)).fetchall()
    return {r["id"]: r["first_seen"] for r in rows}


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


def event_log(event_type: str, title: str, level: str = "info",
              detail: str | None = None, component: str | None = None,
              tenant: str | None = None) -> None:
    """Log a user-initiated or system action to the app_events table."""
    with _connect() as conn:
        conn.execute(
            "INSERT INTO app_events (timestamp, level, event_type, title, detail, component, tenant)"
            " VALUES (?,?,?,?,?,?,?)",
            (datetime.utcnow().isoformat(), level, event_type, title, detail, component, tenant),
        )


def get_recent_events(limit: int = 100) -> list[dict]:
    """Return a unified, timestamp-sorted event list from all event sources."""
    events: list[dict] = []

    with _connect() as conn:
        # Agent collection runs
        for r in conn.execute(
            "SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 40"
        ).fetchall():
            events.append({
                "id":         f"agent:{r['id']}",
                "event_type": "agent_run",
                "level":      r["status"],
                "title":      f"Collection run #{r['id']}",
                "detail":     r["error"],
                "component":  "Agent",
                "tenant":     None,
                "timestamp":  r["started_at"],
            })

        # Job runs (joined with job name/type)
        for r in conn.execute("""
            SELECT jr.*, j.name AS job_name, j.type AS job_type
            FROM job_runs jr
            LEFT JOIN jobs j ON j.id = jr.job_id
            ORDER BY jr.started_at DESC LIMIT 40
        """).fetchall():
            events.append({
                "id":         f"job:{r['id']}",
                "event_type": "job_run",
                "level":      r["status"],
                "title":      r["job_name"] or r["job_type"] or f"Job #{r['job_id']}",
                "detail":     r["error"],
                "component":  r["job_type"] or "Job",
                "tenant":     None,
                "timestamp":  r["started_at"],
            })

        # Capacity reports
        for r in conn.execute(
            "SELECT id, created_at FROM capacity_reports ORDER BY created_at DESC LIMIT 20"
        ).fetchall():
            events.append({
                "id":         f"report:{r['id']}",
                "event_type": "report",
                "level":      "info",
                "title":      "Capacity report generated",
                "detail":     None,
                "component":  "Capacity",
                "tenant":     None,
                "timestamp":  r["created_at"],
            })

        # User-initiated / system actions
        for r in conn.execute(
            "SELECT * FROM app_events ORDER BY timestamp DESC LIMIT 60"
        ).fetchall():
            events.append({
                "id":         f"evt:{r['id']}",
                "event_type": r["event_type"],
                "level":      r["level"],
                "title":      r["title"],
                "detail":     r["detail"],
                "component":  r["component"],
                "tenant":     r["tenant"],
                "timestamp":  r["timestamp"],
            })

    events.sort(key=lambda e: e["timestamp"] or "", reverse=True)
    return events[:limit]


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


# ── Alerts (services/alerts.py) ──────────────────────────────────────────────────

def alert_record(source: str, key: str, severity: str, title: str, body: str, results: str,
                 suppressed: bool) -> dict:
    at = datetime.utcnow().isoformat()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO alerts (at, source, key, severity, title, body, results, suppressed)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (at, source, key, severity, title, body, results, int(suppressed)))
    return {"id": cur.lastrowid, "at": at, "source": source, "key": key, "severity": severity,
            "title": title, "body": body, "results": json.loads(results or "{}"),
            "suppressed": suppressed}


def alert_last(key: str) -> dict | None:
    """The last alert with this key that was sent (not suppressed)."""
    with _connect() as conn:
        row = conn.execute("SELECT at, severity FROM alerts WHERE key = ? AND suppressed = 0"
                           " ORDER BY id DESC LIMIT 1", (key,)).fetchone()
    return dict(row) if row else None


def alert_list(limit: int = 100) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["results"] = json.loads(d["results"] or "{}")
        d["suppressed"] = bool(d["suppressed"])
        out.append(d)
    return out


def purge_alerts(older_than_days: int) -> int:
    cutoff = (datetime.utcnow() - timedelta(days=older_than_days)).isoformat()
    with _connect() as conn:
        return conn.execute("DELETE FROM alerts WHERE at < ?", (cutoff,)).rowcount


# ── Config change log (services/drift.py) ────────────────────────────────────────

def drift_add(changes: list[dict], at: str | None = None) -> None:
    at = at or datetime.utcnow().isoformat()
    with _connect() as conn:
        conn.executemany(
            "INSERT INTO drift_changes (at, kind, item_id, name, project_id, change, severity,"
            " fields, actions) VALUES (?,?,?,?,?,?,?,?,?)",
            [(at, c["kind"], c["item_id"], c["name"], c.get("project_id"), c["change"],
              c["severity"], json.dumps(c["fields"], default=str),
              json.dumps(c["actions"]) if c.get("actions") else None) for c in changes])


def drift_list(kind: str | None = None, since: str | None = None, q: str | None = None,
               limit: int = 500) -> list[dict]:
    """Changes, newest first. `q` matches the item's name or a changed field's name or value."""
    sql, args = "SELECT * FROM drift_changes WHERE 1=1", []
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    if since:
        sql += " AND at >= ?"
        args.append(since)
    if q:
        sql += " AND (name LIKE ? OR fields LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    with _connect() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [{**dict(r), "fields": json.loads(r["fields"] or "[]"),
             "actions": json.loads(r["actions"]) if r["actions"] else None} for r in rows]


def drift_counts(since: str | None = None) -> dict[str, int]:
    with _connect() as conn:
        rows = conn.execute("SELECT kind, COUNT(*) n FROM drift_changes WHERE at >= ? GROUP BY kind",
                            (since or "",)).fetchall()
    return {r["kind"]: r["n"] for r in rows}


def purge_drift(older_than_days: int) -> int:
    cutoff = (datetime.utcnow() - timedelta(days=older_than_days)).isoformat()
    with _connect() as conn:
        return conn.execute("DELETE FROM drift_changes WHERE at < ?", (cutoff,)).rowcount
