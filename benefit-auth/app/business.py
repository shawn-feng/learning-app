"""抖音「经营任务」对接层（Business Task / 应用内活动）

官方文档：developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/business-task/
- 任务创建   POST /dy_open_api/apps/v3/activity/create/          鉴权=client_token（应用级，clt. 前缀），scope=open.business.task_manage
- 查询用户是否完成 POST /dy_open_api/apps/v3/activity/query_activity_user_completion_status/
             鉴权=用户级 access_token（act. 前缀），scope=open.business.task_verify
- client_token POST /oauth/client_token/  grant_type=client_credential

双模式（环境变量 DOUYIN_BUSINESS_TASK_MODE）：
- mock（默认）：经营任务能力（open.business.task_manage / open.business.task_verify）尚未在开放平台
  审批通过前的过渡模式——活动创建/完成查询不真调平台，完成查询一律返回未完成并带 mock 标记，
  任务墙「去完成」跳转链接照常工作（跳抖音对应界面），端到端交互可先行验证。
- live：能力审批通过后切换；活动创建真调平台并把 activity_id/business_task_id 回填到 target_config。
"""
from __future__ import annotations

import os
import time

import httpx

DOUYIN_API_BASE = os.environ.get("DOUYIN_API_BASE", "https://open.douyin.com")

# mock / live
MODE = os.environ.get("DOUYIN_BUSINESS_TASK_MODE", "mock").strip().lower()

# 中台任务类型（bt_ 前缀 = business task）→ 展示名（任务墙用）
TASK_TYPE_LABELS = {
    "bt_like": "点赞视频",
    "bt_follow": "关注账号",
    "bt_finish": "完播视频",
    "bt_share": "转发视频",
    "bt_comment": "评论视频",
}


def is_live() -> bool:
    return MODE == "live"


# ---------------- client_token（应用级，带内存缓存） ----------------
_client_token_cache: dict = {"token": "", "expires_at": 0.0}


async def get_client_token() -> str:
    """获取/续取 client_token（POST /oauth/client_token/，grant_type=client_credential）。
    提前 120s 过期，避免边界竞态。"""
    if _client_token_cache["token"] and time.time() < _client_token_cache["expires_at"] - 120:
        return _client_token_cache["token"]

    client_key = os.environ.get("DOUYIN_CLIENT_KEY", "")
    client_secret = os.environ.get("DOUYIN_CLIENT_SECRET", "")
    if not (client_key and client_secret):
        raise RuntimeError("DOUYIN_CLIENT_KEY/SECRET 未配置，无法获取 client_token")

    async with httpx.AsyncClient(base_url=DOUYIN_API_BASE, timeout=15) as client:
        resp = await client.post(
            "/oauth/client_token/",
            json={
                "client_key": client_key,
                "client_secret": client_secret,
                "grant_type": "client_credential",
            },
        )
        resp.raise_for_status()
        body = resp.json()
    data = body.get("data") or {}
    if str(data.get("error_code", "0")) not in ("0", 0) or not data.get("access_token"):
        raise RuntimeError(f"client_token 获取失败: {data}")
    _client_token_cache["token"] = data["access_token"]
    _client_token_cache["expires_at"] = time.time() + int(data.get("expires_in", 7200))
    return _client_token_cache["token"]


def _check_business_data(body: dict, path: str) -> dict:
    """经营任务 OpenAPI 响应解析——实测两种形状并存，都兼容：
    - 顶层 err_no/err_msg（如 query_activity_user_completion_status，2026-09-28 实测）
    - data.error_code/description（如 activity/create 文档示例）
    """
    if not isinstance(body, dict):
        raise RuntimeError(f"{path} 返回结构异常: {str(body)[:200]}")
    err_no = body.get("err_no")
    if err_no is not None:
        if str(err_no) not in ("0", 0):
            raise RuntimeError(f"{path} err_no={err_no}: {body.get('err_msg') or body}")
        return body.get("data") or body
    data = body.get("data")
    if not isinstance(data, dict):
        raise RuntimeError(f"{path} 返回结构异常: {str(body)[:200]}")
    code = data.get("error_code", 0)
    if str(code) not in ("0", 0):
        # 20028001018 应用未获得该能力 / 20028001014 未授权任何能力 → 提示切回 mock 或去控制台申请
        raise RuntimeError(f"{path} error_code={code}: {data.get('description') or data}")
    return data


# ---------------- 活动（创建/查询） ----------------
async def activity_create(activity: dict) -> dict:
    """创建经营任务活动（仅 live 模式真调平台）。

    activity: {activity_name, start_time, end_time, create_business_task_info_list: [...]}
    返回 {activity_id, business_task_id_list}
    """
    if not is_live():
        raise RuntimeError("business task in mock mode: activity_create unavailable")
    token = await get_client_token()
    async with httpx.AsyncClient(base_url=DOUYIN_API_BASE, timeout=20) as client:
        resp = await client.post(
            "/dy_open_api/apps/v3/activity/create/",
            headers={"access-token": token, "content-type": "application/json"},
            json=activity,
        )
        resp.raise_for_status()
        body = resp.json()
    return _check_business_data(body, "activity/create")


async def activity_query(activity_id: int) -> dict:
    """查询活动信息（仅 live 模式真调平台）"""
    if not is_live():
        raise RuntimeError("business task in mock mode: activity_query unavailable")
    token = await get_client_token()
    async with httpx.AsyncClient(base_url=DOUYIN_API_BASE, timeout=20) as client:
        resp = await client.post(
            "/dy_open_api/apps/v3/activity/query/",
            headers={"access-token": token, "content-type": "application/json"},
            json={"activity_id": activity_id},
        )
        resp.raise_for_status()
        body = resp.json()
    return _check_business_data(body, "activity/query")


# ---------------- 查询用户是否完成 ----------------
async def query_user_completion(
    user_access_token: str, open_id: str, activity_id: int, task_id_list: list[int] | None = None
) -> dict:
    """查询用户在活动下的任务完成状态（live 模式真调平台）。

    返回 {"task_complete_status_map": {<task_id>: bool, ...}, ...}
    mock 模式返回 {"mock": True, "task_complete_status_map": {}}——一律未完成，
    verify_detail 会说明原因，任务保持 claimed，不虚发权益。
    """
    if not is_live():
        return {"mock": True, "mode": "mock", "task_complete_status_map": {}}
    async with httpx.AsyncClient(base_url=DOUYIN_API_BASE, timeout=20) as client:
        resp = await client.post(
            "/dy_open_api/apps/v3/activity/query_activity_user_completion_status/",
            headers={"access-token": user_access_token, "content-type": "application/json"},
            json={
                "activity_id": activity_id,
                "target_open_id": open_id,
                **({"task_id_list": task_id_list} if task_id_list else {}),
            },
        )
        resp.raise_for_status()
        body = resp.json()
    data = _check_business_data(body, "query_activity_user_completion_status")
    return {
        "task_complete_status_map": data.get("task_complete_status_map") or {},
        "posting_video_bind_compelete_info_map": data.get("posting_video_bind_compelete_info_map") or {},
    }
