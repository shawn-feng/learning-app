import aiosqlite
import os
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "database" / "app.db"


async def get_db():
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    yield db
    await db.close()


async def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS parents (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS subscriptions (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL REFERENCES parents(id),
                plan TEXT NOT NULL DEFAULT 'basic',
                max_children INTEGER NOT NULL DEFAULT 2,
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

            -- ISSUE-041 架构转向（2026-08-25）：云端只做「消息交换」，不做数据存储/备份。
            -- sync_deliveries：家长→孩子的「分配数据包」暂存（孩子端拉到、本地落库后 ack 即删）
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

            -- sync_progress：孩子→家长的「进度摘要」，每个孩子只保留最新一份；
            -- requested_at 为家长打上的「请求刷新」标记（孩子端轮询后生成新摘要覆盖）。
            CREATE TABLE IF NOT EXISTS sync_progress (
                parent_id TEXT NOT NULL REFERENCES parents(id),
                child_id TEXT NOT NULL,
                summary TEXT,
                updated_at DATETIME,
                requested_at DATETIME,
                PRIMARY KEY (parent_id, child_id)
            );
            """
        )
        await db.commit()
