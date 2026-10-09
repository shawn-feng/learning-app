import os
import uuid
import secrets
import bcrypt
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from ..database import get_db
from ..security import decode_token

router = APIRouter(prefix="/api/auth", tags=["auth"])
JWT_SECRET = os.environ.get("JWT_SECRET", "learning-app-dev-secret-key-change-in-production-32bytes")
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_HOURS = 72


class RegisterRequest(BaseModel):
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class DouyinLoginRequest(BaseModel):
    access_token: str  # benefit-auth user token（客户端经 OAuth code 换取，见 LAN server /api/v1/auth/douyin）


class SetPasswordRequest(BaseModel):
    new_password: str


def create_token(parent_id: str) -> str:
    payload = {
        "sub": parent_id,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRES_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


async def get_current_parent(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth[7:]
    parent_id = verify_token(token)
    if not parent_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return parent_id


@router.post("/register")
async def register(req: RegisterRequest, db=Depends(get_db)):
    existing = await db.execute_fetchall(
        "SELECT id FROM compat_parents WHERE email = ?", (req.email,)
    )
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    parent_id = str(uuid.uuid4())
    password_hash = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()

    await db.execute(
        "INSERT INTO compat_parents (id, email, password_hash) VALUES (?, ?, ?)",
        (parent_id, req.email, password_hash),
    )

    now = datetime.now(timezone.utc)
    await db.execute(
        """INSERT INTO compat_subscriptions (id, parent_id, plan, max_children, features, starts_at, expires_at, status)
           VALUES (?, ?, 'basic', 4, '["learning"]', ?, ?, 'active')""",
        (str(uuid.uuid4()), parent_id, now.isoformat(), (now + timedelta(days=30)).isoformat()),
    )
    await db.commit()

    token = create_token(parent_id)
    return {"token": token, "parent_id": parent_id}


@router.post("/login")
async def login(req: LoginRequest, db=Depends(get_db)):
    rows = await db.execute_fetchall(
        "SELECT id, password_hash FROM compat_parents WHERE email = ?", (req.email,)
    )
    if not rows:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    row = rows[0]
    if not bcrypt.checkpw(req.password.encode(), row["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_token(row["id"])
    return {"token": token, "parent_id": row["id"]}


@router.get("/me")
async def get_me(parent_id: str = Depends(get_current_parent), db=Depends(get_db)):
    """返回当前登录家长的信息（网页个人页使用）"""
    rows = await db.execute_fetchall(
        "SELECT id, email, created_at FROM compat_parents WHERE id = ?", (parent_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Parent not found")
    return {"parent_id": rows[0]["id"], "email": rows[0]["email"], "created_at": rows[0]["created_at"]}


@router.post("/douyin-login")
async def douyin_login(req: DouyinLoginRequest, db=Depends(get_db)):
    """抖音扫码登录家长账号（benefit-auth IdP 接入）。

    客户端（经 LAN server）用 OAuth code 从 benefit-auth 换得 user access_token 后调本接口：
    核验身份 → 按 benefit_user_id 找/建家长 → 签发本服务 session token。
    抖音新建的家长初始订阅即时过期（待解锁）：完成中台任务获得权益后，
    /api/license 查询时会自动延长有效期（见 license.sync_benefit_entitlements）。
    """
    # 合并后本进程直接核验 benefit user token（BENEFIT_JWT_SECRET）
    payload = decode_token(req.access_token)
    if not payload or payload.get("typ") != "user":
        raise HTTPException(status_code=401, detail="抖音登录凭证无效或已过期，请重新扫码")
    benefit_user_id = payload["sub"]
    urows = await db.execute_fetchall("SELECT email, nickname FROM users WHERE id = ?", (benefit_user_id,))
    info_email = (urows[0]["email"] if urows else "") or ""

    rows = await db.execute_fetchall(
        "SELECT id, email FROM compat_parents WHERE benefit_user_id = ?", (benefit_user_id,)
    )
    is_new = not rows
    if rows:
        parent_id, email = rows[0]["id"], rows[0]["email"]
    else:
        parent_id = str(uuid.uuid4())
        # 邮箱仅作账号标识：优先用中台注册邮箱，否则用抖音占位邮箱（保证唯一）
        email = info_email.strip().lower() or f"douyin_{benefit_user_id[:12]}@douyin.local"
        suffix = 0
        while await db.execute_fetchall("SELECT 1 FROM compat_parents WHERE email = ?", (email,)):
            suffix += 1
            email = f"douyin_{benefit_user_id[:12]}_{suffix}@douyin.local"
        password_hash = bcrypt.hashpw(secrets.token_hex(24).encode(), bcrypt.gensalt()).decode()
        now = datetime.now(timezone.utc)
        await db.execute(
            "INSERT INTO compat_parents (id, email, password_hash, benefit_user_id, password_set) VALUES (?, ?, ?, ?, 0)",
            (parent_id, email, password_hash, benefit_user_id),
        )
        # 初始订阅即时过期（抖音家长走「完成任务→加权益」解锁；邮箱注册的 30 天体验不受影响）
        await db.execute(
            """INSERT INTO compat_subscriptions (id, parent_id, plan, max_children, features, starts_at, expires_at, status)
               VALUES (?, ?, 'douyin', 4, '["learning"]', ?, ?, 'active')""",
            (str(uuid.uuid4()), parent_id, now.isoformat(), now.isoformat()),
        )
        await db.commit()

    token = create_token(parent_id)
    return {"token": token, "parent_id": parent_id, "email": email, "is_new": is_new}


@router.get("/parent-status")
async def parent_status(parent_id: str = Depends(get_current_parent), db=Depends(get_db)):
    """家长账号状态（LAN server 代理用）：是否已设置密码（抖音家长首次为否）"""
    rows = await db.execute_fetchall(
        "SELECT id, email, password_set FROM compat_parents WHERE id = ?", (parent_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Parent not found")
    return {
        "parent_id": rows[0]["id"],
        "email": rows[0]["email"],
        "has_password": bool(rows[0]["password_set"]),
    }


@router.post("/set-password")
async def set_password(req: SetPasswordRequest, parent_id: str = Depends(get_current_parent), db=Depends(get_db)):
    """设置/修改家长密码（抖音家长首次进家长中心时调用；凭证为本服务 cloud token）"""
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="密码至少 8 位")
    if len(req.new_password) > 128:
        raise HTTPException(status_code=400, detail="密码过长")
    password_hash = bcrypt.hashpw(req.new_password.encode(), bcrypt.gensalt()).decode()
    await db.execute(
        "UPDATE compat_parents SET password_hash = ?, password_set = 1 WHERE id = ?",
        (password_hash, parent_id),
    )
    await db.commit()
    return {"success": True}
