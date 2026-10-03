"""演示任务种子脚本 → 已升级为「正式运营配置」种子（幂等，可重复执行）。

当前灌入的是已接通抖音经营任务的 5 条真实任务（2026-09-29 配置）：
- 每条任务带 activity_id / business_task_id（平台侧真活动），重复执行只更新文案/链接，不会冲掉平台 id
- target_name / video_title 用于任务墙展示（用户需要知道给谁点赞、关注谁）

用法：/opt/benefit-auth/venv/bin/python seed_demo_tasks.py
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:
    import aiosqlite
except ImportError:
    sys.path.insert(0, str(Path(__file__).parent / ".deps"))
    import aiosqlite

from app.database import DB_PATH, SCHEMA

DEMO_APP_ID = "app_demo_builtin"

# 目标视频/账号（林语堂英语学习方法推广视频，发布者=做给孩子看，抖音号 1262668803）
PROD_TARGET = {
    "target_url": "https://www.douyin.com/video/7653986142022290726",
    "target_name": "做给孩子看",
    "video_title": "林语堂英语学习方法",
}

# 中台任务 → 平台活动映射（2026-09-29 控制台实建 + not_bc_check=true）
PROD_WIRING = {
    "demo-bt-like": {"activity_id": 436510947842, "business_task_id": 1260987846596009788},
    "demo-bt-follow": {"activity_id": 323645137154, "business_task_id": 1260987846595983899},
    "demo-bt-finish": {"activity_id": 263940867074, "business_task_id": 1260987846596010274},
    "demo-bt-share": {"activity_id": 263911051522, "business_task_id": 1260987846596011210},
    "demo-bt-comment": {"activity_id": 263940928770, "business_task_id": 1260987846596011211},
}


def task_rows() -> list[dict]:
    reward = {"type": "points", "points": 10, "note": "任务奖励"}
    common = {
        "app_id": DEMO_APP_ID,
        "platform": "douyin",
        "verify_mode": "auto",
        "max_times_per_user": 1,
        "start_at": None,
        "end_at": None,
        "status": "active",
    }
    t = [
        ("demo-bt-like", "给账号视频点赞",
         "跳转抖音给「做给孩子看」的视频点赞，回来点「我完成了」验证", "bt_like"),
        ("demo-bt-follow", "关注官方账号",
         "跳转抖音关注「做给孩子看」，回来点「我完成了」验证", "bt_follow"),
        ("demo-bt-finish", "看完推广视频",
         "跳转抖音完整观看视频，回来点「我完成了」验证", "bt_finish"),
        ("demo-bt-share", "转发推广视频",
         "跳转抖音把视频转发/分享出去，回来点「我完成了」验证", "bt_share"),
        ("demo-bt-comment", "去视频说句话",
         "跳转抖音在视频下发表评论，回来点「我完成了」验证", "bt_comment"),
    ]
    rows = []
    for tid, title, desc, ttype in t:
        rows.append({
            **common,
            "id": tid,
            "title": title,
            "description": desc,
            "task_type": ttype,
            "target_config": {
                **PROD_TARGET,
                "label": {"bt_like": "点赞视频", "bt_follow": "关注账号", "bt_finish": "完播视频",
                          "bt_share": "转发视频", "bt_comment": "评论视频"}[ttype],
                **PROD_WIRING[tid],
            },
            "reward_config": reward,
        })
    return rows


async def main():
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    await db.executescript(SCHEMA)

    existing = await db.execute_fetchall("SELECT id FROM apps WHERE app_id=?", (DEMO_APP_ID,))
    if not existing:
        await db.execute(
            "INSERT INTO apps (id, app_id, app_secret_hash, name, icon_url, status) VALUES (?,?,?,?,?, 'active')",
            ("demo-app-internal", DEMO_APP_ID, "not-for-api$0", "平台演示任务", ""))
        print(f"+ 内置演示 App：{DEMO_APP_ID}")

    for r in task_rows():
        dup = await db.execute_fetchall("SELECT id FROM tasks WHERE id=?", (r["id"],))
        if dup:
            await db.execute(
                "UPDATE tasks SET title=?, description=?, target_config=?, reward_config=?, status='active' WHERE id=?",
                (r["title"], r["description"], json.dumps(r["target_config"], ensure_ascii=False),
                 json.dumps(r["reward_config"], ensure_ascii=False), r["id"]))
            print(f"= 更新任务 {r['id']}（{r['title']}）")
        else:
            await db.execute(
                """INSERT INTO tasks (id, app_id, platform, title, description, task_type, target_config,
                                      reward_config, verify_mode, max_times_per_user, start_at, end_at, status)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (r["id"], r["app_id"], r["platform"], r["title"], r["description"], r["task_type"],
                 json.dumps(r["target_config"], ensure_ascii=False),
                 json.dumps(r["reward_config"], ensure_ascii=False),
                 r["verify_mode"], r["max_times_per_user"], r["start_at"], r["end_at"], r["status"]))
            print(f"+ 新建任务 {r['id']}（{r['title']}）")

    await db.commit()
    await db.close()
    print(f"\n完成。DB={DB_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
