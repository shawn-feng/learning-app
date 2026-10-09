"""云端兼容端点——learning-server 认证代理的上游（2026-10-08 认证切换）。

learning-server 原以 cloud-service（www）为认证上游；切换到本服务后调用以下
/api/account/* 端点（nginx 把 /api/auth/* 分流到 cloud :8000，故沿用 /api/account 前缀）：

- POST /api/account/login            （account.py 既有）{token, user_id, nickname}
- POST /api/account/register         （account.py 既有）
- GET  /api/account/license          本文件：LicenseData（parent_id/email/plan/max_children/
                                     features/starts_at/expires_at/status/is_expired）
- POST /api/account/douyin-login     本文件：benefit token → {token, parent_id, email, is_new}
- GET  /api/account/parent-status    本文件：{has_password, email}
- POST /api/account/set-password     本文件：设置密码

身份连续性：201 生产数据全部挂在旧 cloud parent_id 下（如 test@qq.com=86a84278…）。
legacy_parents 表维护 email/benefit_user_id → 旧 parent_id 映射（种子来自 cloud parents 表），
login/register/douyin-login 返回的 parent_id 一律走映射，未命中回退 benefit user_id。

License 计算：special_permanent_users 标记 → 2099 永久；否则按 vip_days 权益
「完成当天(+08:00) + N 天、不叠加取 max」；无权益即已过期。
"""
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..database import get_db
from ..deps import get_current_user
from ..security import create_user_token, decode_token, hash_password, verify_password

router = APIRouter(prefix="/api/account", tags=["legacy-cloud"])
TZ = ZoneInfo("Asia/Shanghai")
PERMANENT_EXPIRES = "2099-12-31T00:00:00+00:00"


async def _user_by_id(db, user_id: str) -> dict | None:
    rows = await db.execute_fetchall("SELECT * FROM users WHERE id=?", (user_id,))
    return dict(rows[0]) if rows else None


async def _legacy_parent_id(db, user: dict) -> str:
    """email / benefit_user_id → 旧 cloud parent_id；未命中回退 benefit user_id。"""
    email = (user.get("email") or "").strip().lower()
    if email:
        rows = await db.execute_fetchall(
            "SELECT parent_id FROM legacy_parents WHERE email=?", (email,))
        if rows:
            return rows[0]["parent_id"]
    rows = await db.execute_fetchall(
        "SELECT parent_id FROM legacy_parents WHERE benefit_user_id=?", (user["id"],))
    if rows:
        return rows[0]["parent_id"]
    return user["id"]


async def _is_special(db, user_id: str) -> bool:
    rows = await db.execute_fetchall(
        "SELECT value FROM settings WHERE key='special_permanent_users'")
    return bool(rows) and user_id in (rows[0]["value"] or "")


async def _compute_expiry(db, user_id: str) -> tuple[str, bool]:
    """返回 (expires_at_iso, is_expired)。special → 2099；否则 vip_days 权益取 max。"""
    if await _is_special(db, user_id):
        return PERMANENT_EXPIRES, False
    now = datetime.now(timezone.utc)
    expiry = None
    rows = await db.execute_fetchall(
        "SELECT reward_code, granted_at FROM entitlements WHERE user_id=? AND status != 'revoked'",
        (user_id,))
    for r in rows:
        # 历史数据存在双重编码（json.dumps 了未解析的 config 字符串），逐层解到 dict 为止
        reward = r["reward_code"]
        for _ in range(2):
            if not isinstance(reward, str):
                break
            try:
                reward = json.loads(reward or "{}")
            except Exception:
                reward = None
                break
        if not isinstance(reward, dict) or reward.get("type") != "vip_days":
            continue
        days = int(reward.get("days") or 0)
        if days <= 0 or not r["granted_at"]:
            continue
        try:
            granted = datetime.fromisoformat(str(r["granted_at"]).replace("Z", "+00:00"))
        except Exception:
            continue
        day = granted.astimezone(TZ).date() + timedelta(days=days)
        exp = datetime(day.year, day.month, day.day, 23, 59, 59, tzinfo=TZ)
        if expiry is None or exp > expiry:
            expiry = exp
    if expiry is None:
        return now.isoformat(), True
    return expiry.astimezone(timezone.utc).isoformat(), expiry <= now


@router.get("/license")
async def license(user_id: str = Depends(get_current_user), db=Depends(get_db)):
    """LicenseData（cloud /api/license 兼容形状）"""
    user = await _user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    expires_at, is_expired = await _compute_expiry(db, user_id)
    return JSONResponse({
        "parent_id": await _legacy_parent_id(db, user),
        "email": user.get("email") or "",
        "plan": "basic",
        "max_children": 4,
        "features": ["learning"],
        "starts_at": user.get("created_at") or "",
        "expires_at": expires_at,
        "status": "active",
        "is_expired": is_expired,
    })


class DouyinLoginRequest(BaseModel):
    access_token: str


@router.post("/douyin-login")
async def douyin_login(req: DouyinLoginRequest, db=Depends(get_db)):
    """benefit user token → 找用户 → 签新 token（cloud /api/auth/douyin-login 兼容形状）"""
    payload = decode_token(req.access_token or "")
    if not payload or payload.get("typ") != "user":
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = await _user_by_id(db, payload["sub"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "token": create_user_token(user["id"]),
        "parent_id": await _legacy_parent_id(db, user),
        "email": user.get("email") or "",
        "is_new": False,
    }


class DouyinCodeLoginRequest(BaseModel):
    code: str
    redirect_uri: str


@router.post("/douyin-code-login")
async def douyin_code_login(req: DouyinCodeLoginRequest, db=Depends(get_db)):
    """第一方免 secret 换码登录：IdP 授权码 → 用户身份（cloud douyin-login 兼容形状 + benefit_user_id）。

    learning-server 装在用户机器上不能存 client_secret，故授权码由本服务直接消费
    （码只投递到发起方 redirect_uri，持码即来源证明）。secret 只存本服务端。
    """
    from .oauth import consume_idp_code

    user_id = consume_idp_code(req.code, req.redirect_uri)
    if not user_id:
        raise HTTPException(status_code=401, detail="invalid or expired authorization code")
    user = await _user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "token": create_user_token(user["id"]),
        "parent_id": await _legacy_parent_id(db, user),
        "email": user.get("email") or "",
        "benefit_user_id": user["id"],
        "is_new": False,
    }


class DouyinCodeResetRequest(BaseModel):
    code: str
    redirect_uri: str
    new_password: str


@router.post("/douyin-reset-password")
async def douyin_reset_password(req: DouyinCodeResetRequest, db=Depends(get_db)):
    """第一方免 secret 换码重置密码：IdP 授权码确认身份 → 直接改密（无需旧密码）。"""
    from .oauth import consume_idp_code

    if not (8 <= len(req.new_password) <= 128):
        raise HTTPException(status_code=400, detail="密码需为 8-128 位")
    user_id = consume_idp_code(req.code, req.redirect_uri)
    if not user_id:
        raise HTTPException(status_code=401, detail="invalid or expired authorization code")
    user = await _user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await db.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (hash_password(req.new_password), user_id))
    await db.commit()
    return {"success": True}


@router.get("/parent-status")
async def parent_status(user_id: str = Depends(get_current_user), db=Depends(get_db)):
    user = await _user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"has_password": bool(user.get("password_hash")), "email": user.get("email") or ""}


class SetPasswordRequest(BaseModel):
    new_password: str


@router.post("/set-password")
async def set_password(req: SetPasswordRequest, user_id: str = Depends(get_current_user),
                       db=Depends(get_db)):
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    user = await _user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("password_hash") and verify_password(req.new_password, user["password_hash"]):
        return {"ok": True, "note": "与新密码相同"}
    await db.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (hash_password(req.new_password), user_id))
    await db.commit()
    return {"ok": True}
