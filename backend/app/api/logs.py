from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import get_ai_provider
from app.services.ai.base import AIProvider
from app.services.db import cache_get

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("/recent")
async def recent_logs(
    host:    str | None = Query(None),
    service: str | None = Query(None),
    level:   str | None = Query(None),
    keyword: str | None = Query(None),
    limit:   int        = Query(500),
):
    """Return cached hypervisor log entries with optional filtering."""
    data, collected_at = cache_get("logs:recent")
    if data is None:
        raise HTTPException(503, detail={"code": "no_data", "key": "logs:recent"})

    entries = data
    if host:    entries = [e for e in entries if e.get("hostname") == host or e.get("host") == host]
    if service: entries = [e for e in entries if e.get("service", "") == service]
    if level:   entries = [e for e in entries if e.get("level", "").upper() == level.upper()]
    if keyword:
        kw = keyword.lower()
        entries = [e for e in entries if kw in e.get("message", "").lower()]

    return {
        "entries": entries[:limit],
        "total": len(entries),
        "collected_at": collected_at,
    }


@router.get("/hosts")
async def log_hosts():
    """Return list of hypervisor hostnames that have log data."""
    data, _ = cache_get("logs:recent")
    if not data:
        return []
    seen = {}
    for e in data:
        h = e.get("hostname") or e.get("host", "unknown")
        seen[h] = seen.get(h, 0) + 1
    return [{"hostname": h, "count": c} for h, c in seen.items()]


@router.get("/services")
async def log_services():
    """Return list of service names that have log data."""
    data, _ = cache_get("logs:recent")
    if not data:
        return []
    seen: dict[str, int] = {}
    for e in data:
        s = e.get("service", "unknown")
        seen[s] = seen.get(s, 0) + 1
    return [{"service": s, "count": c} for s, c in sorted(seen.items(), key=lambda x: -x[1])]


class NLPQuery(BaseModel):
    query: str


import re as _re
from collections import Counter as _Counter


def _normalize_msg(msg: str) -> str:
    """Strip variable parts (timestamps, UUIDs, IPs, numbers) to create a dedup key."""
    s = msg
    s = _re.sub(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.,Z+-]*', '[TS]', s)
    s = _re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '[UUID]', s, flags=_re.I)
    s = _re.sub(r'\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b', '[IP]', s)
    s = _re.sub(r'\b\d{5,}\b', '[NUM]', s)
    return s[:120]


def _compress_logs(entries: list[dict], max_patterns: int = 60) -> list[dict]:
    """
    De-duplicate log entries by normalizing messages.
    Returns a compact list of unique patterns with occurrence counts.
    """
    seen: dict[tuple, dict] = {}
    for e in entries:
        key = (e.get("service", ""), e.get("level", ""), _normalize_msg(e.get("message", "")))
        if key not in seen:
            seen[key] = {
                "service": e.get("service", ""),
                "host":    e.get("hostname") or e.get("host", ""),
                "level":   e.get("level", ""),
                "message": e.get("message", "")[:200],
                "count":   1,
            }
        else:
            seen[key]["count"] += 1

    # Sort: errors first, then by count desc
    ordered = sorted(seen.values(),
                     key=lambda x: (0 if x["level"] == "ERROR" else 1 if x["level"] == "WARNING" else 2,
                                    -x["count"]))
    return ordered[:max_patterns]


def _build_log_summary(data: list[dict]) -> dict:
    """High-level summary of log state for AI context — stays small."""
    errors   = [e for e in data if e.get("level") == "ERROR"]
    warnings = [e for e in data if e.get("level") == "WARNING"]
    by_svc   = _Counter(e.get("service", "") for e in errors)
    types    = _Counter()
    for e in errors:
        m = (e.get("message") or "").lower()
        if any(k in m for k in ("connection", "amqp", "rabbit", "refused")):
            types["connection/messaging"] += 1
        elif "timeout" in m:
            types["timeout"] += 1
        elif any(k in m for k in ("permission", "auth", "forbidden", "denied")):
            types["auth/permission"] += 1
        elif any(k in m for k in ("not found", "404", "does not exist")):
            types["not found"] += 1
        else:
            types["other"] += 1

    hosts_with_errors = list({e.get("hostname") or e.get("host", "") for e in errors})

    return {
        "total_entries":           len(data),
        "error_count":             len(errors),
        "warning_count":           len(warnings),
        "errors_by_service":       dict(by_svc.most_common()),
        "error_types":             dict(types.most_common(6)),
        "hosts_with_errors":       hosts_with_errors,
    }


@router.post("/query")
async def nlp_query(body: NLPQuery, ai: AIProvider = Depends(get_ai_provider)):
    """NLP: answer a question using compressed log patterns + PCD inventory context."""
    data, collected_at = cache_get("logs:recent")
    if not data:
        raise HTTPException(503, detail={"code": "no_data", "key": "logs:recent"})

    query_lower = body.query.lower()

    # ── Service-aware pre-filter ───────────────────────────────────────────────
    all_services = {e.get("service", "") for e in data}
    mentioned = [s for s in all_services if s and
                 s.lower().replace("-", "").replace("_", "") in
                 query_lower.replace("-", "").replace("_", "")]

    if mentioned:
        pool = [e for e in data if e.get("service") in mentioned or e.get("level") == "ERROR"]
    else:
        pool = [e for e in data if e.get("level") in ("ERROR", "WARNING")] or data

    # ── Compress: de-duplicate into unique patterns (keeps context small) ──────
    compressed = _compress_logs(pool, max_patterns=60)

    # ── High-level summary (always included) ──────────────────────────────────
    summary = _build_log_summary(data)

    # ── PCD inventory (compact) ────────────────────────────────────────────────
    pcd: dict = {}
    try:
        svrs, hyps, tens = (cache_get(k)[0] for k in
                            ("inventory:servers", "inventory:hypervisors", "inventory:tenants"))
        if hyps:
            pcd["hypervisors"] = [{"name": h["hostname"], "state": h["state"], "ip": h["host_ip"]}
                                  for h in hyps]
        if svrs:
            pcd["active_servers"] = [{"name": s["name"], "status": s["status"],
                                       "hyp": s.get("hypervisor_hostname", "")}
                                      for s in svrs if s.get("status") == "ACTIVE"][:20]
        if tens:
            pcd["tenants"] = [t["name"] for t in tens]
    except Exception:
        pass

    context = {
        "question":           body.query,
        "log_summary":        summary,
        "pcd_cluster":        pcd,
        "unique_log_patterns": compressed,   # de-duplicated, ≤60 entries
    }

    prompt = (
        "You are a Platform9 PCD infrastructure analyst. "
        "Answer the question using the log patterns and cluster data below. "
        "The log_patterns are de-duplicated — 'count' shows how many times each occurred. "
        "Structure your response in three sections:\n"
        "1. Root Cause — what is failing and why\n"
        "2. Cascading Effects — services/components impacted\n"
        "3. Recommended Fixes — specific, actionable steps an operator can take to resolve the issue "
        "(commands, config changes, service restarts, etc.)\n"
        "Be concise and specific. No preamble."
    )

    answer = await ai.analyze(prompt, context)

    return {
        "answer":        answer,
        "logs_searched": len(pool),
        "unique_patterns": len(compressed),
        "services_found": list({e.get("service") for e in pool if e.get("service")}),
    }


@router.post("/analyze")
async def analyze_logs(logs: list[str], ai: AIProvider = Depends(get_ai_provider)):
    """Paste-and-analyze: accepts raw log lines, returns AI summary."""
    analysis = await ai.analyze(
        "Analyze the following infrastructure log lines from a Platform9 PCD environment. "
        "Structure your response in three sections:\n"
        "1. Key Findings — errors, recurring patterns, signs of instability\n"
        "2. Root Cause — most likely cause of the issues observed\n"
        "3. Recommended Fixes — specific, actionable remediation steps an operator can take\n"
        "Start directly with findings — no preamble.",
        {"log_lines": logs[:500]},
    )
    return {"analysis": analysis, "lines_analyzed": min(len(logs), 500)}
