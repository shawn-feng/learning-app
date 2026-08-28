"""权益认证中台 - 独立认证服务入口"""
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

from .database import init_db
from .routers import apps, me, oauth
from .pages import login_page, me_page

app = FastAPI(title="Benefit Auth Center", version="0.2.0")

app.include_router(apps.router)
app.include_router(me.router)
app.include_router(oauth.router)


@app.on_event("startup")
async def startup():
    await init_db()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "benefit-auth"}


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
