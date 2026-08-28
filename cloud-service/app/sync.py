import uuid
import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from .auth import get_current_parent
from .database import get_db

router = APIRouter(prefix="/api/sync", tags=["sync"])

# ISSUE-041 架构转向（2026-08-25 用户拍板）：云端只做「消息交换」，不做数据存储/备份。
# - sync_deliveries：家长→孩子的「分配数据包」暂存（只含课程数据/method 全文，不含 html/mp4 文件；
#   孩子端拉取后在本地写库合并，ack 即删，云端不留备份）。
# - sync_progress：孩子→家长的「进度摘要」（孩子端本地汇总 kb.sqlite 成 JSON，只存最新一份；
#   家长 GET 带 request=1 时打「请求刷新」标记，孩子端轮询后生成新摘要覆盖）。
# kb.sqlite / 家长库资料一律不上云；多 PC 数据迁移走本地 zip 备份 + 恢复。


class DeliverIn(BaseModel):
    payload: dict


class AckIn(BaseModel):
    ids: list[str]


class ProgressIn(BaseModel):
    summary: dict


@router.post("/deliver/{child_id}")
async def create_delivery(
    child_id: str,
    body: DeliverIn,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """家长上传一个分配数据包（主题+课程数据，不含文件），暂存等待孩子端取走。"""
    await db.execute(
        "INSERT INTO sync_deliveries (id, parent_id, child_id, payload, status) "
        "VALUES (?, ?, ?, ?, 'pending')",
        (str(uuid.uuid4()), parent_id, child_id, json.dumps(body.payload, ensure_ascii=False)),
    )
    await db.commit()
    return {"ok": True}


@router.get("/deliver/{child_id}")
async def list_deliveries(
    child_id: str,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """孩子端拉取所有待处理的分配包（含完整 payload，id 升序便于 ack）。"""
    rows = await db.execute_fetchall(
        "SELECT id, payload, created_at FROM sync_deliveries "
        "WHERE parent_id = ? AND child_id = ? AND status = 'pending' ORDER BY created_at ASC",
        (parent_id, child_id),
    )
    return {
        "deliveries": [
            {
                "id": r["id"],
                "payload": json.loads(r["payload"] or "{}"),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }


@router.post("/deliver/{child_id}/ack")
async def ack_deliveries(
    child_id: str,
    body: AckIn,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """孩子端确认已在本地应用分配包 → 云端删除（投递即删，不做备份）。"""
    if not body.ids:
        return {"acked": 0}
    placeholders = ",".join("?" for _ in body.ids)
    await db.execute(
        f"DELETE FROM sync_deliveries WHERE parent_id = ? AND child_id = ? AND id IN ({placeholders})",
        (parent_id, child_id, *body.ids),
    )
    await db.commit()
    return {"acked": len(body.ids)}


@router.put("/progress/{child_id}")
async def upload_progress(
    child_id: str,
    body: ProgressIn,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """孩子端上传最新进度摘要（覆盖旧摘要，每孩子只存一份）。"""
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT INTO sync_progress (parent_id, child_id, summary, updated_at, requested_at) "
        "VALUES (?, ?, ?, ?, NULL) "
        "ON CONFLICT(parent_id, child_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
        (parent_id, child_id, json.dumps(body.summary, ensure_ascii=False), now),
    )
    await db.commit()
    return {"ok": True, "updated_at": now}


@router.get("/progress/{child_id}")
async def get_progress(
    child_id: str,
    request: int = 0,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """家长读取孩子进度摘要；request=1 时打「请求刷新」标记（孩子端轮询后会生成新摘要覆盖）。"""
    if request:
        now = datetime.now(timezone.utc).isoformat()
        await db.execute(
            "INSERT INTO sync_progress (parent_id, child_id, summary, updated_at, requested_at) "
            "VALUES (?, ?, '{}', NULL, ?) "
            "ON CONFLICT(parent_id, child_id) DO UPDATE SET requested_at = excluded.requested_at",
            (parent_id, child_id, now),
        )
        await db.commit()
    row = await db.execute_fetchall(
        "SELECT summary, updated_at, requested_at FROM sync_progress WHERE parent_id = ? AND child_id = ?",
        (parent_id, child_id),
    )
    if not row:
        return {
            "summary": None,
            "updated_at": None,
            "requested_at": None,
            "note": "孩子端尚未上传进度摘要",
        }
    return {
        "summary": json.loads(row[0]["summary"] or "{}"),
        "updated_at": row[0]["updated_at"],
        "requested_at": row[0]["requested_at"],
        "note": None,
    }
