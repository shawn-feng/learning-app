"""权益认证中台 - 抖音 OAuth 扫码登录

流程（二维码登录）：
1. GET /api/oauth/douyin/qrcode → 生成登录二维码（内容为授权 URL，带 state）
2. PC 前端展示二维码并轮询 /api/oauth/douyin/status?qr_code=xxx
3. 用户用抖音 App 扫码 → 授权 → 回调 /api/oauth/douyin/callback?code=XXX&state=xxx
4. 服务端换 access_token + open_id → 绑定/创建用户 → 签发中台 JWT
   → 存入 state（PC 轮询拿到）并 302 到 /me
"""
import base64
import io
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
import qrcode
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse

from ..database import get_db, new_id
from ..security import create_user_token

router = APIRouter(prefix="/api/oauth/douyin", tags=["oauth-douyin"])

# 抖音开放平台凭证（.env 注入）
CLIENT_KEY = os.environ.get("DOUYIN_CLIENT_KEY", "")
CLIENT_SECRET = os.environ.get("DOUYIN_CLIENT_SECRET", "")
CALLBACK_BASE = os.environ.get("PUBLIC_BASE_URL", "http://localhost:9001")
DOUYIN_API = os.environ.get("DOUYIN_API_BASE", "https://open.douyin.com")

# 授权码状态存储（内存，够用；生产可换 Redis）
# state -> {"t": 创建时间, "token": 登录后写入的中台 JWT（供 PC 轮询获取）}
_state_store: dict[str, dict] = {}


def _is_configured() -> bool:
    return bool(CLIENT_KEY and CLIENT_SECRET)


def _state_cleanup():
    """清理过期 state（10 分钟内有效）"""
    now = time.time()
    expired = [k for k, v in _state_store.items() if now - v["t"] > 600]
    for k in expired:
        _state_store.pop(k, None)


def _build_authorize_url(state: str) -> str:
    redirect_uri = f"{CALLBACK_BASE}/api/oauth/douyin/callback"
    return (
        f"https://open.douyin.com/platform/oauth/connect?"
        f"client_key={CLIENT_KEY}"
        f"&response_type=code"
        f"&scope=user_info"
        f"&state={state}"
        f"&redirect_uri={quote(redirect_uri)}"
    )


def _make_qr_data_url(content: str) -> str:
    """把内容生成二维码 PNG，返回 base64 data URL"""
    qr = qrcode.QRCode(box_size=8, border=2)
    qr.add_data(content)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{b64}"


@router.get("/qrcode")
async def douyin_qrcode():
    """生成抖音扫码登录二维码（PC 展示，手机扫码）"""
    if not _is_configured():
        raise HTTPException(
            status_code=503,
            detail="抖音登录暂未开放，服务端未配置 DOUYIN_CLIENT_KEY / DOUYIN_CLIENT_SECRET",
        )
    _state_cleanup()
    state = secrets.token_urlsafe(16)
    _state_store[state] = {"t": time.time(), "token": None}

    authorize_url = _build_authorize_url(state)
    return {
        "qr_code": state,
        "qr_data_url": _make_qr_data_url(authorize_url),
        "expires_in": 600,
    }


@router.get("/status")
async def douyin_qr_status(qr_code: str):
    """PC 轮询：用户扫码授权后返回 complete + token"""
    item = _state_store.get(qr_code)
    if not item:
        return {"status": "expired"}
    if item["token"]:
        return {"status": "complete", "token": item["token"]}
    return {"status": "pending"}


@router.get("/authorize")
async def douyin_authorize():
    """生成抖音扫码登录跳转链接"""
    if not _is_configured():
        return HTMLResponse(
            "<html><body style='font-family:sans-serif;padding:40px'>"
            "<h3>抖音扫码登录未配置</h3><p>服务端未设置 DOUYIN_CLIENT_KEY / DOUYIN_CLIENT_SECRET。</p>"
            "<p>请在抖音开放平台创建应用后将凭证配置到 .env 并重启。</p></body></html>",
            status_code=503,
        )
    _state_cleanup()
    state = secrets.token_urlsafe(16)
    _state_store[state] = {"t": time.time()}

    redirect_uri = f"{CALLBACK_BASE}/api/oauth/douyin/callback"
    # 抖音开放平台新版：scope=user_info 等；response_type=code
    authorize_url = (
        f"https://open.douyin.com/platform/oauth/connect?"
        f"client_key={CLIENT_KEY}"
        f"&response_type=code"
        f"&scope=user_info"
        f"&state={state}"
        f"&redirect_uri={quote(redirect_uri)}"
    )
    return {"authorize_url": authorize_url}


@router.get("/callback")
async def douyin_callback(code: str, state: str, db=Depends(get_db)):
    """抖音 OAuth 回调：换 token、绑定账号、签发中台 JWT

    state 保留在 _state_store 中并写入 token，供 PC 端 /status 轮询获取；
    同时 302 到 /me（手机浏览器直接完成登录）。
    """
    if state not in _state_store:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

    if not _is_configured():
        raise HTTPException(status_code=503, detail="Douyin OAuth not configured")

    # 1. code 换 access_token
    token_resp = await _douyin_post(
        "/oauth/access_token/",
        data={"client_key": CLIENT_KEY, "client_secret": CLIENT_SECRET, "code": code, "grant_type": "authorization_code"},
    )
    access_token = token_resp.get("access_token")
    refresh_token = token_resp.get("refresh_token", "")
    expires_in = token_resp.get("expires_in", 86400)
    open_id = token_resp.get("open_id")
    if not access_token or not open_id:
        raise HTTPException(status_code=401, detail="Failed to obtain douyin token")

    # 2. 拉取用户公开信息
    user_info = await _douyin_get(
        "/api/douyin/v1/user/info/",
        params={"access_token": access_token, "open_id": open_id},
    )
    nickname = user_info.get("nickname") or ""
    avatar = user_info.get("avatar") or ""

    # 3. 绑定或创建用户（一人可绑多个平台账号；同一 open_id 复用）
    rows = await db.execute_fetchall(
        "SELECT user_id FROM platform_accounts WHERE platform='douyin' AND platform_user_id=?",
        (open_id,),
    )
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))).isoformat()
    if rows:
        user_id = rows[0]["user_id"]
        await db.execute(
            """UPDATE platform_accounts SET access_token=?, refresh_token=?, token_expires_at=?, nickname=?, avatar_url=?
               WHERE platform='douyin' AND platform_user_id=?""",
            (access_token, refresh_token, expires_at, nickname, avatar, open_id),
        )
    else:
        user_id = new_id()
        await db.execute(
            "INSERT INTO users (id, nickname, avatar_url) VALUES (?,?,?)",
            (user_id, nickname, avatar),
        )
        await db.execute(
            """INSERT INTO platform_accounts
               (id, user_id, platform, platform_user_id, nickname, avatar_url, access_token, refresh_token, token_expires_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (new_id(), user_id, "douyin", open_id, nickname, avatar, access_token, refresh_token, expires_at),
        )
    await db.commit()

    # 4. 签发中台 JWT：写入 state 供 PC 轮询，同时 302 到个人页
    token = create_user_token(user_id)
    _state_store[state]["token"] = token
    me_url = f"/me?token={token}"
    return RedirectResponse(me_url)


async def _douyin_post(path: str, data: dict) -> dict:
    async with httpx.AsyncClient(base_url=DOUYIN_API, timeout=15) as client:
        resp = await client.post(path, data=data)
        resp.raise_for_status()
        body = resp.json()
        if body.get("data", {}).get("error_code", 0) != 0:
            raise HTTPException(status_code=502, detail=f"Douyin API error: {body.get('data', {})}")
        return body.get("data", {})


async def _douyin_get(path: str, params: dict) -> dict:
    async with httpx.AsyncClient(base_url=DOUYIN_API, timeout=15) as client:
        resp = await client.get(path, params=params)
        resp.raise_for_status()
        body = resp.json()
        if body.get("data", {}).get("error_code", 0) != 0:
            raise HTTPException(status_code=502, detail=f"Douyin API error: {body.get('data', {})}")
        return body.get("data", {})
