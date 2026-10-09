from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from .cloud_auth import get_current_parent
from ..database import get_db
import json

LEARNING_APP_NAME = "学习伙伴"


def _reward_days(reward_code) -> int:
    """reward_code 解析 vip_days 天数；其他类型返回 0"""
    try:
        r = json.loads(reward_code) if isinstance(reward_code, str) else (reward_code or {})
    except Exception:
        return 0
    if not isinstance(r, dict) or r.get("type") != "vip_days":
        return 0
    try:
        return max(0, int(r.get("days") or 0))
    except (TypeError, ValueError):
        return 0

router = APIRouter(prefix="/api/license", tags=["license"])


async def sync_benefit_entitlements(parent_id: str, db) -> None:
    """每次查询有效期时同步 benefit-auth 任务权益：新完成的任务 → 自动延长订阅有效期。

    幂等：applied_entitlements 记录已落账的权益 id，不重复延长。
    benefit-auth 不可达/未配置时静默跳过（license 照常返回，不因中台故障阻断鉴权）。
    """
    rows = await db.execute_fetchall("SELECT benefit_user_id FROM compat_parents WHERE id = ?", (parent_id,))
    benefit_user_id = rows[0]["benefit_user_id"] if rows else None
    if not benefit_user_id:
        return
    # 合并后直接查本库权益（学习伙伴应用下，active 状态）
    try:
        entitlements = await db.execute_fetchall(
            """SELECT e.id, e.status, e.reward_code FROM entitlements e
               JOIN tasks t ON t.id = e.task_id
               JOIN apps a ON a.app_id = t.app_id
               WHERE e.user_id = ? AND a.name = ?""",
            (benefit_user_id, LEARNING_APP_NAME),
        )
    except Exception:
        return

    for ent in entitlements:
        ent_id = ent["id"] or ""
        days = _reward_days(ent["reward_code"])
        if not ent_id or ent["status"] != "active" or days <= 0:
            continue
        subs = await db.execute_fetchall(
            "SELECT id, expires_at FROM compat_subscriptions WHERE parent_id = ? AND status = 'active' ORDER BY expires_at DESC",
            (parent_id,),
        )
        now = datetime.now(timezone.utc)
        if subs:
            try:
                current = datetime.fromisoformat(subs[0]["expires_at"])
            except (TypeError, ValueError):
                current = now
            # 完成当天往后算 7 天（anchor = 完成时刻 + days）；已有更长有效期不缩短。
            # 每日任务 + 7 天覆盖 => 用户需保持每周至少完成一次，权益才不断档。
            anchor = now + timedelta(days=days)
            new_exp = max(current, anchor).isoformat()
            await db.execute(
                "UPDATE compat_subscriptions SET expires_at = ? WHERE id = ?", (new_exp, subs[0]["id"])
            )
        else:
            await db.execute(
                """INSERT INTO compat_subscriptions (id, parent_id, plan, max_children, features, starts_at, expires_at, status)
                   VALUES (?, ?, 'douyin', 4, '["learning"]', ?, ?, 'active')""",
                (parent_id + "-ent", parent_id, now.isoformat(), (now + timedelta(days=days)).isoformat()),
            )
    await db.commit()


@router.get("")
async def get_license(parent_id: str = Depends(get_current_parent), db=Depends(get_db)):
    await sync_benefit_entitlements(parent_id, db)
    rows = await db.execute_fetchall(
        "SELECT * FROM compat_subscriptions WHERE parent_id = ? AND status = 'active'",
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
    await sync_benefit_entitlements(parent_id, db)
    rows = await db.execute_fetchall(
        "SELECT * FROM compat_subscriptions WHERE parent_id = ? AND status = 'active'",
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
