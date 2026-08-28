"""权益认证中台 - 独立认证服务入口"""
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

from .database import init_db
from .routers import apps, me, oauth_douyin
from .pages import login_page, me_page

app = FastAPI(title="Benefit Auth Center", version="0.1.0")

app.include_router(apps.router)
app.include_router(me.router)
app.include_router(oauth_douyin.router)


@app.on_event("startup")
async def startup():
    await init_db()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "benefit-auth"}


# ---------- 页面 ----------
# 首页当前为空白页（内容已按要求移除）；/login、/me 保留
_BLANK_PAGE = (
    "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
    "<title></title></head><body></body></html>"
)


@app.get("/", response_class=HTMLResponse)
async def index():
    return _BLANK_PAGE


@app.get("/login", response_class=HTMLResponse)
async def login():
    return login_page()


@app.get("/me", response_class=HTMLResponse)
async def profile():
    return me_page()
