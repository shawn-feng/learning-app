"""权益认证中台 - 独立认证服务入口（2026-09-21 方案A' 合并版：原 cloud-service 已并入）"""
import asyncio
import os
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from .database import init_db, get_db
from .poller import poll_loop
from .routers import account, admin, apps, cloud_auth, cloud_license, legacy, me, oauth, sync
from .pages import login_page, me_page

app = FastAPI(title="Benefit Auth Center", version="0.2.0")

# 静态资源（如官方账号抖音二维码 app/static/douyin-account-qr.jpg）
_STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

# 旧 cloud-service 合并：App 安装包分发目录（electron-updater 拉取 latest.yml/安装包）
DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "/opt/learning-cloud/download")
# 旧 /api/version 写接口的管理员 token（发布流水线用）
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

app.include_router(account.router)
app.include_router(admin.router)
app.include_router(apps.router)
app.include_router(me.router)
app.include_router(oauth.router)
app.include_router(legacy.router)
# 旧 cloud-service 兼容路由（老 LAN server 的认证上游 + 消息交换）
app.include_router(cloud_auth.router)
app.include_router(cloud_license.router)
app.include_router(sync.router)


@app.get("/admin/reviews", response_class=HTMLResponse)
async def admin_reviews_page(token: str = ""):
    """管理审核页（每日转发任务凭证审核兜底）"""
    return await admin.admin_page_html_view(token=token)


@app.on_event("startup")
async def startup():
    await init_db()
    # 每分钟自动检测任务完成（用户无需回站点「验证」）；campaign 循环已停用（被每日 cron 机制取代）
    asyncio.create_task(poll_loop())
    # App 安装包目录（/download/，nginx 正则放行）+ 种子版本
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    app.mount("/download", StaticFiles(directory=DOWNLOAD_DIR), name="download")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "benefit-auth", "merged": True}


# ---------- 页面 ----------
# 根路径与 /login 均为登录页（选择平台 → 扫码 → 登录），供 www / auth 入口复用
@app.get("/", response_class=HTMLResponse)
async def index():
    return login_page()


@app.get("/login", response_class=HTMLResponse)
async def login():
    return login_page()


@app.get("/me", response_class=HTMLResponse)
async def profile():
    return me_page()


# ---------- 旧 cloud-service：App 版本分发 ----------
_SEED_VERSION = {
    "version": "0.1.0",
    "release_date": "2026-08-12",
    "release_notes": "新增 AI 伙伴 emoji 配置，修复 API key 保存问题，增加云端同步和自动版本检测",
    "download_url": None,
    "min_version": "0.1.0",
}


class VersionRecord(BaseModel):
    version: str
    release_date: str
    release_notes: str = ""
    download_url: Optional[str] = None
    min_version: str = "0.0.0"


@app.get("/api/version")
async def app_version(db=Depends(get_db)):
    from .database import get_db as _gdb  # noqa: F401（占位避免循环导入提示）
    rows = await db.execute_fetchall(
        """SELECT version, release_date, release_notes, download_url, min_version
           FROM app_versions ORDER BY created_at DESC, version DESC LIMIT 1"""
    )
    if not rows:
        return _SEED_VERSION
    row = rows[0]
    return {
        "version": row["version"],
        "release_date": row["release_date"],
        "release_notes": row["release_notes"] or "",
        "download_url": row["download_url"],
        "min_version": row["min_version"],
    }


@app.post("/api/version")
async def set_app_version(rec: VersionRecord, request: Request, db=Depends(get_db)):
    """登记/更新 App 版本记录（发布新版本后调用；需要 X-Admin-Token 头）"""
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_TOKEN not configured on server")
    if request.headers.get("X-Admin-Token", "") != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid admin token")
    await db.execute(
        """INSERT INTO app_versions (version, release_date, release_notes, download_url, min_version)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(version) DO UPDATE SET
             release_date = excluded.release_date,
             release_notes = excluded.release_notes,
             download_url = excluded.download_url,
             min_version = excluded.min_version""",
        (rec.version, rec.release_date, rec.release_notes, rec.download_url, rec.min_version),
    )
    await db.commit()
    return {"success": True, "version": rec.version}



