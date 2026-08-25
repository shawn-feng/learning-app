import os
import uuid
import hashlib
import shutil
import base64
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from .auth import get_current_parent
from .database import get_db

router = APIRouter(prefix="/api/sync", tags=["sync"])

# File storage root: cloud-service/storage/{parent_id}/{child_id}/
STORAGE_ROOT = Path(__file__).parent.parent / "storage"

# ISSUE-041 层 A：每个文件云端保留的最近版本数（不可变快照，可回滚）
VERSION_KEEP = 5


def get_child_storage(parent_id: str, child_id: str) -> Path:
    return STORAGE_ROOT / parent_id / child_id


def get_parent_storage(parent_id: str) -> Path:
    """家长空间（ISSUE-041 层 B）：家长库 + 全局配置，按 parent_id 归桶。"""
    return STORAGE_ROOT / parent_id / "_parent"


# ISSUE-041 层 B：家长空间在 sync_files_meta 里的占位 child_id（区别于真实孩子 UUID）
PARENT_SPACE_CHILD = "_parent"


def _version_key(file_path: str) -> str:
    """文件路径 → 版本目录名（base64url，避免嵌套目录与特殊字符）。"""
    return base64.urlsafe_b64encode(file_path.replace("\\", "/").encode("utf-8")).decode("ascii")


def _safe_storage_path(storage_dir: Path, file_path: str) -> Path:
    """防目录穿越：解析后必须仍在 storage_dir 内（新增端点统一走这里）。"""
    rel = file_path.replace("\\", "/").lstrip("/")
    p = (storage_dir / rel).resolve()
    if not str(p).startswith(str(storage_dir.resolve())) and p != storage_dir.resolve():
        raise HTTPException(status_code=400, detail="非法文件路径")
    return p


def _keep_version(parent_id: str, child_id: str, file_path: str) -> None:
    """上传覆盖前把旧版本快照到 .versions/<key>/<ts>.bin，并裁剪到最近 VERSION_KEEP 份。"""
    storage_dir = get_child_storage(parent_id, child_id)
    disk_path = _safe_storage_path(storage_dir, file_path)
    if not disk_path.exists():
        return
    vdir = storage_dir / ".versions" / _version_key(file_path)
    vdir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    shutil.copy2(disk_path, vdir / f"{ts}.bin")
    versions = sorted(vdir.glob("*.bin"), key=lambda p: p.name)
    for old in versions[:-VERSION_KEEP]:
        try:
            old.unlink(missing_ok=True)
        except OSError:
            pass


def _upsert_meta(db, parent_id: str, child_id: str, file_path: str, content_hash: str, size: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    existing = db.execute_fetchall(
        "SELECT id FROM sync_files_meta WHERE parent_id = ? AND child_id = ? AND file_path = ?",
        (parent_id, child_id, file_path),
    )
    if existing:
        db.execute(
            "UPDATE sync_files_meta SET content_hash = ?, size = ?, updated_at = ? "
            "WHERE parent_id = ? AND child_id = ? AND file_path = ?",
            (content_hash, size, now, parent_id, child_id, file_path),
        )
    else:
        db.execute(
            "INSERT INTO sync_files_meta (id, parent_id, child_id, file_path, content_hash, size, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), parent_id, child_id, file_path, content_hash, size, now),
        )


class SyncFileEntry(BaseModel):
    path: str
    hash: str
    size: int
    updated_at: str


class SyncStatusResponse(BaseModel):
    files: list[SyncFileEntry]


def compute_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@router.get("/status/{child_id}", response_model=SyncStatusResponse)
async def get_sync_status(
    child_id: str,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """获取指定孩子云端文件同步状态（文件列表 + hash）"""
    rows = await db.execute_fetchall(
        "SELECT file_path, content_hash, size, updated_at FROM sync_files_meta "
        "WHERE parent_id = ? AND child_id = ?",
        (parent_id, child_id),
    )
    files = [
        SyncFileEntry(
            path=row["file_path"],
            hash=row["content_hash"] or "",
            size=row["size"] or 0,
            updated_at=row["updated_at"],
        )
        for row in rows
    ]
    return SyncStatusResponse(files=files)


@router.post("/upload/{child_id}")
async def upload_file(
    child_id: str,
    file: UploadFile = File(...),
    file_path: str = Form(...),
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """上传一个孩子数据文件到云端（ISSUE-041 层 A：覆盖前自动保留旧版本，可回滚）"""
    assert file.filename, "File must have a name"

    # Read file content
    content = await file.read()
    content_hash = compute_hash(content)
    size = len(content)

    storage_dir = get_child_storage(parent_id, child_id)
    disk_path = _safe_storage_path(storage_dir, file_path)

    # 内容未变 → 直接返回，不产生版本噪音
    existing = await db.execute_fetchall(
        "SELECT content_hash FROM sync_files_meta WHERE parent_id = ? AND child_id = ? AND file_path = ?",
        (parent_id, child_id, file_path),
    )
    if existing and existing[0]["content_hash"] == content_hash:
        return {"path": file_path, "hash": content_hash, "size": size, "uploaded": False, "changed": False}

    # 覆盖前快照旧版本（防本地损坏反向污染云端真源）
    _keep_version(parent_id, child_id, file_path)

    # Save to disk
    disk_path.parent.mkdir(parents=True, exist_ok=True)
    disk_path.write_bytes(content)

    _upsert_meta(db, parent_id, child_id, file_path, content_hash, size)
    await db.commit()

    return {"path": file_path, "hash": content_hash, "size": size, "uploaded": True, "changed": True}


@router.post("/download/{child_id}")
async def download_file(
    child_id: str,
    file_path: str = Form(...),
    parent_id: str = Depends(get_current_parent),
):
    """从云端下载指定孩子的文件内容，返回 base64 编码的文件数据"""
    import base64

    disk_path = _safe_storage_path(get_child_storage(parent_id, child_id), file_path)
    if not disk_path.exists():
        raise HTTPException(status_code=404, detail="File not found on cloud")

    content = disk_path.read_bytes()
    return {
        "path": file_path,
        "content_base64": base64.b64encode(content).decode("ascii"),
        "size": len(content),
    }


@router.post("/upload-batch/{child_id}")
async def upload_batch(
    child_id: str,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
    files: list[UploadFile] = File(...),
):
    """批量上传孩子数据文件（用于全量快照备份）"""
    results = []
    now = datetime.now(timezone.utc).isoformat()
    storage_dir = get_child_storage(parent_id, child_id)

    for file in files:
        if not file.filename:
            continue

        content = await file.read()
        content_hash = compute_hash(content)
        size = len(content)

        # Use filename as the relative path
        fp = file.filename.replace("\\", "/")
        disk_path = _safe_storage_path(storage_dir, fp)
        disk_path.parent.mkdir(parents=True, exist_ok=True)
        disk_path.write_bytes(content)

        existing = await db.execute_fetchall(
            "SELECT id FROM sync_files_meta WHERE parent_id = ? AND child_id = ? AND file_path = ?",
            (parent_id, child_id, fp),
        )

        if existing:
            await db.execute(
                "UPDATE sync_files_meta SET content_hash = ?, size = ?, updated_at = ? "
                "WHERE parent_id = ? AND child_id = ? AND file_path = ?",
                (content_hash, size, now, parent_id, child_id, fp),
            )
        else:
            await db.execute(
                "INSERT INTO sync_files_meta (id, parent_id, child_id, file_path, content_hash, size, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), parent_id, child_id, fp, content_hash, size, now),
            )

        results.append({"path": fp, "hash": content_hash, "size": size})

    await db.commit()
    return {"uploaded": len(results), "files": results}


# ---- ISSUE-041 层 A：云端版本历史（防损坏 / 误删回滚） ----

@router.get("/versions/{child_id}")
async def list_versions(
    child_id: str,
    file_path: str,
    parent_id: str = Depends(get_current_parent),
):
    """列出某文件云端保留的历史版本（时间戳，降序，最新在前）。"""
    vdir = get_child_storage(parent_id, child_id) / ".versions" / _version_key(file_path)
    if not vdir.exists():
        return {"file_path": file_path, "versions": []}
    versions = sorted((p.stem for p in vdir.glob("*.bin")), reverse=True)
    return {"file_path": file_path, "versions": versions}


@router.post("/restore/{child_id}")
async def restore_file(
    child_id: str,
    file_path: str = Form(...),
    version: str = Form(...),
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """把云端文件回滚到指定历史版本（版本列表来自 /versions）。"""
    storage_dir = get_child_storage(parent_id, child_id)
    vfile = storage_dir / ".versions" / _version_key(file_path) / f"{version}.bin"
    if not vfile.exists():
        raise HTTPException(status_code=404, detail="版本不存在")

    content = vfile.read_bytes()
    content_hash = compute_hash(content)
    size = len(content)

    disk_path = _safe_storage_path(storage_dir, file_path)
    disk_path.parent.mkdir(parents=True, exist_ok=True)
    disk_path.write_bytes(content)

    _upsert_meta(db, parent_id, child_id, file_path, content_hash, size)
    await db.commit()
    return {"path": file_path, "hash": content_hash, "size": size, "restored": True}


# ---- ISSUE-041 层 B：家长空间（家长库/全局配置跨设备迁移） + 孩子清单 ----

@router.get("/children")
async def list_cloud_children(
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """返回该家长云端已有的孩子 id 清单（新机拉回全量数据的入口）。"""
    rows = await db.execute_fetchall(
        "SELECT DISTINCT child_id FROM sync_files_meta "
        "WHERE parent_id = ? AND child_id != ? ORDER BY child_id",
        (parent_id, PARENT_SPACE_CHILD),
    )
    return {"children": [r["child_id"] for r in rows]}


@router.get("/parent/status")
async def get_parent_status(
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """家长空间文件同步状态（文件列表 + hash）。"""
    rows = await db.execute_fetchall(
        "SELECT file_path, content_hash, size, updated_at FROM sync_files_meta "
        "WHERE parent_id = ? AND child_id = ?",
        (parent_id, PARENT_SPACE_CHILD),
    )
    return SyncStatusResponse(
        files=[
            SyncFileEntry(
                path=row["file_path"],
                hash=row["content_hash"] or "",
                size=row["size"] or 0,
                updated_at=row["updated_at"],
            )
            for row in rows
        ]
    )


@router.post("/parent/upload")
async def upload_parent_file(
    file: UploadFile = File(...),
    file_path: str = Form(...),
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """上传一个家长空间文件（家长库/全局配置；覆盖前同样保留版本）。"""
    assert file.filename, "File must have a name"
    content = await file.read()
    content_hash = compute_hash(content)
    size = len(content)

    storage_dir = get_parent_storage(parent_id)
    disk_path = _safe_storage_path(storage_dir, file_path)

    existing = await db.execute_fetchall(
        "SELECT content_hash FROM sync_files_meta WHERE parent_id = ? AND child_id = ? AND file_path = ?",
        (parent_id, PARENT_SPACE_CHILD, file_path),
    )
    if existing and existing[0]["content_hash"] == content_hash:
        return {"path": file_path, "hash": content_hash, "size": size, "uploaded": False}

    _keep_version(parent_id, PARENT_SPACE_CHILD, file_path)
    disk_path.parent.mkdir(parents=True, exist_ok=True)
    disk_path.write_bytes(content)
    _upsert_meta(db, parent_id, PARENT_SPACE_CHILD, file_path, content_hash, size)
    await db.commit()
    return {"path": file_path, "hash": content_hash, "size": size, "uploaded": True}


@router.post("/parent/download")
async def download_parent_file(
    file_path: str = Form(...),
    parent_id: str = Depends(get_current_parent),
):
    """下载一个家长空间文件内容，返回 base64。"""
    import base64 as _b64

    disk_path = _safe_storage_path(get_parent_storage(parent_id), file_path)
    if not disk_path.exists():
        raise HTTPException(status_code=404, detail="File not found on cloud")
    content = disk_path.read_bytes()
    return {
        "path": file_path,
        "content_base64": _b64.b64encode(content).decode("ascii"),
        "size": len(content),
    }


# ---- ISSUE-041 层 C：家长→孩子事件信箱（异步轮询，事件=唤醒信号） ----
# 事件类型：assign_topic（分配主题，payload={topicDir}）、send_materials（资料已更新）、
#          request_progress（家长请求最新进度，payload={}）。
# 数据本身走文件同步（storage/{parent_id}/{child_id}/）；事件只触发对端「现在同步一次」。


class SyncEventIn(BaseModel):
    type: str
    payload: dict = {}


@router.post("/events/{child_id}")
async def post_event(
    child_id: str,
    event: SyncEventIn,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """家长写入一条待处理事件（发送给指定孩子）。"""
    if event.type not in ("assign_topic", "send_materials", "request_progress"):
        raise HTTPException(status_code=400, detail="未知事件类型")
    await db.execute(
        "INSERT INTO sync_events (id, parent_id, child_id, type, payload, status) "
        "VALUES (?, ?, ?, ?, ?, 'pending')",
        (str(uuid.uuid4()), parent_id, child_id, event.type, event.payload),
    )
    await db.commit()
    return {"ok": True}


@router.get("/events/{child_id}")
async def poll_events(
    child_id: str,
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """孩子端轮询：返回该孩子所有 pending 事件（id 升序，便于 ack）。"""
    rows = await db.execute_fetchall(
        "SELECT id, type, payload, created_at FROM sync_events "
        "WHERE parent_id = ? AND child_id = ? AND status = 'pending' ORDER BY created_at ASC",
        (parent_id, child_id),
    )
    return {
        "events": [
            {
                "id": r["id"],
                "type": r["type"],
                "payload": r["payload"] or {},
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }


@router.post("/events/{child_id}/ack")
async def ack_events(
    child_id: str,
    ids: list[str],
    parent_id: str = Depends(get_current_parent),
    db=Depends(get_db),
):
    """孩子端确认处理完成（按事件 id 标记 done）。"""
    if not ids:
        return {"acked": 0}
    placeholders = ",".join("?" for _ in ids)
    await db.execute(
        f"UPDATE sync_events SET status = 'done' "
        f"WHERE parent_id = ? AND child_id = ? AND id IN ({placeholders})",
        (parent_id, child_id, *ids),
    )
    await db.commit()
    return {"acked": len(ids)}


@router.get("/progress/{child_id}")
async def get_cloud_progress(
    child_id: str,
    parent_id: str = Depends(get_current_parent),
):
    """家长异地查进度：直接读云端保存的该孩子 kb.sqlite（无需孩子电脑在线）。

    返回每个主题的课程总数/已完成数 + 最近几条 daily 记录（前端展示摘要）。
    """
    import sqlite3

    kb_path = get_child_storage(parent_id, child_id) / "kb.sqlite"
    if not kb_path.exists():
        return {"topics": [], "daily": [], "note": "云端暂无该孩子的学习数据（孩子端尚未同步）"}

    try:
        con = sqlite3.connect(str(kb_path))
        con.row_factory = sqlite3.Row
        topics = []
        try:
            topic_rows = con.execute(
                "SELECT name, file FROM topics ORDER BY file"
            ).fetchall()
            for t in topic_rows:
                total = con.execute(
                    "SELECT COUNT(*) AS c FROM courses WHERE topic = ?", (t["file"],)
                ).fetchone()["c"]
                done = con.execute(
                    "SELECT COUNT(*) AS c FROM courses WHERE topic = ? AND status = '✅'",
                    (t["file"],),
                ).fetchone()["c"]
                topics.append(
                    {"name": t["name"], "file": t["file"], "courses": total, "done": done}
                )
            daily_rows = con.execute(
                "SELECT date, summary FROM daily ORDER BY date DESC LIMIT 5"
            ).fetchall()
            daily = [{"date": d["date"], "summary": d["summary"] or ""} for d in daily_rows]
        finally:
            con.close()
        return {"topics": topics, "daily": daily}
    except sqlite3.Error:
        return {"topics": [], "daily": [], "note": "云端孩子数据损坏，无法读取"}
