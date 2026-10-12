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
    password_hash TEXT,                     -- 账号密码登录（平台扫码用户为空）
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

-- 运行设置（campaign 每日推广视频等键值配置）
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- 旧 cloud parent_id 身份映射（认证切换：email/benefit_user_id → 201 数据空间的 parent_id）
CREATE TABLE IF NOT EXISTS legacy_parents (
    email TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    benefit_user_id TEXT DEFAULT ''
);

-- 视频互动记录（授权用户视频下的评论者，用于互动数据分析与用户定位）
CREATE TABLE IF NOT EXISTS video_interactions (
    id TEXT PRIMARY KEY,                -- 平台评论 id（前缀平台名保证全局唯一，如 douyin:<cid>）
    owner_user_id TEXT NOT NULL,        -- 视频作者 = 本中台授权用户
    platform TEXT NOT NULL DEFAULT 'douyin',
    item_id TEXT NOT NULL,              -- 视频 item_id
    interaction_type TEXT NOT NULL DEFAULT 'comment',
    interactor_open_id TEXT DEFAULT '', -- 互动用户在该应用下的 open_id（本应用内稳定唯一）
    douyin_no TEXT DEFAULT '',          -- 抖音号（平台若返回则记录）
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    content TEXT DEFAULT '',            -- 评论内容
    digg_count INTEGER DEFAULT 0,       -- 该评论获赞数
    reply_count INTEGER DEFAULT 0,      -- 该评论回复数
    interacted_at DATETIME,             -- 评论时间（平台秒级时间戳转 ISO）
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    raw TEXT DEFAULT ''                 -- 平台原始 JSON（字段名以实际返回为准，全量留存便于分析）
);
CREATE INDEX IF NOT EXISTS idx_video_interactions_item ON video_interactions(platform, item_id);
CREATE INDEX IF NOT EXISTS idx_video_interactions_interactor ON video_interactions(interactor_open_id);

-- ============ 旧 cloud-service 兼容域（2026-09-21 方案A' 合并） ============
-- 旧版 LAN server（≤0.5.20）仍调 /api/auth/* + /api/license（cloud JWT + bcrypt 凭证 +
-- subscriptions 有效期）；新协议见 legacy.py /api/account/*。
-- 注意：legacy_parents 是并行「认证切换」的身份映射表，兼容域表用 compat_ 前缀。
CREATE TABLE IF NOT EXISTS compat_parents (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    benefit_user_id TEXT,
    password_set INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compat_subscriptions (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES compat_parents(id),
    plan TEXT NOT NULL DEFAULT 'basic',
    max_children INTEGER NOT NULL DEFAULT 4,
    features TEXT,
    starts_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS app_versions (
    version TEXT PRIMARY KEY,
    release_date TEXT NOT NULL,
    release_notes TEXT,
    download_url TEXT,
    min_version TEXT NOT NULL DEFAULT '0.0.0',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 消息交换（ISSUE-041）：家长→孩子数据包暂存 + 孩子→家长进度摘要
CREATE TABLE IF NOT EXISTS sync_deliveries (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sync_deliveries_pending
    ON sync_deliveries(parent_id, child_id, status);

CREATE TABLE IF NOT EXISTS sync_progress (
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    summary TEXT,
    updated_at DATETIME,
    requested_at DATETIME,
    PRIMARY KEY (parent_id, child_id)
);

-- ============ TokenHub 统一模型接入（ISSUE-174，2026-10-09） ============
-- 每个中台用户（家长）一把腾讯云 TokenHub 普通密钥；LAN server 凭用户 JWT 换取。
CREATE TABLE IF NOT EXISTS tokenhub_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,                  -- 中台用户 users.id（家长身份唯一锚点）
    api_key_id TEXT NOT NULL,               -- TokenHub ApiKeyId（ak-…）
    api_key TEXT NOT NULL DEFAULT '',       -- 明文 sk-…（DescribeApiKey 可随时取回）
    status TEXT NOT NULL DEFAULT 'active',  -- active / disabled / deleted
    quota_cycle_unit TEXT NOT NULL DEFAULT 'd',
    quota_cycle_credits INTEGER NOT NULL DEFAULT 5000000,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 模型轮换（2026-10-10）：双 Key 平滑换绑 + 次日恢复档位
    pending_restore_credits INTEGER NOT NULL DEFAULT 0,  -- >0 = 待恢复的原档位（新 Key 当期先用"继承的剩余量"）
    restore_after_date TEXT NOT NULL DEFAULT '',          -- 恢复档位最早日期（轮换次日）
    pending_delete_key_id TEXT NOT NULL DEFAULT '',       -- 待删除的旧 Key（30 分钟平滑窗口后回收）
    rotated_at TEXT NOT NULL DEFAULT '',                  -- 最近一次轮换时间（UTC）
    expires_at TEXT NOT NULL DEFAULT ''                   -- Key 有效期截止日（YYYY-MM-DD，空=不过期；到期后台自动禁用）
);
CREATE INDEX IF NOT EXISTS idx_tokenhub_keys_user ON tokenhub_keys(user_id);

-- 管理员登录挑战（账密通过后发邮件二维码确认；id 留在登录浏览器，token 走邮件，二者分离）
CREATE TABLE IF NOT EXISTS admin_login_challenges (
    id TEXT PRIMARY KEY,                    -- 登录页轮询用（不出现在邮件里）
    approve_token TEXT NOT NULL UNIQUE,     -- 邮件确认链接用（不回传登录页）
    approved INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);

-- 登录防撞库：账号/app_id 失败计数与锁定（重启不掉锁； ratelimit.acct_* 读写）
CREATE TABLE IF NOT EXISTS login_lockouts (
    subject TEXT PRIMARY KEY,               -- 如 admin:<username> / app:<app_id>
    fails INTEGER NOT NULL DEFAULT 0,
    locked_until REAL NOT NULL DEFAULT 0,   -- epoch 秒（重启后仍有效）
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        await _seed_admin(db)
        await db.commit()


async def _seed_admin(db):
    """管理员凭证种子（ISSUE-174）：首次启动写入默认账密，之后一律以 DB 为准（管理页可改密）。"""
    from .security import hash_password

    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('admin_username', ?) "
        "ON CONFLICT(key) DO NOTHING",
        (os.environ.get("ADMIN_USERNAME", "79734745@qq.com"),),
    )
    # 默认密码 123456（用户登录后在管理页自行修改）；env ADMIN_PASSWORD 仅在 DB 为空时作为种子
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?) "
        "ON CONFLICT(key) DO NOTHING",
        (hash_password(os.environ.get("ADMIN_PASSWORD", "123456")),),
    )
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('admin_email', ?) "
        "ON CONFLICT(key) DO NOTHING",
        (os.environ.get("ADMIN_EMAIL", "79734745@qq.com"),),
    )


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

    cols4 = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(users)"))}
    if "password_hash" not in cols4:
        await db.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")

    cols5 = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(video_interactions)"))}
    if "raw" not in cols5:
        await db.execute("ALTER TABLE video_interactions ADD COLUMN raw TEXT DEFAULT ''")

    # TokenHub 模型轮换列（ISSUE-174 第五轮，2026-10-10）
    cols6 = {r["name"] for r in (await db.execute_fetchall("PRAGMA table_info(tokenhub_keys)"))}
    for col, ddl in (
        ("pending_restore_credits", "ALTER TABLE tokenhub_keys ADD COLUMN pending_restore_credits INTEGER NOT NULL DEFAULT 0"),
        ("restore_after_date", "ALTER TABLE tokenhub_keys ADD COLUMN restore_after_date TEXT NOT NULL DEFAULT ''"),
        ("pending_delete_key_id", "ALTER TABLE tokenhub_keys ADD COLUMN pending_delete_key_id TEXT NOT NULL DEFAULT ''"),
        ("rotated_at", "ALTER TABLE tokenhub_keys ADD COLUMN rotated_at TEXT NOT NULL DEFAULT ''"),
        ("expires_at", "ALTER TABLE tokenhub_keys ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in cols6:
            await db.execute(ddl)


async def get_setting(db, key: str, default: str = "") -> str:
    """settings 键值读取（管理页配置的凭证/开关等；值均为字符串）"""
    rows = await db.execute_fetchall("SELECT value FROM settings WHERE key=?", (key,))
    return rows[0]["value"] if rows else default


async def set_setting(db, key: str, value: str) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


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


# ---------------- 视频互动记录 ----------------
async def upsert_video_interactions(db, owner_user_id: str, platform: str, item_id: str,
                                    comments: list[dict]):
    """把评论列表写入/更新到 video_interactions（按平台评论 id 幂等）。

    每条 comment 规范化后含：comment_id / interactor_open_id / douyin_no / nickname /
    avatar_url / content / digg_count / reply_count / create_time(秒级时间戳)。
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
