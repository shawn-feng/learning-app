"""抖音开放平台 Provider

环境变量（写服务器 .env，不入代码）：
  DOUYIN_CLIENT_KEY    抖音开放平台 Client Key
  DOUYIN_CLIENT_SECRET 抖音开放平台 Client Secret
  DOUYIN_API_BASE      默认 https://open.douyin.com
"""
from __future__ import annotations

from .base import PlatformProvider


class DouyinProvider(PlatformProvider):
    platform = "douyin"
    display_name = "抖音"
    # 测试期登录必须带 trial.whitelist：未加入白名单的用户登录会触发
    # 「用户未绑定应用白名单,请授权trial.whitelist权限」错误，官方 pay 文档 FAQ
    # 明确「需要在 scope 中添加 trial.whitelist 和 user_info」。
    # 应用「申请上线」后请改回 ["user_info"]，上线用户无需 trial.whitelist。
    default_scopes = ["user_info", "trial.whitelist"]
    # 获取用户视频列表所需的高级 scope：2023 起旧 video.list 改版为 video.list.bind（经营能力），
    # 仅在 PC 扫码授权场景可见；申请入口在控制台「总览 → 申请上线」流程的权限选择里。
    advanced_scopes = ["video.list.bind"]
    authorize_base = "https://open.douyin.com/platform/oauth/connect"
    api_base = "https://open.douyin.com"

    async def user_info(self, access_token: str, open_id: str) -> dict:
        """拉取用户公开信息（昵称/头像）。

        官方文档（获取用户公开信息）：POST https://open.douyin.com/oauth/userinfo/，
        表单体 open_id + access_token；data.nickname / data.avatar。
        注意：旧路径 GET /api/douyin/v1/user/info/ 已废弃，现返回 HTML 兜底页（非 JSON）。
        """
        return await self._post(
            "/oauth/userinfo/",
            {"access_token": access_token, "open_id": open_id},
        )

    async def video_list(self, access_token: str, open_id: str, cursor: int = 0) -> dict:
        """拉取用户视频列表（需 video.list scope）。

        官方文档（获取用户视频列表）：GET /oauth/video/list/。
        返回 data: { "list": [...], "cursor": int, "has_more": bool }
        """
        return await self._get(
            "/oauth/video/list/",
            {"access_token": access_token, "open_id": open_id, "cursor": cursor, "count": 10},
        )
