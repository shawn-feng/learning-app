"""管理门户：侧边菜单式后台（TokenHub 凭证与配额 / 管理员安全设置）+ 登录（账密 → 邮箱验证码）。

与 admin.py 的 X-Admin-Token 体系并存：本模块面向浏览器管理员（Cookie 会话），
admin.py 面向脚本/流水线（静态 token）。

凭证与 SMTP（ISSUE-174）：
- TokenHub ak/sk：管理页「TokenHub → 凭证配置」可配（settings tokenhub_ak/tokenhub_sk），
  DB 优先 env 兜底；页面上只显示 SecretId 前几位，Key 列表只显示前几位（绝不回全量）。
- 管理员账密：DB settings 播种（79734745@qq.com / 123456），页面可改密。
- SMTP 授权码：管理页「安全设置」配置（settings smtp_user/smtp_auth_code），env 兜底。

二次验证规则（2026-10-09 定版）：**一旦 SMTP 配置好，登录即默认启用邮箱验证码**——
账密通过后向管理员邮箱发 6 位验证码（5 分钟有效），登录页输入验证码通过才签发会话；
SMTP 未配置时降级单因素（账密直进 + 后台横幅提醒）。验证码错 5 次作废重来。
"""
import io
import json
import os
import secrets

import jwt
import qrcode  # noqa: F401（保留：二维码生成备用于扫码流程）
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from ..database import get_db, get_setting, set_setting
from ..mail import MailNotConfigured, send_login_mail
from .. import ratelimit
from ..security import create_admin_token, hash_password, verify_password
from .. import tokenhub
from .. import user_admin
from .. import user_admin

router = APIRouter(tags=["admin-portal"])

COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() != "false"
CHALLENGE_TTL_S = 300
CODE_MAX_FAILS = 5

_verify_fails: dict[str, int] = {}
_alert_mail_last = [0.0]


async def admin_credentials(db) -> tuple[str, str]:
    username = await get_setting(db, "admin_username", os.environ.get("ADMIN_USERNAME", "79734745@qq.com"))
    pwd_hash = await get_setting(db, "admin_password_hash", "")
    return username, pwd_hash


async def smtp_credentials(db) -> tuple[str, str]:
    """SMTP 凭证：管理页配置（DB）优先，env 兜底。"""
    user = await get_setting(db, "smtp_user", "") or os.environ.get("SMTP_USER", "")
    code = await get_setting(db, "smtp_auth_code", "") or os.environ.get("SMTP_AUTH_CODE", "")
    return user.strip(), code.strip()


async def sync_tokenhub_cfg(db) -> None:
    """把管理页配置的 TokenHub ak/sk（DB）同步进运行时覆盖（DB 优先，env 兜底）。"""
    sid = await get_setting(db, "tokenhub_ak", "")
    sk = await get_setting(db, "tokenhub_sk", "")
    if sid or sk:
        tokenhub.set_runtime_config(sid, sk)


async def _alert_login_fail(db, ip: str, username: str, locked: bool) -> None:
    """管理登录失败告警邮件（10 分钟节流；尽力而为，不抛错）。"""
    import time as _t
    if _t.time() - _alert_mail_last[0] < 600:
        return
    _alert_mail_last[0] = _t.time()
    try:
        smtp_user, smtp_code = await smtp_credentials(db)
        if not (smtp_user and smtp_code):
            return
        to_email = await get_setting(db, "admin_email", "79734745@qq.com")
        import html as _h
        u, i = _h.escape(username), _h.escape(ip)
        send_login_mail(smtp_user, smtp_code, to_email,
                        f"<p>⚠️ 管理后台刚刚有一次<b>登录失败</b>：账号 {u}，来源 IP {i}。"
                        f"{'该账号已临时锁定 15 分钟。' if locked else ''}"
                        f"如非本人操作，请立即修改管理员密码。</p>", b"")
    except Exception:  # noqa: BLE001
        pass


async def require_admin_cookie(request: Request) -> str:
    token = request.cookies.get("ba_admin", "")
    try:
        payload = jwt.decode(token, os.environ.get("BENEFIT_JWT_SECRET", "benefit-auth-dev-secret-change-me"),
                             algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="管理会话无效或已过期，请重新登录")
    if payload.get("typ") != "admin":
        raise HTTPException(status_code=401, detail="管理会话无效")
    return payload.get("sub", "")


def _issue_admin_cookie(username: str) -> JSONResponse:
    token = create_admin_token(username)
    resp = JSONResponse({"status": "approved"})
    resp.set_cookie("ba_admin", token, httponly=True, samesite="lax",
                    secure=COOKIE_SECURE, max_age=8 * 3600)
    return resp


# ---------------- 登录（账密 → [SMTP 已配] 邮箱验证码） ----------------

class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/api/admin-portal/login")
async def portal_login(body: LoginBody, request: Request, db=Depends(get_db)):
    # ---- 防撞库限流（哈希之前，全部命中即拒） ----
    ip = ratelimit.client_ip(request)
    if ratelimit.ip_exceeded(f"login:{ip}", ratelimit.IP_WINDOW_S, ratelimit.IP_LOGIN_MAX):
        raise HTTPException(status_code=429, detail="尝试过于频繁，请 15 分钟后再试")
    if ratelimit.fuse_tripped():
        raise HTTPException(status_code=429, detail="系统繁忙，请稍后再试")
    subject = f"admin:{body.username}"
    locked, remain = await ratelimit.acct_status(db, subject, ratelimit.ACCT_FAILS, ratelimit.ACCT_LOCK_S)
    if locked:
        raise HTTPException(status_code=423, detail=f"失败次数过多，账号已临时锁定（约 {remain//60+1} 分钟后自动解锁）")

    username, pwd_hash = await admin_credentials(db)
    if not pwd_hash:
        raise HTTPException(status_code=503, detail="管理员凭证未初始化，请重启服务完成种子")
    if not (secrets.compare_digest(body.username, username)
            and verify_password(body.password, pwd_hash)):
        # ---- 失败：全局熔断计数 + 账号失败锁 + 统一延迟 + 告警邮件（节流） ----
        ratelimit.fuse_record_fail()
        locked_now, _ = await ratelimit.acct_record_fail(db, subject, ratelimit.ACCT_FAILS, ratelimit.ACCT_LOCK_S)
        ratelimit.fail_delay()
        await _alert_login_fail(db, ip, body.username, locked_now)
        raise HTTPException(status_code=401, detail="账号或密码错误")
    await ratelimit.acct_reset(db, subject)

    smtp_user, smtp_code = await smtp_credentials(db)
    if not (smtp_user and smtp_code):
        # 单因素降级：SMTP 未配置。后台会横幅提醒去「安全设置」补配。
        return _issue_admin_cookie(username)

    # 二次验证：发 6 位验证码到管理员邮箱（复用挑战表：approve_token 列存验证码）
    if ratelimit.hit(f"chal:{ip}", ratelimit.CHALLENGE_DAY_S, ratelimit.CHALLENGE_DAILY_MAX):
        raise HTTPException(status_code=429, detail="今日验证邮件次数已达上限，请明天再试")
    await db.execute("DELETE FROM admin_login_challenges WHERE expires_at < datetime('now')")
    challenge = secrets.token_urlsafe(24)
    code = "".join(secrets.choice("0123456789") for _ in range(6))
    await db.execute(
        """INSERT INTO admin_login_challenges (id, approve_token, approved, expires_at)
           VALUES (?,?,0,datetime('now', '+' || ? || ' seconds'))""",
        (challenge, code, CHALLENGE_TTL_S),
    )
    await db.commit()
    _verify_fails.pop(challenge, None)

    to_email = await get_setting(db, "admin_email", "79734745@qq.com")
    html = _code_mail_html(code)
    try:
        send_login_mail(smtp_user, smtp_code, to_email, html, b"")
    except MailNotConfigured as e:
        await db.execute("DELETE FROM admin_login_challenges WHERE id=?", (challenge,))
        await db.commit()
        raise HTTPException(status_code=503, detail=f"验证邮件发送失败：{e}") from e
    except Exception as e:  # noqa: BLE001
        await db.execute("DELETE FROM admin_login_challenges WHERE id=?", (challenge,))
        await db.commit()
        raise HTTPException(status_code=502, detail=f"验证邮件发送失败：{e}") from e
    return {"challenge": challenge, "email": to_email, "ttl": CHALLENGE_TTL_S}


class VerifyBody(BaseModel):
    challenge: str
    code: str


@router.post("/api/admin-portal/verify")
async def verify_code(body: VerifyBody, request: Request, db=Depends(get_db)):
    """登录页提交邮箱验证码：通过即签发管理 Cookie（同浏览器，无需跳转）。错 5 次作废挑战。"""
    vip = ratelimit.client_ip(request)
    if ratelimit.ip_exceeded(f"verify:{vip}", 3600, ratelimit.VERIFY_HOURLY_MAX):
        raise HTTPException(status_code=429, detail="验证尝试过于频繁，请 1 小时后再试")
    rows = await db.execute_fetchall(
        "SELECT * FROM admin_login_challenges WHERE id=? AND approved=0 AND expires_at > datetime('now')",
        (body.challenge,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="验证会话不存在或已过期，请重新登录")
    challenge = rows[0]["id"]
    fails = _verify_fails.get(challenge, 0)
    if not (secrets.compare_digest(body.code.strip(), rows[0]["approve_token"])):
        fails += 1
        if fails >= CODE_MAX_FAILS:
            await db.execute("DELETE FROM admin_login_challenges WHERE id=?", (challenge,))
            await db.commit()
            _verify_fails.pop(challenge, None)
            raise HTTPException(status_code=400, detail="验证码错误次数过多，请重新登录")
        _verify_fails[challenge] = fails
        raise HTTPException(status_code=400, detail=f"验证码错误（剩余 {CODE_MAX_FAILS - fails} 次机会）")
    username, _ = await admin_credentials(db)
    await db.execute("DELETE FROM admin_login_challenges WHERE id=?", (challenge,))
    await db.commit()
    _verify_fails.pop(challenge, None)
    return _issue_admin_cookie(username)


@router.post("/api/admin-portal/logout")
async def portal_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("ba_admin")
    return resp


class ChangePasswordBody(BaseModel):
    oldPassword: str
    newPassword: str


@router.post("/api/admin-portal/change-password")
async def change_password(body: ChangePasswordBody, db=Depends(get_db),
                          admin: str = Depends(require_admin_cookie)):
    _, pwd_hash = await admin_credentials(db)
    if not verify_password(body.oldPassword, pwd_hash):
        raise HTTPException(status_code=400, detail="旧密码错误")
    if len(body.newPassword) < 6:
        raise HTTPException(status_code=400, detail="新密码至少 6 位")
    await set_setting(db, "admin_password_hash", hash_password(body.newPassword))
    await db.commit()
    return {"ok": True}


# ---------------- SMTP 设置（安全设置菜单） ----------------

class SmtpBody(BaseModel):
    smtpUser: str = ""
    authCode: str = ""


@router.get("/api/admin-portal/smtp")
async def get_smtp(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    db_user = await get_setting(db, "smtp_user", "")
    db_code = await get_setting(db, "smtp_auth_code", "")
    env_user = os.environ.get("SMTP_USER", "")
    env_code = os.environ.get("SMTP_AUTH_CODE", "")
    if db_user and db_code:
        source, user, masked = "db", db_user, _mask_code(db_code)
    elif env_user and env_code:
        source, user, masked = "env", env_user, _mask_code(env_code)
    else:
        source, user, masked = "none", (db_user or env_user), ""
    return {"smtpUser": user, "authCodeMasked": masked, "source": source,
            "adminEmail": await get_setting(db, "admin_email", "79734745@qq.com")}


def _mask_code(code: str) -> str:
    if not code:
        return ""
    if len(code) <= 8:
        return "*" * len(code)
    return f"{code[:4]}****{code[-4:]}"


@router.post("/api/admin-portal/smtp")
async def save_smtp(body: SmtpBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    if body.smtpUser.strip():
        await set_setting(db, "smtp_user", body.smtpUser.strip())
    if body.authCode.strip() and "*" not in body.authCode:
        await set_setting(db, "smtp_auth_code", body.authCode.strip())
    await db.commit()
    user, code = await smtp_credentials(db)
    return {"ok": True, "ready": bool(user and code)}


@router.post("/api/admin-portal/smtp/test")
async def test_smtp(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    user, code = await smtp_credentials(db)
    to_email = await get_setting(db, "admin_email", "79734745@qq.com")
    try:
        send_login_mail(user, code, to_email,
                        "<p>这是一封测试邮件——SMTP 授权码配置有效 ✅（学习伙伴管理后台）</p>", b"")
    except MailNotConfigured as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"发送失败：{e}") from e
    return {"ok": True, "to": to_email}


# ---------------- TokenHub 菜单（凭证配置 + Key 列表） ----------------

class TokenHubCfgBody(BaseModel):
    secretId: str = ""
    secretKey: str = ""


@router.get("/api/admin-portal/tokenhub/config")
async def get_tokenhub_cfg(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    db_ak = await get_setting(db, "tokenhub_ak", "")
    db_sk = await get_setting(db, "tokenhub_sk", "")
    env_ak = os.environ.get("TOKENHUB_SECRET_ID", "")
    env_sk = os.environ.get("TOKENHUB_SECRET_KEY", "")
    if db_ak and db_sk:
        source, ak, masked = "db", db_ak, tokenhub.mask_secret_id(db_ak)
    elif env_ak and env_sk:
        source, ak, masked = "env", env_ak, tokenhub.mask_secret_id(env_ak)
    else:
        source, ak, masked = "none", (db_ak or env_ak), (tokenhub.mask_secret_id(db_ak or env_ak) if (db_ak or env_ak) else "")
    return {"secretId": ak, "secretIdMasked": masked, "source": source,
            "configured": tokenhub.configured()}


@router.post("/api/admin-portal/tokenhub/config")
async def save_tokenhub_cfg(body: TokenHubCfgBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    if body.secretId.strip():
        await set_setting(db, "tokenhub_ak", body.secretId.strip())
    if body.secretKey.strip() and "*" not in body.secretKey:
        await set_setting(db, "tokenhub_sk", body.secretKey.strip())
    await db.commit()
    await sync_tokenhub_cfg(db)
    sid, sk, _ = tokenhub.get_config()
    return {"ok": True, "configured": bool(sid and sk), "secretIdMasked": tokenhub.mask_secret_id(sid)}


@router.post("/api/admin-portal/tokenhub/test")
async def test_tokenhub(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    """连通测试：用当前凭证调 DescribeApiKeyList。"""
    await sync_tokenhub_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=400, detail="TokenHub 凭证未配置")
    try:
        total = tokenhub.list_api_keys()
        sid, _, _ = tokenhub.get_config()
        return {"ok": True, "keyCount": total, "secretIdMasked": tokenhub.mask_secret_id(sid)}
    except tokenhub.TokenHubError as e:
        raise HTTPException(status_code=502, detail=f"连通失败：{e.message}") from e


@router.get("/api/admin-portal/tokenhub/keys")
async def admin_list_keys(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    await sync_tokenhub_cfg(db)
    rows = await db.execute_fetchall(
        """SELECT k.*, u.email AS user_email, u.nickname AS user_nickname
           FROM tokenhub_keys k LEFT JOIN users u ON u.id = k.user_id
           WHERE k.status != 'deleted' ORDER BY k.created_at DESC""")
    items = []
    for row in rows:
        r = dict(row)
        item = {
            "userId": r["user_id"],
            "userLabel": r["user_email"] or r["user_nickname"] or r["user_id"][:12],
            "keyId": r["api_key_id"],
            # 需求：只显示 Key 前几位，绝不回显后缀或全量
            "keyMasked": tokenhub.mask_key_prefix(r.get("api_key") or ""),
            "status": r["status"],
            "quotaCycleCredits": r["quota_cycle_credits"],
            "createdAt": r["created_at"],
        }
        try:
            detail = tokenhub.describe_api_key(r["api_key_id"])
            item["quota"] = tokenhub.quota_of(detail)
            item["reachable"] = True
        except tokenhub.TokenHubError as e:
            item["quota"] = None
            item["reachable"] = False
            item["error"] = str(e)
        items.append(item)
    today_used = sum((i.get("quota") or {}).get("cycleUsed", 0) for i in items)
    abnormal = sum(1 for i in items if not i["reachable"]
                   or (i.get("quota") or {}).get("quotaStatus") == "inactive"
                   or i["status"] != "active")
    return {"keys": items, "summary": {"total": len(items), "todayUsed": today_used, "abnormal": abnormal},
            "defaultDailyCredits": await tokenhub.get_default_daily_credits(db),
            "tokenhubConfigured": tokenhub.configured()}


@router.get("/api/admin-portal/tokenhub/usage-models")
async def admin_usage_by_models(days: int = 14, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    """按模型维度的账号整体用量（官方口径，分钟级以上延迟；不能按家长拆分）。"""
    await sync_tokenhub_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=400, detail="TokenHub 凭证未配置")
    try:
        return tokenhub.usage_by_models(days)
    except tokenhub.TokenHubError as e:
        raise HTTPException(status_code=502, detail=f"查询失败：{e.message}") from e


class QuotaBody(BaseModel):
    userId: str
    credits: int
    cycleUnit: str = ""      # 空 = 保持现周期；d / m / lifetime
    monthStartDay: int = 1   # 仅 m 时生效


@router.post("/api/admin-portal/tokenhub/quota")
async def admin_set_quota(body: QuotaBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    if body.credits < 1 or body.credits > 10_000_000_000_000:
        raise HTTPException(status_code=400, detail="配额超出范围")
    await sync_tokenhub_cfg(db)
    row = await tokenhub.get_user_key_row(db, body.userId)
    if not row:
        raise HTTPException(status_code=404, detail="该用户尚无 TokenHub Key")
    # 周期：不传 = 保持 Key 现有周期；传入则连周期一起改
    unit = body.cycleUnit.strip() if body.cycleUnit.strip() else (row.get("quota_cycle_unit") or "d").strip()
    if unit not in ("d", "m", "lifetime"):
        raise HTTPException(status_code=400, detail="重置周期无效")
    _, msd = await tokenhub.get_quota_cycle(db)
    tokenhub.modify_quota(row["api_key_id"], body.credits, unit, msd)
    # 手工调整代表管理员意图：清除自动恢复档位的排队（避免与新设定冲突）
    await db.execute(
        "UPDATE tokenhub_keys SET quota_cycle_credits=?, quota_cycle_unit=?, "
        "pending_restore_credits=0, restore_after_date='', updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (body.credits, unit, row["id"]))
    await db.commit()
    user_admin._describe_cache.pop(row["api_key_id"], None)
    return {"ok": True, "userId": body.userId, "credits": body.credits, "cycleUnit": unit}


class StatusBody(BaseModel):
    userId: str
    enable: bool


@router.post("/api/admin-portal/tokenhub/status")
async def admin_set_status(body: StatusBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    await sync_tokenhub_cfg(db)
    row = await tokenhub.get_user_key_row(db, body.userId)
    if not row:
        raise HTTPException(status_code=404, detail="该用户尚无 TokenHub Key")
    tokenhub.set_status(row["api_key_id"], body.enable)
    await db.execute("UPDATE tokenhub_keys SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                     ("active" if body.enable else "disabled", row["id"]))
    await db.commit()
    return {"ok": True, "userId": body.userId, "status": "active" if body.enable else "disabled"}


class DeleteBody(BaseModel):
    userId: str


@router.post("/api/admin-portal/tokenhub/delete")
async def admin_delete_key(body: DeleteBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    await sync_tokenhub_cfg(db)
    row = await tokenhub.get_user_key_row(db, body.userId)
    if not row:
        raise HTTPException(status_code=404, detail="该用户尚无 TokenHub Key")
    try:
        tokenhub.delete_api_key(row["api_key_id"])
    except tokenhub.TokenHubError as e:
        if e.code != "ResourceNotFound":
            raise HTTPException(status_code=502, detail=f"TokenHub 删除失败: {e.message}") from e
    await db.execute("UPDATE tokenhub_keys SET status='deleted', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                     (row["id"],))
    await db.commit()
    return {"ok": True, "userId": body.userId}


class ProvisionBody(BaseModel):
    userId: str
    credits: int | None = None


@router.post("/api/admin-portal/tokenhub/provision")
async def admin_provision(body: ProvisionBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    await sync_tokenhub_cfg(db)
    row = await tokenhub.ensure_user_key(db, body.userId, daily_credits=body.credits)
    return {"ok": True, "keyId": row["api_key_id"], "credits": row["quota_cycle_credits"]}


class DefaultQuotaBody(BaseModel):
    credits: int


@router.post("/api/admin-portal/tokenhub/default-quota")
async def admin_set_default_quota(body: DefaultQuotaBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    await tokenhub.set_default_daily_credits(db, body.credits)
    return {"ok": True, "credits": body.credits}


# ---------------- 默认模型（四下拉：文本/视觉/ASR/TTS） ----------------
# 选项为策划清单：标注「已实测/当前可用」的为验证过可直接用的；「预留」项当前不可用
# （TokenHub 数据面无音频端点），选中后 app 服务端自动回落可用通道。

MODEL_OPTIONS = {
    "text": [
        {"v": "deepseek/deepseek-flash", "n": "DeepSeek Flash（已实测·推荐）"},
        {"v": "glm-5.3-flash", "n": "GLM-5.3 Flash（已实测）"},
        {"v": "hy4-preview", "n": "Hy4 Preview（未实测）"},
        {"v": "kimi-k3", "n": "Kimi K3（未实测）"},
        {"v": "minimax-m3", "n": "MiniMax M3（未实测）"},
        {"v": "glm-5.3-flashx", "n": "GLM-5.3 FlashX（未实测）"},
    ],
    "vision": [
        {"v": "deepseek/deepseek-v4-flash-vision-exp", "n": "DeepSeek V4 Flash Vision（已实测·推荐）"},
        {"v": "hy-vision-2.0-instruct", "n": "混元 Vision 2.0（已实测）"},
        {"v": "hunyuan-t1-vision-20250916", "n": "混元 T1 Vision（已实测）"},
        {"v": "glm-5v-turbo", "n": "GLM-5V Turbo（实测可调，输出偏慢）"},
    ],
    "asr": [
        {"v": "hy-asr-3.0-preview", "n": "混元 ASR 3.0（TokenHub·同池计费·推荐，需在控制台开通后付费）"},
        {"v": "qwen-audio-3.0-asr-flash", "n": "千问 ASR Flash（DashScope·自配/兜底通道）"},
    ],
    "tts": [
        {"v": "edge-tts", "n": "Edge TTS（免费·当前可用）"},
        {"v": "minimax-speech-02-hd", "n": "MiniMax Speech 02 HD（TokenHub·chat+audio 模态，需开通后付费）"},
        {"v": "qwen-tts", "n": "千问 TTS（预留·凭证未上收）"},
    ],
}


class DefaultModelsBody(BaseModel):
    text: str = ""
    vision: str = ""
    asr: str = ""
    tts: str = ""


@router.get("/api/admin-portal/tokenhub/models")
async def admin_get_default_models(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    return {"models": await tokenhub.get_default_models(db), "options": MODEL_OPTIONS}


@router.get("/api/admin-portal/tokenhub/platform-models")
async def admin_platform_models(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    """TokenHub 平台全量模型按四类分组（默认模型下拉的动态数据源）。

    精选条目（实测/推荐标注）在前，其余同类型平台模型按 id 排序在后。
    """
    await sync_tokenhub_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=400, detail="TokenHub 凭证未配置")
    try:
        groups = tokenhub.group_platform_models()
    except tokenhub.TokenHubError as e:
        raise HTTPException(status_code=502, detail=f"查询失败：{e.message}") from e
    out: dict[str, list[dict]] = {}
    for cat in ("text", "vision", "asr", "tts"):
        curated = list(MODEL_OPTIONS.get(cat, []))
        curated_ids = {o["v"] for o in curated}
        dyn = [
            {"v": m["id"], "n": m["name"] if m["name"] != m["id"] else m["id"]}
            for m in sorted(groups.get(cat, []), key=lambda x: x["id"])
            if m["id"] and m["id"] not in curated_ids
        ]
        out[cat] = curated + dyn
    return out


@router.post("/api/admin-portal/tokenhub/models")
async def admin_set_default_models(body: DefaultModelsBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    old = await tokenhub.get_default_models(db)
    await tokenhub.set_default_models(db, body.model_dump())
    new = await tokenhub.get_default_models(db)
    # 2026-10-10 晚：Key 已改回 BindType=all（不绑模型），换默认模型**无需轮换**——
    # 新默认经 /model-config 实时下发到 app（getSystemDefaultModels），文本/视觉改完即生效。
    return {"ok": True, "models": new, "rotation": None}


# ---------------- 用户管理（全部用户 + Key 全量信息 + 查询） ----------------

@router.get("/api/admin-portal/users")
async def admin_users_list(
    request: Request,
    q: str = "",
    state: str = "",
    used_min: str = "",
    used_max: str = "",
    remain_min: str = "",
    remain_max: str = "",
    credits_min: str = "",
    credits_max: str = "",
    last_active: str = "",
    expiry: str = "",
    sort: str = "usedToday",
    order: str = "desc",
    db=Depends(get_db),
    admin: str = Depends(require_admin_cookie),
):
    """全部用户 + Key 全量信息（远端 describe 60s 缓存、14 天用量扫描 10 分钟缓存）。"""
    data = await user_admin.collect_rows(db)
    rows = user_admin.apply_query(data["rows"], {
        "q": q, "state": state, "used_min": used_min, "used_max": used_max,
        "remain_min": remain_min, "remain_max": remain_max,
        "credits_min": credits_min, "credits_max": credits_max,
        "last_active": last_active, "expiry": expiry, "sort": sort, "order": order,
    })
    return {"rows": rows, "summary": data["summary"], "matched": len(rows)}


@router.get("/api/admin-portal/users/{user_id}/detail")
async def admin_user_detail(user_id: str, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    detail = await user_admin.user_detail(db, user_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return detail


class TokenHubSettingsBody(BaseModel):
    dailyCredits: int
    validityDays: int
    cycleUnit: str = "d"
    monthStartDay: int = 1


@router.get("/api/admin-portal/tokenhub/settings")
async def get_th_settings(db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    return await tokenhub.get_default_settings(db)


@router.post("/api/admin-portal/tokenhub/settings")
async def save_th_settings(body: TokenHubSettingsBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    if body.dailyCredits < 1 or body.validityDays < 1:
        raise HTTPException(status_code=400, detail="数值无效")
    if body.cycleUnit not in ("d", "m", "lifetime"):
        raise HTTPException(status_code=400, detail="重置周期无效")
    await tokenhub.set_default_settings(db, body.dailyCredits, body.validityDays,
                                        body.cycleUnit, body.monthStartDay)
    return {"ok": True}


class RenewBody(BaseModel):
    userId: str
    days: int


@router.post("/api/admin-portal/users/renew")
async def admin_renew_key(body: RenewBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    """续期：从当前到期日（或今天）起延长；到期被禁用的 Key 同时重新启用。"""
    await user_admin.sync_cfg(db)
    try:
        result = await tokenhub.renew_user_key(db, body.userId, body.days)
    except tokenhub.TokenHubError as e:
        raise HTTPException(status_code=502, detail=f"续期失败：{e.message}") from e
    user_admin._describe_cache.clear()
    return {"ok": True, **result}


class RotateBody(BaseModel):
    userId: str


@router.post("/api/admin-portal/tokenhub/rotate")
async def admin_rotate_key(body: RotateBody, db=Depends(get_db), admin: str = Depends(require_admin_cookie)):
    """手动轮换单个用户的 Key（继承剩余配额、换绑当前默认模型）。"""
    row = await tokenhub.get_user_key_row(db, body.userId)
    if not row:
        raise HTTPException(status_code=404, detail="该用户尚无 TokenHub Key")
    if row["pending_delete_key_id"]:
        raise HTTPException(status_code=409, detail="该 Key 刚轮换过（30 分钟平滑窗口内），请稍后再试")
    defaults = await tokenhub.get_default_models(db)
    result = await tokenhub.rotate_user_key(db, row, defaults["text"], defaults["vision"])
    return {"ok": True, **result}


# ---------------- 页面 ----------------

@router.get("/admin/login", response_class=HTMLResponse)
async def admin_login_page():
    return HTMLResponse(_login_page_html())


@router.get("/admin/tokenhub", response_class=HTMLResponse)
async def admin_tokenhub_page(request: Request):
    try:
        await require_admin_cookie(request)
    except HTTPException:
        return RedirectResponse("/admin/login", status_code=303)
    return HTMLResponse(_dashboard_html())


def _code_mail_html(code: str) -> str:
    return f"""<!DOCTYPE html><html><body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
<h3 style="margin-bottom:8px;">🔐 管理后台登录验证码</h3>
<p style="color:#475569;font-size:14px;">有人正在使用账号密码登录学习伙伴管理后台。<br>
如果是你本人，请在登录页输入以下验证码（5 分钟内有效）；否则请忽略本邮件并尽快修改密码。</p>
<p style="margin:20px 0;"><span style="font-size:34px;font-weight:800;letter-spacing:10px;
background:#f1f5f9;padding:10px 22px;border-radius:10px;">{code}</span></p>
<p style="color:#94a3b8;font-size:12px;">学习伙伴 · 权益认证中台</p>
</body></html>"""


def _login_page_html() -> str:
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理后台登录 · 学习伙伴</title>
<style>
:root{--pri:#3b82f6;--pri-h:#2563eb;--card:#1e293b;--line:#334155;--txt:#e2e8f0;--sub:#94a3b8}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;color:var(--txt)}
.card{background:var(--card);border-radius:16px;padding:36px;width:390px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h3{margin-bottom:6px;font-size:18px} .lead{color:var(--sub);font-size:13px;margin-bottom:20px;line-height:1.7}
label{display:block;font-size:13px;color:#cbd5e1;margin:12px 0 6px}
input{width:100%;border:1.5px solid var(--line);border-radius:9px;padding:11px 13px;font-size:14px;
background:#0f172a;color:var(--txt);outline:none;transition:border-color .15s}
input:focus{border-color:var(--pri);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
.code{font-size:22px;letter-spacing:10px;text-align:center;font-weight:700}
button{width:100%;margin-top:20px;border:none;border-radius:10px;padding:12px;font-size:15px;
font-weight:700;background:var(--pri);color:#fff;cursor:pointer;transition:background .15s}
button:hover{background:var(--pri-h)}
button:disabled{background:#334155;cursor:not-allowed}
.tip{margin-top:14px;font-size:13px;line-height:1.6;min-height:20px}
.tip.ok{color:#4ade80}.tip.err{color:#f87171}.tip.wait{color:#fbbf24}
.hidden{display:none}
</style></head><body><div class="card">
<div id="step1">
<h3>🔐 管理后台</h3>
<p class="lead">账号密码登录；已配置邮箱验证时会向管理员邮箱发送 6 位验证码（5 分钟内有效）。<br>
首次部署未配置邮箱验证时，账密通过后直接进入后台。</p>
<form id="f">
<label>账号</label><input id="u" autocomplete="username" required>
<label>密码</label><input id="p" type="password" autocomplete="current-password" required>
<button id="b" type="submit">登录</button>
</form>
<div class="tip" id="tip"></div>
</div>
<div id="step2" class="hidden">
<h3>✉️ 邮箱验证码</h3>
<p class="lead">验证码已发送到 <b id="mail-to"></b>（5 分钟内有效）</p>
<form id="fv">
<label>6 位验证码</label><input id="code" class="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" required>
<button id="bv" type="submit">验证并进入后台</button>
</form>
<div class="tip" id="tip2"></div>
</div>
<script>
const $ = id => document.getElementById(id);
const setTip = (t, cls) => { const e = $("tip"); e.textContent = t; e.className = "tip " + (cls||""); };
let CH = "";
$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("b").disabled = true; setTip("验证中…");
  try {
    const res = await fetch("/api/admin-portal/login", { method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ username: $("u").value, password: $("p").value }) });
    const j = await res.json();
    if (!res.ok) { setTip(j.detail || "登录失败", "err"); $("b").disabled = false; return; }
    if (j.status === "approved") { location.href = "/admin/tokenhub"; return; }   // 单因素降级直进
    CH = j.challenge; $("mail-to").textContent = j.email || "管理员邮箱";
    $("step1").classList.add("hidden"); $("step2").classList.remove("hidden");
    $("code").focus();
  } catch (err) { setTip("网络错误", "err"); $("b").disabled = false; }
});
$("fv").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("bv").disabled = true; setTip2("验证中…");
  try {
    const res = await fetch("/api/admin-portal/verify", { method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ challenge: CH, code: $("code").value.trim() }) });
    const j = await res.json();
    if (!res.ok) { setTip2(j.detail || "验证失败", "err"); $("bv").disabled = false; return; }
    location.href = "/admin/tokenhub";
  } catch (err) { setTip2("网络错误", "err"); $("bv").disabled = false; }
});
function setTip2(t, cls) { const e = $("tip2"); e.textContent = t; e.className = "tip " + (cls||""); }
</script></div></body></html>"""


def _dashboard_html() -> str:
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理后台 · 学习伙伴</title>
<style>
:root{--pri:#2563eb;--pri-h:#1d4ed8;--bg:#f1f5f9;--card:#ffffff;--line:#e2e8f0;
--txt:#0f172a;--sub:#475569;--mut:#94a3b8;--ok:#16a34a;--warn:#d97706;--danger:#dc2626;--r:12px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:var(--bg);color:var(--txt);display:flex;min-height:100vh}
/* ---- 侧边菜单 ---- */
.side{width:208px;background:#0f172a;color:#cbd5e1;padding:22px 14px;flex-shrink:0}
.side h3{color:#fff;font-size:15px;padding:0 10px 16px;border-bottom:1px solid #1e293b;margin-bottom:14px;line-height:1.5}
.mitem{display:block;width:100%;text-align:left;border:none;background:none;color:#94a3b8;
padding:11px 14px;border-radius:9px;font-size:13.5px;cursor:pointer;margin-bottom:4px;transition:background .15s,color .15s}
.mitem:hover{background:#1e293b;color:#e2e8f0}
.mitem.on{background:var(--pri);color:#fff;font-weight:600}
.side .foot{margin-top:22px;padding:0 10px;font-size:11px;color:#475569;line-height:1.7}
/* ---- 主区 ---- */
.main{flex:1;padding:28px 32px;min-width:0}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;gap:12px}
h2{font-size:20px;margin-bottom:4px}
.lead{color:var(--mut);font-size:13px;margin-bottom:4px;line-height:1.6}
/* ---- 通用组件 ---- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;margin-bottom:18px}
.panel h4{font-size:14.5px;margin-bottom:6px}
.panel .d{color:var(--sub);font-size:12.5px;margin-bottom:12px;line-height:1.7}
.panel label{display:block;font-size:12.5px;color:var(--sub);margin:10px 0 5px;font-weight:500}
.panel input,.panel select{width:100%;max-width:440px;border:1px solid var(--line);border-radius:8px;
padding:9px 12px;font-size:13px;outline:none;background:#fff;color:var(--txt);transition:border-color .15s}
.panel input:focus,.panel select:focus{border-color:var(--pri);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.row{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
button{border:none;border-radius:8px;padding:8px 15px;font-size:12.5px;font-weight:600;cursor:pointer;
transition:background .15s,opacity .15s}
button:hover{opacity:.88}
.q{background:var(--pri);color:#fff}.g{background:#fff;border:1px solid var(--line);color:var(--sub)}
.off{background:#fef3c7;color:#92400e}.on{background:#dcfce7;color:#15803d}
.del{background:#fee2e2;color:#b91c1c}
.tip{font-size:12.5px;margin-top:2px;min-height:16px;line-height:1.5}
.tip.ok{color:var(--ok)}.tip.err{color:var(--danger)}
.state{font-size:12px;padding:3px 9px;border-radius:6px;display:inline-block;font-weight:600}
.st-ok{background:#dcfce7;color:#15803d}.st-env{background:#dbeafe;color:#1d4ed8}.st-no{background:#fee2e2;color:#b91c1c}
.warn{background:#fef9c3;border:1px solid #fde047;color:#854d0e;border-radius:10px;
padding:11px 15px;font-size:13px;margin-bottom:16px;line-height:1.6}
/* ---- 统计卡 ---- */
.cards{display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:15px 20px;min-width:150px}
.stat .n{font-size:22px;font-weight:800}
.stat .l{color:var(--mut);font-size:12px;margin-top:3px}
/* ---- 表格 ---- */
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:var(--r);overflow:hidden;
border:1px solid var(--line);margin-bottom:8px}
th,td{padding:11px 13px;font-size:13px;text-align:left;border-bottom:1px solid #f1f5f9;vertical-align:top}
th{background:#f8fafc;color:var(--sub);font-size:12px;font-weight:600}
tbody tr:hover{background:#f8fafc}
.bar{background:var(--line);border-radius:6px;height:8px;width:110px;display:inline-block;vertical-align:middle}
.bar i{display:block;height:8px;border-radius:6px;background:var(--pri)}
.pct{font-size:12px;color:var(--sub);margin-left:6px}
.mut{color:var(--mut);font-size:12px}
.err{color:var(--danger);font-size:12px}
code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:12px}
.page{display:none}.page.on{display:block}
.fbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fbar input,.fbar select{border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12.5px;background:#fff;outline:none}
.fbar input:focus,.fbar select:focus{border-color:var(--pri)}
.modal-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px}
.modal-card{background:#fff;border-radius:14px;padding:24px;max-width:680px;width:100%;max-height:82vh;overflow:auto}
.modal-card h4{margin-bottom:8px}
.modal-card .kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:12.5px;margin-bottom:10px}
.modal-card .kv b{color:var(--sub);font-weight:600}
.modal-card .sec{border-top:1px solid var(--line);margin:12px 0;padding-top:10px;font-weight:700;font-size:13px}
@media (max-width:860px){body{flex-direction:column}.side{width:100%;padding:14px}.main{padding:20px 16px}}
</style></head><body>
<div class="side">
  <h3>🧊 学习伙伴<br>管理后台</h3>
  <button class="mitem on" id="m-tokenhub" onclick="switchMenu('tokenhub')">🧊 TokenHub</button>
  <button class="mitem" id="m-users" onclick="switchMenu('users')">👥 用户管理</button>
  <button class="mitem" id="m-security" onclick="switchMenu('security')">🔒 安全设置</button>
  <div class="foot">benefit-auth ·<br>每家长一把托管 Key<br>初始日配额 <span id="defq-side">…</span> tokens</div>
</div>
<div class="main">

  <!-- ============ TokenHub 菜单 ============ -->
  <div class="page on" id="p-tokenhub">
    <div class="topbar">
      <div><h2>TokenHub 模型服务</h2>
      <p class="lead">每家长一把托管 API Key · 凭证可在此页配置（DB 优先，env 兜底）· 禁用/删除约 8 秒生效</p></div>
      <button class="g" onclick="logout()">退出登录</button>
    </div>

    <div class="panel">
      <h4>🔑 TokenHub 凭证（腾讯云 CAM SecretId / SecretKey）</h4>
      <div class="d">用于调用 TokenHub 管控 API（发 Key / 调额 / 禁用）。当前状态：
        <span class="state" id="th-state">…</span>
        <span class="mut" id="th-sid"></span>
      </div>
      <label>SecretId（AKID…）</label><input id="th-ak" placeholder="">
      <label>SecretKey（留空 = 不修改已保存值）</label><input id="th-sk" type="password">
      <div class="row">
        <button class="q" onclick="saveThCfg()">保存凭证</button>
        <button class="g" onclick="testThCfg()">测试连通</button>
        <span class="tip" id="th-tip"></span>
      </div>
    </div>

    <div class="panel">
      <h4>🎛️ 默认模型</h4>
      <div class="d">
        四类默认模型，下拉含<b>平台全部同类型模型</b>（精选实测项在前，其余按 id 排列）。
        保存后<b>实时下发</b>到各 app（文本 / 视觉 / 编程 agent 的系统默认 + 语音识别通道模型），
        无需轮换。语音转录走 TokenHub asrproxy 专用端点（与文本同池计费，需在控制台开通后付费）；
        语音合成为 Edge TTS（免费）或 TokenHub Speech 类模型（chat+audio 模态）。
      </div>
      <label>文本模型（助手对话 / 编程 agent）</label><select id="dm-text"></select>
      <label>视觉模型（读图 / 教材截图）</label><select id="dm-vision"></select>
      <label>语音转录模型（ASR）</label><select id="dm-asr"></select>
      <label>语音合成模型（TTS）</label><select id="dm-tts"></select>
      <div class="row">
        <button class="q" onclick="saveModels()">保存默认模型</button>
        <span class="tip" id="dm-tip"></span>
      </div>
    </div>

    <div class="panel">
      <h4>🎓 新用户初始配额与有效期</h4>
      <div class="d">新用户注册（抖音扫码）时自动发放 Key：按此<b>初始 Token 量</b>、<b>重置周期</b>和<b>有效期</b>执行，
      并绑定上方「默认模型」的文本/视觉模型（+向量模型）。到期后 Key 自动禁用（约 8 秒生效），
      可在「👥 用户管理」中对单个用户<b>调额</b>、<b>续期</b>。修改只影响之后新注册/新发放的 Key，存量 Key 不变。</div>
      <label>新用户初始 Token 量（每周期）</label><input id="set-credits" type="number" min="1">
      <label>重置周期</label>
      <select id="set-cycle" onchange="$('set-msd-row').style.display=this.value==='m'?'':'none'">
        <option value="d">按日重置（每天 0 点恢复）</option>
        <option value="m">按月重置（每月起始日恢复）</option>
        <option value="lifetime">总量（不重置，用完即止）</option>
      </select>
      <div id="set-msd-row" style="display:none">
        <label>每月起始日（1~31，小月自动取月末）</label><input id="set-msd" type="number" min="1" max="31" value="1">
      </div>
      <label>有效期（天）</label><input id="set-validity" type="number" min="1">
      <div class="row">
        <button class="q" onclick="saveThSettings()">保存</button>
        <span class="tip" id="thset-tip"></span>
      </div>
    </div>

    <div class="panel">
      <h4>🧾 用户与 Key 名册</h4>
      <div class="d">全部用户的 Key 信息与查询（按配额区间/最近使用等筛选、详情弹窗、CSV 导出、单 Key 调额/轮换/续期）已移至「👥 用户管理」菜单。</div>
      <div class="row"><button class="q" onclick="switchMenu('users')">前往用户管理</button></div>
    </div>

    <div class="panel">
      <h4>📊 按模型用量（官方口径 · 账号整体）</h4>
      <div class="d">腾讯 DescribeUsageRankList Dimension=model 实测支持：按模型汇总全部用户 Key 的 token 消耗
      （分钟级以上到账延迟；<b>账号整体口径，不能按家长拆分</b>——家长级实时拆分见 app 配额面板的本地统计）。
      可据此核对文本 / 视觉 / 语音各类模型的实际消耗。</div>
      <div class="row">
        <select id="um-days" style="width:auto">
          <option value="1">今日</option>
          <option value="7" selected>近 7 天</option>
          <option value="14">近 14 天</option>
          <option value="30">近 30 天</option>
        </select>
        <button class="q" onclick="loadUsageModels()">查询</button>
        <span class="tip" id="um-tip"></span>
      </div>
      <div id="um-wrap" style="display:none">
        <table><thead><tr>
          <th>模型</th><th>输入 tokens</th><th>输出 tokens</th><th>合计 tokens</th>
        </tr></thead><tbody id="um-rows"></tbody></table>
      </div>
    </div>
  </div>

  <!-- ============ 用户管理菜单 ============ -->
  <div class="page" id="p-users">
    <div class="topbar">
      <div><h2>👥 用户管理</h2>
      <p class="lead">全部注册用户与其 TokenHub Key 全量信息；支持关键字、状态、配额区间、最近使用等查询</p></div>
      <div class="row">
        <button class="g" onclick="exportUsersCsv()">导出 CSV</button>
        <button class="g" onclick="loadUsers(true)">强制刷新</button>
        <button class="g" onclick="logout()">退出登录</button>
      </div>
    </div>

    <div class="cards">
      <div class="stat"><div class="n" id="u-total">-</div><div class="l">注册用户</div></div>
      <div class="stat"><div class="n" id="u-withkey">-</div><div class="l">已发放 Key</div></div>
      <div class="stat"><div class="n" id="u-used14">-</div><div class="l">近14天总消耗（官方·有延迟）</div></div>
      <div class="stat"><div class="n" id="u-abn">-</div><div class="l">异常/耗尽</div></div>
    </div>

    <div class="panel">
      <div class="fbar">
        <input id="fq" placeholder="关键字：邮箱/昵称/用户ID/Key" style="min-width:220px">
        <select id="fstate">
          <option value="">全部状态</option><option value="active">正常</option>
          <option value="exhausted">额度耗尽</option><option value="disabled">已禁用</option>
          <option value="abnormal">管控异常</option><option value="nokey">未发放 Key</option>
        </select>
        <input id="fused-min" type="number" placeholder="当日已用≥" style="width:110px">
        <input id="fused-max" type="number" placeholder="当日已用≤" style="width:110px">
        <input id="fremain-min" type="number" placeholder="剩余≥" style="width:100px">
        <input id="fremain-max" type="number" placeholder="剩余≤" style="width:100px">
        <select id="flast">
          <option value="">最近使用不限</option><option value="7d">7 天内用过</option>
          <option value="14d">14 天内用过</option><option value="stale">14 天未用</option>
          <option value="never">从未使用</option>
        </select>
        <select id="fexp">
          <option value="">有效期不限</option><option value="expiring">7 天内到期</option>
          <option value="expired">已到期</option>
        </select>
        <select id="fsort">
          <option value="usedToday">按当日用量</option><option value="remain">按剩余配额</option>
          <option value="credits">按配额档位</option><option value="tokens14d">按14天用量</option>
          <option value="lastActive">按最近使用</option><option value="expiresAt">按有效期</option>
          <option value="created">按注册/发放时间</option>
        </select>
        <select id="forder"><option value="desc">降序</option><option value="asc">升序</option></select>
        <button class="q" onclick="loadUsers(true)">查询</button>
        <button class="g" onclick="resetUsers()">重置</button>
      </div>
      <span class="tip" id="u-tip"></span>
    </div>

    <table><thead><tr>
    <th>用户</th><th>注册/发放</th><th>状态</th><th>Key（前几位）</th><th>当日已用 / 配额</th><th>剩余</th><th>有效期</th><th>近14天用量·活跃</th><th>最近使用</th><th>操作</th>
    </tr></thead><tbody id="urows"><tr><td colspan="10" class="mut">加载中…</td></tr></tbody></table>
    <p class="mut">最近使用时间来自腾讯用量统计（按天粒度，有分钟级以上延迟）；「详情」可查看该 Key 的全部信息（绑定模型 / IP 白名单 / 限额包时间等）。</p>

    <div id="u-modal" class="modal-ov" style="display:none" onclick="if(event.target===this)this.style.display='none'">
      <div class="modal-card" id="u-modal-body"></div>
    </div>

    <div id="q-modal" class="modal-ov" style="display:none" onclick="if(event.target===this)this.style.display='none'">
      <div class="modal-card" style="max-width:440px">
        <h4>🎚️ 配额调整（即时生效）</h4>
        <div class="d">用户：<b id="q-user"></b></div>
        <label>配额（tokens / 每周期）</label><input id="q-credits" type="number" min="1">
        <label>重置周期</label>
        <select id="q-cycle" onchange="qCycleChange()">
          <option value="keep">保持现有周期</option>
          <option value="d">按日重置（每天 0 点恢复）</option>
          <option value="m">按月重置（每月起始日恢复）</option>
          <option value="lifetime">总量（不重置，用完即止）</option>
        </select>
        <div id="q-msd-row" style="display:none">
          <label>每月起始日（1~31）</label><input id="q-msd" type="number" min="1" max="31" value="1">
        </div>
        <div class="tip" id="q-tip"></div>
        <div class="row" style="margin-top:14px">
          <button class="q" onclick="saveQuota()">保存</button>
          <button class="g" onclick="closeQuota()">取消</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ============ 安全设置菜单 ============ -->
  <div class="page" id="p-security">
    <div class="topbar">
      <div><h2>管理员安全设置</h2>
      <p class="lead">登录密码与二次验证（邮箱 SMTP）</p></div>
      <button class="g" onclick="logout()">退出登录</button>
    </div>

    <div class="warn" id="smtp-warn" style="display:none">
      ⚠️ 邮箱二次验证未配置：当前登录仅密码单因素。请在下方填入 QQ 邮箱授权码并保存——保存后立即启用邮箱验证码二次验证。
    </div>

    <div class="panel">
      <h4>📧 二次验证邮箱（SMTP）</h4>
      <div class="d">启用后，管理员登录需输入发送到邮箱的 6 位验证码（5 分钟有效）。
      SMTP 服务商固定 QQ（smtp.qq.com:465）；「授权码」在 QQ 邮箱 设置→账户→开启 SMTP 服务 后生成（不是邮箱登录密码）。<br>
      当前状态：<span class="state" id="smtp-state">…</span>　接收邮箱：<b id="admin-name">…</b></div>
      <label>发件邮箱</label><input id="smtp-user" placeholder="79734745@qq.com">
      <label>授权码（留空 = 不修改已保存值）</label><input id="smtp-code" type="password">
      <div class="row">
        <button class="q" onclick="saveSmtp()">保存并启用二次验证</button>
        <button class="g" onclick="testSmtp()">发送测试邮件</button>
        <span class="tip" id="smtp-tip"></span>
      </div>
    </div>

    <div class="panel">
      <h4>🔑 修改管理员密码</h4>
      <div class="d">管理后台登录密码（与邮箱验证码相互独立）</div>
      <label>旧密码</label><input id="old-pwd" type="password">
      <label>新密码（至少 6 位）</label><input id="new-pwd" type="password">
      <div class="row">
        <button class="q" onclick="changePwd()">修改密码</button>
        <span class="tip" id="pwd-tip"></span>
      </div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const H = {"Content-Type":"application/json"};
const fmt = n => (n || 0).toLocaleString("zh-CN");
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tip = (id, t, cls) => { const e = $(id); e.textContent = t; e.className = "tip " + (cls||""); };

let usersLoaded = false;
function switchMenu(name) {
  for (const p of ["tokenhub", "users", "security"]) {
    $("p-" + p).classList.toggle("on", p === name);
    $("m-" + p).classList.toggle("on", p === name);
  }
  if (name === "security") loadSecurity();
  if (name === "users" && !usersLoaded) { loadUsers(); usersLoaded = true; }
}

/* ---------- TokenHub 凭证 ---------- */
async function loadThCfg() {
  const res = await fetch("/api/admin-portal/tokenhub/config");
  if (res.status === 401) { location.href = "/admin/login"; return; }
  const j = await res.json();
  const st = $("th-state");
  if (j.source === "db") { st.textContent = "已配置（页面保存）"; st.className = "state st-ok"; }
  else if (j.source === "env") { st.textContent = "env 兜底（建议在页面保存一份）"; st.className = "state st-env"; }
  else { st.textContent = "未配置"; st.className = "state st-no"; }
  $("th-sid").textContent = j.secretIdMasked ? "当前 SecretId：" + j.secretIdMasked : "";
  $("th-ak").value = j.source === "db" ? (j.secretId || "") : "";
  $("th-ak").placeholder = j.secretIdMasked || "AKID…";
}
async function saveThCfg() {
  const res = await fetch("/api/admin-portal/tokenhub/config", { method: "POST", headers: H,
    body: JSON.stringify({ secretId: $("th-ak").value, secretKey: $("th-sk").value }) });
  const j = await res.json();
  tip("th-tip", j.ok ? `✅ 已保存（${j.secretIdMasked}）` : "保存失败", j.ok ? "ok" : "err");
  $("th-sk").value = "";
  loadThCfg();
}
async function testThCfg() {
  tip("th-tip", "连通测试中…");
  const res = await fetch("/api/admin-portal/tokenhub/test", { method: "POST" });
  const j = await res.json();
  tip("th-tip", res.ok ? `✅ 连通成功（账号下现有 ${j.keyCount} 个 Key，${j.secretIdMasked}）` : (j.detail || "连通失败"), res.ok ? "ok" : "err");
}

/* ---------- 默认模型（四下拉；选项 = 精选 + 平台全量动态合并） ---------- */
const DM_OPTIONS = __DM_OPTIONS__;
let dmLoaded = null;
async function loadModels() {
  const [res, optRes] = await Promise.all([
    fetch("/api/admin-portal/tokenhub/models"),
    fetch("/api/admin-portal/tokenhub/platform-models").catch(() => null),
  ]);
  if (res.status === 401) { location.href = "/admin/login"; return; }
  const j = await res.json();
  let options = DM_OPTIONS; // 平台模型拉取失败时回落精选静态清单
  if (optRes && optRes.ok) {
    try { options = await optRes.json(); } catch (e) { /* 回落静态 */ }
  }
  for (const cat of ["text", "vision", "asr", "tts"]) {
    const sel = $("dm-" + cat);
    sel.innerHTML = "";
    const opts = options[cat] || [];
    const curatedN = (DM_OPTIONS[cat] || []).length;
    const dynN = opts.length - curatedN;
    for (let i = 0; i < opts.length; i++) {
      if (i === curatedN && dynN > 0) {
        const g = document.createElement("optgroup");
        g.label = "—— 平台全部同类型模型 ——";
        sel.appendChild(g);
      }
      const o = opts[i];
      const op = document.createElement("option");
      op.value = o.v;
      op.textContent = o.n + "  ·  " + o.v;
      const group = sel.querySelector("optgroup:last-of-type");
      (i >= curatedN && dynN > 0 && group ? group : sel).appendChild(op);
    }
    const cur = (j.models || {})[cat];
    if (cur && ![...sel.querySelectorAll("option")].some(o => o.value === cur)) {
      const op = document.createElement("option");
      op.value = cur; op.textContent = "（自定义）" + cur;
      sel.appendChild(op);
    }
    sel.value = cur || (opts[0] && opts[0].v) || "";
  }
  dmLoaded = { text: $("dm-text").value, vision: $("dm-vision").value };
}
async function saveModels() {
  const next = { text: $("dm-text").value, vision: $("dm-vision").value, asr: $("dm-asr").value, tts: $("dm-tts").value };
  const res = await fetch("/api/admin-portal/tokenhub/models", { method: "POST", headers: H, body: JSON.stringify(next) });
  const j = await res.json();
  if (!j.ok) { tip("dm-tip", "保存失败", "err"); return; }
  tip("dm-tip", "✅ 默认模型已保存（实时下发各 app：文本/视觉改完即生效，无需轮换）", "ok");
  loadModels();
  load();
}
async function rotateUser(userId) {
  if (!confirm("轮换该家长的 Key：换绑当前默认模型并继承剩余配额（旧 Key 30 分钟后回收），确认？")) return;
  const res = await fetch("/api/admin-portal/tokenhub/rotate", { method: "POST", headers: H,
    body: JSON.stringify({ userId }) });
  const j = await res.json();
  alert(j.ok ? `✅ 已轮换：新 Key ${j.newKeyId.slice(0, 24)}…（继承 ${fmt(j.inheritedCredits)} tokens）` : "失败: " + (j.detail || res.status));
  load();
}

/* ---------- 新用户初始配额与有效期 ---------- */
async function loadThSettings() {
  const res = await fetch("/api/admin-portal/tokenhub/settings");
  if (res.status === 401) { location.href = "/admin/login"; return; }
  const j = await res.json();
  $("set-credits").value = j.dailyCredits || 5000000;
  $("set-validity").value = j.validityDays || 365;
  $("set-cycle").value = j.cycleUnit || "d";
  $("set-msd").value = j.monthStartDay || 1;
  $("set-msd-row").style.display = ($("set-cycle").value === "m") ? "" : "none";
  $("defq-side").textContent = fmt(j.dailyCredits);
}
async function saveThSettings() {
  const res = await fetch("/api/admin-portal/tokenhub/settings", { method: "POST", headers: H,
    body: JSON.stringify({ dailyCredits: parseInt($("set-credits").value, 10),
                           validityDays: parseInt($("set-validity").value, 10),
                           cycleUnit: $("set-cycle").value,
                           monthStartDay: parseInt($("set-msd").value || "1", 10) }) });
  const j = await res.json();
  tip("thset-tip", j.ok ? "✅ 已保存：之后新注册/新发放的 Key 按此执行（存量 Key 不变）" : "保存失败: " + (j.detail || res.status), j.ok ? "ok" : "err");
}
/* ---------- 按模型用量（TokenHub 菜单；官方口径账号整体） ---------- */
async function loadUsageModels() {
  const tip = $("um-tip"), wrap = $("um-wrap"), tb = $("um-rows");
  tip.textContent = "查询中…"; wrap.style.display = "none";
  try {
    const res = await fetch("/api/admin-portal/tokenhub/usage-models?days=" + ($("um-days").value || "14"),
      { headers: H });
    const j = await res.json();
    if (!res.ok) { tip.textContent = j.detail || ("失败 " + res.status); return; }
    const rows = j.rows || [];
    if (!rows.length) { tip.textContent = "该区间暂无用量"; return; }
    const fmtW = (n) => n >= 10000 ? (n / 10000).toFixed(1) + " 万" : String(n || 0);
    tb.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.model}</td><td>${fmtW(r.input)}</td><td>${fmtW(r.output)}</td><td>${fmtW(r.total)}</td>`;
      tb.appendChild(tr);
    });
    tip.textContent = `${j.startTime} ~ ${j.endTime} · 共 ${rows.length} 个模型`;
    wrap.style.display = "";
  } catch (e) { tip.textContent = "请求失败：" + e; }
}

/* ---------- 配额调整 / 轮换（用户管理页调用；setQuota/rotateUser 全局可用） ---------- */
let qTarget = null;
function setQuota(userId, current, unit) {
  qTarget = { userId, unit: unit || "d" };
  const u = USERS.find(x => x.userId === userId) || {};
  $("q-user").textContent = u.userLabel || userId.slice(0, 8);
  $("q-credits").value = current || "";
  $("q-cycle").value = "keep";
  $("q-msd-row").style.display = "none";
  tip("q-tip", "");
  $("q-modal").style.display = "flex";
}
function closeQuota() { $("q-modal").style.display = "none"; }
function qCycleChange() { $("q-msd-row").style.display = $("q-cycle").value === "m" ? "" : "none"; }
async function saveQuota() {
  const credits = parseInt($("q-credits").value, 10);
  if (!(credits >= 1)) { tip("q-tip", "配额无效", "err"); return; }
  const cycle = $("q-cycle").value;
  const body = { userId: qTarget.userId, credits, cycleUnit: cycle === "keep" ? "" : cycle,
                 monthStartDay: parseInt($("q-msd").value || "1", 10) };
  const res = await fetch("/api/admin-portal/tokenhub/quota", { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) { tip("q-tip", j.detail || "保存失败", "err"); return; }
  tip("q-tip", "✅ 已保存（即时生效，自动恢复档位已清除）", "ok");
  setTimeout(() => { closeQuota(); loadUsers(); }, 600);
}
async function rotateUser(userId) {
  if (!confirm("轮换该家长的 Key：换绑当前默认模型并继承剩余配额（旧 Key 30 分钟后回收），确认？")) return;
  const res = await fetch("/api/admin-portal/tokenhub/rotate", { method: "POST", headers: H,
    body: JSON.stringify({ userId }) });
  const j = await res.json();
  alert(j.ok ? "✅ 已轮换，新 Key " + j.newKeyId.slice(0, 24) + "…" : "失败: " + (j.detail || res.status));
  if (typeof loadUsers === "function" && $("p-users").classList.contains("on")) loadUsers();
}

/* ---------- 安全设置 ---------- */
async function loadSecurity() {
  const res = await fetch("/api/admin-portal/smtp");
  if (res.status === 401) { location.href = "/admin/login"; return; }
  const j = await res.json();
  $("smtp-user").value = j.source === "db" ? (j.smtpUser || "") : "";
  $("smtp-user").placeholder = j.smtpUser || "79734745@qq.com";
  const st = $("smtp-state");
  if (j.source === "db") { st.textContent = `已启用（${j.authCodeMasked}）`; st.className = "state st-ok"; }
  else if (j.source === "env") { st.textContent = "env 兜底（建议在页面保存一份）"; st.className = "state st-env"; }
  else { st.textContent = "未配置（当前仅密码单因素）"; st.className = "state st-no"; }
  $("smtp-warn").style.display = j.source === "none" ? "" : "none";
  $("admin-name").textContent = j.adminEmail || "…";
}
async function saveSmtp() {
  const res = await fetch("/api/admin-portal/smtp", { method: "POST", headers: H,
    body: JSON.stringify({ smtpUser: $("smtp-user").value, authCode: $("smtp-code").value }) });
  const j = await res.json();
  tip("smtp-tip", j.ok ? (j.ready ? "✅ 已保存，二次验证已启用（下次登录需输入邮箱验证码）" : "已保存（凭证仍不完整）") : "保存失败: " + (j.detail || res.status), j.ok ? "ok" : "err");
  $("smtp-code").value = "";
  loadSecurity();
}
async function testSmtp() {
  tip("smtp-tip", "发送中…");
  const res = await fetch("/api/admin-portal/smtp/test", { method: "POST" });
  const j = await res.json();
  tip("smtp-tip", res.ok ? `✅ 测试邮件已发送到 ${j.to}` : (j.detail || "发送失败"), res.ok ? "ok" : "err");
}
async function changePwd() {
  const oldV = $("old-pwd").value, newV = $("new-pwd").value;
  if (newV.length < 6) { tip("pwd-tip", "新密码至少 6 位", "err"); return; }
  const res = await fetch("/api/admin-portal/change-password", { method: "POST", headers: H,
    body: JSON.stringify({ oldPassword: oldV, newPassword: newV }) });
  const j = await res.json();
  if (j.ok) { tip("pwd-tip", "✅ 密码已修改，下次登录生效", "ok"); $("old-pwd").value = ""; $("new-pwd").value = ""; }
  else tip("pwd-tip", j.detail || "修改失败", "err");
}
async function logout() {
  await fetch("/api/admin-portal/logout", { method: "POST" });
  location.href = "/admin/login";
}

/* ---------- 用户管理 ---------- */
let USERS = [];
  const STATE_TXT = { active:"✅ 正常", exhausted:"⛔ 额度耗尽", disabled:"⛔ 已禁用", expired:"⏰ 已到期", abnormal:"⚠️ 管控异常", nokey:"—" };
const UNIT_TXT = { d:"每日重置", m:"每月重置", lifetime:"总量不重置" };
async function loadUsers(force) {
  const p = new URLSearchParams({
    q: $("fq").value, state: $("fstate").value,
    used_min: $("fused-min").value, used_max: $("fused-max").value,
    remain_min: $("fremain-min").value, remain_max: $("fremain-max").value,
    last_active: $("flast").value, expiry: $("fexp").value,
    sort: $("fsort").value, order: $("forder").value,
  });
  if (force) p.set("force", "1");
  const res = await fetch("/api/admin-portal/users?" + p.toString());
  if (res.status === 401) { location.href = "/admin/login"; return; }
  const j = await res.json();
  USERS = j.rows || [];
  $("u-total").textContent = fmt(j.summary.total);
  $("u-withkey").textContent = fmt(j.summary.withKey);
  $("u-used14").textContent = fmt(j.summary.tokens14d);
  $("u-abn").textContent = fmt(j.summary.abnormal);
  const tb = $("urows");
  tb.innerHTML = "";
  if (!USERS.length) { tb.innerHTML = '<tr><td colspan="9" class="mut">没有符合条件的用户</td></tr>'; return; }
  USERS.forEach(u => {
    const tr = document.createElement("tr");
    const rate = u.credits ? Math.min(100, Math.round(u.usedToday / u.credits * 100)) : 0;
    const stTxt = u.hasKey ? (STATE_TXT[u.state] || u.state) : "— 未发放";
    const expTxt = !u.hasKey ? "—" : (!u.expiresAt ? "长期" :
      (u.daysLeft !== null && u.daysLeft !== undefined && u.daysLeft < 0 ? "已到期" : u.expiresAt + `<div class="mut">剩 ${u.daysLeft} 天</div>`));
    tr.innerHTML = `
      <td>${esc(u.userLabel)}<div class="mut">${u.nickname ? esc(u.nickname)+" · " : ""}${u.userId.slice(0,8)}</div></td>
      <td class="mut">${(u.registeredAt||"").slice(0,10)}<div>${u.hasKey ? "发放 " + (u.keyCreatedAt||"").slice(0,10) : ""}</div></td>
      <td>${stTxt}</td>
      <td>${u.hasKey ? "<code>"+u.keyMasked+"</code>" : "—"}</td>
      <td>${fmt(u.usedToday)} / ${fmt(u.credits)}<div class="mut">${UNIT_TXT[u.quotaCycleUnit] || "每周期"}</div>
        <div class="bar" style="width:90px"><i style="width:${rate}%"></i></div></td>
      <td>${fmt(u.remain)}</td>
      <td>${expTxt}</td>
      <td>${fmt(u.tokens14d)}<div class="mut">活跃 ${u.activeDays14d} 天</div></td>
      <td>${u.lastActive || "—"}</td>
      <td>
        <button class="g" onclick="userDetail('${u.userId}')">详情</button>
        ${u.hasKey ? `<button class="q" onclick="setQuota('${u.userId}', ${u.credits}, '${u.quotaCycleUnit}')">调额</button>
        <button class="g" onclick="renewUser('${u.userId}')">续期</button>
        <button class="g" onclick="rotateUser('${u.userId}')">轮换</button>` : ""}
      </td>`;
    tb.appendChild(tr);
  });
  tip("u-tip", `匹配 ${USERS.length} 个用户 / 全部 ${j.summary.total} 个`);
}
function resetUsers() {
  ["fq","fused-min","fused-max","fremain-min","fremain-max"].forEach(i => $(i).value = "");
  $("fstate").value = ""; $("flast").value = ""; $("fexp").value = "";
  $("fsort").value = "usedToday"; $("forder").value = "desc";
  loadUsers(true);
}
async function renewUser(userId) {
  const v = prompt("续期天数（从当前到期日或今天起延长；到期被禁用的 Key 将自动重新启用）：", "30");
  if (!v) return;
  const res = await fetch("/api/admin-portal/users/renew", { method: "POST", headers: H,
    body: JSON.stringify({ userId, days: parseInt(v, 10) }) });
  const j = await res.json();
  alert(j.ok ? "✅ 已续期至 " + j.expiresAt + (j.reEnabled ? "（Key 已重新启用）" : "") : "失败: " + (j.detail || res.status));
  loadUsers();
}
async function userDetail(userId) {
  const res = await fetch("/api/admin-portal/users/" + encodeURIComponent(userId) + "/detail");
  if (res.status === 401) { location.href = "/admin/login"; return; }
  const d = await res.json();
  const row = d.row || {}, full = d.full || {}, kr = d.keyRow || {};
  const kv = arr => arr.map(pair => `<b>${pair[0]}</b><span>${pair[1]}</span>`).join("");
  const bound = ((full.BindingItems || []).map(b => b.ResourceId)).concat((row.remote || {}).boundModels || []);
  $("u-modal-body").innerHTML = `
    <h4>👤 用户信息</h4>
    <div class="kv">${kv([
      ["用户ID", row.userId || (d.user||{}).id], ["邮箱", (d.user||{}).email || "—"],
      ["昵称", (d.user||{}).nickname || "—"], ["注册时间", (d.user||{}).created_at || "—"],
      ["201 parent_id", row.parentRef || "—"]])}</div>
    <div class="sec">🔑 TokenHub Key</div>
    <div class="kv">${row.hasKey ? kv([
      ["Key ID", row.keyId], ["Key（前几位）", row.keyMasked],
      ["DB 状态", row.keyDbStatus], ["网关状态", (row.remote||{}).keyStatus || "—"],
      ["创建时间", row.keyCreatedAt || "—"], ["腾讯侧更新", full.UpdateTime || (row.remote||{}).remoteUpdateTime || "—"],
      ["绑定方式", full.BindType || (row.remote||{}).bindType || "—"],
      ["绑定模型", (full.BindingItems || []).map(b => b.ResourceId).join("、") || (row.remote||{}).boundModels && (row.remote||{}).boundModels.join("、") || "（全模型）"],
      ["IP 白名单", (full.IpWhitelist || (row.remote||{}).ipWhitelist || []).length ? (full.IpWhitelist || (row.remote||{}).ipWhitelist).join("、") : "不限制"],
      ["账号 Uin/SubUin", (full.Uin || "—") + " / " + (full.SubUin || "—")],
      ["轮换状态", row.rotatedAt ? "最近轮换 " + row.rotatedAt : "未轮换"],
      ["待恢复档位", row.pendingRestore ? fmt(row.pendingRestore) + " tokens（次日起）" : "无"]]) : kv([["状态", "未发放 Key（首次使用模型时自动发放）"]])}</div>
    ${row.hasKey ? `<div class="sec">📊 配额与用量</div>
    <div class="kv">${kv([
      ["当日已用", fmt(row.usedToday) + " tokens"], ["配额档位", fmt(row.credits) + " tokens/天"],
      ["剩余", fmt(row.remain) + " tokens"], ["额度包状态", (row.remote||{}).quotaStatus || "—"],
      ["限额包周期", ((full.QuotaSet||[{}])[0].CycleUnit) || "—"],
      ["限额包生效", ((full.QuotaSet||[{}])[0].StartTime) || "—"],
      ["限额包到期", ((full.QuotaSet||[{}])[0].ExpireTime) || "—"],
      ["近14天用量", fmt(row.tokens14d) + " tokens（活跃 " + row.activeDays14d + " 天）"],
      ["最近使用", row.lastActive || "统计暂缺/未使用"],
      ["有效期", row.expiresAt ? (row.expiresAt + ((row.daysLeft !== null && row.daysLeft !== undefined && row.daysLeft < 0) ? "（已到期，可续期）" : "（剩 " + row.daysLeft + " 天）")) : "长期有效"]])}</div>` : ""}
    <div class="row"><button class="g" onclick="$('u-modal').style.display='none'">关闭</button></div>`;
  $("u-modal").style.display = "flex";
}
function exportUsersCsv() {
  const head = ["邮箱","昵称","用户ID","201parent_id","注册时间","状态","当日已用","配额","重置周期","剩余","近14天用量","14天活跃天","最近使用","KeyID","Key前几位","Key发放时间"];
  const lines = [head.join(",")];
  USERS.forEach(u => lines.push([u.email, u.nickname, u.userId, u.parentRef, u.registeredAt,
    u.state, u.usedToday, u.credits, (UNIT_TXT[u.quotaCycleUnit] || u.quotaCycleUnit || ""), u.remain, u.tokens14d, u.activeDays14d, u.lastActive,
    u.keyId, u.keyMasked, u.keyCreatedAt].map(v => '"' + String(v === null || v === undefined ? "" : v).split('"').join('""') + '"').join(",")));
  const blob = new Blob([String.fromCharCode(0xFEFF) + lines.join(String.fromCharCode(13, 10))], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "users-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
}

loadThCfg();
loadThSettings();
loadModels();
if (location.hash === "#users") { switchMenu("users"); }
</script></body></html>""".replace("__DM_OPTIONS__", json.dumps(MODEL_OPTIONS, ensure_ascii=False))
