"""已下线接口的 410 存根（2026-10-10 登录安全裁剪，ISSUE-174）。

- /api/auth/*：旧 cloud 账密登录族（≤2026-10-08 的 LAN server 在用）→ 已被 /api/account/* 取代
- /api/license：旧 cloud 订阅校验 → 已被 /api/account/license 取代

保留 410 存根而非直接消失：旧客户端能看到明确的"请升级"错误，而非 404/连接错误。
确认全部旧客户端已升级后可整体移除本路由。
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(tags=["deprecated"])

_MSG = {"detail": "此接口已下线（登录统一改为抖音扫码）。请升级客户端到最新版本后重试。"}


@router.api_route("/api/auth/{path:path}", methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
@router.api_route("/api/license", methods=["GET", "POST"], include_in_schema=False)
async def _gone(path: str = ""):
    return JSONResponse(_MSG, status_code=410)
