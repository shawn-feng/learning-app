/**
 * AGENTS 用户版本库（schema 平移自 electron/lib/agent-prompts.ts）。
 * 路径：<dataDir>/agents.sqlite（全局；scope/ref 区分孩子/家长）
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const AGENTS_SCHEMA = `
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
`;

export function openAgents(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDir, "agents.sqlite"));
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(AGENTS_SCHEMA);
  return db;
}

export interface PromptVersion {
  content: string;
  updated: string;
}

/** 读取当前用户版本；无用户版本返回 null（调用方回退代码默认）。 */
export function getAgentPrompt(dataDir: string, scope: string, ref: string): string | null {
  const db = openAgents(dataDir);
  try {
    const row = db
      .prepare("SELECT content FROM prompts WHERE scope = ? AND ref = ?")
      .get(scope, ref) as { content: string } | undefined;
    return row ? row.content : null;
  } finally {
    db.close();
  }
}

/** 保存用户版本（整体替换）：旧版本先入历史；空内容 = 恢复默认（删除当前行，保留历史）。 */
export function saveAgentPrompt(
  dataDir: string,
  scope: string,
  ref: string,
  content: string
): void {
  const db = openAgents(dataDir);
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

/** 历史版本（时间倒序，最新在前，最多 50 条）。 */
export function listAgentPromptHistory(
  dataDir: string,
  scope: string,
  ref: string
): PromptVersion[] {
  const db = openAgents(dataDir);
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

/** 回退到指定历史版本（按 updated 定位）；成功则其成为当前用户版本。 */
export function restoreAgentPromptVersion(
  dataDir: string,
  scope: string,
  ref: string,
  updated: string
): boolean {
  const db = openAgents(dataDir);
  try {
    const row = db
      .prepare("SELECT content FROM prompt_history WHERE scope = ? AND ref = ? AND updated = ?")
      .get(scope, ref, updated) as { content: string } | undefined;
    if (!row) return false;
    saveAgentPrompt(dataDir, scope, ref, row.content);
    return true;
  } finally {
    db.close();
  }
}
