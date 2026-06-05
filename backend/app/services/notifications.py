"""
Notification delivery — email (SMTP) and webhook.
Both are best-effort; failures are logged but not raised.
"""

import json
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


async def send_email(subject: str, body_text: str, body_html: str | None = None) -> bool:
    to = settings.alert_email_to
    if not to or not settings.smtp_host:
        logger.debug("Email not configured — skipping alert email.")
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"[PCD Ops] {subject}"
        msg["From"]    = settings.smtp_from or settings.smtp_user
        msg["To"]      = to
        msg.attach(MIMEText(body_text, "plain"))
        if body_html:
            msg.attach(MIMEText(body_html, "html"))

        with smtplib.SMTP(settings.smtp_host, int(settings.smtp_port or 587)) as server:
            server.ehlo()
            if settings.smtp_port != "25":
                server.starttls()
            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)
            server.sendmail(msg["From"], [to], msg.as_string())
        logger.info("Alert email sent to %s: %s", to, subject)
        return True
    except Exception as e:
        logger.warning("Email delivery failed: %s", e)
        return False


async def send_webhook(payload: dict) -> bool:
    url = settings.webhook_url
    if not url:
        logger.debug("Webhook not configured — skipping.")
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
        logger.info("Webhook delivered to %s", url)
        return True
    except Exception as e:
        logger.warning("Webhook delivery failed: %s", e)
        return False


async def send_alert(subject: str, body: str, severity: str = "high", findings: list | None = None) -> None:
    """Send alert via all configured channels."""
    payload = {
        "source": "pcd-ops",
        "severity": severity,
        "subject": subject,
        "body": body,
        "findings": findings or [],
    }
    await send_email(subject, body)
    await send_webhook(payload)
