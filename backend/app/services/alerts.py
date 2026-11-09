"""Alerts: what gets sent, where, and how often.

A source (anomaly detection, the config change log, jobs) raises an Alert. raise_alert() checks
the source's rule in Settings (on, and at least its minimum severity), suppresses a repeat of
the same key within the cooldown unless it is more severe, sends it to every configured channel
(services/notifications.py: email, the generic webhook, Slack) and records it in the alerts
table and the event log.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.config import settings
from app.services import db, notifications

logger = logging.getLogger(__name__)

SEVERITIES = ("low", "medium", "high", "critical")
SOURCES = ("anomaly", "drift", "job", "certificate")
CHANNELS = ("email", "webhook", "slack")
SLACK_COLOR = {"low": "#6b7280", "medium": "#d97706", "high": "#dc2626", "critical": "#7f1d1d"}


@dataclass
class Alert:
    source: str           # anomaly | drift | job | certificate | test
    key: str              # the same key within the cooldown is one alert, e.g. job:3
    severity: str         # one of SEVERITIES
    title: str
    body: str = ""
    fields: list[list[str]] = field(default_factory=list)   # [label, value]
    link: str | None = None                                  # page path, e.g. /changes


def rank(severity: str) -> int:
    return SEVERITIES.index(severity) if severity in SEVERITIES else 0


def rule(source: str) -> tuple[bool, str]:
    """(on, minimum severity) for a source, from Settings."""
    if source == "anomaly":
        return settings.alert_anomaly_enabled, settings.alert_anomaly_min
    if source == "drift":
        return settings.alert_drift_enabled, settings.alert_drift_min
    if source == "job":
        return settings.alert_jobs_enabled, "low"
    return True, "low"


def configured() -> list[str]:
    """Channels with somewhere to send to."""
    out = []
    if settings.smtp_host and settings.alert_email_to:
        out.append("email")
    if settings.webhook_url:
        out.append("webhook")
    if settings.slack_webhook_url:
        out.append("slack")
    return out


def link_url(path: str | None) -> str | None:
    base = (settings.alert_base_url or "").rstrip("/")
    return f"{base}{path}" if base and path else None


def text(a: Alert) -> str:
    lines = [a.title, ""] if a.body or a.fields else [a.title]
    if a.body:
        lines.append(a.body)
    lines += [f"{k}: {v}" for k, v in a.fields]
    if url := link_url(a.link):
        lines += ["", url]
    return "\n".join(lines)


def webhook_payload(a: Alert) -> dict:
    """The generic webhook's JSON: the keys it has always had, then the alert's own."""
    return {"source": "pcd-ops", "severity": a.severity, "subject": a.title, "body": text(a),
            "findings": [], "alert_source": a.source, "key": a.key,
            "fields": [{"label": k, "value": v} for k, v in a.fields], "link": link_url(a.link)}


def slack_payload(a: Alert) -> dict:
    """Block Kit, in a colored attachment so the severity shows at a glance."""
    head = f"*{_esc(a.title)}*" + (f"\n{_esc(a.body)}" if a.body else "")
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": head}}]
    if a.fields:
        blocks.append({"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*{_esc(k)}*\n{_esc(v)}"} for k, v in a.fields[:10]]})
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text":
                   f"PCD Ops · {a.source} · {a.severity}"}]})
    if url := link_url(a.link):
        blocks.append({"type": "actions", "elements": [{"type": "button", "url": url,
                       "text": {"type": "plain_text", "text": "View in PCD Ops"}}]})
    return {"text": f"[{a.severity}] {a.title}",
            "attachments": [{"color": SLACK_COLOR.get(a.severity, "#6b7280"), "blocks": blocks}]}


def _esc(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def _send(a: Alert, channels: list[str]) -> dict[str, str | None]:
    """{channel: None if sent, else why not}."""
    out: dict[str, str | None] = {}
    for ch in channels:
        if ch == "email":
            out[ch] = await notifications.deliver_email(f"[{a.severity}] {a.title}", text(a))
        elif ch == "webhook":
            out[ch] = await notifications.deliver_webhook(webhook_payload(a))
        elif ch == "slack":
            out[ch] = await notifications.deliver_slack(slack_payload(a))
    return out


def _suppressed(a: Alert) -> bool:
    """Sent with this key within the cooldown, at the same severity or higher."""
    last = db.alert_last(a.key)
    if not last:
        return False
    since = datetime.utcnow() - timedelta(minutes=settings.alert_cooldown_min)
    return last["at"] >= since.isoformat() and rank(last["severity"]) >= rank(a.severity)


async def raise_alert(a: Alert) -> dict | None:
    """Send `a` if its source's rule allows it and it isn't a repeat; record what happened.
    Returns the record, or None when the rule filtered it out."""
    on, minimum = rule(a.source)
    if not on or rank(a.severity) < rank(minimum):
        return None
    suppressed = _suppressed(a)
    results = {} if suppressed else await _send(a, configured())
    rec = db.alert_record(a.source, a.key, a.severity, a.title, text(a),
                          json.dumps(results), suppressed)
    if not suppressed:
        failed = [c for c, r in results.items() if r]
        db.event_log("alert", f"Alert ({a.severity}): {a.title}",
                      level="error" if failed else ("warning" if rank(a.severity) >= 2 else "info"),
                      detail=(f"Not sent to {', '.join(failed)}. " if failed else "")
                      + (f"Sent to {', '.join(c for c in results if not results[c])}."
                         if any(r is None for r in results.values()) else "No channel is set up."),
                      component="Alerts")
    return rec


async def test(channel: str | None = None) -> dict[str, str | None]:
    """Send a test alert to one channel, or every channel, whatever the rules say."""
    a = Alert("test", "test", "low", "Test alert from PCD Ops",
              "If you can read this, alerts reach this channel.",
              fields=[["Sent", datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")]],
              link="/settings?tab=alerts")
    results = await _send(a, [channel] if channel else list(CHANNELS))
    db.alert_record("test", "test", "low", a.title, text(a), json.dumps(results), False)
    return results

