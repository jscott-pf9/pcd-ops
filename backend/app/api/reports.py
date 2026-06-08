from fastapi import APIRouter, HTTPException

from app.services import db

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/{report_id}")
async def get_report(report_id: str):
    """Get a capacity report by ID including per-tenant data and AI analysis."""
    data = db.report_get(report_id)
    if data is None:
        raise HTTPException(404, detail="Report not found")
    return data


@router.delete("/{report_id}", status_code=204)
async def delete_report(report_id: str):
    """Delete a capacity report."""
    db.delete_report(report_id)


@router.delete("/purge", status_code=200)
async def purge_reports(older_than_days: int = 30):
    """Delete capacity reports older than N days."""
    count = db.purge_reports(older_than_days)
    return {"deleted": count, "older_than_days": older_than_days}
