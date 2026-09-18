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
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { resolveWithin } from "@pi/agent-core";
import { openParentLib } from "../db/parent-lib.js";
import { openKb } from "../db/kb.js";
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
  type WriteRequest,
} from "./db-channel.js";
import { loadNamespaces, tier2Read, tier2Write, describeNamespace, type NamespaceRow } from "./tier2.js";

export interface ParentToolDeps extends MaterialCtx {
  /** 家长 agent 工作区（临时产出） */
  workspaceDir: string;
  /** agent 私有目录 */
  agentDir: string;
  auth: Record<string, unknown>;
  appSettings?: Record<string, unknown>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

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
        db.prepare(
          `INSERT INTO courses (
             topic, title, sort_order,
             material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        return ok(`已落库课程「${params.title}」（${params.topic}）。`);
      } finally {
        db.close();
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
          return ok(
            `课程不存在：${params.topic}/${params.title}（先用 parent_library_courses 核对该主题下的课程名）`
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
        if (!uuid) throw new Error(`课程不存在：${topic}/${title}（先用 parent_upsert_course 建课）`);
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
      "用视觉模型读一张图片（教材扫描页/截图/图示），返回画面描述与图中文字。\n\n" +
      "**何时调用**：需要知道图片/扫描件里到底写了什么（起草教学文案前常需要）。\n" +
      "参数 path 用材料相对路径（如 lunyu/media/page1.jpg）；图片需是 png/jpg/webp/gif/bmp 等常见格式。",
    parameters: Type.Object({
      path: Type.String({ description: "图片的材料相对路径" }),
      question: Type.Optional(Type.String({ description: "想让模型重点回答的问题（缺省=描述并识别全部文字）" })),
    }),
    execute: async (_id: string, params: { path: string; question?: string }) => {
      let abs: string;
      // 材料真源优先；也允许读家长上传目录（uploads/ 前缀），二者都在沙箱内解析
      const rel = String(params.path ?? "").trim();
      if (rel.startsWith("uploads/") || rel.startsWith("files/")) {
        abs = resolveWithin(deps.dataDir, rel.replace(/^files\//, "files/"));
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
    courseContentTool,
    upsertCourseContentTool,
    dbDescribeTool,
    dbReadTool,
    dbWriteTool,
    imageTool,
    convoTool,
    logTool,
    // 编程 agent（P3 上移）：家长 agent 描述需求 → 服务端编程 agent 产出 HTML 资料到真源
    createProgrammingTool({ dataDir: deps.dataDir, db: deps.db, parentId: deps.parentId }, { scope: "parent" }),
  ];
}

// ==================== 受控数据通道：可复用 builder（家长主助手 + 数据管理 agent 共用） ====================

function buildDbDescribeTool(deps: ParentToolDeps) {
  const parentSpecs = parentLibTableRegistry();
  const parentPaths = parentLibPaths();
  const childReadSpecs = childKbReadableRegistry();
  const childWriteSpecs = childKbWritableRegistry();

  // Tier 2 namespace 注册行存家长库（会话元数据已常驻 prompt；describe 只兜底单实体详情）
  const nsFor = (scope: "parent" | "child"): NamespaceRow[] => {
    try {
      const pdb = openParentLib(deps.dataDir, deps.parentId);
      try {
        return loadNamespaces(pdb, scope);
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
        ...nsParent.map((n) => `- ns:${n.ns}（家长库）`),
        ...nsChild.map((n) => `- ns:${n.ns}（孩子库，只读）`),
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
      "countOnly=true 只返回命中行数（「有没有/有几条」用这个，别拉行）。等值 where + 列裁剪 + 排序 + 行数上限全部参数化在库内执行；" +
      "返回体超字符预算会自动截断并提示。\n" +
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
      limit: Type.Optional(Type.Number({ description: "最多返回行数（缺省 50，最大 200）" })),
      countOnly: Type.Optional(Type.Boolean({ description: "true=只返回命中行数（F6）" })),
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
        return ok(r.text);
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
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description: "insert=行数组；update=要写入的列值对象（{列: 新值}）",
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
      params: { table: string; child?: string; op: "insert" | "update" | "delete"; rows?: Array<Record<string, unknown>>; where?: Record<string, unknown> }
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
        }
        return ok(r.text);
      } finally {
        db.close();
      }
    },
  });
}

/**
 * 数据管理 agent 工具集（独立 agent，parent-data 会话专用）：只暴露「统一数据 API」三件套
 * + 日期工具，不携带资料/对话/编程等家长主助手工具——与运营类家长 agent 隔离。
 * 覆盖家长内容库全部 6 张表（topics/courses/tags/question_bank/knowledge_points/course_knowledge_questions）。
 */
export function createDataAgentTools(deps: ParentToolDeps) {
  return [buildDbDescribeTool(deps), buildDbReadTool(deps), buildDbWriteTool(deps)];
}

export const DATA_AGENT_TOOL_NAMES = ["parent_db_describe", "parent_db_read", "parent_db_write", "get_date"];

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
  "parent_library_course_content",
  "parent_upsert_course_content",
  "parent_db_describe",
  "parent_db_read",
  "parent_db_write",
  "parent_read_image",
  "parent_read_child_conversation",
  "parent_build_material",
  "log_activity",
  "get_date",
];
