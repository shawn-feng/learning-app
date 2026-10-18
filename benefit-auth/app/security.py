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
# ISSUE-188（2026-10-18）：learning-server 的 cloud_token 是**设备级、只存服务端**的凭证，
# 用它向 /api/account/license 校验家长权益。原来沿用 72h 用户 token → app 连续用 3 天就必须
# 重新扫码；而「VIP 到期后完成任务即恢复、无需重扫」也依赖它能长期可用。
# 因此单独发长效 token（默认 365 天，env 可调）；网页会话 Cookie / me 页仍用 72h 用户 token。
DEVICE_TOKEN_TTL_DAYS = int(os.environ.get("DEVICE_TOKEN_TTL_DAYS", "365"))


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


PBKDF2_ITERATIONS = 120_000


def hash_password(raw: str) -> str:
    """用户登录口令哈希：PBKDF2-HMAC-SHA256，存储格式 pbkdf2_sha256$iter$salt$hash"""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", raw.encode(), salt.encode(), PBKDF2_ITERATIONS).hex()
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest}"


def verify_password(raw: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", raw.encode(), salt.encode(), int(iters)).hex()
        return secrets.compare_digest(calc, digest)
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


def create_user_token(user_id: str, ttl_hours: int | None = None) -> str:
    payload = {
        "sub": user_id,
        "typ": "user",
        "exp": datetime.now(timezone.utc)
        + timedelta(hours=ttl_hours if ttl_hours is not None else USER_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_device_token(user_id: str) -> str:
    """设备级长效 token（learning-server 专用，只存服务端；免频繁扫码）。"""
    return create_user_token(user_id, ttl_hours=DEVICE_TOKEN_TTL_DAYS * 24)


ADMIN_TOKEN_TTL_HOURS = 8


def create_admin_token(username: str) -> str:
    """管理后台会话 token（两步登录通过后签发，Cookie 携带）"""
    payload = {
        "sub": username,
        "typ": "admin",
        "exp": datetime.now(timezone.utc) + timedelta(hours=ADMIN_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
