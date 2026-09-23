/**
 * ISSUE-129 token 用量统计（服务端唯一真源）。
 *
 * 口径（用户 2026-09-21 拍板）：**按模型返回字段原样直传**（input / cacheRead / cacheWrite /
 * output / reasoning / totalTokens / cost），每行带模型名；不做本地 system/工具归因估算，
 * 不对账 input 与 cacheRead 的包含关系；token-plan 包月 cost=0 属正常，展示主显 token。
 *
 * 数据来源：data/agent-sessions/<parentId>/<slot>/*.jsonl 每条 assistant 消息自带的 usage
 * （pi-ai Usage）。扫描器幂等（游标记每文件已处理行数 + 主键去重），可回填全部历史。
 *
 * 已知边界：考核出题/判分、recording 汇总等 ephemeral 会话是 SessionManager.inMemory()，不落盘，
 * 扫不到（见 ISSUE-129「已知边界」）。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { localDateOf } from "./sessions.js";

export type TokenScope = "parent" | "child" | "scene" | "course";

export interface TokenUsageRow {
  ts: number;
  date: string;
  scope: TokenScope;
  childId: string;
  slot: string;
  model: string;
  stopReason: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 扫描某家长全部持久会话，把新增 assistant 消息的 usage 幂等写入 token_usage。
 * 游标 token_usage_files 按 (parent_id, file) 记行数，只处理增量行；重复扫描安全。
 * 返回本轮新写入的行数（用于日志/测试断言）。
 */
export function scanTokenUsageIntoDb(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childIds: string[]
): number {
  const agentRoot = path.join(dataDir, "agent-sessions", parentId);
  if (!fs.existsSync(agentRoot)) return 0;

  // slot → (scope, childId)：目录名 parent* 为家长侧；<childId>-<kind> 按已知孩子列表归属。
  const slotInfo = (slot: string): { scope: TokenScope; childId: string; kind: string } => {
    if (slot === "parent" || slot.startsWith("parent-")) {
      return { scope: "parent", childId: "", kind: slot };
    }
    for (const cid of childIds) {
      if (slot.startsWith(`${cid}-`)) {
        const kind = slot.slice(cid.length + 1);
        const scope: TokenScope = kind === "main" ? "child" : kind === "scene" ? "scene" : "course";
        return { scope, childId: cid, kind };
      }
    }
    return { scope: "child", childId: "", kind: slot };
  };

  const insert = db.prepare(
    `INSERT OR REPLACE INTO token_usage
       (parent_id, session_file, entry_id, ts, date, scope, child_id, slot, model, stop_reason,
        input, cache_read, cache_write, output, reasoning, total_tokens, cost)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const getCursor = db.prepare(
    "SELECT line_count FROM token_usage_files WHERE parent_id = ? AND file = ?"
  );
  const setCursor = db.prepare(
    `INSERT INTO token_usage_files (parent_id, file, line_count, updated)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(parent_id, file) DO UPDATE SET
       line_count = excluded.line_count, updated = excluded.updated`
  );

  // 递归收集全部 jsonl（课程子会话在 slot 目录的子目录里，与 indexAgentSessionsIntoDb 同款）
  const files: string[] = [];
  const collect = (cur: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) collect(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  collect(agentRoot);

  let inserted = 0;
  for (const f of files) {
    const fileKey = path.relative(agentRoot, f).split(path.sep).join("/");
    // slot 目录 = fileKey 的第一段
    const slot = fileKey.includes("/") ? fileKey.split("/")[0] : fileKey.replace(/\.jsonl$/, "");
    const info = slotInfo(slot);
    const lineCount =
      (getCursor.get(parentId, fileKey) as { line_count: number } | undefined)?.line_count ?? 0;
    let rawLines: string[];
    try {
      rawLines = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    if (rawLines.length <= lineCount) continue;
    let processed = lineCount;
    for (let i = lineCount; i < rawLines.length; i++) {
      let entry: any;
      try {
        entry = JSON.parse(rawLines[i]);
      } catch {
        // 尾部半行（正在写入）不推进游标，下次重扫
        break;
      }
      processed = i + 1;
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      const usage = entry.message.usage;
      if (!usage) continue;
      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      const costTotal = usage.cost?.total ?? usage.cost;
      insert.run(
        parentId,
        fileKey,
        String(entry.id ?? `${i}`),
        ts,
        localDateOf(ts),
        info.scope,
        info.childId,
        slot,
        String(entry.message.model ?? ""),
        String(entry.message.stopReason ?? ""),
        num(usage.input),
        num(usage.cacheRead),
        num(usage.cacheWrite),
        num(usage.output),
        num(usage.reasoning),
        num(usage.totalTokens),
        num(costTotal)
      );
      inserted++;
    }
    setCursor.run(parentId, fileKey, processed, new Date().toISOString());
  }
  return inserted;
}

export interface TokenDayRow {
  date: string;
  scope: string;
  child_id: string;
  rounds: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total_tokens: number;
  cost: number;
}

/** 按日期 × 渠道聚合（from/to 可选，YYYY-MM-DD，含端点；scope 可选）。 */
export function queryTokenUsageDays(
  db: DatabaseSync,
  parentId: string,
  opts: { from?: string; to?: string; scope?: string } = {}
): TokenDayRow[] {
  const where: string[] = ["parent_id = ?"];
  const args: unknown[] = [parentId];
  if (opts.from) {
    where.push("date >= ?");
    args.push(opts.from);
  }
  if (opts.to) {
    where.push("date <= ?");
    args.push(opts.to);
  }
  if (opts.scope) {
    where.push("scope = ?");
    args.push(opts.scope);
  }
  return db
    .prepare(
      `SELECT date, scope, child_id, COUNT(*) AS rounds,
              SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
              SUM(output) AS output, SUM(reasoning) AS reasoning,
              SUM(total_tokens) AS total_tokens, SUM(cost) AS cost
       FROM token_usage WHERE ${where.join(" AND ")}
       GROUP BY date, scope, child_id ORDER BY date DESC, scope`
    )
    .all(...(args as any[])) as unknown as TokenDayRow[];
}

export interface TokenSessionRow {
  session_file: string;
  scope: string;
  child_id: string;
  slot: string;
  models: string;
  rounds: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total_tokens: number;
  cost: number;
  first_ts: number;
  last_ts: number;
}

/** 某天按会话聚合（会话可能热切换过模型 → models 为逗号串）。 */
export function queryTokenUsageSessions(
  db: DatabaseSync,
  parentId: string,
  date: string,
  scope?: string
): TokenSessionRow[] {
  const where: string[] = ["parent_id = ?", "date = ?"];
  const args: unknown[] = [parentId, date];
  if (scope) {
    where.push("scope = ?");
    args.push(scope);
  }
  return db
    .prepare(
      `SELECT session_file, scope, child_id, slot,
              GROUP_CONCAT(DISTINCT model) AS models,
              COUNT(*) AS rounds,
              SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
              SUM(output) AS output, SUM(reasoning) AS reasoning,
              SUM(total_tokens) AS total_tokens, SUM(cost) AS cost,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM token_usage WHERE ${where.join(" AND ")}
       GROUP BY session_file ORDER BY first_ts DESC`
    )
    .all(...(args as any[])) as unknown as TokenSessionRow[];
}

/** 有用量数据的日期列表（倒序；客户端日期选择器/懒加载用）。 */
export function listTokenUsageDates(db: DatabaseSync, parentId: string): Array<{ date: string; rounds: number }> {
  return db
    .prepare(
      "SELECT date, COUNT(*) AS rounds FROM token_usage WHERE parent_id = ? GROUP BY date ORDER BY date DESC"
    )
    .all(parentId) as Array<{ date: string; rounds: number }>;
}
