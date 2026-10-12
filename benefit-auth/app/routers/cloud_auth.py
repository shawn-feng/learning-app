"""旧 cloud 家长 JWT 的鉴权依赖（兼容保留）。

2026-10-10 登录安全裁剪（ISSUE-174 安全轮）：
- 本模块原有 /api/auth/* 账密路由（register/login/me/douyin-login/parent-status/set-password）
  已全部下线——用户统一走抖音扫码登录（legacy.py /api/account/douyin-code-login），
  账密登录通道是撞库主目标，无产品场景。旧路径由 deprecated.py 返回 410 Gone。
- 仅保留 `get_current_parent`：/api/sync（sync.py，LAN server 消息交换）仍在用。
"""
import os

import jwt
from fastapi import HTTPException, Request

JWT_SECRET = os.environ.get("JWT_SECRET", "learning-app-dev-secret-key-change-in-production-32bytes")
JWT_ALGORITHM = "HS256"


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
