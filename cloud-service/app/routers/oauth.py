"""权益认证中台 - 通用 OAuth 路由（多平台 + 跨平台绑定 + IdP 授权码流程）

路径（以抖音为例，{platform} 可替换为 wechat/xhs）：
  GET  /api/oauth/{platform}/qrcode       生成扫码登录二维码（mode=login|bind|upgrade）
  GET  /api/oauth/{platform}/status       轮询登录结果（PC 端）
  GET  /api/oauth/{platform}/callback     平台 OAuth 回调（换码/绑定/升级）
  GET  /api/oauth/{platform}/authorize    生成授权跳转链接（mode=login|upgrade）
  POST /api/oauth/session                 用 token 写入会话 Cookie（同域后续请求可用）
  GET  /oauth/authorize                   IdP：第三方 App 发起授权（重定向到本站登录）
  POST /oauth/token                       IdP：用授权码换取 user/app token
  GET  /oauth/userinfo                   IdP：用 user token 取用户身份
"""
from __future__ import annotations

import base64
import io
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

import httpx
import qrcode as qrcode_lib
from fastapi import APIRouter, Cookie, Depends, Form, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from ..database import get_db, new_id, find_user_by_platform, upsert_platform_account, get_platform_account, add_whitelist, list_whitelist
from ..deps import get_current_user, get_optional_user
from ..security import create_user_token, create_app_token, decode_token
from ..platforms import get_provider, is_supported, PlatformError

router = APIRouter(tags=["oauth"])

CALLBACK_BASE = os.environ.get("PUBLIC_BASE_URL", "http://localhost:9001")
SESSION_COOKIE = "ba_sid"
_SECURE = os.environ.get("COOKIE_SECURE", "auto")
SECURE_COOKIE = (
    _SECURE == "true"
    if _SECURE in ("true", "false")
    else CALLBACK_BASE.startswith("https")
)

# 扫码登录状态（内存；生产建议 Redis）
# state -> {t, kind, platform, user_id?, scopes?, token?}
_qr_states: dict[str, dict] = {}
# IdP 授权码
# code -> {t, user_id, client_id, redirect_uri, scope}
_codes: dict[str, dict] = {}


# ---------------- 工具 ----------------
def _cleanup_states():
    now = time.time()
    for k in [k for k, v in _qr_states.items() if now - v["t"] > 600]:
        _qr_states.pop(k, None)
    for k in [k for k, v in _codes.items() if now - v["t"] > 300]:
        _codes.pop(k, None)


def _make_qr_data_url(content: str) -> str:
    qr = qrcode_lib.QRCode(box_size=8, border=2)
    qr.add_data(content)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _set_session_cookie(response: Response, token: str):
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=SECURE_COOKIE,
        samesite="lax",
        max_age=3600 * 72,
    )


def _redirect_with_session(dest: str, token: str) -> RedirectResponse:
    """302 跳转并带上会话 Cookie。

    ⚠️ FastAPI 陷阱：端点直接 return 一个 Response（如 RedirectResponse）时，设在注入参数
    response 上的 Set-Cookie 会被整个丢弃（只有返回 dict/模型的常规路径才会合并）。因此
    Cookie 必须设在返回的跳转对象上——callback 的 cont 续接全靠这个 Cookie 传递登录态，
    丢了一定会在授权页死循环（登录 → 回续接地址 → 仍视为未登录 → 又要求扫码）。
    """
    resp = RedirectResponse(dest)
    _set_session_cookie(resp, token)
    return resp


def _provider_or_404(platform: str):
    if not is_supported(platform):
        raise HTTPException(status_code=404, detail=f"unsupported platform: {platform}")
    provider = get_provider(platform)
    if not provider.is_configured():
        raise HTTPException(
            status_code=503,
            detail=f"{platform} 登录暂未开放，服务端未配置 {platform.upper()}_CLIENT_KEY / {platform.upper()}_CLIENT_SECRET",
        )
    return provider


def _resolve_user_id(request: Request | None, ba_sid: str) -> str | None:
    """从 Bearer 或会话 Cookie 解析当前登录用户 UUID"""
    if request is not None:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            p = decode_token(auth[7:])
            if p and p.get("typ") == "user":
                return p["sub"]
    if ba_sid:
        p = decode_token(ba_sid)
        if p and p.get("typ") == "user":
            return p["sub"]
    return None


# ---------------- 扫码登录（login / bind / upgrade） ----------------
@router.get("/api/oauth/{platform}/qrcode")
async def qrcode(platform: str, mode: str = "login", scopes: str = "",
                 user_id: str = Depends(get_optional_user)):
    """生成平台扫码登录二维码。
    mode=login    ：默认，任意用户扫码 → 创建/登录
    mode=bind     ：需已登录，扫码把该平台账号绑定到当前 UUID
    mode=upgrade  ：需已登录，扫码重授权以扩大 scope（如 video.list）

    ⚠️ 已弃用于登录场景：二维码内容是平台授权页链接，抖音 App 不识别（扫码报
    「链接不合法」）。登录请改走 /api/oauth/{platform}/authorize 整页跳官方授权页。
    """
    provider = _provider_or_404(platform)
    if mode in ("bind", "upgrade") and not user_id:
        raise HTTPException(status_code=401, detail="请先登录")

    _cleanup_states()
    state = secrets.token_urlsafe(16)
    req_scopes = None
    if mode == "upgrade":
        req_scopes = [s for s in (scopes.split(",") if scopes else provider.all_scopes()) if s]

    _qr_states[state] = {
        "t": time.time(),
        "kind": mode,
        "platform": platform,
        "user_id": user_id if mode in ("bind", "upgrade") else None,
        "scopes": req_scopes,
        "token": None,
    }
    authorize_url = provider.authorize_url(
        f"{CALLBACK_BASE}/api/oauth/{platform}/callback",
        state,
        req_scopes,
    )
    return {"qr_code": state, "qr_data_url": _make_qr_data_url(authorize_url), "expires_in": 600}


@router.get("/api/oauth/{platform}/status")
async def status(platform: str, qr_code: str):
    item = _qr_states.get(qr_code)
    if not item or item["platform"] != platform:
        return {"status": "expired"}
    if item.get("token") or item.get("whitelisted"):
        return {
            "status": "complete",
            "token": item.get("token"),
            "whitelisted": item.get("whitelisted", False),
            "nickname": item.get("nickname", ""),
        }
    return {"status": "pending"}


@router.get("/api/oauth/{platform}/authorize")
async def authorize_link(platform: str, mode: str = "login", scopes: str = "", token: str = "",
                         cont: str = "", request: Request = None, ba_sid: str = Cookie(default="")):
    """生成平台授权链接并 302 跳转（标准 OAuth：浏览器直接跳平台授权页，扫码后回跳）

    用途：
      mode=login    ：登录（任意用户扫码 → 创建/登录）
      mode=bind     ：需已登录，扫码把该平台账号绑定到当前 UUID
      mode=upgrade  ：需已登录，扫码重授权以扩大 scope（如 video.list）

    cont：登录续接地址（仅接受站内相对路径，如 /oauth/authorize?...）。
    callback 登录成功后带着会话 Cookie 回到该地址，由它继续后续流程（如 IdP 发 code）；
    已登录时访问本端点则直接 302 回 cont，无需再扫码。
    抖音 App 只识别官方授权页展示的二维码，自生成的二维码扫码会报「链接不合法」，
    因此登录一律走本端点整页跳转，不再用 /qrcode 自绘二维码。

    state 会存入 _qr_states，callback 校验依赖它（旧实现只生成 state 不落库，回调必报 Invalid or expired state）。
    bind/upgrade 的用户识别：优先 Authorization Bearer / 会话 Cookie（ba_sid），
    纯浏览器跳转场景（页面按钮 location.href）无 Bearer 且 Cookie 仅在 auth 子域有效，
    因此支持显式 ?token=<userJWT> 兜底（页面按钮带上即可跨子域升级授权）。
    """
    provider = _provider_or_404(platform)
    user_id = _resolve_user_id(request, ba_sid)
    if not user_id and token:
        p = decode_token(token)
        if p and p.get("typ") == "user":
            user_id = p["sub"]
    if mode in ("bind", "upgrade") and not user_id:
        raise HTTPException(status_code=401, detail="请先登录")
    cont = cont if cont.startswith("/") else ""
    if mode == "login" and cont and user_id:
        return RedirectResponse(cont)
    req_scopes = None
    if mode == "upgrade":
        req_scopes = [s for s in (scopes.split(",") if scopes else provider.all_scopes()) if s]
    _cleanup_states()
    state = secrets.token_urlsafe(16)
    _qr_states[state] = {
        "t": time.time(),
        "kind": mode,
        "platform": platform,
        "user_id": user_id if mode in ("bind", "upgrade") else None,
        "scopes": req_scopes,
        "token": None,
        "cont": cont,
    }
    url = provider.authorize_url(
        f"{CALLBACK_BASE}/api/oauth/{platform}/callback", state=state, scopes=req_scopes
    )
    return RedirectResponse(url)


@router.get("/api/oauth/{platform}/callback")
async def callback(platform: str, code: str, state: str, response: Response, db=Depends(get_db)):
    """平台 OAuth 回调：换 token → 登录/绑定/升级 → 写会话 Cookie + 返回 /me"""
    item = _qr_states.get(state)
    if not item or item["platform"] != platform:
        raise HTTPException(status_code=400, detail="Invalid or expired state")
    provider = _provider_or_404(platform)

    try:
        token_data = await provider.exchange_code(code, f"{CALLBACK_BASE}/api/oauth/{platform}/callback")
    except PlatformError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"platform request failed: {e}")

    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token", "")
    expires_in = int(token_data.get("expires_in", 86400))
    open_id = token_data.get("open_id")
    granted_scopes = token_data.get("scope", "")
    if not access_token or not open_id:
        raise HTTPException(status_code=401, detail="Failed to obtain platform token")

    kind = item["kind"]
    # 按抖音官方模板，测试白名单授权只授予 trial.whitelist（无 user_info），故跳过 user_info 拉取。
    nickname, avatar = "", ""
    if kind != "whitelist":
        try:
            info = await provider.user_info(access_token, open_id)
            nickname = info.get("nickname") or ""
            avatar = info.get("avatar") or ""
        except (PlatformError, httpx.HTTPError) as e:
            if kind in ("bind", "upgrade"):
                raise HTTPException(status_code=502, detail=str(e))
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()

    if kind == "login":
        existing = await find_user_by_platform(db, platform, open_id)
        if existing:
            user_id = existing
            await upsert_platform_account(
                db, user_id=user_id, platform=platform, platform_user_id=open_id,
                nickname=nickname, avatar_url=avatar, access_token=access_token,
                refresh_token=refresh_token, token_expires_at=expires_at,
                scopes=granted_scopes or ",".join(provider.default_scopes),
            )
        else:
            user_id = new_id()
            await db.execute("INSERT INTO users (id, nickname, avatar_url) VALUES (?,?,?)",
                            (user_id, nickname, avatar))
            await upsert_platform_account(
                db, user_id=user_id, platform=platform, platform_user_id=open_id,
                nickname=nickname, avatar_url=avatar, access_token=access_token,
                refresh_token=refresh_token, token_expires_at=expires_at,
                scopes=granted_scopes or ",".join(provider.default_scopes),
            )
        await db.commit()
        token = create_user_token(user_id)
        item["token"] = token
        cont = item.get("cont") or ""
        if cont:
            # IdP 续接：带着会话 Cookie 回续接地址（如 /oauth/authorize，由它向第三方 App 发 code）
            return _redirect_with_session(cont, token)
        return _redirect_with_session(f"/me?token={token}", token)

    elif kind == "bind":
        # 已登录态：把该平台账号挂到当前 UUID
        owner = item["user_id"]
        conflict = await find_user_by_platform(db, platform, open_id)
        if conflict and conflict != owner:
            raise HTTPException(status_code=409, detail="该平台账号已绑定到其他用户")
        await upsert_platform_account(
            db, user_id=owner, platform=platform, platform_user_id=open_id,
            nickname=nickname, avatar_url=avatar, access_token=access_token,
            refresh_token=refresh_token, token_expires_at=expires_at,
            scopes=granted_scopes or ",".join(provider.default_scopes),
        )
        await db.commit()
        token = create_user_token(owner)
        item["token"] = token
        return _redirect_with_session(f"/me?token={token}&bound={platform}", token)

    elif kind == "upgrade":
        owner = item["user_id"]
        acct = await get_platform_account(db, owner, platform)
        if not acct:
            raise HTTPException(status_code=404, detail="请先绑定该平台账号")
        await upsert_platform_account(
            db, user_id=owner, platform=platform, platform_user_id=open_id,
            nickname=nickname, avatar_url=avatar, access_token=access_token,
            refresh_token=refresh_token, token_expires_at=expires_at,
            scopes=granted_scopes or acct["scopes"],
        )
        await db.commit()
        token = create_user_token(owner)
        item["token"] = token
        return _redirect_with_session(f"/me?token={token}&upgraded={platform}", token)

    elif kind == "whitelist":
        # 测试白名单授权：扫码同意 trial.whitelist 即登记，无需创建中台用户
        await add_whitelist(
            db, platform=platform, platform_user_id=open_id,
            nickname=nickname, avatar_url=avatar,
        )
        await db.commit()
        item["whitelisted"] = True
        item["nickname"] = nickname
        return HTMLResponse(_whitelist_success_page(nickname, open_id))

    raise HTTPException(status_code=400, detail="unknown oauth kind")


@router.post("/api/oauth/session")
async def set_session(response: Response, token: str):
    """用 user JWT 写入会话 Cookie（同域后续请求可用）"""
    payload = decode_token(token)
    if not payload or payload.get("typ") != "user":
        raise HTTPException(status_code=401, detail="Invalid token")
    _set_session_cookie(response, token)
    return {"ok": True}


# ==================== 测试白名单（trial.whitelist） ====================
_WHITELIST_SCOPE = "trial.whitelist"


def _new_whitelist_state() -> tuple[str, str]:
    """生成 trial.whitelist 授权二维码状态，返回 (state, authorize_url)"""
    provider = get_provider("douyin")
    _cleanup_states()
    state = secrets.token_urlsafe(16)
    # 按抖音开放平台官方「抖音号操作授权说明」模板：测试白名单授权 scope 只用 trial.whitelist。
    _qr_states[state] = {
        "t": time.time(), "kind": "whitelist", "platform": "douyin",
        "user_id": None, "scopes": [_WHITELIST_SCOPE],
        "token": None, "whitelisted": False, "nickname": "",
    }
    authorize_url = provider.authorize_url(
        f"{CALLBACK_BASE}/api/oauth/douyin/callback", state, [_WHITELIST_SCOPE]
    )
    return state, authorize_url


@router.get("/api/oauth/douyin/whitelist/qrcode")
async def whitelist_qrcode(db=Depends(get_db)):
    """生成 trial.whitelist 授权二维码：指定抖音号扫码同意授权即加入测试白名单。

    返回 qr_data_url 与 authorize_url。⚠️ 抖音 App 不识别自绘二维码（扫码报
    「链接不合法」），请用 authorize_url 整页跳转官方授权页（如 GET /whitelist）。
    """
    if not get_provider("douyin").is_configured():
        raise HTTPException(status_code=503, detail="douyin 未配置 CLIENT_KEY / CLIENT_SECRET")
    state, authorize_url = _new_whitelist_state()
    return {
        "qr_code": state,
        "qr_data_url": _make_qr_data_url(authorize_url),
        "authorize_url": authorize_url,
        "expires_in": 600,
    }


@router.get("/whitelist", response_class=HTMLResponse)
async def whitelist_page(db=Depends(get_db)):
    """开发者白名单授权页：跳转抖音官方授权页，扫码同意 trial.whitelist 即加入白名单。

    同意后 callback（kind=whitelist）直接返回成功页，无需本页轮询。
    """
    if not get_provider("douyin").is_configured():
        return HTMLResponse("<h3>douyin 未配置 CLIENT_KEY / CLIENT_SECRET</h3>")
    _, authorize_url = _new_whitelist_state()
    return RedirectResponse(authorize_url)


@router.get("/api/oauth/douyin/whitelist")
async def whitelist_list(authorization: str = "", token: str = "", db=Depends(get_db)):
    """查看当前测试白名单。若服务端设置了 BENEFIT_ADMIN_TOKEN，则需 ?token= 或 Authorization Bearer 校验。"""
    admin = os.environ.get("BENEFIT_ADMIN_TOKEN")
    if admin:
        provided = token or (authorization[7:] if authorization.startswith("Bearer ") else "")
        if provided != admin:
            raise HTTPException(status_code=401, detail="admin token required")
    rows = await list_whitelist(db)
    return {"count": len(rows), "whitelist": rows}


# ==================== IdP：第三方 App 授权码流程 ====================
@router.get("/oauth/authorize")
async def idp_authorize(
    request: Request,
    client_id: str = Query(...),
    redirect_uri: str = Query(...),
    response_type: str = "code",
    scope: str = "",
    state: str = "",
    ba_sid: str = Cookie(default=""),
    db=Depends(get_db),
):
    """第三方 App（如 learning-app）发起授权：用户在本站用抖音登录后回跳 code。"""
    if response_type != "code":
        raise HTTPException(status_code=400, detail="unsupported response_type")
    app_rows = await db.execute_fetchall("SELECT * FROM apps WHERE app_id=?", (client_id,))
    if not app_rows:
        raise HTTPException(status_code=401, detail="Invalid client_id")
    app = app_rows[0]
    allowed = [u.strip() for u in (app["redirect_uris"] or "").split(",") if u.strip()]
    if allowed and redirect_uri not in allowed:
        raise HTTPException(status_code=400, detail="redirect_uri not allowed for this client")

    # 已登录（会话 Cookie）→ 直接发 code 回跳
    token = ba_sid
    uid = None
    if token:
        p = decode_token(token)
        if p and p.get("typ") == "user":
            uid = p["sub"]
    if uid:
        code = secrets.token_urlsafe(24)
        _codes[code] = {
            "t": time.time(), "user_id": uid, "client_id": client_id,
            "redirect_uri": redirect_uri, "scope": scope,
        }
        _cleanup_states()
        sep = "&" if "?" in redirect_uri else "?"
        return RedirectResponse(f"{redirect_uri}{sep}code={code}&state={quote(state)}")

    # 未登录 → 渲染“登录后续接”页（扫码登录后自动回到本地址，带上会话）
    continue_url = f"/oauth/authorize?{urlencode({'client_id': client_id, 'redirect_uri': redirect_uri, 'response_type': response_type, 'scope': scope, 'state': state})}"
    return HTMLResponse(_authorize_continue_page(continue_url, app["name"]))


def consume_idp_code(code: str, redirect_uri: str) -> str | None:
    """消费 IdP 授权码（一次性），返回 user_id；码无效/过期/redirect_uri 不符返回 None。

    供第一方应用（学习伙伴 LAN server）免 secret 换身份：授权码只投递到发起方
    redirect_uri（App 本地回调），持码即证明来源，client_secret 无需下发到用户机器
    （learning-server 装在用户电脑上，不能存 SK）。第三方接入仍走 /oauth/token + secret。
    """
    _cleanup_states()
    rec = _codes.get(code)
    if not rec or rec["redirect_uri"] != redirect_uri:
        return None
    _codes.pop(code, None)
    return rec["user_id"]


@router.post("/oauth/token")
async def idp_token(
    grant_type: str = Form(...),
    code: str = Form(...),
    client_id: str = Form(...),
    client_secret: str = Form(...),
    redirect_uri: str = Form(""),
    db=Depends(get_db),
):
    """用授权码换取 token。返回 user JWT（身份）与 app JWT（调用本网站 API 用）。"""
    if grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="unsupported grant_type")
    _cleanup_states()
    rec = _codes.get(code)
    if not rec or rec["client_id"] != client_id:
        raise HTTPException(status_code=400, detail="invalid authorization code")
    if redirect_uri and rec["redirect_uri"] != redirect_uri:
        raise HTTPException(status_code=400, detail="redirect_uri mismatch")

    app_rows = await db.execute_fetchall("SELECT * FROM apps WHERE app_id=?", (client_id,))
    app = app_rows[0]
    # 校验 client_secret（app_secret 哈希比对）
    from ..security import verify_secret
    if not verify_secret(client_secret, app["app_secret_hash"]):
        raise HTTPException(status_code=401, detail="Invalid client credentials")

    user_token = create_user_token(rec["user_id"])
    app_token = create_app_token(client_id)
    _codes.pop(code, None)
    return {
        "access_token": user_token,
        "token_type": "Bearer",
        "expires_in": 72 * 3600,
        "app_token": app_token,
        "scope": rec["scope"],
        "user_id": rec["user_id"],
    }


@router.get("/oauth/userinfo")
async def idp_userinfo(user_id: str = Depends(get_current_user), db=Depends(get_db)):
    """用 user token 取用户身份（供第三方 App 识别登录用户）"""
    users = await db.execute_fetchall("SELECT * FROM users WHERE id=?", (user_id,))
    if not users:
        raise HTTPException(status_code=404, detail="User not found")
    u = users[0]
    accounts = await db.execute_fetchall(
        "SELECT platform, platform_user_id, nickname, avatar_url, scopes, bind_at FROM platform_accounts WHERE user_id=?",
        (user_id,),
    )
    return {
        "user_id": user_id,
        "nickname": u["nickname"],
        "avatar_url": u["avatar_url"],
        "email": u["email"],
        "platform_accounts": [dict(a) for a in accounts],
    }


# ==================== 未登录授权续接页 ====================
def _authorize_continue_page(continue_url: str, app_name: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录以授权 {app_name}</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:#f5f6fa;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center}}
.card{{background:#fff;border-radius:20px;padding:32px;max-width:420px;width:92%;text-align:center;
box-shadow:0 12px 40px rgba(15,23,42,.08)}}
.brand{{width:48px;height:48px;border-radius:14px;margin:0 auto 14px;
background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;font-size:22px;
display:flex;align-items:center;justify-content:center;font-weight:700}}
h2{{font-size:19px;margin-bottom:6px}}
.lead{{color:#64748b;font-size:14px;line-height:1.7;margin:10px 0 18px}}
.spin{{width:34px;height:34px;border:3px solid #e2e8f0;border-top-color:#7c3aed;border-radius:50%;margin:26px auto;animation:rot 1s linear infinite}}
@keyframes rot{{to{{transform:rotate(360deg)}}}}
.hint{{color:#94a3b8;font-size:12.5px;margin-top:12px;line-height:1.6}}
.hint a{{color:#7c3aed;text-decoration:none}}
</style></head>
<body><div class="card">
<div class="brand">益</div>
<h2>登录以授权 {app_name}</h2>
<p class="lead">正在跳转抖音官方授权页，<br>请用抖音 App「扫一扫」扫描页面上的二维码并确认授权。</p>
<div class="spin"></div>
<div class="hint">若未自动跳转，<a id="go">点此继续</a></div>
</div>
<script>
// 抖音 App 只识别官方授权页展示的二维码（自绘二维码扫码会提示「链接不合法」），
// 故整页跳转官方授权页；授权完成后经 callback 带会话回到 CONT 续接发 code。
const CONT = {json.dumps(continue_url)};
const target = '/api/oauth/douyin/authorize?mode=login&cont=' + encodeURIComponent(CONT);
document.getElementById('go').href = target;
location.replace(target);
</script></body></html>"""


# ==================== 测试白名单页面 ====================
def _whitelist_success_page(nickname: str, open_id: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>已加入测试白名单</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:#ecfdf5;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center}}
.card{{background:#fff;border-radius:20px;padding:36px;max-width:420px;width:92%;text-align:center;
box-shadow:0 12px 40px rgba(15,23,42,.08)}}
.big{{font-size:46px}}
h2{{font-size:20px;margin:10px 0 6px;color:#047857}}
.name{{font-size:16px;color:#0f172a;margin:8px 0}}
.id{{font-size:12px;color:#94a3b8;word-break:break-all}}
.tip{{color:#64748b;font-size:13px;line-height:1.7;margin-top:14px}}
</style></head>
<body><div class="card">
<div class="big">✅</div>
<h2>已加入测试白名单</h2>
<div class="name">{nickname or '该抖音账号'}</div>
<div class="id">open_id: {open_id}</div>
<p class="tip">该账号已获准在本应用测试阶段使用。<br>你可以关闭此页面。</p>
</div></body></html>"""
