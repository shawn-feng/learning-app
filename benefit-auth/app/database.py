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
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 应用创建的营销任务
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
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
"""


async def get_db():
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    yield db
    await db.close()


async def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.executescript(SCHEMA)
        await db.commit()


def now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())
