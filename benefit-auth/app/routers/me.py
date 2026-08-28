"""权益认证中台 - 用户侧 API

/me 个人主页、任务列表/领取/提交、我的权益
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database import get_db, new_id
from ..deps import get_current_user
from ..verifiers import get_verifier

router = APIRouter(prefix="/api/me", tags=["me"])


class SubmitRequest(BaseModel):
    proof_url: str = ""
    proof_text: str = ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- 个人主页 ----------
@router.get("")
async def me(user_id: str = Depends(get_current_user), db=Depends(get_db)):
    users = await db.execute_fetchall("SELECT * FROM users WHERE id = ?", (user_id,))
    if not users:
        raise HTTPException(status_code=404, detail="User not found")
    u = users[0]

    accounts = await db.execute_fetchall(
        "SELECT platform, platform_user_id, nickname, avatar_url, bind_at FROM platform_accounts WHERE user_id=?",
        (user_id,),
    )
    return {
        "user_id": user_id,
        "nickname": u["nickname"],
        "avatar_url": u["avatar_url"],
        "email": u["email"],
        "platform_accounts": [dict(a) for a in accounts],
    }


# ---------- 任务列表（按 App 分组，含我的状态） ----------
@router.get("/tasks")
async def my_tasks(user_id: str = Depends(get_current_user), db=Depends(get_db)):
    now = _now()
    tasks = await db.execute_fetchall(
        """SELECT t.*, a.name AS app_name, a.icon_url AS app_icon
           FROM tasks t JOIN apps a ON a.app_id = t.app_id
           WHERE t.status='active'
             AND (t.start_at IS NULL OR t.start_at <= ?)
             AND (t.end_at IS NULL OR t.end_at >= ?)
           ORDER BY t.created_at DESC""",
        (now, now),
    )
    result = []
    for t in tasks:
        instances = await db.execute_fetchall(
            "SELECT * FROM task_instances WHERE task_id=? AND user_id=? ORDER BY claimed_at DESC",
            (t["id"], user_id),
        )
        my_status = None
        instance_id = None
        if instances:
            latest = instances[0]
            my_status = latest["status"]
            instance_id = latest["id"]

        can_claim = my_status is None
        if my_status == "rejected":
            claimed_count = len(instances)
            can_claim = claimed_count < (t["max_times_per_user"] or 1)

        result.append({
            "task_id": t["id"],
            "app_name": t["app_name"],
            "app_icon": t["app_icon"],
            "title": t["title"],
            "description": t["description"],
            "task_type": t["task_type"],
            "target_config": json.loads(t["target_config"] or "{}"),
            "reward_config": json.loads(t["reward_config"] or "{}"),
            "verify_mode": t["verify_mode"],
            "my_status": my_status,
            "task_instance_id": instance_id,
            "can_claim": can_claim,
            "max_times_per_user": t["max_times_per_user"],
        })
    return {"tasks": result}


# ---------- 领取任务 ----------
@router.post("/tasks/{task_id}/claim")
async def claim_task(task_id: str, user_id: str = Depends(get_current_user), db=Depends(get_db)):
    now = _now()
    rows = await db.execute_fetchall(
        """SELECT * FROM tasks WHERE id=? AND status='active'
           AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at >= ?)""",
        (task_id, now, now),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Task not found or not active")
    task = rows[0]

    # 领取次数限制（含 rejected 可重试）
    claimed = (await db.execute_fetchall(
        "SELECT COUNT(*) c FROM task_instances WHERE task_id=? AND user_id=?", (task_id, user_id)))[0]["c"]
    if claimed >= (task["max_times_per_user"] or 1):
        raise HTTPException(status_code=409, detail="Task claim limit reached")

    # 已有未终结实例则直接返回
    active_instances = await db.execute_fetchall(
        "SELECT * FROM task_instances WHERE task_id=? AND user_id=? AND status IN ('claimed','submitted')",
        (task_id, user_id),
    )
    if active_instances:
        return {"task_instance_id": active_instances[0]["id"], "status": active_instances[0]["status"]}

    instance_id = new_id()
    await db.execute(
        "INSERT INTO task_instances (id, task_id, user_id, status, claimed_at) VALUES (?,?,?,?,?)",
        (instance_id, task_id, user_id, "claimed", now),
    )
    await db.commit()

    # 可自动验证的任务：领取后立即尝试自动验证（bind_account / follow_account 等）
    return await _auto_verify_if_possible(instance_id, task, user_id, db)


async def _auto_verify_if_possible(instance_id: str, task: dict, user_id: str, db):
    """领取后立即自动验证（auto 模式）。manual 模式等用户提交凭证。"""
    if task["verify_mode"] != "auto":
        return {"task_instance_id": instance_id, "status": "claimed"}

    accounts = await db.execute_fetchall(
        "SELECT * FROM platform_accounts WHERE user_id=? AND platform='douyin'", (user_id,))
    if not accounts:
        return {"task_instance_id": instance_id, "status": "claimed", "note": "awaiting platform bind"}

    account = accounts[0]
    inst_rows = await db.execute_fetchall("SELECT * FROM task_instances WHERE id=?", (instance_id,))
    instance = dict(inst_rows[0])
    instance["task_type"] = task["task_type"]
    instance["target_config"] = task["target_config"]

    verifier = get_verifier(task)
    result = await verifier.verify(instance, account)

    now = _now()
    await db.execute(
        "UPDATE task_instances SET status=?, verify_detail=?, granted_at=? WHERE id=?",
        ("granted" if result.ok else "claimed", json.dumps(result.to_dict(), ensure_ascii=False), now, instance_id),
    )
    if result.ok:
        await _grant_entitlement(task, instance_id, user_id, db)
    await db.commit()
    return {"task_instance_id": instance_id, "status": "granted" if result.ok else "claimed",
            "verify": result.to_dict()}


# ---------- 提交完成凭证（manual 模式） ----------
@router.post("/tasks/{instance_id}/submit")
async def submit_proof(instance_id: str, req: SubmitRequest,
                       user_id: str = Depends(get_current_user), db=Depends(get_db)):
    rows = await db.execute_fetchall(
        "SELECT * FROM task_instances WHERE id=? AND user_id=?", (instance_id, user_id))
    if not rows:
        raise HTTPException(status_code=404, detail="Task instance not found")
    inst = rows[0]
    if inst["status"] not in ("claimed", "rejected"):
        raise HTTPException(status_code=409, detail=f"Task already {inst['status']}")

    if not req.proof_url.strip() and not req.proof_text.strip():
        raise HTTPException(status_code=400, detail="Please provide proof (link or text)")

    evidence = {"proof_url": req.proof_url.strip(), "proof_text": req.proof_text.strip()}
    await db.execute(
        "UPDATE task_instances SET status='submitted', evidence=?, submitted_at=? WHERE id=?",
        (json.dumps(evidence, ensure_ascii=False), _now(), instance_id),
    )
    await db.commit()
    return {"task_instance_id": instance_id, "status": "submitted", "note": "awaiting review"}


# ---------- 我的权益 ----------
@router.get("/entitlements")
async def my_entitlements(user_id: str = Depends(get_current_user), db=Depends(get_db)):
    rows = await db.execute_fetchall(
        """SELECT e.*, t.title AS task_title, a.name AS app_name
           FROM entitlements e
           LEFT JOIN tasks t ON t.id = e.task_id
           LEFT JOIN apps a ON a.app_id = e.app_id
           WHERE e.user_id = ? ORDER BY e.granted_at DESC""",
        (user_id,),
    )
    return {"entitlements": [{
        "id": e["id"], "app_name": e["app_name"], "task_title": e["task_title"],
        "reward_code": json.loads(e["reward_code"] or "{}"),
        "status": e["status"], "granted_at": e["granted_at"], "used_at": e["used_at"],
    } for e in rows]}


async def _grant_entitlement(task: dict, instance_id: str, user_id: str, db):
    """发放权益：把 reward_config 写入 entitlements"""
    ent_id = new_id()
    await db.execute(
        """INSERT INTO entitlements (id, app_id, user_id, task_id, task_instance_id, reward_code, status)
           VALUES (?,?,?,?,?,?, 'active')""",
        (ent_id, task["app_id"], user_id, task["id"], instance_id,
         json.dumps(task.get("reward_config") or {}, ensure_ascii=False)),
    )
