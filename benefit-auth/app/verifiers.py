"""权益认证中台 - 验证器架构（可插拔）

验证器决定"任务是否完成"：
- DouyinAutoVerifier：通过抖音开放平台 API 自动验证
  - follow_account: 拉取用户关注列表，匹配目标 open_id
  - publish_video:   拉取用户作品列表，匹配标题/话题
  - bind_account:    用户已绑定平台账号即通过
  - fans_reach:      拉取用户信息，检查粉丝数阈值
- ManualReviewVerifier：用户提交凭证 → 待人工审核（点赞/评论等平台无开放查询接口的任务）

验证结果写入 task_instances.verify_detail，可追溯。
"""
import json
import os
from datetime import datetime, timezone

import httpx

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
                videos = await self._douyin_get("/api/douyin/v1/user/video/list/", access_token, open_id)
                items = videos.get("list", [])
                keyword = (target.get("keyword") or "").strip()
                match = any(keyword in (v.get("title") or "") for v in items) if keyword else bool(items)
                return VerifyResult(match, {"method": "publish_video", "keyword": keyword, "video_count": len(items)})

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
    """根据任务的 verify_mode 返回对应验证器"""
    if task.get("verify_mode") == "manual":
        return ManualReviewVerifier()
    return DouyinAutoVerifier()
