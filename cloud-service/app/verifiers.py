"""权益认证中台 - 验证器架构（可插拔）

验证器决定"任务是否完成"：
- DouyinAutoVerifier：通过抖音开放平台 API 自动验证
  - follow_account: 拉取用户关注列表，匹配目标 open_id
  - publish_video:   拉取用户作品列表，匹配标题/话题
  - bind_account:    用户已绑定平台账号即通过
  - fans_reach:      拉取用户信息，检查粉丝数阈值
- DouyinBusinessTaskVerifier：bt_* 任务走抖音「经营任务」能力
  （bt_like 点赞 / bt_follow 关注 / bt_finish 完播 / bt_share 转发 / bt_comment 评论），
  用 activity_id + business_task_id 查询用户完成状态；能力未审批前为 mock 模式
  （完成查询一律未完成并带 mock 标记，见 app/business.py）。
- ManualReviewVerifier：用户提交凭证 → 待人工审核（点赞/评论等平台无开放查询接口的任务）

验证结果写入 task_instances.verify_detail，可追溯。
"""
import json
import os
from datetime import datetime, timezone

import httpx

from . import business

DOUYIN_API_BASE = os.environ.get("DOUYIN_API_BASE", "https://open.douyin.com")


class VerifyResult:
    def __init__(self, ok: bool, detail: dict):
        self.ok = ok
        self.detail = detail

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "detail": self.detail,
            "verified_at": datetime.now(timezone.utc).isoformat(),
        }


class TaskVerifier:
    """基类：verify(instance, account) -> VerifyResult"""

    async def verify(self, instance, account) -> VerifyResult:  # pragma: no cover
        raise NotImplementedError


# ---------------- 抖音自动验证器 ----------------
class DouyinAutoVerifier(TaskVerifier):
    async def verify(self, instance, account) -> VerifyResult:
        """instance: dict(task_id, task_type, target_config, evidence)
           account:  dict(platform_user_id, access_token, ...)"""
        if not account or not account.get("access_token"):
            return VerifyResult(False, {"error": "platform account not bound"})

        task_type = instance.get("task_type", "")
        target = json.loads(instance.get("target_config") or "{}")
        access_token = account["access_token"]
        open_id = account["platform_user_id"]

        try:
            if task_type == "bind_account":
                # 绑定授权即完成
                return VerifyResult(True, {"method": "bind_account"})

            if task_type == "fans_reach":
                info = await self._douyin_get("/api/douyin/v1/user/info/", access_token, open_id)
                followers = info.get("follower_count", 0)
                threshold = int(target.get("fans_threshold", 0))
                ok = followers >= threshold
                return VerifyResult(ok, {"method": "fans_reach", "followers": followers, "threshold": threshold})

            if task_type == "follow_account":
                target_open_id = target.get("target_open_id")
                if not target_open_id:
                    return VerifyResult(False, {"error": "target_open_id not configured"})
                following = await self._douyin_get("/api/douyin/v1/user/following/list/", access_token, open_id)
                items = following.get("list", [])
                match = any(item.get("open_id") == target_open_id for item in items)
                return VerifyResult(match, {"method": "follow_account", "checked_open_id": target_open_id, "found": match})

            if task_type == "publish_video":
                # 旧路径 /api/douyin/v1/user/video/list/ 已废弃（返回 HTML 兜底页），
                # 2026-08-28 实测新路径 GET /oauth/video/list/ 可用
                videos = await self._douyin_get("/oauth/video/list/", access_token, open_id)
                items = videos.get("list", [])
                keyword = (target.get("keyword") or "").strip()
                match = any(keyword in (v.get("title") or "") for v in items) if keyword else bool(items)
                return VerifyResult(match, {"method": "publish_video", "keyword": keyword, "video_count": len(items)})

            # follow_account / fans_reach 的旧路径同样已废弃，但新路径未经实测确认，
            # 保持原样并在此声明：真实调用会失败，待平台文档确认后迁移
            return VerifyResult(False, {"error": f"unsupported task_type for auto verify: {task_type}"})
        except Exception as e:  # noqa: BLE001
            return VerifyResult(False, {"error": f"douyin api error: {e}"})

    async def _douyin_get(self, path: str, access_token: str, open_id: str) -> dict:
        """调抖音开放平台 API（HTTPS，携带 access_token + open_id）"""
        async with httpx.AsyncClient(base_url=DOUYIN_API_BASE, timeout=15) as client:
            resp = await client.get(path, params={"access_token": access_token, "open_id": open_id})
            resp.raise_for_status()
            data = resp.json()
            if data.get("data", {}).get("error_code", 0) != 0:
                raise RuntimeError(f"douyin api error: {data.get('data', {})}")
            return data.get("data", {})


# ---------------- 抖音经营任务验证器 ----------------
class DouyinBusinessTaskVerifier(TaskVerifier):
    """bt_* 任务：用「经营任务」能力查询用户在活动下的任务完成状态。

    target_config 约定：
    - activity_id      平台活动 id（live 模式必填，创建活动后回填）
    - business_task_id 平台任务 id（活动内单个任务，查询用）
    - target_url       用户去完成的跳转链接（抖音对应界面，任务墙「去完成」按钮用）
    """

    async def verify(self, instance, account) -> VerifyResult:
        if not account or not account.get("access_token"):
            return VerifyResult(False, {"error": "platform account not bound"})

        task_type = instance.get("task_type", "")
        if task_type not in business.TASK_TYPE_LABELS:
            return VerifyResult(False, {"error": f"unknown business task type: {task_type}"})

        target = json.loads(instance.get("target_config") or "{}")

        # 多活动模式（每日互动任务：一条任务挂点赞/完播/评论多个任务，任一完成即算完成）；
        # 按 activity_id 分组批量查询（单活动多任务 → 1 次请求）
        acts = target.get("activities") or []
        if acts:
            if not business.is_live():
                return VerifyResult(False, {
                    "method": "business_task_multi", "task_type": task_type, "mode": "mock",
                    "note": "全局 mock 模式（服务器 .env 未设 DOUYIN_BUSINESS_TASK_MODE=live），"
                            "完成查询为模拟结果，任务保持已领取"})
            groups: dict[int, list[tuple[str, int]]] = {}
            for a in acts:
                if a.get("activity_id") and a.get("business_task_id"):
                    groups.setdefault(int(a["activity_id"]), []).append(
                        (a.get("type") or "", int(a["business_task_id"])))
            results, ok = {}, False
            try:
                for aid, pairs in groups.items():
                    status = await business.query_user_completion(
                        account["access_token"], account["platform_user_id"], aid,
                        [btid for _, btid in pairs])
                    m = status.get("task_complete_status_map") or {}
                    for ttype, btid in pairs:
                        v = bool(m.get(str(btid), m.get(btid, False)))
                        results[ttype or str(btid)] = v
                        ok = ok or v
            except Exception as e:  # noqa: BLE001
                return VerifyResult(False, {
                    "method": "business_task_multi", "task_type": task_type,
                    "mode": "live", "error": f"douyin api error: {e}"})
            return VerifyResult(ok, {
                "method": "business_task_multi", "task_type": task_type,
                "mode": "live", "results": results,
                "note": None if ok else "尚未查到完成记录；若你做的是转发，请提交凭证人工审核"})

        activity_id = target.get("activity_id")
        business_task_id = target.get("business_task_id")
        has_ids = bool(activity_id and business_task_id)
        if not business.is_live():
            return VerifyResult(False, {
                "method": "business_task", "task_type": task_type, "mode": "mock",
                "note": "全局 mock 模式（服务器 .env 未设 DOUYIN_BUSINESS_TASK_MODE=live），"
                        "完成查询为模拟结果，任务保持已领取"})
        if not has_ids:
            return VerifyResult(False, {
                "method": "business_task", "task_type": task_type, "mode": "live",
                "note": "该任务尚未关联平台活动（activity_id/business_task_id 未回填），暂按模拟处理"})

        try:
            status = await business.query_user_completion(
                account["access_token"],
                account["platform_user_id"],
                int(activity_id or 0),
                [int(business_task_id)] if business_task_id else None,
            )
        except Exception as e:  # noqa: BLE001
            return VerifyResult(False, {"method": "business_task", "error": f"douyin api error: {e}"})

        complete_map = status.get("task_complete_status_map") or {}
        ok = bool(complete_map.get(str(business_task_id), complete_map.get(business_task_id, False)))
        detail = {
            "method": "business_task",
            "task_type": task_type,
            "mode": "live" if business.is_live() else "mock",
            "activity_id": activity_id,
            "business_task_id": business_task_id,
            "complete_map": {str(k): v for k, v in complete_map.items()},
        }
        if status.get("mock"):
            detail["note"] = (
                "经营任务能力（open.business.task_manage/task_verify）尚未在开放平台审批通过，"
                "完成查询为模拟结果（一律未完成）；能力开通后切 DOUYIN_BUSINESS_TASK_MODE=live"
            )
        return VerifyResult(ok, detail)


# ---------------- 人工审核器 ----------------
class ManualReviewVerifier(TaskVerifier):
    """用户提交凭证（链接/截图说明）→ 状态置 submitted → 后台审核后 grant/reject"""

    async def verify(self, instance, account) -> VerifyResult:
        evidence = json.loads(instance.get("evidence") or "{}")
        proof = evidence.get("proof_url") or evidence.get("proof_text")
        if not proof:
            return VerifyResult(False, {"error": "no proof submitted"})
        return VerifyResult(True, {"method": "manual_review", "status": "pending_review"})


def get_verifier(task: dict) -> TaskVerifier:
    """根据任务的 verify_mode/task_type 返回对应验证器"""
    if str(task.get("task_type") or "").startswith("bt_"):
        return DouyinBusinessTaskVerifier()
    if task.get("verify_mode") == "manual":
        return ManualReviewVerifier()
    return DouyinAutoVerifier()
