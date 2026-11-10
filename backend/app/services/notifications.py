"""
Notification delivery — email (SMTP), generic webhook and Slack.
Each `deliver_*` returns None when sent, else why not ("not configured" or the error); none
raises. services/alerts.py decides what to send and where.
"""

import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

NOT_CONFIGURED = "not configured"


def _smtp_send(to: str, subject: str, body_text: str, body_html: str | None) -> None:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[PCD Ops] {subject}"
    msg["From"]    = settings.smtp_from or settings.smtp_user
    msg["To"]      = to
    msg.attach(MIMEText(body_text, "plain"))
    if body_html:
        msg.attach(MIMEText(body_html, "html"))
    with smtplib.SMTP(settings.smtp_host, int(settings.smtp_port or 587), timeout=20) as server:
        server.ehlo()
        if settings.smtp_port != "25":
            server.starttls()
        if settings.smtp_user and settings.smtp_password:
            server.login(settings.smtp_user, settings.smtp_password)
        server.sendmail(msg["From"], [a.strip() for a in to.split(",") if a.strip()],
                        msg.as_string())


async def deliver_email(subject: str, body_text: str, body_html: str | None = None,
                        to: str | None = None) -> str | None:
    """Send to `to` (comma-separated addresses), or to the alert recipients from Settings."""
    to = to or settings.alert_email_to
    if not to or not settings.smtp_host:
        return NOT_CONFIGURED
    try:
        await asyncio.to_thread(_smtp_send, to, subject, body_text, body_html)
        logger.info("Email sent to %s: %s", to, subject)
        return None
    except Exception as e:
        logger.warning("Email delivery failed: %s", e)
        return str(e) or type(e).__name__


async def _post(url: str, payload: dict, what: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("%s delivery failed: %s", what, e)
        return f"HTTP {e.response.status_code}: {e.response.text[:200]}"
    except Exception as e:
        logger.warning("%s delivery failed: %s", what, e)
        return str(e) or type(e).__name__


async def deliver_webhook(payload: dict) -> str | None:
    if not settings.webhook_url:
        return NOT_CONFIGURED
    return await _post(settings.webhook_url, payload, "Webhook")


async def deliver_slack(payload: dict) -> str | None:
    """POST a Slack message (Block Kit) to the incoming webhook from Settings."""
    if not settings.slack_webhook_url:
        return NOT_CONFIGURED
    return await _post(settings.slack_webhook_url, payload, "Slack")


async def send_email(subject: str, body_text: str, body_html: str | None = None,
                     to: str | None = None) -> bool:
    """True if sent (the capacity report job uses this directly)."""
    return await deliver_email(subject, body_text, body_html, to) is None
