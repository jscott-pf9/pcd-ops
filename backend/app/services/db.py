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
            CREATE TABLE IF NOT EXISTS saved_configs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                type       TEXT NOT NULL,
                content    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
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
            CREATE TABLE IF NOT EXISTS deployments (
                id           TEXT PRIMARY KEY,
                app_name     TEXT NOT NULL,
                profile_id   INTEGER,
                tenant_name  TEXT NOT NULL,
                network_name TEXT,
                key_pair     TEXT,
                extra_vars   TEXT NOT NULL DEFAULT '{}',
                hcl          TEXT NOT NULL,
                tf_state     TEXT,
                outputs      TEXT NOT NULL DEFAULT '{}',
                status       TEXT NOT NULL DEFAULT 'deploying',
                error_msg    TEXT,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );
        """)
    _seed_default_roles(_connect())
    _seed_default_sg_templates(_connect())


_DEFAULT_ROLES = [
    {
        "name": "NGINX Web Server",
        "description": "Installs NGINX, opens HTTP/HTTPS firewall ports.",
        "yaml": """\
#cloud-config
package_update: true
package_upgrade: true
packages:
  - nginx
  - ufw
runcmd:
  - ufw allow 'Nginx Full'
  - ufw --force enable
  - systemctl enable nginx
  - systemctl start nginx""",
    },
    {
        "name": "Apache Web Server",
        "description": "Installs Apache2 with mod_ssl, opens HTTP/HTTPS.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - apache2
  - ufw
runcmd:
  - a2enmod ssl
  - ufw allow 'Apache Full'
  - ufw --force enable
  - systemctl enable apache2
  - systemctl start apache2""",
    },
    {
        "name": "PostgreSQL Database",
        "description": "Installs PostgreSQL, enables service, opens port 5432.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - postgresql
  - postgresql-contrib
  - ufw
runcmd:
  - systemctl enable postgresql
  - systemctl start postgresql
  - ufw allow 5432/tcp""",
    },
    {
        "name": "MariaDB Database",
        "description": "Installs MariaDB, sets root password, opens port 3306.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - mariadb-server
  - ufw
runcmd:
  - systemctl enable mariadb
  - systemctl start mariadb
  - mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED BY 'changeme'; FLUSH PRIVILEGES;"
  - ufw allow 3306/tcp""",
    },
    {
        "name": "Redis Cache",
        "description": "Installs Redis, binds to all interfaces, opens port 6379.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - redis-server
  - ufw
runcmd:
  - sed -i 's/^bind 127.0.0.1 ::1/bind 0.0.0.0/' /etc/redis/redis.conf
  - sed -i 's/^# requirepass foobared/requirepass changeme/' /etc/redis/redis.conf
  - systemctl enable redis-server
  - systemctl start redis-server
  - ufw allow 6379/tcp""",
    },
    {
        "name": "Docker Host",
        "description": "Installs Docker CE and Compose plugin; adds ubuntu user to docker group.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker ubuntu""",
    },
    {
        "name": "Kubernetes Node (k3s)",
        "description": "Installs k3s single-node cluster; kubeconfig world-readable.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - curl
runcmd:
  - curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644
  - systemctl enable k3s""",
    },
    {
        "name": "Monitoring (Prometheus + Grafana)",
        "description": "Installs Prometheus on :9090 and Grafana on :3000.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - prometheus
  - ufw
runcmd:
  - wget -q -O /tmp/grafana.deb https://dl.grafana.com/oss/release/grafana_10.4.2_amd64.deb
  - dpkg -i /tmp/grafana.deb || apt-get -f install -y
  - systemctl enable prometheus grafana-server
  - systemctl start prometheus grafana-server
  - ufw allow 9090/tcp
  - ufw allow 3000/tcp""",
    },
    {
        "name": "VPN Gateway (WireGuard)",
        "description": "Installs WireGuard, enables IP forwarding, opens UDP 51820.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - wireguard
  - ufw
runcmd:
  - wg genkey | tee /etc/wireguard/privatekey | wg pubkey > /etc/wireguard/publickey
  - echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
  - sysctl -p
  - ufw allow 51820/udp
  - ufw --force enable""",
    },
    {
        "name": "Load Balancer (HAProxy)",
        "description": "Installs HAProxy and opens ports 80 and 443.",
        "yaml": """\
#cloud-config
package_update: true
packages:
  - haproxy
  - ufw
runcmd:
  - systemctl enable haproxy
  - systemctl start haproxy
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable""",
    },
]


_DEFAULT_SG_TEMPLATES = [
    {
        "name": "Web Server (HTTP/HTTPS)",
        "description": "Opens ports 80 and 443 for public web traffic.",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 80,  "port_max": 80,  "cidr": "0.0.0.0/0"},
            {"direction": "ingress", "protocol": "tcp", "port_min": 443, "port_max": 443, "cidr": "0.0.0.0/0"},
            {"direction": "egress",  "protocol": "",    "port_min": "",  "port_max": "",  "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "SSH Access",
        "description": "Allows SSH on port 22 from anywhere (restrict CIDR in production).",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 22, "port_max": 22, "cidr": "0.0.0.0/0"},
            {"direction": "egress",  "protocol": "",    "port_min": "", "port_max": "", "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "PostgreSQL",
        "description": "Allows PostgreSQL access on port 5432 from internal network.",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 5432, "port_max": 5432, "cidr": "10.0.0.0/8"},
            {"direction": "egress",  "protocol": "",    "port_min": "",   "port_max": "",   "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "MySQL / MariaDB",
        "description": "Allows MySQL/MariaDB access on port 3306 from internal network.",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 3306, "port_max": 3306, "cidr": "10.0.0.0/8"},
            {"direction": "egress",  "protocol": "",    "port_min": "",   "port_max": "",   "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "Redis",
        "description": "Allows Redis access on port 6379 from internal network.",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 6379, "port_max": 6379, "cidr": "10.0.0.0/8"},
            {"direction": "egress",  "protocol": "",    "port_min": "",   "port_max": "",   "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "Load Balancer",
        "description": "HTTP, HTTPS, and health-check ports for a load balancer.",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 80,   "port_max": 80,   "cidr": "0.0.0.0/0"},
            {"direction": "ingress", "protocol": "tcp", "port_min": 443,  "port_max": 443,  "cidr": "0.0.0.0/0"},
            {"direction": "ingress", "protocol": "tcp", "port_min": 8080, "port_max": 8080, "cidr": "10.0.0.0/8"},
            {"direction": "egress",  "protocol": "",    "port_min": "",   "port_max": "",   "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "Kubernetes Node",
        "description": "API server (6443), kubelet (10250), and node-port range (30000-32767).",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 6443,  "port_max": 6443,  "cidr": "10.0.0.0/8"},
            {"direction": "ingress", "protocol": "tcp", "port_min": 10250, "port_max": 10250, "cidr": "10.0.0.0/8"},
            {"direction": "ingress", "protocol": "tcp", "port_min": 30000, "port_max": 32767, "cidr": "0.0.0.0/0"},
            {"direction": "egress",  "protocol": "",    "port_min": "",    "port_max": "",    "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "Monitoring (Prometheus + Grafana)",
        "description": "Prometheus scrape (9090) and Grafana UI (3000) from internal network.",
        "rules": [
            {"direction": "ingress", "protocol": "tcp", "port_min": 9090, "port_max": 9090, "cidr": "10.0.0.0/8"},
            {"direction": "ingress", "protocol": "tcp", "port_min": 3000, "port_max": 3000, "cidr": "10.0.0.0/8"},
            {"direction": "egress",  "protocol": "",    "port_min": "",   "port_max": "",   "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "WireGuard VPN",
        "description": "WireGuard UDP on 51820 from anywhere.",
        "rules": [
            {"direction": "ingress", "protocol": "udp", "port_min": 51820, "port_max": 51820, "cidr": "0.0.0.0/0"},
            {"direction": "egress",  "protocol": "",    "port_min": "",    "port_max": "",    "cidr": "0.0.0.0/0"},
        ],
    },
    {
        "name": "ICMP (Ping)",
        "description": "Allows ICMP ping from anywhere.",
        "rules": [
            {"direction": "ingress", "protocol": "icmp", "port_min": "", "port_max": "", "cidr": "0.0.0.0/0"},
            {"direction": "egress",  "protocol": "icmp", "port_min": "", "port_max": "", "cidr": "0.0.0.0/0"},
        ],
    },
]


def _seed_default_roles(conn: sqlite3.Connection) -> None:
    """Insert built-in sample roles that don't already exist (by name)."""
    existing = {
        row[0].lower()
        for row in conn.execute("SELECT name FROM saved_configs WHERE type = 'role'").fetchall()
    }
    now = datetime.utcnow().isoformat()
    inserted = False
    for role in _DEFAULT_ROLES:
        if role["name"].lower() in existing:
            continue
        content = json.dumps({"description": role["description"], "yaml": role["yaml"]})
        conn.execute(
            "INSERT INTO saved_configs (name, type, content, created_at, updated_at) VALUES (?,?,?,?,?)",
            (role["name"], "role", content, now, now),
        )
        inserted = True
    if inserted:
        conn.commit()


def _seed_default_sg_templates(conn: sqlite3.Connection) -> None:
    """Insert built-in sample SG templates that don't already exist (by name)."""
    existing = {
        row[0].lower()
        for row in conn.execute("SELECT name FROM saved_configs WHERE type = 'sg-template'").fetchall()
    }
    now = datetime.utcnow().isoformat()
    inserted = False
    for tpl in _DEFAULT_SG_TEMPLATES:
        if tpl["name"].lower() in existing:
            continue
        content = json.dumps({"description": tpl["description"], "rules": tpl["rules"]})
        conn.execute(
            "INSERT INTO saved_configs (name, type, content, created_at, updated_at) VALUES (?,?,?,?,?)",
            (tpl["name"], "sg-template", content, now, now),
        )
        inserted = True
    if inserted:
        conn.commit()


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


_DEPLOY_LEVEL = {
    "deploying": "running",
    "running":   "success",
    "stopped":   "info",
    "destroyed": "info",
    "error":     "error",
}


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

        # Deployments — use updated_at as the event timestamp
        for r in conn.execute(
            "SELECT * FROM deployments ORDER BY updated_at DESC LIMIT 30"
        ).fetchall():
            events.append({
                "id":         f"deploy:{r['id']}",
                "event_type": "deployment",
                "level":      _DEPLOY_LEVEL.get(r["status"], "info"),
                "title":      r["app_name"],
                "detail":     r["error_msg"],
                "component":  "Deployment",
                "tenant":     r["tenant_name"],
                "timestamp":  r["updated_at"],
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


# ── Deployments ────────────────────────────────────────────────────────────────

def deployment_create(app_name: str, profile_id: int | None, tenant_name: str,
                      network_name: str, key_pair: str, hcl: str,
                      extra_vars: dict | None = None) -> dict:
    import uuid as _uuid
    dep_id = str(_uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _connect() as conn:
        conn.execute(
            """INSERT INTO deployments
               (id, app_name, profile_id, tenant_name, network_name, key_pair,
                extra_vars, hcl, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,'deploying',?,?)""",
            (dep_id, app_name, profile_id, tenant_name, network_name, key_pair,
             json.dumps(extra_vars or {}), hcl, now, now),
        )
        row = conn.execute("SELECT * FROM deployments WHERE id = ?", (dep_id,)).fetchone()
    return _dep_row(row)


def deployment_list(profile_id: int | None = None) -> list[dict]:
    with _connect() as conn:
        if profile_id is not None:
            rows = conn.execute(
                "SELECT * FROM deployments WHERE profile_id = ? ORDER BY created_at DESC", (profile_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM deployments ORDER BY created_at DESC"
            ).fetchall()
    return [_dep_row(r) for r in rows]


def deployment_get(dep_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM deployments WHERE id = ?", (dep_id,)).fetchone()
    return _dep_row(row) if row else None


def deployment_update(dep_id: str, *, status: str | None = None,
                      tf_state: str | None = None, outputs: dict | None = None,
                      error_msg: str | None = None) -> dict | None:
    now = datetime.utcnow().isoformat()
    with _connect() as conn:
        if status is not None:
            conn.execute("UPDATE deployments SET status = ?, updated_at = ? WHERE id = ?",
                         (status, now, dep_id))
        if tf_state is not None:
            conn.execute("UPDATE deployments SET tf_state = ?, updated_at = ? WHERE id = ?",
                         (tf_state, now, dep_id))
        if outputs is not None:
            conn.execute("UPDATE deployments SET outputs = ?, updated_at = ? WHERE id = ?",
                         (json.dumps(_sanitize(outputs)), now, dep_id))
        if error_msg is not None:
            conn.execute("UPDATE deployments SET error_msg = ?, updated_at = ? WHERE id = ?",
                         (error_msg, now, dep_id))
        row = conn.execute("SELECT * FROM deployments WHERE id = ?", (dep_id,)).fetchone()
    return _dep_row(row) if row else None


def deployment_delete(dep_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM deployments WHERE id = ?", (dep_id,))


def _dep_row(row) -> dict:
    if row is None:
        return None
    r = dict(row)
    r["extra_vars"] = json.loads(r.get("extra_vars") or "{}")
    r["outputs"]    = json.loads(r.get("outputs")    or "{}")
    return r
