"""权益认证中台 - 公共依赖（当前用户 / 当前 App 认证）"""
from fastapi import Depends, Header, HTTPException

from .security import decode_token


def get_bearer_token(authorization: str = Header(default="")) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return authorization[7:]


def get_current_user(token: str = Depends(get_bearer_token)) -> str:
    """返回 user_id"""
    payload = decode_token(token)
    if not payload or payload.get("typ") != "user":
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload["sub"]


def get_current_app(token: str = Depends(get_bearer_token)) -> str:
    """返回 app_id"""
    payload = decode_token(token)
    if not payload or payload.get("typ") != "app":
        raise HTTPException(status_code=401, detail="Invalid app token")
    return payload["sub"]
