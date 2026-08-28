"""权益认证中台 - 安全工具（JWT / 哈希 / 随机凭证）"""
import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt

# 生产环境通过环境变量注入强随机密钥
JWT_SECRET = os.environ.get("BENEFIT_JWT_SECRET", "benefit-auth-dev-secret-change-me")
JWT_ALGORITHM = "HS256"
APP_TOKEN_TTL_HOURS = 24
USER_TOKEN_TTL_HOURS = 72


def hash_secret(raw: str) -> str:
    """app_secret 存储哈希（带盐），不回传明文"""
    salt = secrets.token_hex(8)
    return f"{salt}${hashlib.sha256((salt + raw).encode()).hexdigest()}"


def verify_secret(raw: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$", 1)
        return hashlib.sha256((salt + raw).encode()).hexdigest() == digest
    except Exception:
        return False


def gen_app_credentials() -> tuple[str, str]:
    """生成 app_id / app_secret"""
    app_id = "app_" + secrets.token_hex(8)
    app_secret = secrets.token_urlsafe(24)
    return app_id, app_secret


def create_app_token(app_id: str) -> str:
    payload = {
        "sub": app_id,
        "typ": "app",
        "exp": datetime.now(timezone.utc) + timedelta(hours=APP_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_user_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "typ": "user",
        "exp": datetime.now(timezone.utc) + timedelta(hours=USER_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
