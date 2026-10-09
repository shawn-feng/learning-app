"""权益认证中台 - 管理端（X-Admin-Token 鉴权）

- POST /api/admin/daily-task      每日任务生成（幂等；当天 23:59 过期；视频轮换）
- GET  /api/admin/pending-reviews 待审核凭证列表（学习伙伴应用）
- POST /api/admin/review          通过/拒绝（通过即发放权益）
- GET  /admin/reviews?token=      管理审核页（浏览器用）

每日任务机制（2026-09-30 定稿）：自动检测为主、人工审核兜底。
- 自动检测（bt_* 经营任务，verify_mode=auto）：点赞 / 完播 / 评论 —— 每天生成当日任务时同步
  创建**当日平台活动**（平台完成记录=每用户每活动一次，日抛活动才能支撑每日重做），
  用户点「我完成了，验证」时服务端真查平台完成状态（open.business.task_verify）。
- 人工审核兜底（bt_share，verify_mode=manual）：转发——平台对转发事件不归因（实测），
  用户提交凭证，管理员在 /admin/reviews 人工通过后发权益。
- 奖励与旧每日任务一致：vip_days 7；云端按「完成当天 +7 天、不叠加」折算，同日多任务不多得。
- 建活动配方（实证）：ASCII 活动名；账号维度 anchor_id=抖音号 + dependence(AnchorID=2)；
  condition_type：点赞/完播=4（实证 true），评论/转发=1（评论实证 true，=4 时不登记）；
  not_bc_check=true。
"""
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ..database import get_db, new_id

router = APIRouter(prefix="/api/admin", tags=["admin"])

ADMIN_TOKEN = os.environ.get("BENEFIT_ADMIN_TOKEN", "")
DAILY_VIDEOS_FILE = os.environ.get("DAILY_VIDEOS_FILE", "/opt/benefit-auth/daily-videos.json")
LEARNING_APP_NAME = "学习伙伴"
TZ = ZoneInfo("Asia/Shanghai")
DY_BASE = os.environ.get("DOUYIN_API_BASE", "https://open.douyin.com")
PUBLISHER_DY = os.environ.get("CAMPAIGN_PUBLISHER_DY", "1262668803")
PUBLISHER_NAME = "做给孩子看"

# 当日自动活动定义（点赞/完播/评论，账号维度——账号下任意视频均计入）；
# 转发平台会改绑到创建时最新视频（不归因"任意视频"），故走人工审核兜底，不建活动。
# condition_type 实证：点赞/完播=4，评论=1（=4 时不登记）
_DAILY_AUTO = [
    ("like", "点赞", {"short_video_digg_event_info": {"anchor_id": PUBLISHER_DY}}, 4),
    ("finish", "完播", {"short_video_finish_playing_event_info": {"anchor_id": PUBLISHER_DY,
                                                                 "finish_play_video_count": 1}}, 4),
    ("comment", "评论", {"short_video_comment_event_info": {"anchor_id": PUBLISHER_DY}}, 1),
]


def require_admin(x_admin_token: str = Header(default="")) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="服务端未配置 BENEFIT_ADMIN_TOKEN")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid admin token")


async def _learning_app(db) -> dict:
    rows = await db.execute_fetchall("SELECT * FROM apps WHERE name=?", (LEARNING_APP_NAME,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"未找到应用：{LEARNING_APP_NAME}")
    return rows[0]


def _today() -> datetime:
    return datetime.now(TZ)


def _pick_video(now: datetime) -> dict:
    """按天轮换当日视频（运营维护 daily-videos.json；空文件/缺失则用兜底文案）"""
    data = {}
    try:
        data = json.loads(Path(DAILY_VIDEOS_FILE).read_text(encoding="utf-8"))
    except Exception:
        pass
    videos = data.get("videos") or []
    fallback = data.get("fallback_note") or f"打开官方抖音号「{PUBLISHER_NAME}」主页，看最新一条视频"
    if not videos:
        return {"link": "", "note": fallback}
    v = videos[now.timetuple().tm_yday % len(videos)]
    if isinstance(v, dict):
        return {"link": v.get("link", ""), "note": v.get("note", "")}
    return {"link": str(v), "note": ""}


def _client_token() -> str:
    r = httpx.post(DY_BASE + "/oauth/client_token/", json={
        "client_key": os.environ.get("DOUYIN_CLIENT_KEY", ""),
        "client_secret": os.environ.get("DOUYIN_CLIENT_SECRET", ""),
        "grant_type": "client_credential"})
    return r.json()["data"]["access_token"]


def _create_bt_activity_multi(tag: str, defs: list, day_start_ts: int, day_end_ts: int):
    """创建当日活动（一个活动挂多个任务），返回 (activity_id, [(type, task_id)...])。

    单活动多任务 → 完成查询可批量（task_id_list），每用户每轮 1 次请求。
    """
    try:
        tok = _client_token()
        now = int(time.time())
        task_list = []
        for tname, _label, event_obj, cond in defs:
            task_list.append({
                "task_name": f"daily-{tname}", "start_time": now + 60, "end_time": day_end_ts,
                "task_event_info": {
                    "common_event_info": {
                        "task_type_enum": 1,
                        "task_dependence": {"dependence_list": [
                            {"dependence_type_enum": 2, "dependence_value": PUBLISHER_DY}]},
                        "complete_conditions": [
                            {"condition_type": cond, "task_complete_condition_stage": [1]}],
                    },
                    **event_obj}})
        body = {
            "activity_name": f"daily-{tag}-{time.strftime('%m%d')}"[:50],
            "start_time": now + 60, "end_time": day_end_ts,
            "not_bc_check": True,
            "create_business_task_info_list": task_list}
        r = httpx.post(DY_BASE + "/dy_open_api/apps/v3/activity/create/",
                       headers={"access-token": tok, "content-type": "application/json"},
                       json=body)
        d = r.json()
        if str(d.get("err_no")) != "0":
            print("[daily-task] activity create failed:", str(d)[:200], flush=True)
            return None
        aid = int(d["data"]["activity_id"])
        q = httpx.post(DY_BASE + "/dy_open_api/apps/v3/activity/query_info/",
                       headers={"access-token": tok, "content-type": "application/json"},
                       json={"activity_id": aid})
        tl = ((q.json().get("data") or {}).get("business_task_info_list") or [])
        by_name = {t.get("task_name"): int(t.get("task_id") or 0) for t in tl}
        pairs = [(tname, by_name.get(f"daily-{tname}", 0)) for tname, _l, _, _ in defs]
        if any(tid == 0 for _, tid in pairs):
            print("[daily-task] query_info missing task ids:", pairs, flush=True)
            return None
        m = httpx.post(DY_BASE + "/dy_open_api/apps/v3/activity/modify/",
                       headers={"access-token": tok, "content-type": "application/json"},
                       json={"activity_id": aid, "start_time": now - 1, "end_time": day_end_ts})
        print(f"[daily-task] activity {tag}: {aid} tasks={pairs} modify={m.json().get('err_no')}",
              flush=True)
        return aid, pairs
    except Exception as e:  # noqa: BLE001
        print("[daily-task] activity error:", tag, str(e)[:200], flush=True)
        return None


@router.post("/daily-task")
async def create_daily_task(db=Depends(get_db), _: None = Depends(require_admin)):
    """生成当日任务（幂等：同一天重复调用按标题去重，已存在则跳过）。

    **一天一条任务**：用户对官方账号的任意视频完成 完播/点赞/评论/转发 任意一项即算完成。
    - 内部挂 3 个当日自动活动（点赞/完播/评论，账号维度），验证时任一 true 即通过；
    - 转发平台不归因"任意视频"（会改绑单个视频），作为人工审核兜底：验证不过时可提交凭证；
    - 奖励 vip_days 7（云端按完成当天 +7 天、不叠加折算）。
    """
    app = await _learning_app(db)
    now = _today()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1) - timedelta(seconds=1)
    video = _pick_video(now)
    title = f"{now.month}月{now.day}日 · 官方视频互动任务"

    exists = await db.execute_fetchall(
        "SELECT id FROM tasks WHERE app_id=? AND title=? AND status != 'ended'",
        (app["app_id"], title))
    if exists:
        return {"task_id": exists[0]["id"], "title": title, "created": False, "note": "今日任务已存在"}

    # 文案引导用户 4 件事全做（最大化互动）；核验仍是任一项通过即算完成（保证顺利通过）。
    # 描述只保留核心指令——操作入口走卡片上的「去完成」按钮，奖励展示走「🎁」行，不在描述里重复
    description = (
        f"打开抖音，找到官方账号「{PUBLISHER_NAME}」，任选一条视频（不限哪一条，建议看最新一条），"
        f"请把以下 4 件事【全部做完】：\n"
        f"① 完播观看 ② 点赞 ③ 发表评论 ④ 转发"
    )

    task_id = new_id()
    target_config = {
        "target_url": video["link"] or "",
        "target_name": PUBLISHER_NAME,
        # 不设 video_title：点赞/完播/评论核验为账号维度（官方号下任意视频均算），
        # 展示层不得暗示绑定特定视频；target_url 仅作为「去完成」的快捷入口
        "label": "互动任务",
        "manual_fallback": "share",
        "activities": [],
    }
    await db.execute(
        """INSERT INTO tasks (id, app_id, platform, title, description, task_type, target_config,
           reward_config, verify_mode, max_times_per_user, start_at, end_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            task_id, app["app_id"], "douyin", title, description,
            "bt_interact", json.dumps(target_config, ensure_ascii=False),
            json.dumps({"type": "vip_days", "days": 7}, ensure_ascii=False),
            "auto", 1,
            day_start.isoformat(), day_end.isoformat(),
        ),
    )
    # 单活动多任务（点赞/完播/评论）——完成查询批量，每用户每轮 1 次请求
    degraded = []
    wired = _create_bt_activity_multi("interact", _DAILY_AUTO,
                                      int(day_start.timestamp()), int(day_end.timestamp()))
    if wired:
        aid, pairs = wired
        target_config["activities"] = [
            {"type": tname, "activity_id": aid, "business_task_id": btid}
            for tname, btid in pairs]
    else:
        degraded = [tname for tname, _, _ in _DAILY_AUTO]
    await db.execute("UPDATE tasks SET target_config=? WHERE id=?",
                     (json.dumps(target_config, ensure_ascii=False), task_id))
    await db.commit()
    return {"task_id": task_id, "title": title, "created": True,
            "activities": target_config["activities"], "degraded": degraded, "video": video}


@router.get("/pending-reviews")
async def pending_reviews(db=Depends(get_db), _: None = Depends(require_admin)):
    """待审核凭证列表（学习伙伴应用，status=submitted）"""
    app = await _learning_app(db)
    rows = await db.execute_fetchall(
        """SELECT ti.id, ti.user_id, ti.evidence, ti.submitted_at, t.title AS task_title,
                  u.nickname AS user_nickname
           FROM task_instances ti
           JOIN tasks t ON t.id = ti.task_id
           LEFT JOIN users u ON u.id = ti.user_id
           WHERE t.app_id=? AND ti.status='submitted'
           ORDER BY ti.submitted_at DESC""",
        (app["app_id"],),
    )
    return {"pending": [{
        "instance_id": r["id"],
        "task_title": r["task_title"],
        "user_nickname": r["user_nickname"] or "",
        "evidence": json.loads(r["evidence"] or "{}"),
        "submitted_at": r["submitted_at"],
    } for r in rows]}


class ReviewAction(BaseModel):
    instance_id: str
    action: str  # approve / reject
    comment: str = ""


@router.post("/review")
async def review(req: ReviewAction, db=Depends(get_db), _: None = Depends(require_admin)):
    """通过（发放权益）/ 拒绝。逻辑与 /api/app/reviews/{id} 一致，鉴权换管理员 token。"""
    if req.action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve or reject")

    inst_rows = await db.execute_fetchall(
        """SELECT ti.*, t.app_id AS task_app_id, t.id AS tid, t.reward_config
           FROM task_instances ti JOIN tasks t ON t.id = ti.task_id
           WHERE ti.id=?""",
        (req.instance_id,),
    )
    if not inst_rows:
        raise HTTPException(status_code=404, detail="Task instance not found")
    inst = inst_rows[0]
    if inst["status"] != "submitted":
        raise HTTPException(status_code=409, detail=f"Task not awaiting review (status={inst['status']})")

    now = datetime.now(timezone.utc).isoformat()
    if req.action == "approve":
        await db.execute(
            "UPDATE task_instances SET status='granted', granted_at=? WHERE id=?", (now, req.instance_id))
        await db.execute(
            """INSERT INTO entitlements (id, app_id, user_id, task_id, task_instance_id, reward_code, status)
               VALUES (?,?,?,?,?,?, 'active')""",
            (new_id(), inst["task_app_id"], inst["user_id"], inst["tid"], req.instance_id,
             json.dumps(json.loads(inst["reward_config"] or "{}"), ensure_ascii=False)),
        )
    else:
        await db.execute(
            "UPDATE task_instances SET status='rejected', verify_detail=? WHERE id=?",
            (json.dumps({"rejected": True, "comment": req.comment}, ensure_ascii=False), req.instance_id),
        )
    await db.commit()
    return {"instance_id": req.instance_id, "action": req.action, "success": True}


# ==================== 管理审核页（浏览器） ====================
async def admin_page_html_view(token: str = ""):
    """审核页（/admin/reviews?token=<BENEFIT_ADMIN_TOKEN>）；经 nginx rewrite 到此处。"""
    if not ADMIN_TOKEN or token != ADMIN_TOKEN:
        return HTMLResponse("<h3>token 无效</h3><p>请在地址后加 ?token=<BENEFIT_ADMIN_TOKEN></p>", status_code=401)
    return HTMLResponse(_admin_page_html().replace("__TOKEN__", token))


def _admin_page_html() -> str:
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>任务审核 · 权益认证中台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:#f5f6fa;color:#0f172a;padding:28px 20px}
h2{margin-bottom:4px}
.lead{color:#64748b;font-size:13px;margin-bottom:18px}
.item{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:12px;max-width:760px}
.t{font-weight:700;font-size:14px}
.m{color:#64748b;font-size:12.5px;margin:4px 0}
.p{background:#f8fafc;border-radius:10px;padding:10px 12px;font-size:13px;margin:8px 0;white-space:pre-wrap;word-break:break-all}
.btns{display:flex;gap:8px;margin-top:8px}
button{border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer}
.ok{background:#16a34a;color:#fff}.no{background:#e2e8f0;color:#334155}
.done{color:#15803d;font-size:13px;margin-top:6px}
.empty{color:#94a3b8;font-size:14px;padding:24px 0}
</style></head><body>
<h2>📋 每日互动任务审核（转发兜底）</h2>
<p class="lead">点赞/完播/评论由平台自动核查，无需人工；此处仅审核「转发任务」提交的凭证。通过即发放 7 天权益。</p>
<div id="list"><div class="empty">加载中…</div></div>
<script>
const TOKEN = "__TOKEN__";
const H = { "X-Admin-Token": TOKEN, "Content-Type": "application/json" };
async function load() {
  const res = await fetch("/api/admin/pending-reviews", { headers: H });
  const data = await res.json();
  const list = document.getElementById("list");
  if (!data.pending || !data.pending.length) { list.innerHTML = '<div class="empty">✅ 暂无待审核凭证</div>'; return; }
  list.innerHTML = "";
  data.pending.forEach(p => {
    const div = document.createElement("div"); div.className = "item";
    const proof = p.evidence.proof_url || p.evidence.proof_text || "(未填)";
    div.innerHTML = `<div class="t">${p.task_title}</div>
      <div class="m">用户：${p.user_nickname || p.user_id.slice(0,8)} · 提交于 ${p.submitted_at}</div>
      <div class="p"></div>`;
    div.querySelector(".p").textContent = proof;
    const btns = document.createElement("div"); btns.className = "btns";
    const ok = document.createElement("button"); ok.className = "ok"; ok.textContent = "通过（发 7 天权益）";
    const no = document.createElement("button"); no.className = "no"; no.textContent = "拒绝";
    ok.onclick = () => review(p.instance_id, "approve", div);
    no.onclick = () => review(p.instance_id, "reject", div);
    btns.appendChild(ok); btns.appendChild(no); div.appendChild(btns);
    list.appendChild(div);
  });
}
async function review(id, action, div) {
  const res = await fetch("/api/admin/review", { method: "POST", headers: H,
    body: JSON.stringify({ instance_id: id, action }) });
  const tip = document.createElement("div"); tip.className = "done";
  tip.textContent = res.ok ? (action === "approve" ? "✅ 已通过，权益已发放" : "已拒绝") : "操作失败";
  div.querySelector(".btns").replaceWith(tip);
}
load();
</script></body></html>"""
