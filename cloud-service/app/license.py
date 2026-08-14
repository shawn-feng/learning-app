from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from .auth import get_current_parent
from .database import get_db

router = APIRouter(prefix="/api/license", tags=["license"])


@router.get("")
async def get_license(parent_id: str = Depends(get_current_parent), db=Depends(get_db)):
    rows = await db.execute_fetchall(
        "SELECT * FROM subscriptions WHERE parent_id = ? AND status = 'active'",
        (parent_id,),
    )
    if not rows:
        raise HTTPException(status_code=403, detail="No active subscription")

    sub = rows[0]
    now = datetime.now(timezone.utc)
    expires = datetime.fromisoformat(sub["expires_at"])

    return {
        "parent_id": parent_id,
        "plan": sub["plan"],
        "max_children": sub["max_children"],
        "features": sub["features"],
        "starts_at": sub["starts_at"],
        "expires_at": sub["expires_at"],
        "status": sub["status"],
        "is_expired": now > expires,
    }


@router.post("/verify")
async def verify_license(parent_id: str = Depends(get_current_parent), db=Depends(get_db)):
    rows = await db.execute_fetchall(
        "SELECT * FROM subscriptions WHERE parent_id = ? AND status = 'active'",
        (parent_id,),
    )
    if not rows:
        raise HTTPException(status_code=403, detail="No active subscription")

    sub = rows[0]
    now = datetime.now(timezone.utc)
    expires = datetime.fromisoformat(sub["expires_at"])

    if now > expires:
        return {"valid": False, "reason": "expired"}

    return {
        "valid": True,
        "plan": sub["plan"],
        "max_children": sub["max_children"],
        "features": sub["features"],
        "expires_at": sub["expires_at"],
    }
