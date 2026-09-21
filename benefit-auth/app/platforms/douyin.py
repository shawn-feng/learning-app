"""抖音开放平台 Provider

环境变量（写服务器 .env，不入代码）：
  DOUYIN_CLIENT_KEY    抖音开放平台 Client Key
  DOUYIN_CLIENT_SECRET 抖音开放平台 Client Secret
  DOUYIN_API_BASE      默认 https://open.douyin.com
  DOUYIN_LOGIN_SCOPES  覆盖登录默认 scope（逗号分隔）。登录即带全量能力 scope；
                       若授权页对未审批 scope 报「scope权限不足」，设为 user_info 一键降级。
"""
from __future__ import annotations

import os

from .base import PlatformProvider


class DouyinProvider(PlatformProvider):
    platform = "douyin"
    display_name = "抖音"
    # 应用已于 2026-09-21 审核为「正式应用」，登录无需再带 trial.whitelist（白名单仅测试期应用需要）。
    # 登录 scope 直接带全量能力 scope（用户授权方案：让用户扫码时一并批准），
    # 控制台能力审批通过后用户勾选即可；未通过前行为二选一：授权页忽略该 scope 或报
    # 「应用scope权限不足」——后者用 DOUYIN_LOGIN_SCOPES=user_info 降级，无需改代码。
    default_scopes = ["user_info", "video.list.bind", "video.data", "video.comment"]
    # 升级授权（mode=upgrade）合并的 scope 列表
    advanced_scopes = ["video.list.bind", "video.data", "video.comment"]
    authorize_base = "https://open.douyin.com/platform/oauth/connect"
    api_base = "https://open.douyin.com"

    def __init__(self):
        super().__init__()
        env_scopes = os.environ.get("DOUYIN_LOGIN_SCOPES", "")
        if env_scopes.strip():
            self.default_scopes = [s.strip() for s in env_scopes.split(",") if s.strip()]
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

    async def video_data(self, access_token: str, open_id: str, item_ids: list[str]) -> dict:
        """查询视频实时统计数据（需 video.data scope）。

        官方文档（查询特定视频的视频数据·移动/网站应用）：POST https://open.douyin.com/video/data/，
        access_token / open_id 走 query，业务参数 JSON body {"item_ids": [...]}（单次 ≤20 个）。
        返回 data: { "list": [ { "item_id": "...", "statistics": {"like_count":..,"comment_count":..,
        "play_count":..,"share_count":..} } ] }
        """
        if not item_ids:
            return {"list": []}
        return await self._post_json(
            "/video/data/",
            {"access_token": access_token, "open_id": open_id},
            {"item_ids": item_ids[:20]},
        )

    async def comment_list(self, access_token: str, open_id: str, item_id: str,
                           cursor: int = 0, count: int = 20) -> dict:
        """查询指定视频的评论列表（需 video.comment scope，互动管理）。

        官方文档（视频评论管理接入方案）：GET https://open.douyin.com/video/comment/list/。
        返回 data: { "list": [ { id, text, create_time, digg_count, reply_comment_total,
        user: {open_id?, nickname?, avatar? ...} } ], "cursor": int, "has_more": bool, "total": int }
        注意：评论者可拿到的身份字段以实际返回为准（open_id 在本应用内稳定唯一，可用于定位；
        平台不保证返回「抖音号」）。
        """
        return await self._get(
            "/video/comment/list/",
            {
                "access_token": access_token,
                "open_id": open_id,
                "item_id": item_id,
                "cursor": cursor,
                "count": count,
            },
        )
