# Plan: Automated Testing Suite

## Context
No tests exist. pytest + pytest-asyncio + httpx are already in `pyproject.toml`; vitest is already in `package.json`. The `backend/tests/` directory exists but is empty. Goal: establish a meaningful test suite covering the most critical paths — HCL generation, schedule logic, DB operations, API endpoints — without requiring live OpenStack/Prometheus/AI connections.

---

## Test directory layout

```
tests/
├── backend/
│   ├── conftest.py               # shared fixtures: test app client, temp DB, mocked deps
│   ├── unit/
│   │   ├── test_hcl_builder.py   # _build_deterministic_hcl — no external deps
│   │   ├── test_schedule.py      # _parse_schedule, next_run_at, _ai_feature_due
│   │   ├── test_db.py            # SQLite CRUD: cache, jobs, deployments, saved_configs
│   │   └── test_settings_store.py# load/save settings.json
│   └── api/
│       ├── test_health.py        # GET /api/health
│       ├── test_settings.py      # GET/PUT /api/settings
│       ├── test_jobs.py          # CRUD + /types + trigger
│       ├── test_inventory.py     # endpoints with pre-seeded cache data
│       ├── test_generate.py      # /generate/app-profile-terraform (no AI — deterministic)
│       └── test_agent.py         # GET /api/agent/status, trigger
└── frontend/
    └── src/
        ├── test_schedule_utils.test.ts   # parseAiSchedule, buildAiSchedule
        ├── test_mini_markdown.test.ts    # MiniMarkdown LATEX_MAP replacements
        └── test_settings_types.test.ts   # AppSettings type checks
```

---

## Backend: conftest.py

Key fixtures:

```python
import pytest, tempfile, os
from pathlib import Path
from httpx import AsyncClient, ASGITransport

@pytest.fixture(autouse=True)
def tmp_db(monkeypatch, tmp_path):
    """Override DB_PATH to a temp file for every test."""
    db_file = tmp_path / "test.db"
    monkeypatch.setattr("app.services.db.DB_PATH", db_file)
    # Re-run init_db so tables exist in the temp DB
    from app.services import db
    db.init_db()
    yield db_file

@pytest.fixture(autouse=True)  
def tmp_settings(monkeypatch, tmp_path):
    """Point settings_store at a temp file (no real settings.json)."""
    sf = tmp_path / "settings.json"
    sf.write_text("{}")
    monkeypatch.setenv("SETTINGS_FILE", str(sf))

@pytest.fixture
async def client():
    """Async HTTPX client against the FastAPI app."""
    from app.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
```

External services (OpenStack, Prometheus, AI, SSH) are patched per-test or per-module where needed using `pytest.monkeypatch` or `unittest.mock.patch`.

---

## Backend unit tests

### `test_hcl_builder.py` — most valuable, zero external deps

Test `_build_deterministic_hcl(req)` with various `AppProfileRequest` inputs:

| Test | Checks |
|---|---|
| `test_single_vm_no_networks` | Uses `var.network_name`, basic variables block |
| `test_multi_vm_managed_networks` | Creates network/subnet/router resources per network |
| `test_vm_assigned_to_network` | VM network block references correct resource ID |
| `test_provider_network_data_source` | VM on external net gets `data` source, not resource |
| `test_multi_listener_lb` | HTTP:80 + TERMINATED_HTTPS:443 with `var.tls_cert_ref` |
| `test_sg_per_tier` | Each VM only gets its assigned SGs, not all SGs |
| `test_cloud_init_embedded` | `user_data = <<-CLOUDINIT` block present when yaml set |
| `test_outputs_generated` | All VM profile IP outputs present |
| `test_empty_sg_assignment` | Falls back to `"default"` when no SGs assigned |
| `test_slug_special_chars` | `_slug()` handles dashes, spaces, uppercase |

### `test_schedule.py`

Test `_parse_schedule`, `next_run_at`, `_ai_feature_due`:

| Test | Checks |
|---|---|
| `test_parse_hourly` | Returns ("hourly", None) |
| `test_parse_daily_with_time` | Returns ("daily", "02:00") |
| `test_parse_weekly` | Returns ("weekly", "03:30") |
| `test_next_run_never_ran` | Returns `now` for hourly when no last_ran |
| `test_next_run_daily_future` | Schedules at correct HH:MM next day |
| `test_next_run_daily_past_due` | Returns time in past → is_due = True |
| `test_ai_feature_disabled` | Returns False when enabled=False |
| `test_ai_feature_not_due` | Returns False when last_ran is recent |
| `test_ai_feature_due` | Returns True when schedule window has passed |

### `test_db.py`

Test all CRUD functions against temp SQLite:

- `cache_set` / `cache_get` / `cache_meta`
- `job_create` / `job_list` / `job_get` / `job_update` / `job_delete`
- `deployment_create` / `deployment_list` / `deployment_get` / `deployment_update` / `deployment_delete`
- `saved_config_create` / `saved_config_list` / `saved_config_get` / `saved_config_update` / `saved_config_delete`
- `_sanitize` with NaN/Inf floats

---

## Backend API tests

All use the `client` fixture (async HTTPX against FastAPI in-process).

### `test_health.py`
- `GET /api/health` → 200 `{"status": "ok"}`

### `test_settings.py`
- `GET /api/settings` → 200, contains all AI toggle keys
- `PUT /api/settings` with `ai_backend=claude` → 200, settings updated
- `PUT /api/settings` boolean toggle → False survives round-trip (key regression)

### `test_jobs.py`
- `GET /api/jobs/types` → 200, all 6 job types present with icons
- `POST /api/jobs/` valid type → 201
- `POST /api/jobs/` invalid type → 400
- `GET /api/jobs/` → 200, list
- `PUT /api/jobs/{id}` → 200, updated
- `DELETE /api/jobs/{id}` → 204

### `test_inventory.py`
Pre-seed `inventory:servers`, `inventory:hypervisors`, etc. via `db.cache_set()` in fixture, then:
- `GET /api/inventory/servers` → 200, returns seeded data
- `GET /api/inventory/tenants` → 200
- `GET /api/inventory/keypairs` → 200 (empty list when not cached)
- `GET /api/inventory/summary` → 503 when no data (correct "no_data" code)

### `test_generate.py`
Test the deterministic endpoint (no AI):
- `POST /api/generate/app-profile-terraform` basic → 200, HCL contains `variable "tenant_name"`
- HCL contains `openstack_networking_network_v2` when networks defined
- HCL contains `TERMINATED_HTTPS` when tls listener present
- `GET /api/generate/flavors` → 200 (empty when no cache)
- `GET /api/generate/saved` → 200, empty list
- `POST /api/generate/saved` + `GET` + `PUT` + `DELETE` → full CRUD lifecycle

### `test_agent.py`
- `GET /api/agent/status` → 200, has `is_running` field
- `POST /api/agent/trigger` → 200 (may return `triggered: false` if already running — ok)

---

## Frontend tests (Vitest)

Placed in `frontend/src/` alongside source files, suffixed `.test.ts`:

### `schedule_utils.test.ts`
Test the `parseAiSchedule` / `buildAiSchedule` helpers in SettingsAI.tsx:
- `parseAiSchedule("hourly")` → `{interval:"hourly", time:"02:00"}`  
- `parseAiSchedule("daily@03:30")` → `{interval:"daily", time:"03:30"}`
- `buildAiSchedule("daily","02:00")` → `"daily@02:00"`
- `buildAiSchedule("hourly","anything")` → `"hourly"`

### `mini_markdown.test.ts`
Test the `LATEX_MAP` replacements and `MiniMarkdown` inline renderer in Logs.tsx:
- `$\rightarrow$` → `→`
- `**bold**` → `<strong>bold</strong>`
- Bullet lists render as `<ul><li>`

### `settings_types.test.ts`
Type-safety smoke tests — ensure `AppSettings` has the AI toggle fields and schedule fields.

---

## Appliance Console TUI (`deploy/scripts/appliance-console.sh`)

The TUI runs on tty1 and cannot be unit-tested — validate manually on the deployed VM or in a local terminal:

```bash
# Run the TUI locally (simulates the console without a real Alpine VM)
TERM=linux bash deploy/scripts/appliance-console.sh
```

> `rc-service` calls will fail locally (no OpenRC); that's expected. All menu drawing, key routing, and log viewing still exercise correctly.

### Key-routing tests

| Action | Expected |
|---|---|
| Press `r` | "Restarting pcd-ops…" appears, then menu redraws |
| Press `b` | "Rebooting in 3 seconds" + Ctrl+C cancels |
| Press `s` | "Shutting down in 3 seconds" + Ctrl+C cancels |
| Press `a` | Advanced Options menu draws |
| Press ↑ ↓ ← → (any arrow) | Menu redraws — **no action triggered** |
| Press any other key | Menu redraws silently |

### Advanced Options tests

| Action | Expected |
|---|---|
| Press `u` (Force Update) | Shows git pull → pip install output → npm output → success/fail message; completes in < 5 min |
| Press `l` (View Logs) | Shows last 100 lines of `/var/log/pcd-ops/uvicorn.log` in `less`; press `q` then any key returns to menu. If log missing, prints "Log file not found" then returns |
| Press `n` (Network Info) | Shows `ip addr` + `ip route` output, then "Press any key" to return |
| Press `x` (Emergency Shell) | Drops to `/bin/sh`; `exit` returns to menu |
| Press `b` (Back) | Returns to main menu |

### Regression: arrow keys in Advanced menu

Press ↑ ↓ ← → while in the Advanced Options menu — same as main menu, menu should redraw without triggering any action (especially `b` = Back should not fire from a down-arrow's `B` byte).

---

## What is explicitly NOT tested (yet)

- OpenStack SDK integration (requires live cloud)
- AI provider calls (non-deterministic, slow)
- SSH hypervisor connections
- Full browser E2E (Playwright — future milestone)
- Prometheus/Grafana queries

---

## Files to create

| File | Notes |
|---|---|
| `tests/backend/conftest.py` | tmp_db, tmp_settings, client fixtures |
| `tests/backend/unit/test_hcl_builder.py` | 10 test cases |
| `tests/backend/unit/test_schedule.py` | 9 test cases |
| `tests/backend/unit/test_db.py` | CRUD coverage for all tables |
| `tests/backend/unit/test_settings_store.py` | load/save round-trip |
| `tests/backend/api/test_health.py` | 1 test |
| `tests/backend/api/test_settings.py` | 3 tests |
| `tests/backend/api/test_jobs.py` | 7 tests |
| `tests/backend/api/test_inventory.py` | 5 tests |
| `tests/backend/api/test_generate.py` | 7 tests |
| `tests/backend/api/test_agent.py` | 2 tests |
| `frontend/src/schedule_utils.test.ts` | 4 tests |
| `frontend/src/mini_markdown.test.ts` | 3 tests |

Also update `backend/pyproject.toml` pytest config to include `tests/backend` as testpath, and add `__init__.py` files in each test subpackage.

---

## Verification

```bash
# Backend
cd backend && pytest tests/backend/ -v

# Frontend
cd frontend && npm test -- --run
```

All tests should pass with no live external services required.
