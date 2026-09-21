"""权益认证中台 - 账号注册/登录（邮箱 + 口令）

与平台扫码登录并列的登录方式：注册即创建 users 行（email 唯一），签发与扫码登录同一套 user JWT。
路径用 /api/account/*：nginx 把 /api/auth/* 分流到 learning-cloud :8000（Electron 账号体系），不可占用。
"""
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database import get_db, new_id
from ..security import create_user_token, hash_password, verify_password

router = APIRouter(prefix="/api/account", tags=["account"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MIN_PWD_LEN = 8


class RegisterRequest(BaseModel):
    email: str
    password: str
    nickname: str = ""


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/register")
async def register(req: RegisterRequest, db=Depends(get_db)):
    email = req.email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if len(req.password) < _MIN_PWD_LEN:
        raise HTTPException(status_code=400, detail=f"密码至少 {_MIN_PWD_LEN} 位")
    if len(req.password) > 128:
        raise HTTPException(status_code=400, detail="密码过长")

    exists = await db.execute_fetchall("SELECT 1 FROM users WHERE email=?", (email,))
    if exists:
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")

    user_id = new_id()
    nickname = req.nickname.strip() or email.split("@")[0]
    try:
        await db.execute(
            "INSERT INTO users (id, email, password_hash, nickname) VALUES (?,?,?,?)",
            (user_id, email, hash_password(req.password), nickname),
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")
    return {"token": create_user_token(user_id), "user_id": user_id, "nickname": nickname}


@router.post("/login")
async def login(req: LoginRequest, db=Depends(get_db)):
    email = req.email.strip().lower()
    rows = await db.execute_fetchall(
        "SELECT id, nickname, password_hash FROM users WHERE email=?", (email,))
    if (
        not rows
        or not rows[0]["password_hash"]
        or not verify_password(req.password, rows[0]["password_hash"])
    ):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    user_id = rows[0]["id"]
    return {"token": create_user_token(user_id), "user_id": user_id, "nickname": rows[0]["nickname"]}
