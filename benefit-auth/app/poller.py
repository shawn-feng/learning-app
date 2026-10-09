"""任务完成自动轮询（每分钟）——用户无需回站点击「验证」。

机制：抖音完成查询接口是按 (活动, open_id) 拉取式的，没有"列出谁完成了"的推送，
所以对当日有效的 bt_* 自动任务，轮询所有绑定抖音号：
- 对任务的每个平台活动查完成状态，任一 true 即完成；
- 完成且无实例 → 直接创建 granted 实例 + 发放权益（用户下次打开页面即见"已完成"）；
- 已领取未完成的实例 → 保持（用户仍可点「我完成了，验证」即时核查）；
- submitted（转发凭证待人工审）→ 跳过，不抢人工审核；
- 平台 token 过期自动用 refresh_token 续期；无 task_verify scope 的账号跳过（省配额）。

环境变量：POLL_INTERVAL_S（默认 60）。
"""
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite
import httpx

from .database import DB_PATH

INTERVAL = int(os.environ.get("POLL_INTERVAL_S", "60"))
BASE = "https://open.douyin.com"


def log(*a):
    print("[poller]", time.strftime("%m-%d %H:%M:%S"), *a, flush=True)


def _client_token() -> str:
    r = httpx.post(BASE + "/oauth/client_token/", json={
        "client_key": os.environ.get("DOUYIN_CLIENT_KEY", ""),
        "client_secret": os.environ.get("DOUYIN_CLIENT_SECRET", ""),
        "grant_type": "client_credential"})
    return r.json()["data"]["access_token"]


async def run_once():
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    try:
        now = datetime.now(timezone.utc).isoformat()
        tasks = await db.execute_fetchall(
            """SELECT * FROM tasks WHERE status='active' AND verify_mode='auto'
               AND task_type LIKE 'bt_%' AND start_at<=? AND end_at>=?""", (now, now))
        if not tasks:
            return
        accounts = await db.execute_fetchall(
            """SELECT pa.*, u.nickname FROM platform_accounts pa JOIN users u ON u.id=pa.user_id
               WHERE pa.platform='douyin'""")
        checked = granted = skipped_done = skipped_scope = 0
        for task_row in tasks:
            task = dict(task_row)
            target = json.loads(task["target_config"] or "{}")
            acts = [a for a in (target.get("activities") or [])
                    if a.get("activity_id") and a.get("business_task_id")]
            if not acts:
                continue
            # 按活动分组（单活动多任务 → 每用户每轮 1 次请求）
            groups: dict[int, list[int]] = {}
            for a in acts:
                groups.setdefault(int(a["activity_id"]), []).append(int(a["business_task_id"]))
            for acc_row in accounts:
                acc = dict(acc_row)
                # 实例预检：已发放/待人工审的不再查平台（完成即退出轮询，请求量归零）
                inst = await db.execute_fetchall(
                    "SELECT status FROM task_instances WHERE task_id=? AND user_id=?",
                    (task["id"], acc["user_id"]))
                if inst and inst[0]["status"] in ("granted", "submitted"):
                    skipped_done += 1
                    continue
                if "task_verify" not in (acc.get("scopes") or ""):
                    skipped_scope += 1
                    continue
                token = await _fresh_token(db, acc)
                if not token:
                    continue
                ok, results = await _query_completion(token, acc["platform_user_id"], groups)
                checked += 1
                if not ok:
                    continue
                g = await _grant_if_needed(db, task, acc, results)
                granted += g
        if checked or granted:
            log(f"checked={checked} granted={granted} "
                f"done_skip={skipped_done} no_scope_skip={skipped_scope}")
    finally:
        await db.close()


async def _fresh_token(db, acc: dict) -> str | None:
    """token 未过期直接用；过期则 refresh_token 续期并落库。失败返回 None。"""
    token = acc.get("access_token") or ""
    exp = str(acc.get("token_expires_at") or "")
    try:
        expired = (datetime.fromisoformat(exp.replace("Z", "+00:00"))
                   <= datetime.now(timezone.utc)) if exp else True
    except Exception:
        expired = True
    if not expired:
        return token
    if not acc.get("refresh_token"):
        return None
    try:
        r = httpx.post(BASE + "/oauth/refresh_token/", data={
            "client_key": os.environ.get("DOUYIN_CLIENT_KEY", ""),
            "client_secret": os.environ.get("DOUYIN_CLIENT_SECRET", ""),
            "refresh_token": acc["refresh_token"], "grant_type": "refresh_token"})
        d = r.json().get("data") or {}
        if str(d.get("error_code", d.get("err_no", 1))) in ("0", 0) and d.get("access_token"):
            token = d["access_token"]
            rt = d.get("refresh_token") or acc["refresh_token"]
            await db.execute(
                "UPDATE platform_accounts SET access_token=?, refresh_token=?, "
                "token_expires_at=datetime('now','+15 days') WHERE id=?",
                (token, rt, acc["id"]))
            await db.commit()
            log("token refreshed:", acc.get("nickname"))
            return token
        log("token refresh failed:", acc.get("nickname"), str(d)[:100])
    except Exception as e:  # noqa: BLE001
        log("token refresh error:", acc.get("nickname"), str(e)[:120])
    return None


async def _query_completion(token: str, open_id: str,
                            groups: dict[int, list[int]]) -> tuple[bool, dict]:
    """按活动分组批量查询：每组 1 次请求（task_id_list 批量）。任一任务 true 即 ok。"""
    ok, results = False, {}
    async with httpx.AsyncClient(timeout=15) as client:
        for aid, tids in groups.items():
            try:
                r = await client.post(
                    BASE + "/dy_open_api/apps/v3/activity/query_activity_user_completion_status/",
                    headers={"access-token": token, "content-type": "application/json"},
                    json={"activity_id": aid, "target_open_id": open_id,
                          "task_id_list": tids})
                m = ((r.json().get("data") or {}).get("task_complete_status_map") or {})
                for tid in tids:
                    v = bool(m.get(str(tid)))
                    results[str(tid)] = v
                    ok = ok or v
            except Exception as e:  # noqa: BLE001
                results[f"{aid}?err"] = str(e)[:80]
    return ok, results


async def _grant_if_needed(db, task: dict, acc: dict, results: dict) -> int:
    """完成且未发放 → 实例置 granted + 发权益。返回发放数。"""
    user_id = acc["user_id"]
    inst = await db.execute_fetchall(
        "SELECT * FROM task_instances WHERE task_id=? AND user_id=?",
        (task["id"], user_id))
    now = datetime.now(timezone.utc).isoformat()
    detail = json.dumps({"ok": True, "detail": {
        "method": "business_task_multi", "mode": "live", "poller": True,
        "results": results}}, ensure_ascii=False)
    if inst:
        s = inst[0]["status"]
        if s == "granted" or s == "submitted":
            return 0
        # claimed（用户领了没点验证）或 rejected（凭证被拒但平台实测完成）→ 平台权威，发放
        await db.execute(
            "UPDATE task_instances SET status='granted', granted_at=?, verify_detail=? WHERE id=?",
            (now, detail, inst[0]["id"]))
        instance_id = inst[0]["id"]
    else:
        instance_id = os.urandom(16).hex()
        await db.execute(
            """INSERT INTO task_instances (id, task_id, user_id, status, verify_detail, claimed_at, granted_at)
               VALUES (?,?,?,?,?,?,?)""",
            (instance_id, task["id"], user_id, "granted", detail, now, now))
    await db.execute(
        """INSERT INTO entitlements (id, app_id, user_id, task_id, task_instance_id, reward_code, status)
           VALUES (?,?,?,?,?,?, 'active')""",
        (os.urandom(16).hex(), task["app_id"], user_id, task["id"], instance_id,
         task["reward_config"] or "{}"))
    await db.commit()
    log("GRANTED:", acc.get("nickname"), "task:", task["title"], "results:",
        json.dumps(results, ensure_ascii=False))
    return 1


async def poll_loop():
    await asyncio.sleep(30)  # 等服务起稳
    log(f"started, interval={INTERVAL}s")
    while True:
        try:
            await run_once()
        except Exception as e:  # noqa: BLE001
            log("run_once error:", str(e)[:300])
        await asyncio.sleep(INTERVAL)
