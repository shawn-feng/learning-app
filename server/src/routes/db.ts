/**
 * 数据读写 RPC（DESIGN-SPLIT §3.4）：客户端不持有 SQLite，
 * 通过语义化 op 读写服务端数据；child 相关 op 强制归属校验。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";
import {
  getAgentPrompt,
  listAgentPromptHistory,
  restoreAgentPromptVersion,
  saveAgentPrompt,
} from "../db/agents.js";
import { openParentLib } from "../db/parent-lib.js";

interface RpcContext {
  dataDir: string;
  mainDb: DatabaseSync;
  parentId: string;
}

function assertChildOwned(ctx: RpcContext, childId: string): void {
  const row = ctx.mainDb
    .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
    .get(childId, ctx.parentId);
  if (!row) {
    throw new ApiError(403, "无权访问该孩子的数据");
  }
}

function requireChildId(ctx: RpcContext, args: Record<string, unknown>): string {
  const childId = typeof args.child_id === "string" ? args.child_id : "";
  if (!childId) throw new ApiError(400, "缺少 child_id");
  assertChildOwned(ctx, childId);
  return childId;
}

function str(v: unknown, fallback = ""): string {
  return v === undefined || v === null ? fallback : String(v);
}

function num(v: unknown, fallback = 0): number {
  return v === undefined || v === null ? fallback : Number(v);
}

// ===== 辅助（对齐 electron/lib/kb-sqlite.ts 语义） =====

/** 从 daily 条目原文提取 `- 标签：xxx` 字段行。 */
function extractTagsFromRaw(raw: string): string {
  const m = raw.match(/^[-*]\s*标签[:：]\s*(.+)$/m);
  return m ? m[1].trim() : "";
}

/** 标签字符串归一化：逗号统一、去空白、去空项。 */
function normalizeTags(s: string): string {
  return s
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(",");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** topics 表匹配 topic_key（name 或 topic_key 匹配），失败回退归一化。 */
function resolveKbTopicKey(db: DatabaseSync, input: string): string {
  const row = db
    .prepare("SELECT topic_key FROM topics WHERE name = ? OR topic_key = ? LIMIT 1")
    .get(input, input) as { topic_key: string } | undefined;
  if (row) return row.topic_key;
  const seg = input.split("/")[0].trim();
  return seg.replace(/\.md$/i, "");
}

/** 课程字段白名单（对齐 COURSE_FIELD_MAP）。 */
const COURSE_FIELD_MAP: Record<string, string> = {
  状态: "status",
  掌握状态: "status",
  掌握度: "mastery",
  首次学习: "first_learned",
  首次学习时间: "first_learned",
  最近复习: "last_review",
  复习时间: "last_review",
  上次复习: "last_review",
  复习次数: "review_count",
  教学资料: "material",
  学习资料: "send_material",
  要发送的学习资料: "send_material",
  tags: "tags",
  标签: "tags",
  课时方法: "lesson_method",
  每课教学方法: "lesson_method",
  html地址: "html_path",
  html_path: "html_path",
  学习资料地址: "html_path",
  教学文案: "teaching_copy",
  teaching_copy: "teaching_copy",
  考核掌握度: "exam_mastery",
  考核掌握: "exam_mastery",
  考核掌握情况: "exam_mastery",
};

// ==================== query handlers ====================

type QueryHandler = (ctx: RpcContext, args: Record<string, unknown>) => unknown;

// 导出供服务端无头 worker 直接调用（方案B 阶段②：worker 工具不重复实现 SQL 语义，
// 复用同一 handler，child 归属校验同样生效）。
export const queryHandlers: Record<string, QueryHandler> = {
  "kb.daily_entries.queryByDate": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db
        .prepare("SELECT date, block, title, raw, tags FROM daily_entries WHERE date = ? ORDER BY block, title")
        .all(str(args.date));
    } finally {
      db.close();
    }
  },
  "kb.daily_entries.query": (ctx, args) => {
    // 对齐客户端 queryDaily：date（精确）/ month（YYYY-MM 前缀）+ block/title/tag 过滤
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const date = str(args.date, "");
      const month = str(args.month, "");
      const block = str(args.block, "");
      const title = str(args.title, "");
      const tag = str(args.tag, "");
      const conds: string[] = [];
      const vals: (string | number)[] = [];
      if (date) {
        conds.push("date = ?");
        vals.push(date);
      } else if (month) {
        conds.push("date LIKE ?");
        vals.push(`${month}%`);
      }
      if (block) {
        conds.push("block = ?");
        vals.push(block);
      }
      if (title) {
        conds.push("title = ?");
        vals.push(title);
      }
      if (tag) {
        conds.push("(',' || tags || ',') LIKE ?");
        vals.push(`%,${tag},%`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      return db
        .prepare(`SELECT date, block, title, raw, tags FROM daily_entries ${where} ORDER BY date, block, title`)
        .all(...vals);
    } finally {
      db.close();
    }
  },
  "kb.topics.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db
        .prepare("SELECT name, topic_key, method, progress, rules_json FROM topics ORDER BY topic_key")
        .all();
    } finally {
      db.close();
    }
  },
  "kb.courses.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const topic = str(args.topic, "");
      const sql =
        "SELECT topic, title, sort_order, status, mastery, exam_mastery, first_learned, last_review, " +
        "review_count, material, send_material, tags, lesson_method, html_path, teaching_copy " +
        "FROM courses " +
        (topic ? "WHERE topic = ? " : "") +
        "ORDER BY topic, sort_order, title";
      return topic ? db.prepare(sql).all(topic) : db.prepare(sql).all();
    } finally {
      db.close();
    }
  },
  "kb.tags.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db.prepare("SELECT tag, dimension, criteria FROM tags ORDER BY tag").all();
    } finally {
      db.close();
    }
  },
  "kb.progress.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db.prepare("SELECT * FROM topic_progress ORDER BY topic").all();
    } finally {
      db.close();
    }
  },
  // ISSUE-025：取某天 todolist markdown（无则返回 null）。date 缺省 = 今天（本地日期由客户端计算传入）。
  "kb.todo.get": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const date = str(args.date);
    if (!date) throw new ApiError(400, "缺少 date（YYYY-MM-DD）");
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const row = db
        .prepare("SELECT date, items_md, updated FROM child_todos WHERE date = ?")
        .get(date) as { date: string; items_md: string; updated: string } | undefined;
      return row ? { date: row.date, itemsMd: row.items_md, updated: row.updated } : null;
    } finally {
      db.close();
    }
  },
  // ISSUE-025：取近 N 天完成统计（倒序，最新在前；range 默认 30）。供「我的执行力」趋势。
  "kb.todo.stats.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const range = Math.min(365, Math.max(1, num(args.range, 30)));
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db
        .prepare(
          `SELECT date, total, done, parent_total, parent_done, self_total, self_done, rate, streak, updated
           FROM child_todo_stats ORDER BY date DESC LIMIT ?`
        )
        .all(range);
    } finally {
      db.close();
    }
  },
  "agents.get": (ctx, args) => {
    const scope = str(args.scope);
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 强制为当前家长 id
    const ref = scope === "parent" ? ctx.parentId : str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    const content = getAgentPrompt(ctx.dataDir, scope, ref);
    return { content };
  },
  "agents.history": (ctx, args) => {
    const scope = str(args.scope);
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 强制为当前家长 id
    const ref = scope === "parent" ? ctx.parentId : str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    return listAgentPromptHistory(ctx.dataDir, scope, ref);
  },
  "parent_lib.topics.list": (ctx) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      return db
        .prepare("SELECT name, topic_key, method, assess_method, progress, rules_json FROM topics ORDER BY topic_key")
        .all();
    } finally {
      db.close();
    }
  },
  "parent_lib.courses.list": (ctx, args) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      const topic = str(args.topic, "");
      const sql =
        "SELECT topic, title, sort_order, status, mastery, first_learned, last_review, " +
        "review_count, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric " +
        "FROM courses " +
        (topic ? "WHERE topic = ? " : "") +
        "ORDER BY topic, sort_order, title";
      return topic ? db.prepare(sql).all(topic) : db.prepare(sql).all();
    } finally {
      db.close();
    }
  },
  "parent_lib.progress.list": (ctx) => {
    // 家长库主题进度（topic_progress 视图：learned/total/next/updated），供家长页列表聚合
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      return db.prepare("SELECT * FROM topic_progress ORDER BY topic").all();
    } finally {
      db.close();
    }
  },
  "parent_lib.tags.list": (ctx, args) => {
    // 家长库标签定义表（课程标签下拉源）
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      const tag = str(args.tag, "");
      const sql =
        "SELECT tag, dimension, criteria FROM tags " +
        (tag ? "WHERE tag = ? " : "") +
        "ORDER BY tag";
      return tag ? db.prepare(sql).all(tag) : db.prepare(sql).all();
    } finally {
      db.close();
    }
  },
};

// ==================== exec handlers ====================

type ExecHandler = (ctx: RpcContext, args: Record<string, unknown>) => unknown;

// 导出供服务端无头 worker 直接调用（方案B 阶段②），语义与 /db/exec 完全一致。
export const execHandlers: Record<string, ExecHandler> = {
  "kb.daily_entries.insert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO daily_entries (date, block, title, raw, tags)
         VALUES (?, ?, ?, ?, ?)`
      ).run(str(args.date), str(args.block), str(args.title), str(args.raw), str(args.tags));
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.daily_entries.insertMany": (ctx, args) => {
    // 对齐 insertDailyEntries：批量、单事务、重复跳过（INSERT OR IGNORE）；title/tags 从 content 提取
    const childId = requireChildId(ctx, args);
    const date = str(args.date);
    const entries = Array.isArray(args.entries)
      ? (args.entries as Array<Record<string, unknown>>)
      : [];
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const tx = db.prepare(
        "INSERT OR IGNORE INTO daily_entries (date, block, title, raw, tags) VALUES (?, ?, ?, ?, ?)"
      );
      let inserted = 0;
      db.exec("BEGIN");
      try {
        for (const e of entries) {
          const content = str(e.content);
          const title = content.match(/^###\s+(.+)$/m)?.[1]?.trim() ?? "";
          if (!title) continue;
          const r = tx.run(date, str(e.block), title, content, extractTagsFromRaw(content));
          if (r.changes > 0) inserted++;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { inserted, skipped: entries.length - inserted };
    } finally {
      db.close();
    }
  },
  // ISSUE-025：整体写入某天的 todolist markdown（upsert）。agent 的 todo_list 工具与定时
  // 生成/统计都走这里；[家长] 项不可改约束在 agent 提示词层执行（服务端不解析内容）。
  "kb.todo.put": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const date = str(args.date);
    if (!date) throw new ApiError(400, "缺少 date（YYYY-MM-DD）");
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT INTO child_todos (date, items_md, updated) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET items_md = excluded.items_md, updated = excluded.updated`
      ).run(date, str(args.items_md), str(args.updated, new Date().toISOString()));
      return { ok: true };
    } finally {
      db.close();
    }
  },
  // ISSUE-025：写某天完成统计（upsert）。由主进程在统计点 agent 打完勾后解析 markdown 落库。
  "kb.todo.stats.upsert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const date = str(args.date);
    if (!date) throw new ApiError(400, "缺少 date（YYYY-MM-DD）");
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT INTO child_todo_stats (
           date, total, done, parent_total, parent_done, self_total, self_done, rate, streak, updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           total = excluded.total, done = excluded.done,
           parent_total = excluded.parent_total, parent_done = excluded.parent_done,
           self_total = excluded.self_total, self_done = excluded.self_done,
           rate = excluded.rate, streak = excluded.streak, updated = excluded.updated`
      ).run(
        date,
        num(args.total),
        num(args.done),
        num(args.parent_total),
        num(args.parent_done),
        num(args.self_total),
        num(args.self_done),
        num(args.rate, 0),
        num(args.streak, 0),
        str(args.updated, new Date().toISOString())
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.daily_entries.updateField": (ctx, args) => {
    // 对齐 updateDailyField：改 raw 字段行（缺失追加）；field=标签 时同步 tags 列
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const row = db
        .prepare("SELECT raw FROM daily_entries WHERE date = ? AND block = ? AND title = ?")
        .get(str(args.date), str(args.block), str(args.title)) as { raw: string } | undefined;
      if (!row) return { ok: false };
      const field = str(args.field);
      const value = str(args.value);
      const fieldRe = new RegExp(`^- (\\*{0,2}${escapeRegExp(field)}\\*{0,2})\\s*[:：]\\s*.*$`, "m");
      let raw = row.raw;
      if (fieldRe.test(raw)) {
        raw = raw.replace(fieldRe, `- $1：${value}`);
      } else {
        raw = `${raw}\n- ${field}：${value}`;
      }
      if (field === "标签") {
        db.prepare("UPDATE daily_entries SET raw = ?, tags = ? WHERE date = ? AND block = ? AND title = ?").run(
          raw,
          extractTagsFromRaw(raw),
          str(args.date),
          str(args.block),
          str(args.title)
        );
      } else {
        db.prepare("UPDATE daily_entries SET raw = ? WHERE date = ? AND block = ? AND title = ?").run(
          raw,
          str(args.date),
          str(args.block),
          str(args.title)
        );
      }
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.topics.upsert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT INTO topics (name, topic_key, method, progress, rules_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           topic_key = excluded.topic_key,
           method = excluded.method,
           progress = excluded.progress,
           rules_json = excluded.rules_json`
      ).run(
        str(args.name),
        str(args.topic_key),
        str(args.method),
        str(args.progress),
        str(args.rules_json, "{}")
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.topics.deallocate": (ctx, args) => {
    // ISSUE-004：移除孩子某主题的分配。只删 topics 分配行（孩子 agent 不再看到/学习该主题），
    // **保留 courses 与 topic_progress 学习记录**（重新分配时进度可续上）。
    const childId = requireChildId(ctx, args);
    const topicKey = str(args.topic_key);
    if (!topicKey) throw new ApiError(400, "缺少 topic_key");
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const r = db
        .prepare("DELETE FROM topics WHERE topic_key = ? OR name = ?")
        .run(topicKey, topicKey);
      return { removed: Number(r.changes) };
    } finally {
      db.close();
    }
  },
  "kb.courses.upsert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT INTO courses (
           topic, title, sort_order, status, mastery, exam_mastery, first_learned, last_review,
           review_count, material, send_material, tags, lesson_method, html_path, teaching_copy
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic, title) DO UPDATE SET
           sort_order = excluded.sort_order,
           status = excluded.status,
           mastery = excluded.mastery,
           exam_mastery = excluded.exam_mastery,
           first_learned = excluded.first_learned,
           last_review = excluded.last_review,
           review_count = excluded.review_count,
           material = excluded.material,
           send_material = excluded.send_material,
           tags = excluded.tags,
           lesson_method = excluded.lesson_method,
           html_path = excluded.html_path,
           teaching_copy = excluded.teaching_copy`
      ).run(
        str(args.topic),
        str(args.title),
        num(args.sort_order),
        str(args.status),
        str(args.mastery),
        str(args.exam_mastery),
        str(args.first_learned),
        str(args.last_review),
        num(args.review_count),
        str(args.material),
        str(args.send_material),
        str(args.tags),
        str(args.lesson_method),
        str(args.html_path),
        str(args.teaching_copy)
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.courses.insert": (ctx, args) => {
    // 对齐 insertCourse：已有同 (topic,title) 返回 ok:false；sort_order 自动取最大 +1
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const topic = resolveKbTopicKey(db, str(args.topic));
      const exists = db.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?").get(topic, str(args.title));
      if (exists) return { ok: false };
      const max = db
        .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM courses WHERE topic = ?")
        .get(topic) as { m: number };
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO courses (
             topic, title, sort_order, status, mastery, exam_mastery, material, send_material, tags, lesson_method, html_path, teaching_copy
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          topic,
          str(args.title),
          max.m + 1,
          str(args.status),
          str(args.mastery),
          str(args.exam_mastery),
          str(args.material),
          str(args.send_material),
          str(args.tags),
          str(args.lesson_method),
          str(args.html_path),
          str(args.teaching_copy)
        );
      return { ok: r.changes > 0 };
    } finally {
      db.close();
    }
  },
  "kb.courses.updateField": (ctx, args) => {
    // 对齐 updateProgress：field 走白名单；review_count 支持 "+1" 自增；topic 支持中文名匹配
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const col = COURSE_FIELD_MAP[str(args.field)];
      if (!col) {
        throw new ApiError(400, `progress 字段「${str(args.field)}」不支持（合法: ${Object.keys(COURSE_FIELD_MAP).join(" / ")}）`);
      }
      const topic = resolveKbTopicKey(db, str(args.topic));
      const title = str(args.title);
      const exists = db.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?").get(topic, title);
      if (!exists) return { ok: false };
      if (col === "review_count") {
        const v = str(args.value);
        const delta = v === "+1" ? 1 : parseInt(v, 10);
        if (!Number.isFinite(delta) || delta < 0) return { ok: false };
        if (v === "+1") {
          db.prepare("UPDATE courses SET review_count = review_count + 1 WHERE topic = ? AND title = ?").run(topic, title);
        } else {
          db.prepare("UPDATE courses SET review_count = ? WHERE topic = ? AND title = ?").run(delta, topic, title);
        }
        return { ok: true };
      }
      const val = col === "tags" ? normalizeTags(str(args.value)) : str(args.value);
      db.prepare(`UPDATE courses SET ${col} = ? WHERE topic = ? AND title = ?`).run(val, topic, title);
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.courses.updateFields": (ctx, args) => {
    // 批量更新同一课程多字段（一次事务，减少工具调用与 RPC 往返）：
    // args.fields = [{ field, value }×N]，字段白名单/自增/规范化语义与 kb.courses.updateField 一致；
    // 任一字段非法则整体抛错回滚（防止「手动更新 learned/total」等被静默吞掉）。
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const topic = resolveKbTopicKey(db, str(args.topic));
      const title = str(args.title);
      const exists = db.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?").get(topic, title);
      if (!exists) return { ok: false };
      const fields = Array.isArray(args.fields) ? (args.fields as Array<{ field?: unknown; value?: unknown }>) : [];
      if (!fields.length) throw new ApiError(400, "kb.courses.updateFields 需要非空 fields 数组");
      db.exec("BEGIN");
      try {
        for (const f of fields) {
          const fname = str(f?.field);
          const col = COURSE_FIELD_MAP[fname];
          if (!col) {
            throw new ApiError(400, `progress 字段「${fname}」不支持（合法: ${Object.keys(COURSE_FIELD_MAP).join(" / ")}）`);
          }
          const value = str(f?.value);
          if (col === "review_count") {
            const delta = value === "+1" ? 1 : parseInt(value, 10);
            if (!Number.isFinite(delta) || delta < 0) {
              throw new ApiError(400, `复习次数值非法: ${value}`);
            }
            if (value === "+1") {
              db.prepare("UPDATE courses SET review_count = review_count + 1 WHERE topic = ? AND title = ?").run(topic, title);
            } else {
              db.prepare("UPDATE courses SET review_count = ? WHERE topic = ? AND title = ?").run(delta, topic, title);
            }
          } else {
            const val = col === "tags" ? normalizeTags(value) : value;
            db.prepare(`UPDATE courses SET ${col} = ? WHERE topic = ? AND title = ?`).run(val, topic, title);
          }
        }
        db.exec("COMMIT");
        return { ok: true, updated: fields.length };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      db.close();
    }
  },
  "agents.save": (ctx, args) => {
    const scope = str(args.scope);
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 强制为当前家长 id
    const ref = scope === "parent" ? ctx.parentId : str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    saveAgentPrompt(ctx.dataDir, scope, ref, str(args.content));
    return { ok: true };
  },
  "agents.restore": (ctx, args) => {
    const scope = str(args.scope);
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 强制为当前家长 id
    const ref = scope === "parent" ? ctx.parentId : str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    const done = restoreAgentPromptVersion(ctx.dataDir, scope, ref, str(args.updated));
    return { ok: done };
  },
  "parent_lib.topics.upsert": (ctx, args) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      db.prepare(
        `INSERT INTO topics (name, topic_key, method, assess_method, progress, rules_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           topic_key = excluded.topic_key,
           method = excluded.method,
           assess_method = excluded.assess_method,
           progress = excluded.progress,
           rules_json = excluded.rules_json`
      ).run(
        str(args.name),
        str(args.topic_key),
        str(args.method),
        str(args.assess_method),
        str(args.progress),
        str(args.rules_json, "{}")
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "parent_lib.courses.upsert": (ctx, args) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      db.prepare(
        `INSERT INTO courses (
           topic, title, sort_order, status, mastery, first_learned, last_review,
           review_count, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic, title) DO UPDATE SET
           sort_order = excluded.sort_order,
           status = excluded.status,
           mastery = excluded.mastery,
           first_learned = excluded.first_learned,
           last_review = excluded.last_review,
           review_count = excluded.review_count,
           material = excluded.material,
           send_material = excluded.send_material,
           tags = excluded.tags,
           lesson_method = excluded.lesson_method,
           html_path = excluded.html_path,
           teaching_copy = excluded.teaching_copy,
           assess_rubric = excluded.assess_rubric`
      ).run(
        str(args.topic),
        str(args.title),
        num(args.sort_order),
        str(args.status),
        str(args.mastery),
        str(args.first_learned),
        str(args.last_review),
        num(args.review_count),
        str(args.material),
        str(args.send_material),
        str(args.tags),
        str(args.lesson_method),
        str(args.html_path),
        str(args.teaching_copy),
        str(args.assess_rubric)
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "parent_lib.courses.delete": (ctx, args) => {
    // 对齐本地 deleteParentCourse：按 (topic, title) 删除，返回是否删到
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      const r = db
        .prepare("DELETE FROM courses WHERE topic = ? AND title = ?")
        .run(str(args.topic), str(args.title));
      return { ok: r.changes > 0 };
    } finally {
      db.close();
    }
  },
  "parent_lib.courses.move": (ctx, args) => {
    // 对齐本地 moveParentCourse：与相邻课程交换 sort_order（direction=-1 上移 / 1 下移）
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      const topic = str(args.topic);
      const title = str(args.title);
      const direction = args.direction === -1 ? -1 : 1;
      const rows = db
        .prepare("SELECT title, sort_order FROM courses WHERE topic = ? ORDER BY sort_order, title")
        .all(topic) as Array<{ title: string; sort_order: number }>;
      const idx = rows.findIndex((r) => r.title === title);
      const j = idx + direction;
      if (idx < 0 || j < 0 || j >= rows.length) return { ok: false };
      const a = rows[idx];
      const b = rows[j];
      const tmp = a.sort_order;
      db.prepare("UPDATE courses SET sort_order = ? WHERE topic = ? AND title = ?").run(b.sort_order, topic, a.title);
      db.prepare("UPDATE courses SET sort_order = ? WHERE topic = ? AND title = ?").run(tmp, topic, b.title);
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "parent_lib.tags.upsert": (ctx, args) => {
    // 家长新增/更新标签定义（dimension/criteria）
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      db.prepare(
        `INSERT INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)
         ON CONFLICT(tag) DO UPDATE SET dimension = excluded.dimension, criteria = excluded.criteria`
      ).run(str(args.tag), str(args.dimension), str(args.criteria));
      return { ok: true };
    } finally {
      db.close();
    }
  },
};

// ==================== routes ====================

interface DbRoutesDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

export function registerDbRoutes(app: FastifyInstance, deps: DbRoutesDeps): void {
  const ctxFor = (req: { headers: Record<string, string | string[] | undefined> }): RpcContext => ({
    dataDir: deps.config.dataDir,
    mainDb: deps.db,
    parentId: authParent(req, deps.config.jwtSecret),
  });

  app.post("/api/v1/db/query", async (req, reply) => {
    const { op, args } = (req.body ?? {}) as { op?: string; args?: Record<string, unknown> };
    if (!op) return reply.code(400).send({ error: "缺少 op" });
    const handler = queryHandlers[op];
    if (!handler) return reply.code(400).send({ error: `未知查询操作: ${op}` });
    try {
      return { op, result: handler(ctxFor(req), args ?? {}) };
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/db/exec", async (req, reply) => {
    const { op, args } = (req.body ?? {}) as { op?: string; args?: Record<string, unknown> };
    if (!op) return reply.code(400).send({ error: "缺少 op" });
    const handler = execHandlers[op];
    if (!handler) return reply.code(400).send({ error: `未知执行操作: ${op}` });
    try {
      return { op, result: handler(ctxFor(req), args ?? {}) };
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}

/** 服务端无头 worker 直调入口（语义与 /db/query 一致；parentId 由任务上下文提供）。 */
export function runKbQuery<T = unknown>(
  dataDir: string,
  mainDb: DatabaseSync,
  parentId: string,
  op: string,
  args: Record<string, unknown>
): T {
  const handler = queryHandlers[op];
  if (!handler) throw new ApiError(400, `未知查询操作: ${op}`);
  return handler({ dataDir, mainDb, parentId }, args ?? {}) as T;
}

/** 服务端无头 worker 直调入口（语义与 /db/exec 一致）。 */
export function runKbExec<T = unknown>(
  dataDir: string,
  mainDb: DatabaseSync,
  parentId: string,
  op: string,
  args: Record<string, unknown>
): T {
  const handler = execHandlers[op];
  if (!handler) throw new ApiError(400, `未知执行操作: ${op}`);
  return handler({ dataDir, mainDb, parentId }, args ?? {}) as T;
}
