import os
import uuid
import bcrypt
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from .database import get_db

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
        "SELECT id FROM parents WHERE email = ?", (req.email,)
    )
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    parent_id = str(uuid.uuid4())
    password_hash = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()

    await db.execute(
        "INSERT INTO parents (id, email, password_hash) VALUES (?, ?, ?)",
        (parent_id, req.email, password_hash),
    )

    now = datetime.now(timezone.utc)
    await db.execute(
        """INSERT INTO subscriptions (id, parent_id, plan, max_children, features, starts_at, expires_at, status)
           VALUES (?, ?, 'basic', 4, '["learning"]', ?, ?, 'active')""",
        (str(uuid.uuid4()), parent_id, now.isoformat(), (now + timedelta(days=30)).isoformat()),
    )
    await db.commit()

    token = create_token(parent_id)
    return {"token": token, "parent_id": parent_id}


@router.post("/login")
async def login(req: LoginRequest, db=Depends(get_db)):
    rows = await db.execute_fetchall(
        "SELECT id, password_hash FROM parents WHERE email = ?", (req.email,)
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
        "SELECT id, email, created_at FROM parents WHERE id = ?", (parent_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Parent not found")
    return {"parent_id": rows[0]["id"], "email": rows[0]["email"], "created_at": rows[0]["created_at"]}
