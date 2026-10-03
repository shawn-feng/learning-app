"""每日推广视频自动化（campaign）。

定时拉取发布者账号（做给孩子看）的最新视频：
- 视频列表 API 需要 video.list.bind 能力（应用级审批）+ 发布者 token 授权该 scope；
  未就绪时静默跳过（保留当前配置），能力开通后自动生效。
- 检测到新视频（item_id 变化）→
  ①更新 campaign 设置（settings 表）
  ②重建 share 活动（平台把转发任务绑到创建时的最新视频，需随视频更替）
  ③更新五条任务的展示字段（target_url / video_title）
- 旧 share 活动 modify 结束，释放名额。

环境变量：CAMPAIGN_PUBLISHER_OPEN_ID / CAMPAIGN_PUBLISHER_DY / CAMPAIGN_INTERVAL_H
"""
import asyncio
import json
import os
import time
from datetime import datetime, timezone

import aiosqlite
import httpx

from .database import DB_PATH

BASE = "https://open.douyin.com"
KEY = os.environ.get("DOUYIN_CLIENT_KEY", "")
SECRET = os.environ.get("DOUYIN_CLIENT_SECRET", "")
PUBLISHER_OPEN_ID = os.environ.get("CAMPAIGN_PUBLISHER_OPEN_ID", "_000dcEmsmrTQyTRgebT099IxxvFSF50kxp6")
PUBLISHER_DY = os.environ.get("CAMPAIGN_PUBLISHER_DY", "1262668803")
INTERVAL_H = float(os.environ.get("CAMPAIGN_INTERVAL_H", "2"))

LABELS = {
    "demo-bt-follow": "关注账号", "demo-bt-like": "点赞视频", "demo-bt-finish": "完播视频",
    "demo-bt-share": "转发视频", "demo-bt-comment": "评论视频",
}
# 五类任务的建活动配方（账号维度；share 平台会自动绑最新视频，随视频更替重建）
TASK_DEFS = [
    ("demo-bt-follow", "关注做给孩子看", 3,
     {"account_follow_event_info": {"aweme_id": PUBLISHER_DY}}),
    ("demo-bt-like", "给账号视频点赞", 1,
     {"short_video_digg_event_info": {"anchor_id": PUBLISHER_DY}}),
    ("demo-bt-finish", "看完账号视频", 1,
     {"short_video_finish_playing_event_info": {"anchor_id": PUBLISHER_DY,
                                                "finish_play_video_count": 1}}),
    ("demo-bt-share", "转发账号视频", 1,
     {"short_video_share_event_info": {"anchor_id": PUBLISHER_DY}}),
    ("demo-bt-comment", "评论账号视频", 1,
     {"short_video_comment_event_info": {"anchor_id": PUBLISHER_DY}}),
]


def log(*a):
    print("[campaign]", time.strftime("%m-%d %H:%M:%S"), *a, flush=True)


async def get_setting(db, key, default=None):
    rows = await db.execute_fetchall("SELECT value FROM settings WHERE key=?", (key,))
    return rows[0]["value"] if rows else default


async def set_setting(db, key, value):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
    await db.commit()


def client_token() -> str:
    r = httpx.post(BASE + "/oauth/client_token/", json={
        "client_key": KEY, "client_secret": SECRET, "grant_type": "client_credential"})
    return r.json()["data"]["access_token"]


async def get_publisher(db) -> dict | None:
    rows = await db.execute_fetchall(
        "SELECT * FROM platform_accounts WHERE platform='douyin' AND platform_user_id=?",
        (PUBLISHER_OPEN_ID,))
    return dict(rows[0]) if rows else None


async def refresh_if_needed(db, acc: dict) -> dict:
    exp = str(acc.get("token_expires_at") or "")
    try:
        expired = (datetime.fromisoformat(exp.replace("Z", "+00:00")) <= datetime.now(timezone.utc)) if exp else True
    except Exception:
        expired = True
    if not expired:
        return acc
    if not acc.get("refresh_token"):
        return acc
    r = httpx.post(BASE + "/oauth/refresh_token/", data={
        "client_key": KEY, "client_secret": SECRET,
        "refresh_token": acc["refresh_token"], "grant_type": "refresh_token"})
    d = r.json().get("data") or {}
    if str(d.get("error_code", d.get("err_no", 1))) in ("0", 0) and d.get("access_token"):
        acc["access_token"] = d["access_token"]
        if d.get("refresh_token"):
            acc["refresh_token"] = d["refresh_token"]
        await db.execute(
            "UPDATE platform_accounts SET access_token=?, refresh_token=?, "
            "token_expires_at=datetime('now','+15 days') WHERE id=?",
            (acc["access_token"], acc["refresh_token"], acc["id"]))
        await db.commit()
        log("publisher token refreshed")
    else:
        log("publisher token refresh FAILED:", str(d)[:120])
    return acc


async def fetch_latest_video(db) -> dict | None:
    """返回 {item_id, title, url} 或 None（能力未批/无视频/接口失败）。"""
    acc = await refresh_if_needed(db, await get_publisher(db))
    if not acc or not acc.get("access_token"):
        log("no publisher account/token")
        return None
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(BASE + "/oauth/video/list/", params={
            "access_token": acc["access_token"], "open_id": acc["platform_user_id"],
            "cursor": 0, "count": 5})
    body = r.json()
    data = body.get("data") or {}
    items = data.get("list") or []
    if not items:
        log("video list empty/error:", json.dumps(body, ensure_ascii=False)[:200])
        return None
    it = items[0]
    iid = str(it.get("item_id") or "")
    url = it.get("share_url") or (f"https://www.douyin.com/video/{iid}" if iid.isdigit() else "")
    if not url:
        log("latest video has no usable url:", json.dumps(it, ensure_ascii=False)[:200])
        return None
    return {"item_id": iid, "title": str(it.get("title") or "")[:40], "url": url}


async def create_share_activity(title_date: str) -> tuple[int, int] | None:
    """按已验证配方新建转发活动，返回 (activity_id, business_task_id)；经 query_info 取权威 task id。"""
    now = int(time.time())
    body = {
        "activity_name": f"转发做给孩子看 {title_date}"[:50],
        "start_time": now + 60, "end_time": now + 86400 * 30,
        "not_bc_check": True,
        "create_business_task_info_list": [{
            "task_name": "转发账号视频",
            "start_time": now + 60, "end_time": now + 86400 * 30,
            "task_event_info": {
                "common_event_info": {
                    "task_type_enum": 1,
                    "task_dependence": {"dependence_list": [
                        {"dependence_type_enum": 2, "dependence_value": PUBLISHER_DY}]},
                    "complete_conditions": [
                        {"condition_type": 4, "task_complete_condition_stage": [1]}],
                },
                "short_video_share_event_info": {"anchor_id": PUBLISHER_DY},
            }}]}
    try:
        r = httpx.post(BASE + "/dy_open_api/apps/v3/activity/create/",
                       headers={"access-token": client_token(), "content-type": "application/json"},
                       json=body)
        d = r.json()
        if str(d.get("err_no")) != "0":
            log("share activity create failed:", str(d)[:200])
            return None
        aid = d["data"]["activity_id"]
        q = httpx.post(BASE + "/dy_open_api/apps/v3/activity/query_info/",
                       headers={"access-token": client_token(), "content-type": "application/json"},
                       json={"activity_id": aid})
        tl = ((q.json().get("data") or {}).get("business_task_info_list") or [{}])[0]
        btid = int(tl.get("task_id") or 0)
        m = httpx.post(BASE + "/dy_open_api/apps/v3/activity/modify/",
                       headers={"access-token": client_token(), "content-type": "application/json"},
                       json={"activity_id": aid, "start_time": now - 1, "end_time": now + 86400 * 30})
        log(f"share activity created: activity={aid} task={btid} modify={m.json().get('err_no')}")
        return aid, btid
    except Exception as e:  # noqa: BLE001
        log("share activity create error:", str(e)[:200])
        return None


async def end_activity(aid: int):
    try:
        now = int(time.time())
        httpx.post(BASE + "/dy_open_api/apps/v3/activity/modify/",
                   headers={"access-token": client_token(), "content-type": "application/json"},
                   json={"activity_id": aid, "start_time": now - 86400 * 31,
                         "end_time": now - 86400 * 30})
        log("old activity ended:", aid)
    except Exception as e:  # noqa: BLE001
        log("end activity error:", aid, str(e)[:120])


async def run_once():
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    try:
        latest = await fetch_latest_video(db)
        if not latest:
            return
        cur_raw = await get_setting(db, "campaign_video")
        cur = json.loads(cur_raw) if cur_raw else None
        if cur and cur.get("item_id") == latest["item_id"]:
            log("video unchanged:", latest["item_id"])
            return
        log("NEW video detected:", json.dumps(latest, ensure_ascii=False))
        # 1) 重建 share 活动（平台绑最新视频）
        share_task = await db.execute_fetchall(
            "SELECT target_config FROM tasks WHERE id='demo-bt-share'")
        old_share = json.loads((share_task[0]["target_config"] if share_task else "{}") or "{}")
        wired = await create_share_activity(time.strftime("%m%d"))
        # 2) 更新五条任务展示（share 若重建成功则换接线，否则保留旧接线仅换展示）
        for tid, _, _, _ in TASK_DEFS:
            rows = await db.execute_fetchall("SELECT target_config FROM tasks WHERE id=?", (tid,))
            if not rows:
                continue
            tc = json.loads(rows[0]["target_config"] or "{}")
            tc["target_url"] = latest["url"]
            tc["video_title"] = latest["title"]
            tc["target_name"] = tc.get("target_name") or "做给孩子看"
            if tid == "demo-bt-share" and wired:
                if old_share.get("activity_id"):
                    await end_activity(old_share["activity_id"])
                tc["activity_id"], tc["business_task_id"] = wired
            await db.execute("UPDATE tasks SET target_config=? WHERE id=?",
                             (json.dumps(tc, ensure_ascii=False), tid))
        await db.commit()
        # 3) 记录 campaign 设置
        await set_setting(db, "campaign_video", json.dumps(latest, ensure_ascii=False))
        log("campaign re-wired to", latest["item_id"])
    finally:
        await db.close()


async def campaign_loop():
    await asyncio.sleep(20)  # 等服务起稳
    while True:
        try:
            await run_once()
        except Exception as e:  # noqa: BLE001
            log("run_once error:", str(e)[:300])
        await asyncio.sleep(INTERVAL_H * 3600)
