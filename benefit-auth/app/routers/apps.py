"""权益认证中台 - App 侧 API

App 注册 → 获得 app_id/app_secret → 换取 app_token → 创建任务 / 查询用户权益
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database import get_db, new_id
from ..deps import get_current_app
from ..security import create_app_token, gen_app_credentials, hash_secret, verify_secret

router = APIRouter(prefix="/api/app", tags=["app"])


# ---------- 模型 ----------
class RegisterAppRequest(BaseModel):
    name: str
    icon_url: str = ""


class AppTokenRequest(BaseModel):
    app_id: str
    app_secret: str


class CreateTaskRequest(BaseModel):
    title: str
    description: str = ""
    task_type: str                     # follow_account / publish_video / bind_account / fans_reach / like_comment
    target_config: dict = {}
    reward_config: dict = {}           # 权益定义，如 {"type":"vip_days","days":7}
    verify_mode: str = "auto"          # auto / manual
    max_times_per_user: int = 1
    start_at: str | None = None
    end_at: str | None = None


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    target_config: dict | None = None
    reward_config: dict | None = None
    status: str | None = None
    start_at: str | None = None
    end_at: str | None = None


# ---------- 注册与凭证 ----------
@router.post("/register")
async def register_app(req: RegisterAppRequest, db=Depends(get_db)):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="App name is required")
    app_id, app_secret = gen_app_credentials()
    await db.execute(
        "INSERT INTO apps (id, app_id, app_secret_hash, name, icon_url) VALUES (?,?,?,?,?)",
        (new_id(), app_id, hash_secret(app_secret), req.name.strip(), req.icon_url),
    )
    await db.commit()
    # 明文 secret 只在此刻返回一次
    return {"app_id": app_id, "app_secret": app_secret, "name": req.name.strip()}


@router.post("/token")
async def app_token(req: AppTokenRequest, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM apps WHERE app_id = ?", (req.app_id,))
    if not rows:
        raise HTTPException(status_code=401, detail="Invalid app credentials")
    app = rows[0]
    if not verify_secret(req.app_secret, app["app_secret_hash"]):
        raise HTTPException(status_code=401, detail="Invalid app credentials")
    if app["status"] != "active":
        raise HTTPException(status_code=403, detail="App disabled")
    return {"app_token": create_app_token(app["app_id"]), "expires_in": 86400}


# ---------- 任务管理 ----------
_TASK_TYPES = {"follow_account", "publish_video", "bind_account", "fans_reach", "like_comment"}
_VERIFY_MODES = {"auto", "manual"}


@router.post("/tasks")
async def create_task(req: CreateTaskRequest, app_id: str = Depends(get_current_app), db=Depends(get_db)):
    if req.task_type not in _TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"task_type must be one of {sorted(_TASK_TYPES)}")
    if req.verify_mode not in _VERIFY_MODES:
        raise HTTPException(status_code=400, detail="verify_mode must be auto or manual")
    if req.task_type == "like_comment" and req.verify_mode == "auto":
        # 抖音开放平台无点赞/评论查询接口，自动验证不可行，强制 manual
        raise HTTPException(status_code=400, detail="like_comment 任务平台无自动验证接口，verify_mode 必须为 manual")

    task_id = new_id()
    await db.execute(
        """INSERT INTO tasks (id, app_id, title, description, task_type, target_config, reward_config,
           verify_mode, max_times_per_user, start_at, end_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (task_id, app_id, req.title.strip(), req.description,
         req.task_type, json.dumps(req.target_config, ensure_ascii=False),
         json.dumps(req.reward_config, ensure_ascii=False),
         req.verify_mode, max(1, req.max_times_per_user), req.start_at, req.end_at),
    )
    await db.commit()
    return {"task_id": task_id, "status": "created"}


@router.get("/tasks")
async def list_tasks(app_id: str = Depends(get_current_app), db=Depends(get_db)):
    rows = await db.execute_fetchall(
        "SELECT * FROM tasks WHERE app_id = ? ORDER BY created_at DESC", (app_id,)
    )
    result = []
    for t in rows:
        claimed = (await db.execute_fetchall(
            "SELECT COUNT(*) c FROM task_instances WHERE task_id = ?", (t["id"],)))[0]["c"]
        granted = (await db.execute_fetchall(
            "SELECT COUNT(*) c FROM task_instances WHERE task_id = ? AND status='granted'", (t["id"],)))[0]["c"]
        result.append({
            "id": t["id"], "title": t["title"], "description": t["description"],
            "task_type": t["task_type"],
            "target_config": json.loads(t["target_config"] or "{}"),
            "reward_config": json.loads(t["reward_config"] or "{}"),
            "verify_mode": t["verify_mode"], "status": t["status"],
            "claimed_count": claimed, "granted_count": granted,
            "created_at": t["created_at"],
        })
    return {"tasks": result}


@router.put("/tasks/{task_id}")
async def update_task(task_id: str, req: UpdateTaskRequest,
                      app_id: str = Depends(get_current_app), db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM tasks WHERE id = ? AND app_id = ?", (task_id, app_id))
    if not rows:
        raise HTTPException(status_code=404, detail="Task not found")
    fields = []
    values = []
    for key, col in [("title", "title"), ("description", "description"),
                     ("target_config", "target_config"), ("reward_config", "reward_config"),
                     ("status", "status"), ("start_at", "start_at"), ("end_at", "end_at")]:
        val = getattr(req, key)
        if val is not None:
            fields.append(f"{col}=?")
            values.append(json.dumps(val, ensure_ascii=False) if col in ("target_config", "reward_config") else val)
    if fields:
        values.append(task_id)
        await db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", values)
        await db.commit()
    return {"task_id": task_id, "updated": True}


# ---------- 用户权益查询（App 侧） ----------
@router.get("/users/{user_id}/entitlements")
async def get_user_entitlements(user_id: str, app_id: str = Depends(get_current_app), db=Depends(get_db)):
    """App 查询某用户的全部权益（只返回本 App 的）"""
    rows = await db.execute_fetchall(
        """SELECT e.*, t.title AS task_title FROM entitlements e
           LEFT JOIN tasks t ON t.id = e.task_id
           WHERE e.user_id = ? AND e.app_id = ? ORDER BY e.granted_at DESC""",
        (user_id, app_id),
    )
    return {"entitlements": [{
        "id": e["id"], "user_id": e["user_id"], "task_id": e["task_id"],
        "task_title": e["task_title"], "reward_code": json.loads(e["reward_code"] or "{}"),
        "status": e["status"], "granted_at": e["granted_at"], "used_at": e["used_at"],
    } for e in rows]}


@router.post("/entitlements/{entitlement_id}/consume")
async def consume_entitlement(entitlement_id: str, app_id: str = Depends(get_current_app), db=Depends(get_db)):
    """核销权益（用户已使用，权益标记 used）"""
    rows = await db.execute_fetchall(
        "SELECT * FROM entitlements WHERE id = ? AND app_id = ?", (entitlement_id, app_id))
    if not rows:
        raise HTTPException(status_code=404, detail="Entitlement not found")
    ent = rows[0]
    if ent["status"] != "active":
        raise HTTPException(status_code=409, detail=f"Entitlement already {ent['status']}")
    now = datetime.now(timezone.utc).isoformat()
    await db.execute("UPDATE entitlements SET status='used', used_at=? WHERE id=?", (now, entitlement_id))
    await db.commit()
    return {"entitlement_id": entitlement_id, "status": "used"}


# ---------- 人工审核（manual 任务） ----------
class ReviewRequest(BaseModel):
    action: str        # approve / reject
    comment: str = ""


@router.get("/tasks/{task_id}/reviews")
async def list_pending_reviews(task_id: str, app_id: str = Depends(get_current_app), db=Depends(get_db)):
    """查看某任务的待审核实例（App 后台人工审核）"""
    task_rows = await db.execute_fetchall("SELECT * FROM tasks WHERE id=? AND app_id=?", (task_id, app_id))
    if not task_rows:
        raise HTTPException(status_code=404, detail="Task not found")
    rows = await db.execute_fetchall(
        """SELECT ti.*, u.nickname AS user_nickname FROM task_instances ti
           LEFT JOIN users u ON u.id = ti.user_id
           WHERE ti.task_id=? AND ti.status='submitted' ORDER BY ti.submitted_at""",
        (task_id,),
    )
    return {"pending": [{
        "task_instance_id": r["id"], "user_id": r["user_id"], "user_nickname": r["user_nickname"],
        "evidence": json.loads(r["evidence"] or "{}"), "submitted_at": r["submitted_at"],
    } for r in rows]}


@router.post("/reviews/{instance_id}")
async def review_instance(instance_id: str, req: ReviewRequest,
                          app_id: str = Depends(get_current_app), db=Depends(get_db)):
    """审核通过/拒绝：通过则发放权益"""
    if req.action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve or reject")

    inst_rows = await db.execute_fetchall(
        """SELECT ti.*, t.app_id AS task_app_id, t.id AS tid, t.reward_config, t.verify_mode
           FROM task_instances ti JOIN tasks t ON t.id = ti.task_id
           WHERE ti.id=?""",
        (instance_id,),
    )
    if not inst_rows:
        raise HTTPException(status_code=404, detail="Task instance not found")
    inst = inst_rows[0]
    if inst["task_app_id"] != app_id:
        raise HTTPException(status_code=403, detail="Not your task")
    if inst["status"] != "submitted":
        raise HTTPException(status_code=409, detail=f"Task not awaiting review (status={inst['status']})")

    now = datetime.now(timezone.utc).isoformat()
    if req.action == "approve":
        await db.execute(
            "UPDATE task_instances SET status='granted', granted_at=? WHERE id=?", (now, instance_id))
        # 发放权益
        await db.execute(
            """INSERT INTO entitlements (id, app_id, user_id, task_id, task_instance_id, reward_code, status)
               VALUES (?,?,?,?,?,?, 'active')""",
            (new_id(), app_id, inst["user_id"], inst["tid"], instance_id,
             json.dumps(json.loads(inst["reward_config"] or "{}"), ensure_ascii=False)),
        )
    else:
        await db.execute(
            "UPDATE task_instances SET status='rejected' WHERE id=?", (instance_id,))
    await db.execute(
        "INSERT INTO reviews (id, task_instance_id, reviewer, action, comment) VALUES (?,?,?,?,?)",
        (new_id(), instance_id, app_id, req.action, req.comment),
    )
    await db.commit()
    return {"task_instance_id": instance_id, "status": "granted" if req.action == "approve" else "rejected"}
