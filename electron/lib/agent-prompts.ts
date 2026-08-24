/**
 * AGENTS / 系统提示词「用户可编辑版本」存储（ISSUE-033）。
 *
 * 设计：代码默认提示词（buildAgentsMd / buildParentPrompt / buildParentContentPrompt）与
 * 用户版本**完全解耦**——用户一旦保存自己的版本，即以「整体替换」方式成为该 scope/ref 的
 * 唯一权威，开会话时直接写入用户版本，不再被源码默认覆盖。编辑坏了可「恢复默认」（删除用户版本），
 * 且每次保存都会沉淀历史版本，可随时回退。
 *
 * 存储：data/agents.sqlite
 *   - prompts(scope, ref, content, updated)：当前用户版本（无行 = 用代码默认）
 *   - prompt_history(id, scope, ref, content, updated)：每次保存的歷史快照
 *
 * scope/ref：
 *   - 孩子：scope="child",  ref=<childId>   （对应 AGENTS.md）
 *   - 家长：scope="parent", ref="main"      （通用家长工作台助手提示词）
 *   - 家长：scope="parent", ref="content"   （教学内容生成专用提示词）
 */
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { getDataDir } from "./config";

function dbPath(): string {
  return path.join(getDataDir(), "agents.sqlite");
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      scope TEXT NOT NULL,
      ref TEXT NOT NULL,
      content TEXT NOT NULL,
      updated TEXT NOT NULL,
      PRIMARY KEY (scope, ref)
    );
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      ref TEXT NOT NULL,
      content TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_history ON prompt_history(scope, ref, id);
  `);
  return db;
}

export interface PromptVersion {
  content: string;
  updated: string;
}

/** 读取当前用户版本；无用户版本返回 null（调用方应回退到代码默认）。 */
export function getAgentPrompt(scope: string, ref: string): string | null {
  const db = openDb();
  try {
    const row = db
      .prepare("SELECT content FROM prompts WHERE scope = ? AND ref = ?")
      .get(scope, ref) as { content: string } | undefined;
    return row ? row.content : null;
  } finally {
    db.close();
  }
}

/**
 * 保存用户版本（整体替换）。先把旧版本推入历史，再覆盖当前。
 * content 为空/纯空白视为「恢复默认」——删除当前用户版本（但不删历史）。
 */
export function saveAgentPrompt(scope: string, ref: string, content: string): void {
  const db = openDb();
  try {
    const now = new Date().toISOString();
    const trimmed = content.trim();
    db.exec("BEGIN");
    try {
      const existing = db
        .prepare("SELECT content, updated FROM prompts WHERE scope = ? AND ref = ?")
        .get(scope, ref) as { content: string; updated: string } | undefined;
      if (existing && existing.content.trim()) {
        db.prepare(
          "INSERT INTO prompt_history (scope, ref, content, updated) VALUES (?, ?, ?, ?)"
        ).run(scope, ref, existing.content, existing.updated);
      }
      if (!trimmed) {
        db.prepare("DELETE FROM prompts WHERE scope = ? AND ref = ?").run(scope, ref);
      } else {
        db.prepare(
          "INSERT INTO prompts (scope, ref, content, updated) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(scope, ref) DO UPDATE SET content = excluded.content, updated = excluded.updated"
        ).run(scope, ref, content, now);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

/** 恢复默认：删除当前用户版本（历史保留，可回退）。 */
export function resetAgentPrompt(scope: string, ref: string): void {
  saveAgentPrompt(scope, ref, "");
}

/** 历史版本（按时间倒序，最新在前）。 */
export function listAgentPromptHistory(scope: string, ref: string): PromptVersion[] {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        "SELECT content, updated FROM prompt_history WHERE scope = ? AND ref = ? ORDER BY id DESC LIMIT 50"
      )
      .all(scope, ref) as Array<{ content: string; updated: string }>;
    return rows;
  } finally {
    db.close();
  }
}

/** 回退到指定历史版本（按 updated 时间戳定位）；成功后该版本成为当前用户版本。 */
export function restoreAgentPromptVersion(scope: string, ref: string, updated: string): boolean {
  const db = openDb();
  try {
    const row = db
      .prepare("SELECT content FROM prompt_history WHERE scope = ? AND ref = ? AND updated = ?")
      .get(scope, ref, updated) as { content: string } | undefined;
    if (!row) return false;
    saveAgentPrompt(scope, ref, row.content);
    return true;
  } finally {
    db.close();
  }
}
