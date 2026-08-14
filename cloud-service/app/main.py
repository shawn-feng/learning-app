from fastapi import FastAPI
from .database import init_db
from .auth import router as auth_router
from .license import router as license_router
from .sync import router as sync_router

app = FastAPI(title="Learning App Cloud Service", version="0.1.0")

app.include_router(auth_router)
app.include_router(license_router)
app.include_router(sync_router)


@app.on_event("startup")
async def startup():
    await init_db()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/version")
async def app_version():
    """返回最新 App 版本信息，供 Electron 客户端检测升级"""
    return {
        "version": "0.1.0",
        "release_date": "2026-08-12",
        "release_notes": "新增 AI 伙伴 emoji 配置，修复 API key 保存问题，增加云端同步和自动版本检测",
        "download_url": None,  # 生产环境填实际下载地址
        "min_version": "0.1.0",
    }
