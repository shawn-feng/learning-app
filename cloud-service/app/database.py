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

            CREATE TABLE IF NOT EXISTS sync_files_meta (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL REFERENCES parents(id),
                child_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                content_hash TEXT,
                size INTEGER,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(parent_id, child_id, file_path)
            );
            """
        )
        await db.commit()
