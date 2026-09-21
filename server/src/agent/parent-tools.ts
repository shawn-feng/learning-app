/**
 * 家长 agent 工具集（P2，服务端形态）。
 *
 * 与孩子工具集的差异：家长工具面向「课程/资料治理」——资料真源就是服务端磁盘+索引表，
 * 因此这些工具是直接函数调用（不再需要旧架构「客户端工具 → IPC → HTTP 回服务端」的封装）。
 *
 * 危险动作约定（ISSUE-079 待确认项 1 的落地）：
 * `parent_delete_material` 必须 dryRun：`confirm !== true` 时**只返回将删除的清单**，
 * 由 agent 向家长复述并征得同意后再带 `confirm: true` 调用；真删会写 activity-log。
 * 这样即使模型想「顺手清理」，家长也一定先看到清单。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { openParentLib } from "../db/parent-lib.js";
import { openKb } from "../db/kb.js";
import {
  isImageAttachment,
  isTextAttachment,
  looksLikeAttachmentRef,
  missingRemoteHint,
  resolveAttachmentRef,
  UploadRefError,
} from "./upload-ref.js";
import {
  appendParentActivityLog,
  deleteMaterial,
  formatMaterialTree,
  listMaterials,
  materialAbsPath,
  moveMaterial,
  putMaterial,
  readMaterial,
  type MaterialCtx,
} from "./parent-materials.js";
import { describeImageViaVision, imageMimeFromExt } from "./vision.js";
import { createProgrammingTool } from "./programming-agent.js";
import { indexAgentSessionsIntoDb, listSessionDates, querySessionMessages } from "../db/sessions.js";
import {
  getCourseUuid,
  getOrCreateKnowledgePoint,
  getQuestion,
  listCourseContent,
  listKnowledgePoints,
  replaceCourseContent,
  saveQuestion,
  type CourseContent,
} from "../db/assess-content.js";
import {
  describeTables,
  describeChildTables,
  executeWrite,
  executeRead,
  executePathRead,
  parentLibPaths,
  parentLibTableRegistry,
  parentReadableRegistry,
  childKbReadableRegistry,
  childKbWritableRegistry,
  type ColumnSpec,
  type WriteRequest,
} from "./db-channel.js";
import {
  defineNamespace,
  loadNamespaces,
  tier2Read,
  tier2Write,
  describeNamespace,
  type NamespaceRow,
} from "./tier2.js";
import {
  markStale,
  candidatesHintText,
  embeddedColumn,
  type EmbedContext,
} from "./embeddings.js";

export interface ParentToolDeps extends MaterialCtx {
  /** 家长 agent 工作区（临时产出） */
  workspaceDir: string;
  /** agent 私有目录 */
  agentDir: string;
  auth: Record<string, unknown>;
  appSettings?: Record<string, unknown>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** 有界读文本（最多 200KB，避免大附件整份读进内存）。 */
function readTextHead(abs: string, maxBytes = 200 * 1024): string {
  const fd = fs.openSync(abs, "r");
  try {
    const len = Math.max(1, Math.min(maxBytes, 200 * 1024));
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/** 服务端本地时区的 YYYY-MM-DD（与 db/sessions 的 localDateOf 同口径）。 */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对今天的日期（offsetDays=1 → 昨天）；本地时区，跨月/跨年由 Date 处理。 */
function localDateOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** date 参数的宽松解析：支持中文/英文口语表述（今天、昨天、today、yesterday），其余原样返回。 */
function normalizeDateParam(raw: string): string {
  switch (raw.trim().toLowerCase()) {
    case "":
    case "今天":
    case "今日":
    case "today":
      return "";
    case "昨天":
    case "昨日":
    case "yesterday":
      return localDateOffset(1);
    case "前天":
      return localDateOffset(2);
    default:
      return raw.trim();
  }
}

/**
 * childName → { id, name, aiName }（精确匹配；找不到列出可选名，不猜）。
 * 归属校验同 assertChildOwned 口径：只在自己名下孩子里找，找不到即拒绝。
 */
function resolveConvoChild(
  db: DatabaseSync,
  parentId: string,
  childName: string
): { id: string; name: string; aiName: string } {
  const kids = db
    .prepare("SELECT id, name, profile_json FROM children WHERE parent_id = ?")
    .all(parentId) as Array<{ id: string; name: string; profile_json: string | null }>;
  const name = String(childName ?? "").trim();
  const hit = kids.find((k) => k.name === name);
  if (!hit) {
    const names = kids.map((k) => k.name).join("、");
    throw new Error(`找不到孩子「${name}」${names ? `（现有孩子：${names}）` : "（名下暂无孩子）"}`);
  }
  let aiName = "饺子";
  try {
    const p = hit.profile_json ? (JSON.parse(hit.profile_json) as { aiName?: string }) : {};
    if (typeof p.aiName === "string" && p.aiName.trim()) aiName = p.aiName.trim();
  } catch {
    /* profile 损坏则用默认名 */
  }
  return { id: hit.id, name: hit.name, aiName };
}

/** 家长名下全部孩子（按创建时间；供跨孩子批量动作使用，如课程改名联动）。 */
function childrenOf(db: DatabaseSync, parentId: string): Array<{ id: string; name: string }> {
  return db
    .prepare("SELECT id, name FROM children WHERE parent_id = ? ORDER BY created_at, name")
    .all(parentId) as unknown as Array<{ id: string; name: string }>;
}

/** 家长库 topics：topic_key ↔ 中文名 双向解析（家长库 courses.topic 存的是 topic_key）。 */
function parentTopicIndex(pdb: DatabaseSync): {
  byKey: Map<string, { topic_key: string; name: string }>;
  resolve: (raw: string) => { topic_key: string; name: string } | undefined;
} {
  const rows = pdb.prepare("SELECT name, topic_key FROM topics").all() as unknown as Array<{
    name: string;
    topic_key: string;
  }>;
  const byKey = new Map(rows.map((r) => [String(r.topic_key), { topic_key: String(r.topic_key), name: String(r.name) }]));
  const byName = new Map(rows.map((r) => [String(r.name), { topic_key: String(r.topic_key), name: String(r.name) }]));
  return {
    byKey,
    resolve: (raw: string) => {
      const k = String(raw ?? "").trim();
      return byKey.get(k) ?? byName.get(k);
    },
  };
}


/**
 * 孩子是否已分配该主题（只核对、不代分配——「分配主题」是家长的决定，工具不越界）。
 * 仅 `parent_rename_course` 用它提醒「改到未分配主题后孩子看不到」。
 */
function childHasTopic(kb: DatabaseSync, name: string, topicKey: string): boolean {
  return !!kb.prepare("SELECT 1 FROM topics WHERE topic_key = ? OR name = ?").get(topicKey, name);
}

export function createParentAgentTools(deps: ParentToolDeps) {
  const ctx: MaterialCtx = { db: deps.db, dataDir: deps.dataDir, parentId: deps.parentId };

  const listTool = defineTool({
    name: "parent_list_materials",
    label: "列出课程学习资料",
    description:
      "列出服务端课程学习资料真源（可按 topic 或路径前缀过滤）。\n\n" +
      "**何时调用**：整理资料前先看「现在有什么」——去重、归并目录、重命名都必须先列清单。\n" +
      "返回每条的相对路径（可直接用作 read/delete/move 的 path）。",
    parameters: Type.Object({
      topic: Type.Optional(Type.String({ description: "主题目录名（第一级目录，如 lunyu）；不传=全部" })),
      relPrefix: Type.Optional(Type.String({ description: "路径前缀过滤（如 lunyu/materials）" })),
    }),
    execute: async (_id: string, params: { topic?: string; relPrefix?: string }) => {
      const items = listMaterials(ctx, { topic: params?.topic, relPrefix: params?.relPrefix });
      return ok(`共 ${items.length} 条材料：\n${formatMaterialTree(items)}`);
    },
  });

  const readTool = defineTool({
    name: "parent_read_material",
    label: "读取课程资料内容",
    description:
      "读取一份课程资料的正文（html/md/txt/css/js/json 等文本类，超 200KB 截断）。\n\n" +
      "**何时调用**：需要看资料里到底写了什么（如判断两份是否重复、检查链接是否有效）。\n" +
      "音视频/图片等二进制只返回元数据（类型与大小），不返回正文——避免大文件灌爆上下文。",
    parameters: Type.Object({
      path: Type.String({ description: "材料相对路径（来自 parent_list_materials）" }),
    }),
    execute: async (_id: string, params: { path: string }) => {
      const r = readMaterial(ctx, params.path);
      if (r.text === undefined) {
        return ok(`${r.path}：${r.type} 类型（${r.size} 字节），二进制内容不返回正文；如需理解图片内容用 parent_read_image。`);
      }
      return ok(
        `${r.path}（${r.type}，${r.size} 字节${r.truncated ? "，已截断至 200KB" : ""}）：\n\n${r.text}`
      );
    },
  });

  const deleteTool = defineTool({
    name: "parent_delete_material",
    label: "删除课程资料（需确认）",
    description:
      "删除一份课程学习资料。**默认只演练（dryRun）**：不传 confirm 时只返回「将被删除的文件」清单。\n\n" +
      "**流程（必须遵守）**：先调用一次（不传 confirm）拿到清单 → 向家长复述要删什么并征得同意 →\n" +
      "再带 `confirm: true` 调用真正删除。删除会写入家长操作记录（activity-log）可追溯。\n\n" +
      "**为什么**：资料是孩子上课要用的真源，误删无法回滚。",
    parameters: Type.Object({
      path: Type.String({ description: "材料相对路径" }),
      confirm: Type.Optional(Type.Boolean({ description: "true = 真正执行删除；不传/ false = 只返回将删除清单" })),
    }),
    execute: async (_id: string, params: { path: string; confirm?: boolean }) => {
      if (params.confirm !== true) {
        // dryRun：校验路径合法且存在，只回报；不做任何删除
        const items = listMaterials(ctx).filter(
          (m) => m.path === params.path || m.path.startsWith(params.path.replace(/\/+$/, "") + "/")
        );
        if (!items.length) {
          // 路径不存在时明确告知，避免家长以为「确认一下就删了」
          try {
            materialAbsPath(ctx, params.path);
          } catch (err) {
            return ok(`路径非法：${(err as Error).message}`);
          }
          return ok(`没有找到材料「${params.path}」（可用 parent_list_materials 核对准确路径）`);
        }
        return ok(
          `【演练】将删除以下 ${items.length} 项（尚未执行）：\n${items.map((m) => `- ${m.path} [${m.type}, ${m.size}B]`).join("\n")}\n\n` +
            `请向家长复述并确认；确认后再带 confirm=true 调用本工具。`
        );
      }
      const r = deleteMaterial(ctx, params.path);
      appendParentActivityLog(ctx, `删除资料「${r.deleted}」`);
      return ok(`已删除：${r.deleted}（已记入 activity-log）`);
    },
  });

  const moveTool = defineTool({
    name: "parent_move_material",
    label: "移动/重命名课程资料",
    description:
      "把一份资料移动或改名（如把散落的 html 归入 lunyu/materials/、修正错别字文件名）。\n\n" +
      "**何时调用**：整理资料结构时。目标路径已存在会被拒绝（不覆盖），避免静默丢文件。\n" +
      "实现上是「先写新路径再删旧路径」，最坏情况留下重复副本，需要时用 delete 清理。",
    parameters: Type.Object({
      from: Type.String({ description: "源相对路径" }),
      to: Type.String({ description: "目标相对路径" }),
    }),
    execute: async (_id: string, params: { from: string; to: string }) => {
      const r = moveMaterial(ctx, params.from, params.to);
      appendParentActivityLog(ctx, `移动资料「${r.from}」→「${r.to}」`);
      return ok(`已移动：${r.from} → ${r.to}（已记入 activity-log）`);
    },
  });

  const putTool = defineTool({
    name: "parent_put_material",
    label: "写入/覆盖课程资料",
    description:
      "把文本内容写入课程资料真源（新建或覆盖整份文件；单次上限 2MB）。\n\n" +
      "**何时调用**：你生成了教案/练习页等资料后发布到真源。\n" +
      "覆盖已有文件前建议先 parent_read_material 看原内容，避免误覆盖家长手工改过的版本。",
    parameters: Type.Object({
      path: Type.String({ description: "材料相对路径（如 lunyu/materials/lesson-01.html）" }),
      content: Type.String({ description: "完整文本内容" }),
    }),
    execute: async (_id: string, params: { path: string; content: string }) => {
      const meta = putMaterial(ctx, params.path, params.content);
      appendParentActivityLog(ctx, `写入资料「${meta.path}」（${meta.size} 字节）`);
      return ok(`已写入：${meta.path}（${meta.size} 字节，已记入 activity-log）`);
    },
  });

  // 2026-09-18 库域分工：家长库不再存学习进度——家长侧看进度改为实时聚合名下孩子的孩子库。
  // 返回 { byTopicKey: 主题→{learned,total}，byCourseTitle: 课程标题→{done,seen,lastReview} }
  function familyProgress(): {
    byTopicKey: Map<string, { learned: number; total: number }>;
    byCourseTitle: Map<string, { done: number; seen: number; lastReview: string }>;
  } {
    const byTopicKey = new Map<string, { learned: number; total: number }>();
    const byCourseTitle = new Map<string, { done: number; seen: number; lastReview: string }>();
    let kids: Array<{ id: string }> = [];
    try {
      kids = deps.db.prepare("SELECT id FROM children WHERE parent_id = ?").all(deps.parentId) as Array<{ id: string }>;
    } catch {
      return { byTopicKey, byCourseTitle };
    }
    for (const k of kids) {
      let kb: DatabaseSync;
      try {
        kb = openKb(deps.dataDir, deps.parentId, k.id);
      } catch {
        continue;
      }
      try {
        const agg = kb
          .prepare("SELECT topic, learned, total FROM topic_progress")
          .all() as Array<{ topic: string; learned: number; total: number }>;
        for (const r of agg) {
          const cur = byTopicKey.get(r.topic) ?? { learned: 0, total: 0 };
          cur.learned += Number(r.learned) || 0;
          cur.total = Math.max(cur.total, Number(r.total) || 0);
          byTopicKey.set(r.topic, cur);
        }
        const cs = kb
          .prepare("SELECT title, status, last_review FROM courses")
          .all() as Array<{ title: string; status: string; last_review: string }>;
        for (const c of cs) {
          const cur = byCourseTitle.get(c.title) ?? { done: 0, seen: 0, lastReview: "" };
          cur.seen += 1;
          if (c.status === "✅") cur.done += 1;
          if (c.last_review && c.last_review > cur.lastReview) cur.lastReview = c.last_review;
          byCourseTitle.set(c.title, cur);
        }
      } finally {
        kb.close();
      }
    }
    return { byTopicKey, byCourseTitle };
  }

  const topicsTool = defineTool({
    name: "parent_library_topics",
    label: "查看教学主题与进度",
    description:
      "列出家长库里的教学主题及其进度（已学/总数/下一课）。起草排期或整理资料前用它确认权威主题名（topic_key）。",
    parameters: Type.Object({}),
    execute: async () => {
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const rows = db
          .prepare(
            `SELECT t.name, t.topic_key, t.method,
                    (SELECT COUNT(*) FROM courses c WHERE c.topic = t.topic_key) AS total
             FROM topics t ORDER BY t.topic_key`
          )
          .all() as Array<{ name: string; topic_key: string; method: string; total: number }>;
        if (!rows.length) return ok("（家长库暂无教学主题）");
        const progress = familyProgress();
        return ok(
          rows
            .map((r) => {
              const learned = progress.byTopicKey.get(r.topic_key)?.learned ?? 0;
              return `- ${r.name}（${r.topic_key}）：已学 ${learned}/${r.total}${r.method ? `｜方法：${r.method}` : ""}`;
            })
            .join("\n")
        );
      } finally {
        db.close();
      }
    },
  });

  const coursesTool = defineTool({
    name: "parent_library_courses",
    label: "查看主题下的课程",
    description: "列出某主题下的课程（标题/学习进度/资料路径）。改资料前用它核对课程与资料的对应关系。",
    parameters: Type.Object({
      topic: Type.String({ description: "主题目录名（topic_key，如 lunyu）" }),
    }),
    execute: async (_id: string, params: { topic: string }) => {
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const rows = db
          .prepare(`SELECT title, html_path FROM courses WHERE topic = ? ORDER BY sort_order, title`)
          .all(params.topic) as Array<{ title: string; html_path: string }>;
        if (!rows.length) return ok(`主题「${params.topic}」下没有课程（可用 parent_library_topics 核对 topic 名）`);
        const progress = familyProgress();
        return ok(
          rows
            .map((r) => {
              const p = progress.byCourseTitle.get(r.title);
              const prog = p ? `✅${p.done}/${p.seen}｜最近 ${p.lastReview || "-"}` : "未开始";
              return `- ${r.title}｜${prog}｜${r.html_path || "无资料"}`;
            })
            .join("\n")
        );
      } finally {
        db.close();
      }
    },
  });

  const upsertTopicTool = defineTool({
    name: "parent_upsert_topic",
    label: "写入/更新教学主题（家长库）",
    description:
      "把教学主题写入家长库真源（新建或覆盖）。\n\n" +
      "**何时调用**：你设计好一个教学主题（如「论语」）后落库。name 是主键（主题中文名），topic_key 是主题目录名（如 lunyu）。\n" +
      "**先核对再覆盖**：覆盖前先 parent_library_topics 看现有结构，避免误改家长手工维护的字段。覆盖只更新你给的字段。",
    parameters: Type.Object({
      name: Type.String({ description: "主题中文名（主键，如「论语」）" }),
      topic_key: Type.String({ description: "主题目录名（如 lunyu），用于资料/课程归属" }),
      method: Type.Optional(Type.String({ description: "教学方法说明" })),
      assess_method: Type.Optional(Type.String({ description: "考核方法说明" })),
      progress: Type.Optional(Type.String({ description: "进度约定/总目标说明" })),
      rules_json: Type.Optional(Type.String({ description: "主题规则 JSON 字符串（缺省 {}）" })),
    }),
    execute: async (_id, params) => {
      if (!params.name?.trim() || !params.topic_key?.trim()) throw new Error("parent_upsert_topic 需要 name + topic_key");
      const db = openParentLib(deps.dataDir, deps.parentId);
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
          params.name,
          params.topic_key,
          params.method ?? "",
          params.assess_method ?? "",
          params.progress ?? "",
          params.rules_json ?? "{}"
        );
        appendParentActivityLog(ctx, `落库主题「${params.name}」（${params.topic_key}）`);
        markEmbeddedWrite(deps, "topics", [params.name]);
        return ok(`已落库主题「${params.name}」（${params.topic_key}）。`);
      } finally {
        db.close();
      }
    },
  });

  const upsertCourseTool = defineTool({
    name: "parent_upsert_course",
    label: "写入/更新课程（家长库）",
    description:
      "把课程写入家长库真源（新建或覆盖），归属到某主题。\n\n" +
      "**何时调用**：你设计好一门课后落库。topic 是主题目录名，title 是课程名（联合主键）。\n" +
      "课程内容（lesson_method/html_path/teaching_copy/assess_rubric）落家长库即可——孩子端学习时从家长库读取，无需单独写到孩子库。\n" +
      "学习进度/状态不归家长库管（2026-09-18 库域分工后已下线，进度由孩子库承载），没有 status 字段可写。",
    parameters: Type.Object({
      topic: Type.String({ description: "主题目录名（如 lunyu）" }),
      title: Type.String({ description: "课程名" }),
      sort_order: Type.Optional(Type.Number({ description: "排序（缺省 0）" })),
      lesson_method: Type.Optional(Type.String({ description: "教学方法" })),
      html_path: Type.Optional(Type.String({ description: "资料相对路径（如 lunyu/materials/lesson-01.html）" })),
      teaching_copy: Type.Optional(Type.String({ description: "教学文案" })),
      assess_rubric: Type.Optional(Type.String({ description: "考核要点" })),
      material: Type.Optional(Type.String({ description: "教学资料附注" })),
      send_material: Type.Optional(Type.String({ description: "要发送的学习资料" })),
      tags: Type.Optional(Type.String({ description: "课程标签（逗号分隔）" })),
    }),
    execute: async (_id, params) => {
      if (!params.topic?.trim() || !params.title?.trim()) throw new Error("parent_upsert_course 需要 topic + title");
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        // uuid 显式写入（新行）：跨库关联的锚点（ISSUE-123），不让新课程留 NULL uuid 窗口；
        // ON CONFLICT 分支**不动 uuid**（改名/覆盖不得改变关联锚点，改名请用 parent_rename_course）。
        db.prepare(
          `INSERT INTO courses (
             topic, title, uuid, sort_order,
             material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(topic, title) DO UPDATE SET
             sort_order = excluded.sort_order,
             material = excluded.material,
             send_material = excluded.send_material,
             tags = excluded.tags,
             lesson_method = excluded.lesson_method,
             html_path = excluded.html_path,
             teaching_copy = excluded.teaching_copy,
             assess_rubric = excluded.assess_rubric`
        ).run(
          params.topic,
          params.title,
          randomUUID(),
          params.sort_order ?? 0,
          params.material ?? "",
          params.send_material ?? "",
          params.tags ?? "",
          params.lesson_method ?? "",
          params.html_path ?? "",
          params.teaching_copy ?? "",
          params.assess_rubric ?? ""
        );
        appendParentActivityLog(ctx, `落库课程「${params.title}」（${params.topic}）`);
        markEmbeddedWrite(deps, "courses", [params.topic, params.title]);
        return ok(`已落库课程「${params.title}」（${params.topic}）。`);
      } finally {
        db.close();
      }
    },
  });

  // ==================== ISSUE-123：家长库课程 ↔ 孩子库课程 的同步与改名（uuid 为锚点） ====================
  // 背景（2026-09-18 库域分工）：孩子库 courses 只剩「进度 + 显示引用」两域字段，教学真源在家长库；
  // 唯一写入口本来是「分配时」一次性写入，此后没有定时同步 → 家长改课程名/新加课后孩子库不跟随。
  // 本组工具补上「按 uuid 同步」的手动/可重复动作，永不触碰孩子进度字段。

  /** 按 uuid 把家长库所选课程同步到某孩子库（补 uuid / 更新显示排序 / 归并 / 新增），进度字段一概不动。 */
  const syncCoursesTool = defineTool({
    name: "parent_sync_courses_to_child",
    label: "把家长库课程同步到孩子库（按 uuid）",
    description:
      "把孩子库的课程行与**家长库真源**对齐（一次一个孩子）：补齐缺失关联、更新课程显示名/排序、补上家长库新加而孩子库还没有的课。\n\n" +
      "**⚠️ 同步范围 = 该孩子**已分配**的主题**（孩子能不能看到某课完全由「主题是否分配给他」决定）。" +
      "**没有分配给他的主题，整体跳过**：不写入、也不代分配（分配主题是家长的决定，请在家长端操作）——本次跳过了哪些主题会在返回里列出。\n" +
      "**何时调用**：① 家长改过课程名或调整过主题内课程；② 家长库给**已分配主题**新加了课、但孩子那边找不到（考核创建报「课程在孩子库里不存在」就是此症）；" +
      "③ 定期体检孩子库与家长库是否对齐。**幂等**：已对齐的内容不会重复改动。\n" +
      "**边界（重要）**：孩子的学习进度（status/last_review/review_count/tags）**一概不动**；不删任何行（家长库已删的课，孩子库进度行保留为孤儿并列入汇报）；不改孩子级主题规则；不新增主题分配。\n" +
      "**参数**：`child` 必填（一次一个孩子，多孩子多次调用）；`topic` 可选（主题目录名或中文名，只同步该主题——若该主题未分配给孩子会被拒绝并说明）；`titles` 可选（只同步这些课程名）。",
    parameters: Type.Object({
      child: Type.String({ description: "孩子姓名" }),
      topic: Type.Optional(Type.String({ description: "只同步该主题（topic_key 或主题中文名）；不传=全部课程" })),
      titles: Type.Optional(Type.Array(Type.String(), { description: "只同步这些课程名；不传=该范围内全部" })),
    }),
    execute: async (_id, params) => {
      const child = resolveConvoChild(deps.db, deps.parentId, params.child);
      const pdb = openParentLib(deps.dataDir, deps.parentId);
      const kb = openKb(deps.dataDir, deps.parentId, child.id);
      try {
        const topicsIdx = parentTopicIndex(pdb);
        // ⚠️ **同步边界 = 该孩子已分配的主题**（2026-09-21 用户纠正）：
        // 孩子能不能看到某课完全由「主题是否分配给他」决定（`kb.topics.list` → 按 topic_key 逐主题列课）。
        // 把未分配主题的课程写进孩子库 ① 孩子根本看不到 ② 一旦日后分配该主题，会一次性冒出上百门「没分配过」的课，
        // 属于脏数据。所以同步**只在已分配主题内进行**，未分配主题只汇报、不写入（更不代分配——那是家长的决定）。
        const childTopicRows = kb.prepare("SELECT name, topic_key FROM topics").all() as unknown as Array<{
          name: string;
          topic_key: string;
        }>;
        const assignedKeys = new Set(childTopicRows.map((t) => String(t.topic_key)));
        const assignedNames = new Set(childTopicRows.map((t) => String(t.name)));
        /** 家长库某主题是否已分配给该孩子（家长库 topic_key ↔ 孩子库 topic_key/中文名）。 */
        const isAssigned = (parentTopicKey: string, parentTopicName?: string): boolean => {
          if (assignedKeys.has(parentTopicKey)) return true;
          if (parentTopicName && (assignedNames.has(parentTopicName) || assignedKeys.has(parentTopicName))) return true;
          return false;
        };
        const assignedOf = (parentKey: string): { topic_key: string; name: string } | undefined => {
          const meta = topicsIdx.byKey.get(parentKey);
          return isAssigned(parentKey, meta?.name) ? (meta ?? { topic_key: parentKey, name: parentKey }) : undefined;
        };
        const assignedList = [...topicsIdx.byKey.values()].filter((t) => isAssigned(t.topic_key, t.name));
        if (!assignedList.length) {
          return ok(
            `「${child.name}」还没有分配任何学习主题（孩子库 topics 为空），无从同步。\n` +
              `请先在家长端给孩子分配主题——分配时会把该主题下的课程一并写入孩子库。`
          );
        }

        const topicArg = String(params.topic ?? "").trim();
        let topicKeyFilter = "";
        if (topicArg) {
          const hit = topicsIdx.resolve(topicArg);
          if (!hit) {
            const names = [...topicsIdx.byKey.values()].map((t) => `${t.name}(${t.topic_key})`).join("、");
            return ok(`家长库里没有主题「${topicArg}」${names ? `（现有：${names}）` : "（家长库暂无主题）"}`);
          }
          if (!isAssigned(hit.topic_key, hit.name)) {
            return ok(
              `主题「${hit.name}（${hit.topic_key}）」**没有分配给「${child.name}」**，不能同步（同步只在已分配主题内进行）。\n` +
                `该孩子已分配的主题：${assignedList.map((t) => `${t.name}(${t.topic_key})`).join("、")}\n` +
                `要让他学这个主题，请先在家长端给他分配主题（分配时课程会一并写入）。`
            );
          }
          topicKeyFilter = hit.topic_key;
        }
        const titleFilter = new Set(
          (Array.isArray(params.titles) ? params.titles : []).map((t) => String(t).trim()).filter(Boolean)
        );
        const allParent = pdb
          .prepare("SELECT topic, title, sort_order, uuid FROM courses ORDER BY topic, sort_order, title")
          .all() as unknown as Array<{ topic: string; title: string; sort_order: number; uuid: string }>;
        // 白名单：家长库全部主题里，**未分配**给该孩子的 → 只汇报不写入
        const skippedTopics = [...topicsIdx.byKey.values()]
          .filter((t) => !isAssigned(t.topic_key, t.name))
          .map((t) => ({
            name: t.name,
            key: t.topic_key,
            courses: allParent.filter((c) => String(c.topic) === t.topic_key).length,
          }))
          .filter((t) => t.courses > 0);
        const parentCourses = allParent.filter(
          (c) =>
            !!assignedOf(String(c.topic)) &&
            (!topicKeyFilter || String(c.topic) === topicKeyFilter) &&
            (!titleFilter.size || titleFilter.has(String(c.title)))
        );
        if (!parentCourses.length) {
          return ok(
            `已经分配的主题（${assignedList.map((t) => `${t.name}(${t.topic_key})`).join("、")}）下没有符合条件的课程` +
              `（孩子「${child.name}」未做任何改动）。` +
              (titleFilter.size ? `\n请用 parent_library_courses 核对课程名。` : "")
          );
        }
        const parentByKey = new Map(allParent.map((c) => [`${String(c.topic)}|${String(c.title)}`, c]));

        // ---- 步骤 1：补孩子库缺失的 uuid（按 (topic,title) 在同主题内解析 → 同时修 ISSUE-123 R3）----
        const childRows = kb
          .prepare("SELECT rowid AS rid, topic, topic_key, title, uuid, sort_order FROM courses")
          .all() as unknown as Array<{
          rid: number;
          topic: string;
          topic_key: string;
          title: string;
          uuid: string | null;
          sort_order: number;
        }>;
        const byUuid = new Map<string, (typeof childRows)[number]>();
        for (const r of childRows) if (r.uuid) byUuid.set(String(r.uuid), r);
        let uuidFilled = 0;
        // 同样只在**已分配主题**内补 uuid（未分配主题的行不属于本次同步范围，只汇报不动）
        for (const r of childRows.filter((x) => !x.uuid && !!assignedOf(String(x.topic_key || x.topic)))) {
          const p = parentByKey.get(`${r.topic}|${r.title}`);
          if (!p?.uuid) continue; // 解析不到 → 留到孤儿清单里汇报，不动
          kb.prepare("UPDATE courses SET uuid = ? WHERE rowid = ?").run(String(p.uuid), r.rid);
          r.uuid = String(p.uuid);
          byUuid.set(String(p.uuid), r);
          uuidFilled++;
        }

        // ---- 步骤 2：按 uuid 三态同步（进度字段一概不写）----
        let inserted = 0;
        let updated = 0;
        let merged = 0;
        let unchanged = 0;
        const conflicts: string[] = [];
        for (const p of parentCourses) {
          const topic = String(p.topic);
          const title = String(p.title);
          const uuid = String(p.uuid);
          const sortOrder = Number(p.sort_order) || 0;
          const topicMeta = topicsIdx.byKey.get(topic) ?? { topic_key: topic, name: topic };
          const hit = byUuid.get(uuid);
          if (hit) {
            if (String(hit.topic) === topic && String(hit.title) === title && Number(hit.sort_order) === sortOrder) {
              unchanged++;
              continue;
            }
            // 显示名/主题/排序变了 → 只改这四列；改名前先查是否与既有行主键冲突
            const clash = kb
              .prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ? AND COALESCE(uuid,'') <> ?")
              .get(topic, title, uuid) as { uuid?: string } | undefined;
            if (clash) {
              conflicts.push(`「${topic}/${title}」与孩子库另一行（uuid ${String(clash.uuid).slice(0, 8)}）撞名，已跳过`);
              continue;
            }
            kb.prepare("UPDATE courses SET topic = ?, topic_key = ?, title = ?, sort_order = ? WHERE uuid = ?").run(
              topic,
              topicMeta.topic_key,
              title,
              sortOrder,
              uuid
            );
            updated++;
            continue;
          }
          // uuid 未命中：撞上同 (topic,title) 的旧行 → 归并（补 uuid + 更新显示字段，不新建重复行）
          const legacy = kb
            .prepare("SELECT rowid AS rid, uuid FROM courses WHERE topic = ? AND title = ?")
            .get(topic, title) as { rid: number; uuid?: string | null } | undefined;
          if (legacy) {
            if (legacy.uuid) {
              conflicts.push(
                `孩子库「${topic}/${title}」已有行但 uuid 不同（家长库该课 uuid ${uuid.slice(0, 8)}）——可能是「删旧建新」导致，未改动，请人工确认是否同一门课`
              );
              continue;
            }
            kb.prepare("UPDATE courses SET uuid = ?, topic_key = ?, sort_order = ? WHERE rowid = ?").run(
              uuid,
              topicMeta.topic_key,
              sortOrder,
              legacy.rid
            );
            merged++;
            continue;
          }
          kb.prepare(
            `INSERT INTO courses (topic, topic_key, title, uuid, sort_order, status, last_review, review_count, tags)
             VALUES (?, ?, ?, ?, ?, '⬜', '', 0, '')`
          ).run(topic, topicMeta.topic_key, title, uuid, sortOrder);
          inserted++;
        }

        // ---- 步骤 3：汇报（含孤儿行 / 主题未分配）----
        // 孤儿行 = 既按 uuid 也对不上 (topic,title) 的孩子库行（家长库已删/改名未保 uuid）——只汇报，不动
        const parentUuids = new Set(allParent.map((c) => String(c.uuid)));
        const orphanSeen = new Set<string>();
        const orphanList: string[] = [];
        for (const r of childRows) {
          const byUuidHit = !!r.uuid && parentUuids.has(String(r.uuid));
          const byKeyHit = parentByKey.has(`${r.topic}|${r.title}`);
          if (byUuidHit || byKeyHit) continue;
          const k = `${r.topic}|${r.title}`;
          if (orphanSeen.has(k)) continue;
          orphanSeen.add(k);
          orphanList.push(`${r.topic}/${r.title}`);
        }
        // 孩子库里属于「未分配主题」的存量行（历史遗留/早先误同步）：只汇报，不动
        const strayRows = childRows.filter((r) => !assignedOf(String(r.topic_key || r.topic)));
        const lines = [
          `已把家长库课程同步到「${child.name}」的孩子库（**同步范围＝已分配给该孩子的主题**）：`,
          `- 已分配主题 ${assignedList.length} 个：${assignedList.map((t) => `${t.name}(${t.topic_key})`).join("、")}`,
          `- 本次检查这些主题下的课程 ${parentCourses.length} 门；新增 ${inserted} 门｜更新显示/排序 ${updated} 门｜归并旧行 ${merged} 行｜补 uuid ${uuidFilled} 行｜无需改动 ${unchanged} 门`,
        ];
        if (conflicts.length) {
          lines.push(`- ⚠️ 跳过 ${conflicts.length} 项（需人工确认）：\n    ${conflicts.slice(0, 10).join("\n    ")}`);
        }
        if (orphanList.length) {
          lines.push(
            `- ⚠️ 孩子库里有 ${orphanList.length} 门课在家长库找不到（进度已保留为孤儿行，未改动）：` +
              `${orphanList.slice(0, 10).join("、")}${orphanList.length > 10 ? ` …等 ${orphanList.length} 门` : ""}`
          );
        }
        if (skippedTopics.length) {
          const total = skippedTopics.reduce((s, t) => s + t.courses, 0);
          lines.push(
            `- ⏭️ **未分配的主题已整体跳过**（不写入，也不代分配）——${skippedTopics.length} 个主题、共 ${total} 门课：` +
              skippedTopics
                .slice(0, 8)
                .map((t) => `${t.name}(${t.key}) ${t.courses} 门`)
                .join("、") +
              (skippedTopics.length > 8 ? ` …等 ${skippedTopics.length} 个主题` : "") +
              `\n    想让某个孩子学这些主题，请先在家长端给他**分配主题**（分配时课程一并写入）。`
          );
        }
        if (strayRows.length) {
          const uniq = [...new Set(strayRows.map((r) => `${r.topic}/${r.title}`))];
          lines.push(
            `- ℹ️ 孩子库里另有 ${strayRows.length} 行属于未分配主题（孩子看不到；历史遗留，本次未改动）：` +
              `${uniq.slice(0, 5).join("、")}${uniq.length > 5 ? ` …等 ${uniq.length} 行` : ""}`
          );
        }
        lines.push(`（孩子的学习进度一概未改动。）`);
        appendParentActivityLog(
          ctx,
          `同步课程到「${child.name}」：新增 ${inserted}、更新 ${updated}、归并 ${merged}、补 uuid ${uuidFilled}`
        );
        return ok(lines.join("\n"));
      } finally {
        kb.close();
        pdb.close();
      }
    },
  });

  /**
   * 课程改名/换主题：**保 uuid**（ISSUE-123 的同步锚点），并联动所有孩子库的显示名。
   * 旧做法（parent_upsert_course 改 title）是 (topic,title) 主键 upsert = 新建一行新 uuid，
   * 孩子库进度行再也对不上 → 本工具是唯一正确的改名入口。
   */
  const renameCourseTool = defineTool({
    name: "parent_rename_course",
    label: "课程改名/换主题（保 uuid + 联动孩子库）",
    description:
      "给家长库里的课程**改名**（或换到别的主题），**uuid 保持不变**，并同步更新所有孩子库中该课程的显示名——孩子的学习进度原样保留。\n\n" +
      "**何时调用**：家长要「把这门课换个名字 / 挪到别的主题」时。\n" +
      "**⚠️ 改名不要用 parent_upsert_course**：它是 (topic,title) 主键 upsert，改 title 等于**新建一行、新 uuid**，旧行残留，" +
      "孩子库那条进度就永久对不上了（ISSUE-123 R1）。本工具是唯一正确的改名入口。\n" +
      "**参数**：topic + title 定位现有课程（改名前可先 parent_library_courses 核对）；new_title 新名字；new_topic 可选（换主题，接受 topic_key 或中文名）。",
    parameters: Type.Object({
      topic: Type.String({ description: "现有课程的所属主题（topic_key 或中文名）" }),
      title: Type.String({ description: "现有课程名" }),
      new_title: Type.String({ description: "新课程名" }),
      new_topic: Type.Optional(Type.String({ description: "可选：换到该主题（topic_key 或中文名）；不传=主题不变" })),
    }),
    execute: async (_id, params) => {
      const oldTitle = String(params.title ?? "").trim();
      const newTitle = String(params.new_title ?? "").trim();
      if (!oldTitle || !newTitle) throw new Error("parent_rename_course 需要 title + new_title");
      if (oldTitle === newTitle && !String(params.new_topic ?? "").trim()) {
        return ok("新旧课程名相同，无需改名。");
      }
      const pdb = openParentLib(deps.dataDir, deps.parentId);
      try {
        const topicsIdx = parentTopicIndex(pdb);
        const oldTopicArg = String(params.topic ?? "").trim();
        const oldTopicMeta = topicsIdx.resolve(oldTopicArg);
        const oldTopicKey = oldTopicMeta?.topic_key ?? oldTopicArg;
        const row = pdb
          .prepare("SELECT topic, title, uuid FROM courses WHERE topic = ? AND title = ?")
          .get(oldTopicKey, oldTitle) as { topic: string; title: string; uuid?: string | null } | undefined;
        if (!row) {
          const near = pdb
            .prepare("SELECT topic, title FROM courses WHERE topic = ? ORDER BY title LIMIT 20")
            .all(oldTopicKey) as unknown as Array<{ topic: string; title: string }>;
          return ok(
            `家长库「${oldTopicKey}」下没有课程「${oldTitle}」（该主题现有：${near.map((c) => c.title).join("、") || "无"}）`
          );
        }
        const uuid = String(row.uuid ?? "");
        if (!uuid) throw new Error("该课程缺 uuid（家长库应已自动回填），请重新打开家长库后重试");

        let newTopicKey = oldTopicKey;
        if (String(params.new_topic ?? "").trim()) {
          const t = topicsIdx.resolve(String(params.new_topic).trim());
          if (!t) return ok(`家长库里没有主题「${params.new_topic}」`);
          newTopicKey = t.topic_key;
        }
        const occupied = pdb
          .prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ? AND uuid <> ?")
          .get(newTopicKey, newTitle, uuid);
        if (occupied) {
          return ok(`家长库「${newTopicKey}」下已有同名课程「${newTitle}」，改名会撞名——请换个名字，或先把那门课处理掉。`);
        }

        // 1) 先在每个孩子库按**旧名字**补 uuid（改正名前才解析得到），再按 uuid 改显示名
        const kids = childrenOf(deps.db, deps.parentId);
        const perChild: string[] = [];
        let childTouched = 0;
        for (const k of kids) {
          const kb = openKb(deps.dataDir, deps.parentId, k.id);
          try {
            const back = kb
              .prepare("UPDATE courses SET uuid = ? WHERE (uuid IS NULL OR uuid = '') AND topic = ? AND title = ?")
              .run(uuid, oldTopicKey, oldTitle);
            const clash = kb
              .prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ? AND COALESCE(uuid,'') <> ?")
              .get(newTopicKey, newTitle, uuid);
            if (clash) {
              perChild.push(`${k.name}：跳过（已有同名课「${newTitle}」，uuid 不同）`);
              continue;
            }
            const upd = kb
              .prepare("UPDATE courses SET topic = ?, topic_key = ?, title = ? WHERE uuid = ?")
              .run(newTopicKey, newTopicKey, newTitle, uuid);
            // 未分配该主题 → 提醒（不代分配）
            const tName = topicsIdx.byKey.get(newTopicKey)?.name ?? newTopicKey;
            const hasTopic = childHasTopic(kb, tName, newTopicKey);
            const n = Number(upd.changes) + Number(back.changes);
            if (n > 0) childTouched++;
            perChild.push(
              `${k.name}：更新 ${upd.changes} 行${Number(back.changes) ? `、补 uuid ${back.changes} 行` : ""}` +
                (hasTopic ? "" : `（⚠️ 该孩子未分配主题 ${tName}，课程暂时看不到）`)
            );
          } finally {
            kb.close();
          }
        }
        // 2) 家长库改名（uuid 原地不动；知识点挂在 course_uuid 上，不受影响）
        pdb.prepare("UPDATE courses SET topic = ?, title = ? WHERE topic = ? AND title = ?").run(
          newTopicKey,
          newTitle,
          oldTopicKey,
          oldTitle
        );
        appendParentActivityLog(ctx, `课程改名「${oldTitle}」→「${newTitle}」（${oldTopicKey} → ${newTopicKey}）`);
        markEmbeddedWrite(deps, "courses", [newTopicKey, newTitle]);
        return ok(
          `已改名：家长库「${oldTitle}」→「${newTitle}」${newTopicKey !== oldTopicKey ? `（主题 ${oldTopicKey} → ${newTopicKey}）` : ""}，` +
            `uuid 保持不变（知识点/考核内容仍挂在同一门课上）。\n` +
            `孩子库联动（受影响孩子 ${childTouched} 个，进度未改动）：\n  ${perChild.join("\n  ")}\n` +
            `⚠️ 提醒：已生成的考核计划 scope 里保存的是**当时的课程名**，改名后这些旧计划可能取不到课程，` +
            `请在家长端核对/重排相关考核，或用 parent_exam_plan_list 查看。`
        );
      } finally {
        pdb.close();
      }
    },
  });

  // ISSUE-103：课程考核内容（知识点 + 题库 + 挂载关联）——读
  const courseContentTool = defineTool({
    name: "parent_library_course_content",
    label: "查看课程的考核内容（知识点 + 题）",
    description:
      "查看某门课**已结构化**的考核内容：该课全部知识点（名称/详情/序号）及每个知识点下挂着的题目（题干/答案/行为/分值）。\n\n" +
      "**何时调用**：写课程考核内容（parent_upsert_course_content）之前**必做**——那个工具是**整课替换**，" +
      "不看现状就写会把家长手工建的知识点挂载覆盖掉。也用于回答「这门课的考点和题有哪些、有没有重复」。\n" +
      "返回里的 `id=` 是题库题 id / 知识点 id，可在 parent_upsert_course_content 里用 questionId / knowledgePointId 复用。",
    parameters: Type.Object({
      topic: Type.String({ description: "主题目录名（topic_key，如 lunyu）" }),
      title: Type.String({ description: "课程名" }),
    }),
    execute: async (_id: string, params: { topic: string; title: string }) => {
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const uuid = getCourseUuid(db, params.topic, params.title);
        if (!uuid) {
          // ISSUE-111：精确匹配落空 → 向量候选（只提示不代入；未配置时静默跳过）
          const hint = await candidatesHintText(embCtx(deps), "courses", params.title);
          return ok(
            `课程不存在：${params.topic}/${params.title}（先用 parent_library_courses 核对该主题下的课程名）` +
              (hint ? `\n\n${hint}` : "")
          );
        }
        const kps = listKnowledgePoints(db, uuid);
        const content = listCourseContent(db, uuid);
        const qTotal = content.items.reduce((n, it) => n + it.questions.length, 0);
        if (!kps.length && !qTotal) {
          return ok(
            `课程「${params.title}」（${params.topic}）尚未结构化：没有任何知识点，也没有挂题。\n` +
              `可用 parent_upsert_course_content 写入「知识点 + 题」。`
          );
        }
        const clip = (s: unknown, n: number) => {
          const t = String(s ?? "")
            .replace(/\s+/g, " ")
            .trim();
          return t.length > n ? `${t.slice(0, n)}…` : t;
        };
        const byKp = new Map(content.items.map((it) => [it.knowledgePointId, it]));
        const lines: string[] = [
          `课程「${params.title}」（${params.topic}）：${kps.length} 个知识点 / 共 ${qTotal} 道挂题`,
        ];
        for (const kp of kps) {
          const it = byKp.get(kp.id);
          const qs = it?.questions ?? [];
          lines.push("", `【知识点】${kp.name}（id=${kp.id}）${qs.length ? "" : "（未挂题）"}`);
          if (kp.detail) lines.push(`  说明：${clip(kp.detail, 400)}`);
          if (it?.overview) lines.push(`  本课补充：${clip(it.overview, 200)}`);
          qs.forEach((q, i) => {
            lines.push(`  题 ${i + 1}（id=${q.id}｜${q.behavior || "generic"}｜${q.pointMax} 分）`);
            lines.push(`    题干：${clip(q.stem, 300)}`);
            lines.push(`    答案：${clip(q.answer, 300)}`);
          });
        }
        // 兜底：挂载指向的知识点行不属于本课（数据异常时才会出现），也要让 agent 看见
        for (const it of content.items) {
          if (kps.some((k) => k.id === it.knowledgePointId)) continue;
          lines.push("", `【知识点】${it.knowledgePointName || "(名称缺失)"}（id=${it.knowledgePointId}｜归属异常）`);
          it.questions.forEach((q, i) =>
            lines.push(`  题 ${i + 1}（id=${q.id}）题干：${clip(q.stem, 300)}`)
          );
        }
        return ok(lines.join("\n"));
      } finally {
        db.close();
      }
    },
  });

  // ISSUE-103：课程考核内容（知识点 + 题库 + 挂载关联）——写（整课替换）
  const upsertCourseContentTool = defineTool({
    name: "parent_upsert_course_content",
    label: "写入课程考核内容（知识点 + 题，整课替换）",
    description:
      "把一门课的考核内容写入家长库：items 每项 = 一个**知识点**（knowledgePoint 名称，或 knowledgePointId 引用已有）+ 该知识点下要考的**题目**。\n\n" +
      "**何时调用**：家长要「给某课建考点 / 出题 / 把题挂到考点下」时——「建知识点 + 建题 + 关联」一步到位。\n" +
      "**⚠️ items 是整课全量快照，不是增量**：本工具**替换**该课全部挂载——没写进 items 的知识点/题会从这门课移除" +
      "（题本身还留在题库，可再用 questionId 挂回，但家长手工建的挂载关系会丢）。" +
      "**所以必须先 parent_library_course_content 看现状、把要保留的内容一并写进 items，并向家长复述后再调用**。\n" +
      "**题的三种给法**：① `questionId` 单独引用题库已有题（先 parent_library_course_content 拿 id），原样挂载不改题；" +
      "② `questionId` + 内联字段（stem/answer/scoring/pointMax/behavior/note/options 任一）＝**更新该题**，只更新给出的字段，其余保留原值" +
      "（⚠️ 更新是改题库题本身：同一道题挂在多处时会同步生效）；" +
      "③ 内联 `stem`+`answer` 新建题库题（可带 behavior/pointMax/scoring/note/options）。\n" +
      "**behavior**：普通题 generic；背诵 speech_recite（answer 填标准原文）；朗读 speech_read；选择题填 options=[{key,text}]。\n" +
      "课程必须先存在（parent_upsert_course 建课）。",
    parameters: Type.Object({
      topic: Type.String({ description: "主题目录名（topic_key，如 lunyu）" }),
      title: Type.String({ description: "课程名（需已存在）" }),
      items: Type.Array(
        Type.Object({
          knowledgePoint: Type.Optional(
            Type.String({ description: "知识点名称（不存在则新建，已存在则复用；按 course+name 唯一）" })
          ),
          knowledgePointId: Type.Optional(
            Type.String({ description: "已有知识点 id（须属于本课）；给了它就不用 knowledgePoint" })
          ),
          detail: Type.Optional(Type.String({ description: "知识点详情（该考点的详细描述/考核要点）" })),
          overview: Type.Optional(Type.String({ description: "该知识点在本课的补充说明（可空）" })),
          questions: Type.Optional(
            Type.Array(
              Type.Object({
                questionId: Type.Optional(
                  Type.String({
                    description:
                      "引用题库已有题 id；单独给出＝原样挂载，同时给出 stem/answer 等内联字段＝更新该题（只更新给出的字段）",
                  })
                ),
                stem: Type.Optional(Type.String({ description: "题干" })),
                answer: Type.Optional(Type.String({ description: "标准答案（背诵/朗读题为原文）" })),
                scoring: Type.Optional(Type.String({ description: "评分说明或 JSON（可空）" })),
                pointMax: Type.Optional(Type.Number({ description: "满分（缺省 10）" })),
                behavior: Type.Optional(
                  Type.String({ description: "generic / speech_recite / speech_read（缺省 generic）" })
                ),
                note: Type.Optional(Type.String({ description: "备注" })),
                knowledgeSummary: Type.Optional(Type.String({ description: "知识点概要（缺省=知识点名）" })),
                options: Type.Optional(
                  Type.Array(Type.Object({ key: Type.String(), text: Type.String() }), {
                    description: "选择题选项；非选择题不传",
                  })
                ),
              })
            )
          ),
        })
      ),
    }),
    execute: async (_id, params) => {
      const topic = String(params.topic ?? "").trim();
      const title = String(params.title ?? "").trim();
      if (!topic || !title) throw new Error("parent_upsert_course_content 需要 topic + title");
      const items = Array.isArray(params.items) ? params.items : [];
      if (!items.length) {
        throw new Error("items 不能为空——本工具是整课替换，空数组会把该课的挂载全部清空");
      }
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const uuid = getCourseUuid(db, topic, title);
        if (!uuid) {
          const hint = await candidatesHintText(embCtx(deps), "courses", title);
          throw new Error(`课程不存在：${topic}/${title}（先用 parent_upsert_course 建课）${hint ? `\n\n${hint}` : ""}`);
        }
        const before = listCourseContent(db, uuid);

        // questionId 携带的内联字段（有任一即视为「更新该题」而非原样引用）
        const VALID_BEHAVIORS = ["generic", "speech_recite", "speech_read"];
        const inlineFields = (qo: any) => ({
          stem: typeof qo.stem === "string" && qo.stem.trim() ? qo.stem.trim() : undefined,
          answer: typeof qo.answer === "string" && qo.answer.trim() ? qo.answer.trim() : undefined,
          scoring: qo.scoring != null ? String(qo.scoring) : undefined,
          pointMax: qo.pointMax != null ? Number(qo.pointMax) : undefined,
          behavior: qo.behavior != null ? String(qo.behavior).trim() : undefined,
          note: qo.note != null ? String(qo.note) : undefined,
          knowledgeSummary: qo.knowledgeSummary != null ? String(qo.knowledgeSummary) : undefined,
          options: Array.isArray(qo.options) ? qo.options : undefined,
        });

        // 预校验（**只读**）：先把所有错误挑干净再落笔——否则「报错但已建出孤儿知识点/题」会留在库里。
        for (const it of items) {
          const kpIdRaw = typeof it.knowledgePointId === "string" ? it.knowledgePointId.trim() : "";
          const kpName = String(it.knowledgePoint ?? "").trim();
          if (!kpIdRaw && !kpName) {
            throw new Error("每个 item 需要 knowledgePoint（知识点名称）或 knowledgePointId");
          }
          if (kpIdRaw) {
            const row = db
              .prepare("SELECT id FROM knowledge_points WHERE id = ? AND course_uuid = ?")
              .get(kpIdRaw, uuid);
            if (!row) {
              throw new Error(`知识点不存在或不属于本课：${kpIdRaw}（先用 parent_library_course_content 核对 id）`);
            }
          }
          for (const qo of Array.isArray(it.questions) ? it.questions : []) {
            const refId = typeof qo.questionId === "string" ? qo.questionId.trim() : "";
            if (refId) {
              if (!getQuestion(db, refId)) {
                throw new Error(`题库题不存在：${refId}（可用 parent_library_course_content 拿正确 id）`);
              }
              const f = inlineFields(qo);
              if (f.behavior != null && !VALID_BEHAVIORS.includes(f.behavior)) {
                throw new Error(`behavior 只能是 generic / speech_recite / speech_read，收到：${f.behavior}`);
              }
              continue;
            }
            const stem = String(qo.stem ?? "").trim();
            const answer = String(qo.answer ?? "").trim();
            if (!stem || !answer) {
              throw new Error(
                `知识点「${kpName || kpIdRaw}」下的内联题需要 stem + answer（或给 questionId 引用已有题）`
              );
            }
          }
        }

        const replaceItems: Array<{ knowledgePointId: string; overview: string; questionIds: string[] }> = [];
        let created = 0;
        let linked = 0;
        let updated = 0;
        for (const it of items) {
          // 知识点解析：knowledgePointId（须属于本课）优先，否则按名称 getOrCreate（可带 detail）
          const kpIdRaw = typeof it.knowledgePointId === "string" ? it.knowledgePointId.trim() : "";
          const kpName = String(it.knowledgePoint ?? "").trim();
          const kpDetail = String(it.detail ?? "").trim();
          let kpId: string;
          let kpLabel: string;
          if (kpIdRaw) {
            const row = db
              .prepare("SELECT id, name FROM knowledge_points WHERE id = ? AND course_uuid = ?")
              .get(kpIdRaw, uuid) as { id: string; name: string } | undefined;
            if (!row) {
              throw new Error(`知识点不存在或不属于本课：${kpIdRaw}（先用 parent_library_course_content 核对 id）`);
            }
            kpId = kpIdRaw;
            kpLabel = row.name;
            if (kpDetail) getOrCreateKnowledgePoint(db, uuid, kpName || row.name, kpDetail);
          } else if (kpName) {
            const kp = getOrCreateKnowledgePoint(db, uuid, kpName, kpDetail);
            kpId = kp.id;
            kpLabel = kp.name;
          } else {
            throw new Error("每个 item 需要 knowledgePoint（知识点名称）或 knowledgePointId");
          }

          const qs = Array.isArray(it.questions) ? it.questions : [];
          const qids: string[] = [];
          for (const qo of qs) {
            const refId = typeof qo.questionId === "string" ? qo.questionId.trim() : "";
            if (refId) {
              if (!getQuestion(db, refId)) {
                throw new Error(`题库题不存在：${refId}（可用 parent_library_course_content 拿正确 id）`);
              }
              const f = inlineFields(qo);
              const hasInline = Object.values(f).some((v) => v !== undefined);
              if (hasInline) {
                // questionId + 内联字段 = 更新该题：只覆盖给出的字段，其余保留原值（saveQuestion 全字段覆盖，必须先读现值合并）
                if (f.behavior != null && !VALID_BEHAVIORS.includes(f.behavior)) {
                  throw new Error(`behavior 只能是 generic / speech_recite / speech_read，收到：${f.behavior}`);
                }
                const cur = getQuestion(db, refId)!;
                saveQuestion(db, {
                  id: refId,
                  stem: f.stem ?? cur.stem,
                  answer: f.answer ?? cur.answer,
                  scoring: f.scoring !== undefined ? f.scoring : cur.scoring,
                  pointMax: f.pointMax ?? (Number(cur.pointMax) || 10),
                  behavior: f.behavior ?? cur.behavior,
                  note: f.note !== undefined ? f.note : cur.note,
                  knowledgeSummary: f.knowledgeSummary !== undefined ? f.knowledgeSummary : cur.knowledgeSummary,
                  // options 未给出传 undefined → saveQuestion 保留库里原 options
                  options: f.options,
                });
                updated++;
              } else {
                linked++;
              }
              qids.push(refId);
              continue;
            }
            const stem = String(qo.stem ?? "").trim();
            const answer = String(qo.answer ?? "").trim();
            if (!stem || !answer) {
              throw new Error(`知识点「${kpLabel}」下的内联题需要 stem + answer（或给 questionId 引用已有题）`);
            }
            const nid = saveQuestion(db, {
              stem,
              answer,
              scoring: qo.scoring != null ? String(qo.scoring) : null,
              pointMax: Number(qo.pointMax) || 10,
              behavior: String(qo.behavior || "generic"),
              note: qo.note != null ? String(qo.note) : "",
              knowledgeSummary: qo.knowledgeSummary != null ? String(qo.knowledgeSummary) : kpLabel,
              options: Array.isArray(qo.options) ? qo.options : undefined,
            });
            qids.push(nid);
            created++;
          }
          replaceItems.push({ knowledgePointId: kpId, overview: String(it.overview ?? ""), questionIds: qids });
        }

        replaceCourseContent(db, uuid, replaceItems);
        appendParentActivityLog(
          ctx,
          `写入课程考核内容「${title}」（${topic}）：${replaceItems.length} 个知识点、新建 ${created} 题、更新 ${updated} 题、引用 ${linked} 题`
        );

        const after = listCourseContent(db, uuid);
        const countQ = (c: CourseContent) => c.items.reduce((n, x) => n + x.questions.length, 0);
        const pairSet = (c: CourseContent) =>
          new Set(c.items.flatMap((x) => x.questions.map((q) => `${x.knowledgePointId}|${q.id}`)));
        const beforePairs = pairSet(before);
        const afterPairs = pairSet(after);
        const droppedMounts = [...beforePairs].filter((p) => !afterPairs.has(p));
        const afterKpIds = new Set(after.items.map((x) => x.knowledgePointId));
        const droppedKpNames = before.items.filter((x) => !afterKpIds.has(x.knowledgePointId)).map((x) => x.knowledgePointName);

        let msg =
          `已写入课程「${title}」（${topic}）：提交 ${replaceItems.length} 个知识点｜新建题 ${created} 道｜更新题 ${updated} 道｜引用已有题 ${linked} 道。\n` +
          `本课挂载变化：${before.items.length} 个知识点 / ${countQ(before)} 道题 → ${after.items.length} 个知识点 / ${countQ(after)} 道题` +
          `（未挂题的知识点不产生挂载行）。`;
        if (updated > 0) {
          msg += `\n\nℹ️ 本次更新了 ${updated} 道题库题本身（含题干/答案等）。这是全局修改：同一道题若还挂在其他课程/知识点下，改动会同步生效。`;
        }
        if (droppedMounts.length || droppedKpNames.length) {
          const parts: string[] = [];
          if (droppedKpNames.length) parts.push(`知识点挂载被移除：${droppedKpNames.join("、")}`);
          if (droppedMounts.length) parts.push(`另有 ${droppedMounts.length} 条「知识点↔题」挂载被移除`);
          msg +=
            `\n\n⚠️ 本次替换移除了本课原有内容（${parts.join("；")}）。` +
            `如果这不是本意，请立即用本工具把**完整**内容重写一遍（题仍在题库中，可用 questionId 重新挂回）。`;
        }
        return ok(msg);
      } finally {
        db.close();
      }
    },
  });

  const imageTool = defineTool({
    name: "parent_read_image",
    label: "理解图片内容",
    description:
      "用视觉模型读一张图片（教材扫描页/截图/图示/家长聊天里发的作业图），返回画面描述与图中文字。\n\n" +
      "**何时调用**：需要知道图片/扫描件里到底写了什么（起草教学文案前常需要）。\n" +
      "**path 两种来源**：\n" +
      "① 材料库相对路径（如 lunyu/media/page1.jpg，来自 parent_list_materials）；\n" +
      "② **家长聊天里上传的图片**——把消息里 `【附件图片：文件名|引用】` 中的**引用值原样填入**" +
      "（形如 `files/<id>`、裸 id 或 `parents/<pid>/uploads/xxx.jpg`）。不要自己拼路径、也不要换成 materials/ 前缀。\n" +
      "图片需是 png/jpg/webp/gif/bmp 等常见格式；非图片附件用 parent_read_upload。",
    parameters: Type.Object({
      path: Type.String({ description: "图片引用：材料相对路径，或聊天附件标记里的引用值（原样填入）" }),
      question: Type.Optional(Type.String({ description: "想让模型重点回答的问题（缺省=描述并识别全部文字）" })),
    }),
    execute: async (_id: string, params: { path: string; question?: string }) => {
      let abs: string;
      // ISSUE-124：材料真源、家长聊天附件（服务端 files 通道 / 客户端本机上传区）都在沙箱内解析
      const rel = String(params.path ?? "").trim();
      if (looksLikeAttachmentRef(rel)) {
        try {
          abs = resolveAttachmentRef(deps, rel).abs;
        } catch (err) {
          if (err instanceof UploadRefError && err.kind === "missing-remote") return ok(missingRemoteHint(err, rel));
          throw err;
        }
      } else {
        abs = materialAbsPath(ctx, rel);
      }
      if (!fs.existsSync(abs)) throw new Error(`图片不存在：${params.path}`);
      const mime = imageMimeFromExt(abs);
      if (!mime.startsWith("image/")) throw new Error(`${params.path} 不是图片（识别为 ${mime}）`);
      const stat = fs.statSync(abs);
      if (stat.size > 8 * 1024 * 1024) throw new Error(`图片过大（${stat.size} 字节 > 8MB）`);
      const text = await describeImageViaVision(
        {
          dataDir: deps.dataDir,
          parentId: deps.parentId,
          auth: deps.auth,
          appSettings: deps.appSettings,
          agentDir: deps.agentDir,
        },
        { type: "image", mimeType: mime, data: fs.readFileSync(abs).toString("base64") },
        params.question
      );
      return ok(`【${params.path}】\n${text}`);
    },
  });

  // ISSUE-124：读家长聊天里上传的**非图片**附件（txt/md/csv/json…），补齐「附件标记只能读图」的缺口
  const uploadTool = defineTool({
    name: "parent_read_upload",
    label: "读取聊天附件（非图片）",
    description:
      "读取家长在聊天框上传的**非图片附件**的内容（txt / md / csv / json / xml / html 等文本类返回正文，超 200KB 截断）。\n\n" +
      "**何时调用**：家长消息里出现 `【附件文件：文件名|引用】` 且你需要看文件里写了什么时。\n" +
      "**ref 参数**：把标记中的**引用值原样填入**（形如 `files/<id>`、裸 id 或 `parents/<pid>/uploads/文件名`）；" +
      "不要自己拼路径、也不要换成 materials/ 前缀。\n" +
      "图片请用 parent_read_image（有视觉模型能识别图中文字）；pdf/word 等二进制只返回元数据——" +
      "若家长发来的是这类文件，请请他改用文字或截图说明。",
    parameters: Type.Object({
      ref: Type.String({ description: "附件标记里的引用值（原样填入）" }),
    }),
    execute: async (_id: string, params: { ref: string }) => {
      const raw = String(params.ref ?? "").trim();
      if (!looksLikeAttachmentRef(raw)) {
        return ok(
          `「${raw}」看起来不是聊天附件引用。附件引用长这样：` +
            "`files/<id>`、裸 id（如 `0f3a…`）或 `parents/<家长id>/uploads/文件名`——" +
            "请把消息里 `【附件文件：…|…】` 的**后半段**原样传进来。"
        );
      }
      let abs: string;
      try {
        abs = resolveAttachmentRef(deps, raw).abs;
      } catch (err) {
        if (err instanceof UploadRefError && err.kind === "missing-remote") return ok(missingRemoteHint(err, raw));
        throw err;
      }
      const stat = fs.statSync(abs);
      const name = path.basename(abs);
      const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
      if (isImageAttachment(name)) {
        return ok(`${name} 是图片（${stat.size} 字节），请改用 parent_read_image 读它（能识别图中文字）。`);
      }
      if (!isTextAttachment(name)) {
        return ok(
          `${name}：${imageMimeFromExt(name)} 类型（${stat.size} 字节 ≈ ${sizeMb}MB），不是文本类附件，无法直接返回正文。\n` +
            `请如实告诉家长：这类文件（pdf/word/压缩包等）服务端读不了内容，请改用文字描述，或截图后用图片方式发送。`
        );
      }
      if (stat.size > 200 * 1024) {
        return ok(
          `${name}（${stat.size} 字节）超过 200KB，只读前 200KB：\n\n${readTextHead(abs, 200 * 1024)}\n\n（已截断）`
        );
      }
      return ok(`${name}（${stat.size} 字节）：\n\n${readTextHead(abs, stat.size)}`);
    },
  });

  // ISSUE-102：读取孩子对话逐字稿（只读）——让家长 agent 能回答「孩子具体说了什么/学到哪」
  const convoTool = defineTool({
    name: "parent_read_child_conversation",
    label: "读取孩子对话逐字稿（只读）",
    description:
      "读取孩子与 AI 伙伴的**原始对话逐字稿**（只读，无法修改孩子会话）。\n\n" +
      "**何时调用**：需要了解孩子**具体说了什么**时——哪一课卡住了、哪个知识点没懂、提过什么困惑、" +
      "学习过程与情绪如何。只要概括性进度，用 parent_study_plan_list / 家长端每日记录即可，不必读逐字稿。\n" +
      "**参数**：`child` 孩子姓名（不确定先 parent_list_children）；`date` 可选，默认今天，" +
      "支持 `YYYY-MM-DD`、`all`（最近若干天，由 `days` 指定，默认 3 天、最多 7 天）或口语「今天/昨天/前天」。\n" +
      "**边界（务必遵守）**：只能读**自己名下**孩子的记录（系统按归属校验）；" +
      "读取内容仅用于家长了解孩子学习情况——向家长汇报时**概括要点**，" +
      "不要大段复述逐字稿原文；本工具是只读的，不提供任何改写孩子会话的能力。",
    parameters: Type.Object({
      child: Type.String({ description: "孩子姓名" }),
      date: Type.Optional(
        Type.String({ description: "YYYY-MM-DD 或 all（最近若干天）；缺省=今天" })
      ),
      days: Type.Optional(Type.Number({ description: "date=all 时读最近多少天（默认 3，最大 7）" })),
    }),
    execute: async (_id: string, params: { child: string; date?: string; days?: number }) => {
      const child = resolveConvoChild(deps.db, deps.parentId, params.child);
      // 与家长端「对话回顾」页同链路：先把 agent-sessions 新增消息增量索引进 session_messages，再查
      indexAgentSessionsIntoDb(deps.db, deps.dataDir, deps.parentId, child.id);

      const raw = normalizeDateParam(String(params.date ?? ""));
      let dates: string[];
      if (!raw || raw === "today") {
        dates = [todayLocal()];
      } else if (raw === "all") {
        const n = Math.min(7, Math.max(1, Math.round(Number(params.days ?? 3)) || 3));
        const all = listSessionDates(deps.db, child.id);
        if (!all.length) {
          return ok(`「${child.name}」还没有任何对话记录（服务端 agent-sessions 中没有该孩子的消息）。`);
        }
        dates = all.slice(0, n).map((d) => d.date);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        dates = [raw];
      } else {
        throw new Error(
          `date 只能是 YYYY-MM-DD、all，或「今天/昨天/前天」（收到「${raw}」）——省略 date 即读今天`
        );
      }

      const MAX_TOTAL = 16000; // 总字符上限：防止「读全部历史」灌爆上下文
      const MAX_MSG = 600; // 单条上限
      const blocks: string[] = [];
      let total = 0;
      let truncated = false;
      let msgCount = 0;
      for (const date of dates) {
        const msgs = querySessionMessages(deps.db, child.id, date);
        msgCount += msgs.length;
        if (!msgs.length) {
          blocks.push(`【${date}】无对话记录`);
          continue;
        }
        const lines: string[] = [`【${date}】共 ${msgs.length} 条`];
        for (const m of msgs) {
          const who = m.role === "user" ? child.name : child.aiName;
          let text = String(m.text ?? "").trim();
          if (text.length > MAX_MSG) text = `${text.slice(0, MAX_MSG)}…（本条已截断）`;
          const names = [...new Set((m.toolCalls ?? []).map((t) => t.name))].filter(Boolean);
          const line = `${who}：${text}${names.length ? ` （调用：${names.join("、")}）` : ""}`;
          if (total + line.length > MAX_TOTAL) {
            truncated = true;
            break;
          }
          total += line.length;
          lines.push(line);
        }
        blocks.push(lines.join("\n"));
        if (truncated) break;
      }

      if (!msgCount) {
        const avail = listSessionDates(deps.db, child.id)
          .slice(0, 10)
          .map((d) => `${d.date}（${d.count} 条）`)
          .join("、");
        return ok(
          `「${child.name}」在 ${dates.join("、")} 没有对话记录。` +
            (avail ? `\n有记录的日期：${avail}（可用 date=all 或指定日期读取）` : `\n（该孩子还没有任何会话记录）`)
        );
      }
      const header = `「${child.name}」的对话逐字稿（${dates.join("、")}；对孩子说话的是 AI 伙伴「${child.aiName}」）：`;
      const footer = truncated ? "\n\n…（内容过长已截断；可指定单个日期或用 date=all + days 缩小范围）" : "";
      return ok(`${header}\n${blocks.join("\n\n")}${footer}`);
    },
  });

  const logTool = defineTool({
    name: "log_activity",
    label: "记录家长操作",
    description:
      "把本次改动追加记录到家长操作记录（activity-log.md，纯追加）。\n\n" +
      "**何时调用**：用 read/write 之类的通用工具改了工作区内容之后调用一次；\n" +
      "parent_put_material / parent_delete_material / parent_move_material **已自动记录**，无需再调。",
    parameters: Type.Object({
      entry: Type.String({ description: "一句话描述做了什么（如「归并 lunyu 下散落的 3 个 html」）" }),
    }),
    execute: async (_id: string, params: { entry: string }) => {
      if (!params.entry?.trim()) throw new Error("entry 不能为空");
      const file = appendParentActivityLog(ctx, params.entry.trim());
      return ok(`已记录：${params.entry.trim()}（${path.basename(file)}）`);
    },
  });

  // ===== 受控数据通道（ISSUE-105 方案 B P1）：单表简单读写走注册表，复杂编排仍走上面的专用工具 =====
  const dbDescribeTool = buildDbDescribeTool(deps);
  const dbReadTool = buildDbReadTool(deps);
  const dbWriteTool = buildDbWriteTool(deps);

  return [
    listTool,
    readTool,
    deleteTool,
    moveTool,
    putTool,
    topicsTool,
    coursesTool,
    upsertTopicTool,
    upsertCourseTool,
    renameCourseTool,
    syncCoursesTool,
    courseContentTool,
    upsertCourseContentTool,
    dbDescribeTool,
    dbReadTool,
    dbWriteTool,
    imageTool,
    uploadTool,
    convoTool,
    logTool,
    // 编程 agent（P3 上移）：家长 agent 描述需求 → 服务端编程 agent 产出 HTML 资料到真源
    createProgrammingTool({ dataDir: deps.dataDir, db: deps.db, parentId: deps.parentId }, { scope: "parent" }),
  ];
}

// ==================== 受控数据通道：可复用 builder（家长主助手 + 数据管理 agent 共用） ====================

/** 向量兜底的上下文（ISSUE-111）：主库读 settings + 家长身份定位库文件 */
function embCtx(deps: ParentToolDeps): EmbedContext {
  return { db: deps.db, dataDir: deps.dataDir, parentId: deps.parentId };
}

/** 写成功后标记嵌入队列（触及登记列才生效；fire-and-forget）。 */
function markEmbeddedWrite(deps: ParentToolDeps, table: string, pkVals: Array<null | number | bigint | string>): void {
  if (embeddedColumn(table)) markStale(embCtx(deps), table, pkVals);
}

function buildDbDescribeTool(deps: ParentToolDeps) {
  const parentSpecs = parentLibTableRegistry();
  const parentPaths = parentLibPaths();
  const childReadSpecs = childKbReadableRegistry();
  const childWriteSpecs = childKbWritableRegistry();

  // Tier 2 namespace 注册行存家长库（会话元数据已常驻 prompt；describe 只兜底单实体详情）。
  // 数据管理 agent 需要看到自己提交的待确认草案 → includePending。
  const nsFor = (scope: "parent" | "child"): NamespaceRow[] => {
    try {
      const pdb = openParentLib(deps.dataDir, deps.parentId);
      try {
        return loadNamespaces(pdb, scope, { includePending: true });
      } finally {
        pdb.close();
      }
    } catch {
      return [];
    }
  };

  return defineTool({
    name: "parent_db_describe",
    label: "查看数据表/路径结构",
    description:
      "查登记表的列结构、必填、引用校验、路径详情与 Tier 2 灵活实体字段。\n" +
      "系统提示里已带**全部表/路径/ns 清单**（读操作通常不需要本工具）；本工具用于写操作前确认必填/引用校验/行数熔断、查枚举值域、看 Tier 2 实体字段详情。\n" +
      "传 table=表名或 ns:名称 返回单表详情；传 path=路径名 返回该路径的可过滤/可返回列；不传返回全部清单。\n" +
      "复杂流程（整课替换挂载、题目+知识点一起建）仍请用 parent_upsert_course_content。",
    parameters: Type.Object({
      table: Type.Optional(Type.String({ description: "表名或 ns:灵活实体名（可省略=列出全部）" })),
      path: Type.Optional(Type.String({ description: "路径名（如 topic_questions）；传了返回该路径详情" })),
    }),
    execute: async (_id: string, params: { table?: string; path?: string }) => {
      const table = params.table?.trim() || undefined;
      const pathName = params.path?.trim() || undefined;
      if (pathName) {
        const p = parentPaths.find((x) => x.name === pathName);
        if (!p) return ok(`没有登记名为「${pathName}」的路径。可用：${parentPaths.map((x) => x.name).join("、")}`);
        return ok(
          [
            `## 路径 ${p.name}（${p.label}）`,
            p.desc,
            `主体表 ${p.select}；跳链：${p.hops.map((h) => `${h.optional ? "LEFT " : ""}JOIN ${h.table}`).join(" → ")}`,
            `可过滤列：${p.filterable.join("、")}`,
            `可返回列：${p.returns.join("、")}`,
            `单次行数上限：${p.rowLimit}`,
          ].join("\n")
        );
      }
      if (table) {
        if (table.startsWith("ns:")) {
          const name = table.slice(3);
          const ns = nsFor("parent").find((n) => n.ns === name) ?? nsFor("child").find((n) => n.ns === name);
          if (ns) return ok(describeNamespace(ns));
          return ok(`没有名为 ${table} 的灵活实体（当前可用清单见系统提示元数据块）。`);
        }
        const p = parentPaths.find((x) => x.name === table);
        if (p) {
          return ok(
            [
              `## 路径 ${p.name}（${p.label}）`,
              p.desc,
              `主体表 ${p.select}；跳链：${p.hops.map((h) => `${h.optional ? "LEFT " : ""}JOIN ${h.table}`).join(" → ")}`,
              `可过滤列：${p.filterable.join("、")}`,
              `可返回列：${p.returns.join("、")}`,
              `单次行数上限：${p.rowLimit}`,
            ].join("\n")
          );
        }
        const w = parentSpecs.find((s) => s.table === table);
        if (w) return ok(describeTables(parentSpecs, table));
        const r = childReadSpecs.find((s) => s.table === table);
        if (r) return ok(describeChildTables(childReadSpecs, childWriteSpecs, table));
        return ok(
          `没有登记名为「${table}」的表。\n家长库表：${parentSpecs.map((s) => s.table).join("、")}\n` +
            `孩子库表（需传 child=孩子名）：${childReadSpecs.map((s) => s.table).join("、")}`
        );
      }
      const parentList = parentSpecs
        .map((s) => `- ${s.table}（${s.label}）：${s.desc}（允许 ${s.ops.join("/") || "只读"}）`)
        .join("\n");
      const childList = childReadSpecs.map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n");
      const pathList = parentPaths.map((p) => `- ${p.name}（${p.label}）：${p.desc}`).join("\n");
      const nsParent = nsFor("parent");
      const nsChild = nsFor("child");
      const nsList = [
        ...nsParent.map((n) => `- ns:${n.ns}（家长库${n.status === "pending" ? "，待家长确认" : ""}）`),
        ...nsChild.map((n) => `- ns:${n.ns}（孩子库，只读${n.status === "pending" ? "，待家长确认" : ""}）`),
      ].join("\n");
      return ok(
        `【家长库 parent.sqlite】用 parent_db_read / parent_db_write（不传 child）操作：\n${parentList}\n\n` +
          `【家长库命名路径】parent_db_read 传 path=名称（多跳关联一次查询）：\n${pathList}\n\n` +
          `【孩子库 kb（每个孩子一个库）】用 parent_db_read / parent_db_write 传 child=孩子名 操作；` +
          `除 daily_entries、redemption_requests 可写外，其余只读：\n${childList}\n\n` +
          (nsList ? `【Tier 2 灵活实体】parent_db_read 的 table 用 ns:名称：\n${nsList}\n\n` : "") +
          `传 table / path 查详情；例如 parent_db_read({path:'topic_questions', where:{'courses.topic':'lunyu'}})。`
      );
    },
  });
}

function buildDbReadTool(deps: ParentToolDeps) {
  const parentReadSpecs = parentReadableRegistry();
  const parentPaths = parentLibPaths();
  const childReadSpecs = childKbReadableRegistry();
  return defineTool({
    name: "parent_db_read",
    label: "通用查询数据表/路径（只读）",
    description:
      "对受控数据通道登记的表做**只读**查询。表清单/列清单/路径清单已在本会话系统提示的元数据块里，**读操作不需要先 describe**。\n" +
      "不传 child=查家长内容库；传 child=孩子名/id=查该**孩子库**；table 支持 ns:前缀的灵活实体（Tier 2）。\n" +
      "传 path=路径名 可一次拿到多跳关联结果（如 topic_questions=某主题下全部题），与 table 二选一（path 仅家长库，与 child 互斥）。\n" +
      "countOnly=true 只返回命中行数（「有没有/有几条」用这个，别拉行）。要拉全量大列表时用 orderBy + limit + offset 翻页（单次最多 200 行）。" +
      "等值 where + 列裁剪 + 排序 + 分页全部参数化在库内执行；返回体超字符预算会自动截断并提示。\n" +
      "（只读工具——改数据请用 parent_db_write；读孩子对话逐字稿请用 parent_read_child_conversation）",
    parameters: Type.Object({
      table: Type.Optional(
        Type.String({ description: "登记的表名或 ns:灵活实体名（清单见系统提示；与 path 二选一；孩子库表配合 child）" })
      ),
      path: Type.Optional(Type.String({ description: "路径名（如 topic_questions）；仅家长库，与 table/child 互斥" })),
      child: Type.Optional(
        Type.String({ description: "孩子姓名或 id；传了就查该孩子库（kb），不传查家长库（parent.sqlite）" })
      ),
      columns: Type.Optional(Type.Array(Type.String(), { description: "只返回的列（缺省=全部可读列）" })),
      where: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "等值过滤条件 {列: 值}；路径查询用 表.列 全限定名" })
      ),
      orderBy: Type.Optional(Type.String({ description: "排序列（须为可读列）" })),
      orderDesc: Type.Optional(Type.Boolean({ description: "true=降序（缺省升序）" })),
      limit: Type.Optional(Type.Number({ description: "单次最多返回行数（缺省 50，最大 200）" })),
      offset: Type.Optional(Type.Number({ description: "跳过前 N 行（配合 limit/orderBy 分页拉全量；分页必须带 orderBy）" })),
      countOnly: Type.Optional(Type.Boolean({ description: "true=只返回命中行数" })),
    }),
    execute: async (
      _id: string,
      params: {
        table?: string;
        path?: string;
        child?: string;
        columns?: string[];
        where?: Record<string, unknown>;
        orderBy?: string;
        orderDesc?: boolean;
        limit?: number;
        offset?: number;
        countOnly?: boolean;
      }
    ) => {
      const base = {
        columns: params.columns,
        where: params.where,
        orderBy: params.orderBy,
        orderDesc: params.orderDesc,
        limit: params.limit,
        countOnly: params.countOnly,
      };
      if (params.path) {
        if (params.child) return ok("path 查询仅支持家长库，与 child 参数互斥（去掉 child 或改用 table）。");
        if (params.table) return ok("path 与 table 二选一，不要同时传。");
        const db = openParentLib(deps.dataDir, deps.parentId);
        try {
          const r = executePathRead(db, parentPaths, { path: params.path, ...base });
          return ok(r.text);
        } finally {
          db.close();
        }
      }
      if (!params.table) return ok("table 与 path 至少传一个。");
      if (params.child) {
        const kid = resolveConvoChild(deps.db, deps.parentId, params.child);
        if (params.table.startsWith("ns:")) {
          // 孩子侧 Tier 2 一律只读（安全红线 5）；ns 注册行在家长库，scope=child
          let nsRow: NamespaceRow | undefined;
          const pdb = openParentLib(deps.dataDir, deps.parentId);
          try {
            nsRow = loadNamespaces(pdb, "child").find((n) => `ns:${n.ns}` === params.table);
          } finally {
            pdb.close();
          }
          if (!nsRow) return ok(`没有名为 ${params.table} 的灵活实体（清单见系统提示）。`);
          const db = openKb(deps.dataDir, deps.parentId, kid.id);
          try {
            const r = tier2Read(db, nsRow, base);
            return ok(r.text);
          } finally {
            db.close();
          }
        }
        const db = openKb(deps.dataDir, deps.parentId, kid.id);
        try {
          const r = executeRead(db, childReadSpecs, { table: params.table, ...base });
          return ok(r.text);
        } finally {
          db.close();
        }
      }
      if (params.table.startsWith("ns:")) {
        let nsRow: NamespaceRow | undefined;
        const pdb = openParentLib(deps.dataDir, deps.parentId);
        try {
          nsRow = loadNamespaces(pdb, "parent").find((n) => `ns:${n.ns}` === params.table);
        } finally {
          pdb.close();
        }
        if (!nsRow) return ok(`没有名为 ${params.table} 的灵活实体（清单见系统提示）。`);
        const db = openParentLib(deps.dataDir, deps.parentId);
        try {
          const r = tier2Read(db, nsRow, base);
          return ok(r.text);
        } finally {
          db.close();
        }
      }
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const r = executeRead(db, parentReadSpecs, { table: params.table, ...base });
        // ISSUE-111：登记列精确落空 → 附向量候选（只提示不代入；未配置时静默跳过）
        let hint: string | null = null;
        if (r.ok && r.missedEmbedded?.length) {
          const m = r.missedEmbedded[0];
          hint = await candidatesHintText(embCtx(deps), m.table, m.value, { column: m.column });
        }
        return ok(hint ? `${r.text}\n\n${hint}` : r.text);
      } finally {
        db.close();
      }
    },
  });
}

function buildDbWriteTool(deps: ParentToolDeps) {
  const dbSpecs = parentLibTableRegistry();
  const childSpecs = childKbWritableRegistry();
  const ctx: MaterialCtx = { db: deps.db, dataDir: deps.dataDir, parentId: deps.parentId };
  return defineTool({
    name: "parent_db_write",
    label: "受控写数据表（单表增删改）",
    description:
      "对登记表执行受控 insert/update/delete。不传 child=写家长内容库；传 child=孩子名/id=写该**孩子库**（仅 daily_entries、redemption_requests 白名单表）。\n" +
      "table 支持 ns:前缀的灵活实体（Tier 2，仅家长库；孩子侧 ns 只读）。\n" +
      "列白名单 + 逐列校验 + 行数熔断 + 事务 + 审计，update/delete 必须带 where 等值条件（先预览影响行数）。" +
      "写入敏感列（answer/options 等）后返回提示，必须向家长逐条复述。\n" +
      "**不要**用它替代 parent_upsert_course_content 的整课替换语义；孩子库考核/积分/奖励规则等不开放写。",
    parameters: Type.Object({
      table: Type.String({ description: "登记的表名或 ns:灵活实体名（清单见系统提示；孩子库表需配合 child 参数）" }),
      child: Type.Optional(
        Type.String({ description: "孩子姓名或 id；传了就写该孩子库（kb），不传写家长库。孩子库仅 daily_entries/redemption_requests 可写" })
      ),
      op: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")], {
        description: "操作类型",
      }),
      rows: Type.Optional(
        Type.Union([Type.Array(Type.Record(Type.String(), Type.Unknown())), Type.Record(Type.String(), Type.Unknown())], {
          description:
            "insert=行数组 [{列:值},…]（单行也可直接传 {列:值} 对象）；update=列值对象 {列: 新值}（兼容 [{列:值}] 单元素数组）",
        })
      ),
      where: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "update/delete 必填：等值条件 {列: 值}，全部须为登记列",
        })
      ),
    }),
    execute: async (
      _id: string,
      params: {
        table: string;
        child?: string;
        op: "insert" | "update" | "delete";
        rows?: Array<Record<string, unknown>> | Record<string, unknown>;
        where?: Record<string, unknown>;
      }
    ) => {
      if (params.child) {
        const kid = resolveConvoChild(deps.db, deps.parentId, params.child);
        if (params.table.startsWith("ns:")) {
          return ok("孩子库的灵活实体（Tier 2）只读，不开放写（安全红线：孩子侧数据以读为主）。");
        }
        const db = openKb(deps.dataDir, deps.parentId, kid.id);
        try {
          // 兑换申请：child_id 强制为该孩子（执行器侧覆盖，agent 传什么都不生效）
          const force = params.table === "redemption_requests" ? { child_id: kid.id } : undefined;
          const req: WriteRequest = { table: params.table, op: params.op, rows: params.rows, where: params.where, force };
          const r = executeWrite(db, childSpecs, req);
          if (r.ok) {
            appendParentActivityLog(
              ctx,
              `受控写 ${params.op} ${params.table}（孩子 ${kid.name} 库）：${r.text.split("。")[0] || ""}`
            );
          }
          return ok(r.text);
        } finally {
          db.close();
        }
      }
      if (params.table.startsWith("ns:")) {
        // Tier 2 灵活实体写（家长库 entities 表；ns 注册行同库）
        const pdb = openParentLib(deps.dataDir, deps.parentId);
        try {
          const nsRow = loadNamespaces(pdb, "parent").find((n) => `ns:${n.ns}` === params.table);
          if (!nsRow) return ok(`没有名为 ${params.table} 的灵活实体（清单见系统提示）。`);
          const r = tier2Write(pdb, nsRow, { op: params.op, rows: params.rows, where: params.where });
          if (r.ok) {
            appendParentActivityLog(ctx, `受控写 ${params.op} ${params.table}（Tier 2）：${r.text.split("。")[0] || ""}`);
          }
          return ok(r.text);
        } finally {
          pdb.close();
        }
      }
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const req: WriteRequest = { table: params.table, op: params.op, rows: params.rows, where: params.where };
        const r = executeWrite(db, dbSpecs, req);
        if (r.ok) {
          appendParentActivityLog(
            ctx,
            `受控写 ${params.op} ${params.table}（db 通道）：${r.text.split("。")[0] || ""}`
          );
          // ISSUE-111：写触及登记列 → 异步重嵌入（fire-and-forget，不阻塞返回）
          if (embeddedColumn(params.table)) {
            const ec = embeddedColumn(params.table)!;
            // ISSUE-122：rows 现在可能是单行对象（insert 兼容形状）——统一成数组再取主键
            const insertRows = Array.isArray(params.rows) ? params.rows : params.rows ? [params.rows] : [];
            const sources: Array<Record<string, unknown>> =
              params.op === "insert" ? insertRows : [{ ...(params.where ?? {}) }];
            for (const src of sources) {
              const pkVals = ec.pkCols.map((c) => (src[c] ?? null) as null);
              if (pkVals.every((v) => v !== null)) markStale(embCtx(deps), params.table, pkVals);
            }
          }
        } else if (r.missedRef) {
          // ISSUE-111：引用落空 → 向量候选（只提示不代入）
          const hint = await candidatesHintText(embCtx(deps), r.missedRef.refTable, r.missedRef.value);
          if (hint) return ok(`${r.text}\n\n${hint}`);
        }
        return ok(r.text);
      } finally {
        db.close();
      }
    },
  });
}

/**
 * 设计器工具（F15b）：起草 Tier 2 自定义数据场景。只挂数据管理 agent（parent-data）——
 * 运行期家长主助手/孩子 agent 无此工具（安全红线 3：注册表是设计期产物）。
 * 产物是「待确认草案」：家长在「设置 → 自定义数据」确认后才生效，确认前任何 agent 不可见。
 */
function buildDefineNamespaceTool(deps: ParentToolDeps) {
  const ctx: MaterialCtx = { db: deps.db, dataDir: deps.dataDir, parentId: deps.parentId };
  return defineTool({
    name: "define_namespace",
    label: "起草自定义数据场景（待家长确认）",
    description:
      "为家长**新建**一类自定义数据（Tier 2 灵活实体），如习惯打卡、自定义练习记录、家庭读书清单等。零建表、确认后即时生效。\n" +
      "流程：听家长描述场景 → 你设计字段（每个字段必须有清晰的中文说明）→ 调本工具提交**草案** → 告诉家长去「设置 → 自定义数据」点确认。\n" +
      "设计约定：\\n" +
      "- 字段名用小写英文（date/done/minutes 这类），说明用中文；场景里「关联到某门课」就加一个 ref 字段指向 courses.uuid；\\n" +
      "- 家长说「按 XX 筛选/统计」的字段要设 filterable；\\n" +
      "- 只能新建；已有场景的调整（加字段/停用）不归你管，引导家长去设置页。",
    parameters: Type.Object({
      ns: Type.String({ description: "场景名：小写字母开头，3~40 位小写字母/数字/下划线（如 piano_practice）" }),
      scope: Type.Union([Type.Literal("parent"), Type.Literal("child")], {
        description: "数据归属：parent=全家共享一份；child=每个孩子各记各的",
      }),
      label: Type.String({ description: "场景中文名（如 练琴打卡），展示给家长看" }),
      fields: Type.Array(
        Type.Object({
          name: Type.String({ description: "字段名（小写英文标识符）" }),
          kind: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("enum")], {
            description: "类型；enum 需给 values",
          }),
          desc: Type.String({ description: "字段中文说明（agent 与家长都靠它理解语义，必填）" }),
          required: Type.Optional(Type.Boolean({ description: "true=记录时必填" })),
          filterable: Type.Optional(Type.Boolean({ description: "true=可作为筛选/统计条件" })),
          enumValues: Type.Optional(Type.Array(Type.String(), { description: "kind=enum 时的取值列表" })),
          refTable: Type.Optional(Type.String({ description: "引用校验：目标表（如 courses），配合 refColumn" })),
          refColumn: Type.Optional(Type.String({ description: "引用校验：目标列（如 uuid）" })),
        }),
        { description: "字段定义（1~20 个）" }
      ),
    }),
    execute: async (
      _id: string,
      params: {
        ns: string;
        scope: "parent" | "child";
        label: string;
        fields: Array<{
          name: string;
          kind: "string" | "number" | "enum";
          desc: string;
          required?: boolean;
          filterable?: boolean;
          enumValues?: string[];
          refTable?: string;
          refColumn?: string;
        }>;
      }
    ) => {
      if (!params.fields?.length) throw new Error("define_namespace 需要至少一个字段（fields）");
      if (params.fields.length > 20) throw new Error("字段最多 20 个——场景拆细不如先跑起来再说");
      const columns: Record<string, ColumnSpec> = {};
      const insertRequired: string[] = [];
      const filterable: string[] = [];
      const refs: Array<{ column: string; refTable: string; refColumn: string; desc?: string }> = [];
      for (const f of params.fields) {
        columns[f.name] = {
          kind: f.kind,
          desc: f.desc,
          notEmpty: f.required ? true : false,
          ...(f.kind === "enum" ? { enumValues: f.enumValues ?? [] } : {}),
        };
        if (f.required) insertRequired.push(f.name);
        if (f.filterable) filterable.push(f.name);
        if (f.refTable && f.refColumn) {
          refs.push({ column: f.name, refTable: f.refTable, refColumn: f.refColumn, desc: `须存在于 ${f.refTable}.${f.refColumn}` });
        }
      }
      const pdb = openParentLib(deps.dataDir, deps.parentId);
      try {
        const r = defineNamespace(
          pdb,
          parentLibTableRegistry(),
          { ns: params.ns, scope: params.scope, label: params.label, spec: { columns, insertRequired, filterable, refs } },
          { pending: true }
        );
        if (r.ok) appendParentActivityLog(ctx, `提交自定义数据场景草案 ns:${params.ns}（待家长确认）`);
        return ok(r.text);
      } finally {
        pdb.close();
      }
    },
  });
}

/**
 * 数据管理 agent 工具集（独立 agent，parent-data 会话专用）：只暴露「统一数据 API」三件套
 * + 设计器工具 + 日期工具，不携带资料/对话/编程等家长主助手工具——与运营类家长 agent 隔离。
 * 覆盖家长内容库全部 6 张表（topics/courses/tags/question_bank/knowledge_points/course_knowledge_questions）。
 */
export function createDataAgentTools(deps: ParentToolDeps) {
  return [buildDbDescribeTool(deps), buildDbReadTool(deps), buildDbWriteTool(deps), buildDefineNamespaceTool(deps)];
}

export const DATA_AGENT_TOOL_NAMES = [
  "parent_db_describe",
  "parent_db_read",
  "parent_db_write",
  "define_namespace",
  "get_date",
];

export const PARENT_AGENT_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "ls",
  "parent_list_materials",
  "parent_read_material",
  "parent_delete_material",
  "parent_move_material",
  "parent_put_material",
  "parent_library_topics",
  "parent_library_courses",
  "parent_upsert_topic",
  "parent_upsert_course",
  "parent_rename_course",
  "parent_sync_courses_to_child",
  "parent_library_course_content",
  "parent_upsert_course_content",
  "parent_db_describe",
  "parent_db_read",
  "parent_db_write",
  "parent_read_image",
  "parent_read_upload",
  "parent_read_child_conversation",
  "parent_build_material",
  "log_activity",
  "get_date",
];
