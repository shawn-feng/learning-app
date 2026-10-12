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
import { nowLocalIso, toLocalIso } from "../util/time.js";
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

// ---------------------------------------------------------------------------
// 模型类别（ISSUE-174 配额面板四类拆分：文本 / 视觉识别 / 语音识别 / 语音合成）
// ---------------------------------------------------------------------------

export type ModelCategory = "text" | "vision" | "asr" | "tts";

export const MODEL_CATEGORY_NAMES: Record<ModelCategory, string> = {
  text: "文本（含编程）",
  vision: "视觉识别",
  asr: "语音识别",
  tts: "语音合成",
};

/** 按模型名归类（TokenHub/自定义模型命名习惯：vision/-vl/-5v=视觉；asr/audio=语音识别；
 *  tts/minimax-speech=合成——minimax-speech-* 是 TokenHub TTS 系，名字里没有 tts 字样）。 */
export function classifyModelCategory(model: string): ModelCategory {
  const m = String(model || "").toLowerCase();
  if (!m) return "text";
  if (m.includes("tts") || m.includes("minimax-speech")) return "tts";
  if (m.includes("asr") || m.includes("sensevoice") || m.includes("paraformer") || m.includes("audio")) {
    return "asr";
  }
  if (m.includes("vision") || m.includes("-vl") || m.includes("vl-") || m.includes("-5v") || m.includes("4v")) {
    return "vision";
  }
  return "text";
}

export interface CategoryTotals {
  text: number;
  vision: number;
  asr: number;
  tts: number;
}

export interface CategoryDayRow extends CategoryTotals {
  date: string;
}

/** 合成用量落库共享体：TokenHub 语音（识别/合成）与文本同池扣配额，但不经 agent 会话
 *  （不落 jsonl，扫描器扫不到），成功后在此补一行合成记录（scope="parent"、slot=通道）。
 *  仅 TokenHub 通道记录（其他通道不消耗该家长 TokenHub 配额，记入会污染口径）。 */
function recordSyntheticTokenUsage(
  db: DatabaseSync,
  parentId: string,
  slot: "asr" | "tts",
  model: string,
  usage: { input?: number; output?: number; total?: number }
): void {
  const ts = Date.now();
  const entryId = `${slot}-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT OR REPLACE INTO token_usage
       (parent_id, session_file, entry_id, ts, date, scope, child_id, slot, model, stop_reason,
        input, cache_read, cache_write, output, reasoning, total_tokens, cost)
     VALUES (?,?,?,?,?, 'parent', '', ?, ?, 'stop', ?, 0, 0, ?, 0, ?, 0)`
  ).run(
    parentId,
    slot,
    entryId,
    ts,
    localDateOf(ts),
    slot,
    model,
    num(usage.input),
    num(usage.output),
    num(usage.total)
  );
}

/** ASR 用量落库（转录成功后调用；session_file="asr"、slot="asr"）。 */
export function recordAsrTokenUsage(
  db: DatabaseSync,
  parentId: string,
  model: string,
  usage: { input?: number; output?: number; total?: number }
): void {
  recordSyntheticTokenUsage(db, parentId, "asr", model, usage);
}

/** TTS 用量落库（TokenHub 合成成功后调用；session_file="tts"、slot="tts"）。 */
export function recordTtsTokenUsage(
  db: DatabaseSync,
  parentId: string,
  model: string,
  usage: { input?: number; output?: number; total?: number }
): void {
  recordSyntheticTokenUsage(db, parentId, "tts", model, usage);
}

/** 内置（TokenHub）模型匹配：只有这些模型的消耗计入「大模型配额」（与文本同池扣减）。
 *  自定义模型的用量不消耗 TokenHub 配额，绝不能混入（用户 2026-10-10 拍板）。
 *  需兼容带 provider 前缀与裸 id 两种形态（TokenHub 回包的 model 字段两种都出现过）。 */
export function isTokenHubModel(model: string): boolean {
  const m = String(model || "").toLowerCase();
  if (!m) return false;
  const tail = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
  if (tail === "deepseek-flash") return true;                        // 内置文本/编程
  if (tail === "deepseek-v4-flash-vision-exp") return true;          // 内置视觉
  if (tail === "hy-asr-3.0-preview" || tail === "wand-asr-v1") return true; // 内置语音识别
  if (tail.startsWith("minimax-speech-")) return true;               // 内置语音合成（管理端默认模型）
  return false;
}

/** 近 N 天（含今日）按「日期 × 模型类别」聚合的 TokenHub 配额消耗（本地准实时口径）。
 *  仅统计内置模型：自定义模型用量不消耗该配额，不计入。 */
export function queryTokenUsageByCategory(
  db: DatabaseSync,
  parentId: string,
  days = 7
): { today: CategoryTotals; byDay: CategoryDayRow[] } {
  const since = localDateOf(Date.now() - (days - 1) * 86400_000);
  const rows = db
    .prepare(
      `SELECT date, model, SUM(total_tokens) AS tokens, SUM(cost) AS cost
       FROM token_usage WHERE parent_id = ? AND date >= ? AND model != ''
       GROUP BY date, model`
    )
    .all(parentId, since) as Array<{ date: string; model: string; tokens: number; cost: number }>;
  const byDayMap = new Map<string, CategoryDayRow>();
  const today = new Date().toLocaleDateString("sv-SE");
  const empty = (): CategoryDayRow => ({ date: "", text: 0, vision: 0, asr: 0, tts: 0, total: 0, cost: 0 });
  for (const r of rows) {
    if (!isTokenHubModel(r.model)) continue; // 自定义模型不计入配额面板
    let day = byDayMap.get(r.date);
    if (!day) {
      day = empty();
      day.date = r.date;
      byDayMap.set(r.date, day);
    }
    const cat = classifyModelCategory(r.model);
    day[cat] += r.tokens || 0;
    day.total += r.tokens || 0;
    day.cost += r.cost || 0;
  }
  const todayRow = byDayMap.get(today) ?? empty();
  return {
    today: { text: todayRow.text, vision: todayRow.vision, asr: todayRow.asr, tts: todayRow.tts },
    byDay: [...byDayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
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
    setCursor.run(parentId, fileKey, processed, nowLocalIso());
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
