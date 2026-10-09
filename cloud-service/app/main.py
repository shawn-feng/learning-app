"""学习伙伴云服务（合并版，2026-09-21 方案A）

learning-cloud（家长账号/订阅/版本/消息交换）+ benefit-auth（抖音登录 IdP/任务/权益）
合并为单服务：一个进程、一个数据库、一套部署。
对外 URL 与合并前完全一致（Electron / LAN server / nginx 无需改动）：
  /api/auth/* /api/license /api/version /api/sync /download   （原 learning-cloud）
  /oauth/* /api/me/* /api/app/* /api/account/* /api/admin/*   （原 benefit-auth）
"""
import os
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .database import init_db, get_db
from .auth import router as auth_router
from .license import router as license_router
from .sync import router as sync_router
# benefit-auth 合并路由（抖音登录 IdP / 个人中心 / 任务权益 / 管理端）
from .routers import account, admin, apps, me, oauth
from .pages import login_page, me_page

app = FastAPI(title="Learning App Cloud Service", version="0.2.0")

app.include_router(auth_router)
app.include_router(license_router)
app.include_router(sync_router)
app.include_router(account.router)
app.include_router(admin.router)
app.include_router(apps.router)
app.include_router(me.router)
app.include_router(oauth.router)

# ISSUE-040: App 安装包静态托管目录（electron-updater 从这里拉 latest.yml + 安装包 + blockmap）。
DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "/opt/learning-cloud/download")

# ISSUE-040: 版本登记接口的管理员 token（环境变量配置；未配置时写接口返回 503）
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

# 首次部署的种子版本（无任何登记记录时 /api/version 返回它，保持旧客户端兼容）
SEED_VERSION = {
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


# ---------- 网页页面（www 首页/登录 = 权益中台两栏页；个人中心 = 任务/权益） ----------
@app.get("/", response_class=HTMLResponse)
async def index():
    return login_page()


@app.get("/login", response_class=HTMLResponse)
async def login():
    return login_page()


@app.get("/me", response_class=HTMLResponse)
async def profile_page():
    return me_page()


@app.on_event("startup")
async def startup():
    await init_db()
    # 确保安装包目录存在后挂载静态目录（/download/，Nginx 正则已放行）
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    app.mount("/download", StaticFiles(directory=DOWNLOAD_DIR), name="download")
    # 无版本记录时写入种子版本，保证 /api/version 始终有值
    async for db in get_db():
        rows = await db.execute_fetchall("SELECT version FROM app_versions LIMIT 1")
        if not rows:
            await db.execute(
                """INSERT OR IGNORE INTO app_versions (version, release_date, release_notes, download_url, min_version)
                   VALUES (?, ?, ?, ?, ?)""",
                (SEED_VERSION["version"], SEED_VERSION["release_date"], SEED_VERSION["release_notes"],
                 SEED_VERSION["download_url"], SEED_VERSION["min_version"]),
            )
            await db.commit()


@app.get("/health")
async def health():
    return {"status": "ok", "services": ["learning-cloud", "benefit-auth"], "merged": True}


@app.get("/api/version")
async def app_version(db=Depends(get_db)):
    """返回最新 App 版本信息，供 Electron 客户端检测升级（读 app_versions 表）"""
    rows = await db.execute_fetchall(
        """SELECT version, release_date, release_notes, download_url, min_version
           FROM app_versions ORDER BY created_at DESC, version DESC LIMIT 1"""
    )
    if not rows:
        return SEED_VERSION
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


# ---------- 管理审核页（原 benefit-auth /admin/reviews） ----------
@app.get("/admin/reviews", response_class=HTMLResponse)
async def admin_reviews_page(token: str = ""):
    """管理审核页（每日互动任务凭证审核）"""
    return await admin.admin_page_html_view(token=token)
