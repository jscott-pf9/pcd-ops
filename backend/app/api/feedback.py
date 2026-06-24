import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

router = APIRouter(prefix="/feedback", tags=["feedback"])

GITHUB_API = "https://api.github.com"


class FeedbackRequest(BaseModel):
    type: str        # "bug" or "feature"
    title: str
    description: str
    name: str
    email: str


@router.post("")
async def submit_feedback(body: FeedbackRequest):
    if not settings.github_token or not settings.github_repo:
        raise HTTPException(
            status_code=503,
            detail="GitHub feedback not configured — set GITHUB_TOKEN and GITHUB_REPO",
        )

    label = "bug" if body.type == "bug" else "enhancement"
    type_label = "Bug Report" if body.type == "bug" else "Feature Request"

    issue_body = (
        f"**Type:** {type_label}\n"
        f"**Submitted by:** {body.name} ({body.email})\n\n"
        f"---\n\n"
        f"{body.description}"
    )

    payload = {
        "title": body.title,
        "body": issue_body,
        "labels": [label],
    }

    url = f"{GITHUB_API}/repos/{settings.github_repo}/issues"
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)

    if resp.status_code not in (200, 201):
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error {resp.status_code}: {resp.text[:300]}",
        )

    data = resp.json()
    return {"url": data["html_url"], "number": data["number"]}


@router.get("/configured")
async def feedback_configured():
    """Returns whether GitHub feedback is configured so the frontend can show/hide the form."""
    return {"configured": bool(settings.github_token and settings.github_repo)}
