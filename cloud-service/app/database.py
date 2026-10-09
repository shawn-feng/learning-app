"""学习伙伴云服务（合并版）- 数据库

2026-09-21 方案A：learning-cloud 与 benefit-auth 合并为单服务单库。
- 家长/订阅/版本/消息交换（原 learning-cloud）
- 中台用户/平台绑定/任务/权益/白名单（原 benefit-auth）
两张身份域互相关联：parents.benefit_user_id ↔ users.id（抖音扫码登录建号后绑定）。
"""
import json
import os
import uuid
from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent.parent / "database" / "app.db"

SCHEMA = """
-- ============ 家长业务域（原 learning-cloud） ============
CREATE TABLE IF NOT EXISTS parents (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    benefit_user_id TEXT,
    password_set INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES parents(id),
    plan TEXT NOT NULL DEFAULT 'basic',
    max_children INTEGER NOT NULL DEFAULT 4,
    features TEXT,
    starts_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES parents(id),
    device_name TEXT,
    last_active DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ISSUE-040: App 版本发布记录（Electron 客户端 /api/version 查询，POST /api/version 登记）
CREATE TABLE IF NOT EXISTS app_versions (
    version TEXT PRIMARY KEY,
    release_date TEXT NOT NULL,
    release_notes TEXT,
    download_url TEXT,
    min_version TEXT NOT NULL DEFAULT '0.0.0',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ISSUE-041：云端只做「消息交换」：家长→孩子数据包暂存
CREATE TABLE IF NOT EXISTS sync_deliveries (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES parents(id),
    child_id TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sync_deliveries_pending
    ON sync_deliveries(parent_id, child_id, status);

-- 孩子→家长的「进度摘要」，每个孩子只保留最新一份
CREATE TABLE IF NOT EXISTS sync_progress (
    parent_id TEXT NOT NULL REFERENCES parents(id),
    child_id TEXT NOT NULL,
    summary TEXT,
    updated_at DATETIME,
    requested_at DATETIME,
    PRIMARY KEY (parent_id, child_id)
);

-- benefit-auth 权益接入：已落账的抖音任务权益（幂等延长订阅用）
CREATE TABLE IF NOT EXISTS applied_entitlements (
    entitlement_id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    days INTEGER NOT NULL DEFAULT 0,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ 中台身份/任务/权益域（原 benefit-auth） ============
-- 第三方应用
CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    app_id TEXT UNIQUE NOT NULL,
    app_secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    icon_url TEXT DEFAULT '',
    redirect_uris TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 应用创建的营销任务
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    platform TEXT NOT NULL DEFAULT 'douyin',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    task_type TEXT NOT NULL,
    target_config TEXT NOT NULL DEFAULT '{}',
    reward_config TEXT NOT NULL DEFAULT '{}',
    verify_mode TEXT NOT NULL DEFAULT 'manual',
    max_times_per_user INTEGER NOT NULL DEFAULT 1,
    start_at DATETIME,
    end_at DATETIME,
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 中台用户（抖音扫码/账号密码登录产生；家长通过 benefit_user_id 关联）
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户绑定的平台账号（抖音等）
CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    access_token TEXT NOT NULL,
    refresh_token TEXT DEFAULT '',
    token_expires_at DATETIME,
    scopes TEXT NOT NULL DEFAULT '',
    bind_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_user_id)
);

-- 用户领取的任务实例
CREATE TABLE IF NOT EXISTS task_instances (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'claimed',
    evidence TEXT DEFAULT '{}',
    verify_detail TEXT DEFAULT '{}',
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME,
    granted_at DATETIME
);

-- 发放的权益
CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    task_instance_id TEXT REFERENCES task_instances(id),
    reward_code TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME
);

-- 人工审核记录
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_instance_id TEXT NOT NULL REFERENCES task_instances(id),
    reviewer TEXT DEFAULT '',
    action TEXT NOT NULL,
    comment TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 抖音测试白名单
CREATE TABLE IF NOT EXISTS whitelist (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_user_id)
);

-- 视频互动记录（授权用户视频下的评论者，用于互动数据分析与用户定位）
CREATE TABLE IF NOT EXISTS video_interactions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'douyin',
    item_id TEXT NOT NULL,
    interaction_type TEXT NOT NULL DEFAULT 'comment',
    interactor_open_id TEXT DEFAULT '',
    douyin_no TEXT DEFAULT '',
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    content TEXT DEFAULT '',
    digg_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    interacted_at DATETIME,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    raw TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_video_interactions_item ON video_interactions(platform, item_id);
CREATE INDEX IF NOT EXISTS idx_video_interactions_interactor ON video_interactions(interactor_open_id);
"""


async def get_db():
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    yield db
    await db.close()


async def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)
        await db.commit()
        await _migrate(db)
        await db.commit()


async def _migrate(db):
    """兼容已存在的旧库：补齐新增字段（不破坏已有数据）。合并双方（learning-cloud + benefit-auth）的迁移。"""
    # ---- 原 learning-cloud ----
    cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(parents)"))}
    if "benefit_user_id" not in cols:
        await db.execute("ALTER TABLE parents ADD COLUMN benefit_user_id TEXT")
    if "password_set" not in cols:
        await db.execute("ALTER TABLE parents ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1")
    await db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_benefit_user_id ON parents(benefit_user_id)"
    )

    # ---- 原 benefit-auth ----
    task_cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(tasks)"))}
    if "platform" not in task_cols:
        await db.execute("ALTER TABLE tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'douyin'")

    pa_cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(platform_accounts)"))}
    if "scopes" not in pa_cols:
        await db.execute("ALTER TABLE platform_accounts ADD COLUMN scopes TEXT NOT NULL DEFAULT ''")

    app_cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(apps)"))}
    if "redirect_uris" not in app_cols:
        await db.execute("ALTER TABLE apps ADD COLUMN redirect_uris TEXT DEFAULT ''")

    user_cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(users)"))}
    if "password_hash" not in user_cols:
        await db.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")

    vi_cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(video_interactions)"))}
    if vi_cols and "raw" not in vi_cols:
        await db.execute("ALTER TABLE video_interactions ADD COLUMN raw TEXT DEFAULT ''")


def now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


# ---------------- 家长域辅助 ----------------
# （家长登录/订阅相关辅助在 routers/auth.py、routers/license.py 内实现）


# ---------------- 中台域辅助（原 benefit-auth database.py） ----------------
async def find_user_by_platform(db, platform: str, platform_user_id: str) -> str | None:
    """按平台 open_id 查找已关联的中台用户 UUID；未绑定返回 None"""
    rows = await db.execute_fetchall(
        "SELECT user_id FROM platform_accounts WHERE platform=? AND platform_user_id=?",
        (platform, platform_user_id),
    )
    return rows[0]["user_id"] if rows else None


async def upsert_platform_account(
    db,
    *,
    user_id: str,
    platform: str,
    platform_user_id: str,
    nickname: str = "",
    avatar_url: str = "",
    access_token: str,
    refresh_token: str = "",
    token_expires_at=None,
    scopes: str = "",
):
    """已存在则更新 token/scope，否则新建平台账号绑定到 user_id"""
    existing = await db.execute_fetchall(
        "SELECT id FROM platform_accounts WHERE platform=? AND platform_user_id=?",
        (platform, platform_user_id),
    )
    if existing:
        await db.execute(
            """UPDATE platform_accounts SET access_token=?, refresh_token=?, token_expires_at=?,
               nickname=?, avatar_url=?, scopes=?, bind_at=CURRENT_TIMESTAMP WHERE id=?""",
            (access_token, refresh_token, token_expires_at, nickname, avatar_url, scopes, existing[0]["id"]),
        )
    else:
        await db.execute(
            """INSERT INTO platform_accounts
               (id, user_id, platform, platform_user_id, nickname, avatar_url, access_token, refresh_token, token_expires_at, scopes)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (new_id(), user_id, platform, platform_user_id, nickname, avatar_url,
             access_token, refresh_token, token_expires_at, scopes),
        )


async def get_platform_account(db, user_id: str, platform: str) -> dict | None:
    rows = await db.execute_fetchall(
        "SELECT * FROM platform_accounts WHERE user_id=? AND platform=?",
        (user_id, platform),
    )
    return dict(rows[0]) if rows else None


# ---------------- 测试白名单 ----------------
async def add_whitelist(db, platform: str, platform_user_id: str, nickname: str = "", avatar_url: str = ""):
    """将指定平台账号加入测试白名单（已存在则更新昵称/时间）"""
    existing = await db.execute_fetchall(
        "SELECT id FROM whitelist WHERE platform=? AND platform_user_id=?",
        (platform, platform_user_id),
    )
    if existing:
        await db.execute(
            "UPDATE whitelist SET nickname=?, avatar_url=?, granted_at=CURRENT_TIMESTAMP WHERE id=?",
            (nickname, avatar_url, existing[0]["id"]),
        )
    else:
        await db.execute(
            "INSERT INTO whitelist (id, platform, platform_user_id, nickname, avatar_url, granted_at) "
            "VALUES (?,?,?,?,?,?)",
            (new_id(), platform, platform_user_id, nickname, avatar_url, now_iso()),
        )


async def list_whitelist(db) -> list[dict]:
    rows = await db.execute_fetchall(
        "SELECT platform, platform_user_id, nickname, avatar_url, granted_at "
        "FROM whitelist ORDER BY granted_at DESC"
    )
    return [dict(r) for r in rows]


async def is_whitelisted(db, platform: str, platform_user_id: str) -> bool:
    rows = await db.execute_fetchall(
        "SELECT 1 FROM whitelist WHERE platform=? AND platform_user_id=?",
        (platform, platform_user_id),
    )
    return bool(rows)


# ---------------- 视频互动记录 ----------------
async def upsert_video_interactions(db, owner_user_id: str, platform: str, item_id: str,
                                    comments: list[dict]):
    """把评论列表写入/更新到 video_interactions（按平台评论 id 幂等）。

    每条 comment 规范化后含：comment_id / interactor_open_id / douyin_no / nickname /
    avatar_url / content / digg_count / reply_count / create_time(秒级时间戳) / _raw。
    """
    from datetime import datetime, timezone
    for c in comments or []:
        cid = f"{platform}:{c.get('comment_id') or ''}"
        if not c.get("comment_id"):
            continue
        ts = c.get("create_time")
        interacted_at = (
            datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
            if ts else None
        )
        await db.execute(
            """INSERT INTO video_interactions
               (id, owner_user_id, platform, item_id, interaction_type, interactor_open_id,
                douyin_no, nickname, avatar_url, content, digg_count, reply_count, interacted_at, fetched_at, raw)
               VALUES (?,?,?,?,'comment',?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)
               ON CONFLICT(id) DO UPDATE SET
                 content=excluded.content, digg_count=excluded.digg_count,
                 reply_count=excluded.reply_count, nickname=excluded.nickname,
                 avatar_url=excluded.avatar_url, douyin_no=excluded.douyin_no,
                 fetched_at=CURRENT_TIMESTAMP, raw=excluded.raw""",
            (
                cid, owner_user_id, platform, item_id,
                c.get("interactor_open_id") or "", c.get("douyin_no") or "",
                c.get("nickname") or "", c.get("avatar_url") or "",
                c.get("content") or "", int(c.get("digg_count") or 0),
                int(c.get("reply_count") or 0), interacted_at,
                c.get("_raw") or "",
            ),
        )
