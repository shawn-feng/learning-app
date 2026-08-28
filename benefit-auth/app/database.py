"""权益认证中台 - 数据库模型与初始化"""
import json
import os
import uuid
from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent.parent / "benefit.db"

SCHEMA = """
-- 第三方应用
CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    app_id TEXT UNIQUE NOT NULL,
    app_secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    icon_url TEXT DEFAULT '',
    redirect_uris TEXT DEFAULT '',          -- IdP 授权码流程允许的回调地址（逗号分隔）
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 应用创建的营销任务
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    platform TEXT NOT NULL DEFAULT 'douyin',   -- 任务归属平台（douyin/wechat/xhs...）
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    task_type TEXT NOT NULL,              -- follow_account / publish_video / bind_account / fans_reach / like_comment
    target_config TEXT NOT NULL DEFAULT '{}',   -- JSON: 目标配置（如 target_open_id、话题、粉丝阈值）
    reward_config TEXT NOT NULL DEFAULT '{}',   -- JSON: 权益定义（如 {"type":"vip_days","days":7}）
    verify_mode TEXT NOT NULL DEFAULT 'auto',   -- auto=开放平台自动验证 / manual=人工审核
    max_times_per_user INTEGER NOT NULL DEFAULT 1,
    start_at DATETIME,
    end_at DATETIME,
    status TEXT NOT NULL DEFAULT 'active',       -- active / paused / ended
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 中台用户
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户绑定的平台账号（抖音等）
CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    platform TEXT NOT NULL,               -- douyin
    platform_user_id TEXT NOT NULL,       -- open_id
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    access_token TEXT NOT NULL,
    refresh_token TEXT DEFAULT '',
    token_expires_at DATETIME,
    scopes TEXT NOT NULL DEFAULT '',        -- 已授权 scope（逗号分隔），如 user_info,video.list
    bind_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_user_id)
);

-- 用户领取的任务实例
CREATE TABLE IF NOT EXISTS task_instances (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'claimed',  -- claimed / submitted / granted / rejected / expired
    evidence TEXT DEFAULT '{}',              -- JSON: 用户提交凭证（链接/截图）
    verify_detail TEXT DEFAULT '{}',         -- JSON: 验证器结果
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
    reward_code TEXT NOT NULL DEFAULT '{}',   -- JSON: 权益内容
    status TEXT NOT NULL DEFAULT 'active',    -- active / used / revoked
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME
);

-- 人工审核记录
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_instance_id TEXT NOT NULL REFERENCES task_instances(id),
    reviewer TEXT DEFAULT '',
    action TEXT NOT NULL,               -- approve / reject
    comment TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 抖音测试白名单（用户授权 trial.whitelist 后登记，便于在应用上线前指定可体验账号）
CREATE TABLE IF NOT EXISTS whitelist (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,             -- douyin
    platform_user_id TEXT NOT NULL,     -- open_id
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_user_id)
);
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
    """兼容已存在的旧库：补齐本次新增的字段（不破坏已有数据）"""
    cols = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(tasks)"))}
    if "platform" not in cols:
        await db.execute("ALTER TABLE tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'douyin'")

    cols2 = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(platform_accounts)"))}
    if "scopes" not in cols2:
        await db.execute("ALTER TABLE platform_accounts ADD COLUMN scopes TEXT NOT NULL DEFAULT ''")

    cols3 = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(apps)"))}
    if "redirect_uris" not in cols3:
        await db.execute("ALTER TABLE apps ADD COLUMN redirect_uris TEXT DEFAULT ''")


def now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


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
