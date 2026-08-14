import os
import uuid
import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from .auth import get_current_parent
from .database import get_db

router = APIRouter(prefix="/api/sync", tags=["sync"])

# File storage root: cloud-service/storage/{parent_id}/{child_id}/
STORAGE_ROOT = Path(__file__).parent.parent / "storage"


def get_child_storage(parent_id: str, child_id: str) -> Path:
    return STORAGE_ROOT / parent_id / child_id


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
    """上传一个孩子数据文件到云端"""
    assert file.filename, "File must have a name"

    # Read file content
    content = await file.read()
    content_hash = compute_hash(content)
    size = len(content)

    # Save to disk
    storage_dir = get_child_storage(parent_id, child_id)
    disk_path = storage_dir / file_path
    disk_path.parent.mkdir(parents=True, exist_ok=True)
    disk_path.write_bytes(content)

    # Update metadata
    now = datetime.now(timezone.utc).isoformat()
    existing = await db.execute_fetchall(
        "SELECT id FROM sync_files_meta WHERE parent_id = ? AND child_id = ? AND file_path = ?",
        (parent_id, child_id, file_path),
    )

    if existing:
        await db.execute(
            "UPDATE sync_files_meta SET content_hash = ?, size = ?, updated_at = ? "
            "WHERE parent_id = ? AND child_id = ? AND file_path = ?",
            (content_hash, size, now, parent_id, child_id, file_path),
        )
    else:
        await db.execute(
            "INSERT INTO sync_files_meta (id, parent_id, child_id, file_path, content_hash, size, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), parent_id, child_id, file_path, content_hash, size, now),
        )
    await db.commit()

    return {"path": file_path, "hash": content_hash, "size": size, "uploaded": True}


@router.post("/download/{child_id}")
async def download_file(
    child_id: str,
    file_path: str = Form(...),
    parent_id: str = Depends(get_current_parent),
):
    """从云端下载指定孩子的文件内容，返回 base64 编码的文件数据"""
    import base64

    disk_path = get_child_storage(parent_id, child_id) / file_path
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
        disk_path = storage_dir / fp
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
