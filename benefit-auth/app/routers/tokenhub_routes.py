"""TokenHub Key 用户端点（LAN server 凭家长 user JWT 调用）。

- GET /api/tokenhub/key    幂等发放（无则创建），返回明文 Key + 配额摘要
- GET /api/tokenhub/quota  实时配额（DescribeApiKey，60s 内存缓存）

调用方：server/src/auth/tokenhub.ts（服务端代家长调用，user token 即家长 cloud_token）。
"""
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database import get_db, get_setting
from ..deps import get_current_user
from .. import tokenhub

router = APIRouter(prefix="/api/tokenhub", tags=["tokenhub"])

# 配额查询缓存：user_id -> (ts, data)；管控 API 限频 20 QPS 且用量统计本就有延迟
_quota_cache: dict[str, tuple[float, dict]] = {}
_QUOTA_TTL_S = 60.0


async def _sync_cfg(db) -> None:
    """管理页配置的 TokenHub ak/sk（DB）优先于 env——每次管控调用前同步运行时覆盖。"""
    sid = await get_setting(db, "tokenhub_ak", "")
    sk = await get_setting(db, "tokenhub_sk", "")
    if sid or sk:
        tokenhub.set_runtime_config(sid, sk)


async def _describe_active(db, row: dict) -> dict:
    """描述 Key；若远端已不存在（被删/清理）→ 自愈：标记旧行 deleted 并重新发放一次。"""
    try:
        return tokenhub.describe_api_key(row["api_key_id"])
    except tokenhub.TokenHubError as e:
        if e.code != "ResourceNotFound":
            raise
        await db.execute("UPDATE tokenhub_keys SET status='deleted', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                         (row["id"],))
        await db.commit()
        row = await tokenhub.ensure_user_key(db, row["user_id"])
        return tokenhub.describe_api_key(row["api_key_id"])


async def _ensure_with_plaintext(db, user_id: str) -> dict:
    """确保有 Key 且明文已落库（历史行可能只有 key_id）。"""
    row = await tokenhub.ensure_user_key(db, user_id)
    if not row.get("api_key"):
        detail = tokenhub.describe_api_key(row["api_key_id"])
        plain = detail.get("ApiKey") or ""
        if plain:
            await db.execute("UPDATE tokenhub_keys SET api_key=?, updated_at=CURRENT_TIMESTAMP "
                             "WHERE id=?", (plain, row["id"]))
            await db.commit()
            row["api_key"] = plain
    return row


@router.get("/key")
async def get_key(db=Depends(get_db), user_id: str = Depends(get_current_user)):
    await _sync_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=503, detail="服务端未配置 TOKENHUB_SECRET_ID/SECRET_KEY")
    row = await _ensure_with_plaintext(db, user_id)
    detail = await _describe_active(db, row)
    return {
        "apiKey": row.get("api_key") or detail.get("ApiKey") or "",
        "keyId": row["api_key_id"],
        "quota": tokenhub.quota_of(detail),
    }


@router.get("/quota")
async def get_quota(db=Depends(get_db), user_id: str = Depends(get_current_user)):
    await _sync_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=503, detail="服务端未配置 TOKENHUB_SECRET_ID/SECRET_KEY")
    cached = _quota_cache.get(user_id)
    now = time.time()
    if cached and now - cached[0] < _QUOTA_TTL_S:
        return cached[1]
    row = await tokenhub.ensure_user_key(db, user_id)
    detail = await _describe_active(db, row)
    data = {
        "keyId": row["api_key_id"],
        "keyMasked": tokenhub.mask_key(row.get("api_key") or ""),
        "dbStatus": row["status"],
        "quota": tokenhub.quota_of(detail),
        "defaultDailyCredits": await tokenhub.get_default_daily_credits(db),
    }
    _quota_cache[user_id] = (now, data)
    return data


@router.get("/model-config")
async def get_model_config(db=Depends(get_db)):
    """全局默认模型配置（公开只读：仅暴露模型名，不含任何凭证）。

    app 服务端同步循环拉取此端点，作为各功能模块（文本 agent / 视觉 / ASR / TTS）的系统默认模型。
    """
    return {"models": await tokenhub.get_default_models(db)}


@router.get("/usage-models")
async def get_usage_models(days: int = 1, db=Depends(get_db), user_id: str = Depends(get_current_user)):
    """官方按模型用量（家长 JWT，LAN server 转发给配额面板）。

    与配额扣减（DescribeApiKey.CycleUsed）同源，面板分类卡用它保证与「今日已用」一致。
    注意：口径为整个腾讯云账号（多家庭时会混合）；分钟级以上延迟。
    """
    await _sync_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=503, detail="服务端未配置 TOKENHUB_SECRET_ID/SECRET_KEY")
    try:
        return tokenhub.usage_by_models(days)
    except tokenhub.TokenHubError as e:
        raise HTTPException(status_code=502, detail=f"查询失败：{e.message}") from e


class ProvisionBody(BaseModel):
    dailyCredits: int | None = None


@router.post("/key")
async def provision_key(body: ProvisionBody, db=Depends(get_db), user_id: str = Depends(get_current_user)):
    """显式发放/重发（管理员代操作或服务端补拉时用；已有 Key 则幂等返回）。"""
    await _sync_cfg(db)
    if not tokenhub.configured():
        raise HTTPException(status_code=503, detail="服务端未配置 TOKENHUB_SECRET_ID/SECRET_KEY")
    row = await _ensure_with_plaintext(db, user_id)
    if body.dailyCredits and body.dailyCredits != row["quota_cycle_credits"]:
        tokenhub.modify_quota(row["api_key_id"], body.dailyCredits)
        await db.execute("UPDATE tokenhub_keys SET quota_cycle_credits=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                         (body.dailyCredits, row["id"]))
        await db.commit()
        _quota_cache.pop(user_id, None)
        row["quota_cycle_credits"] = body.dailyCredits
    return {"keyId": row["api_key_id"], "apiKey": row.get("api_key") or "",
            "quotaCycleCredits": row["quota_cycle_credits"]}
