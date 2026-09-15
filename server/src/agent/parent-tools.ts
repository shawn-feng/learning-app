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
                    (SELECT COUNT(*) FROM courses c WHERE c.topic = t.topic_key) AS total,
                    (SELECT COUNT(*) FROM courses c WHERE c.topic = t.topic_key AND c.status='✅') AS learned
             FROM topics t ORDER BY t.topic_key`
          )
          .all() as Array<{ name: string; topic_key: string; method: string; total: number; learned: number }>;
        if (!rows.length) return ok("（家长库暂无教学主题）");
        return ok(
          rows
            .map((r) => `- ${r.name}（${r.topic_key}）：已学 ${r.learned}/${r.total}${r.method ? `｜方法：${r.method}` : ""}`)
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
    description: "列出某主题下的课程（标题/状态/资料路径）。改资料前用它核对课程与资料的对应关系。",
    parameters: Type.Object({
      topic: Type.String({ description: "主题目录名（topic_key，如 lunyu）" }),
    }),
    execute: async (_id: string, params: { topic: string }) => {
      const db = openParentLib(deps.dataDir, deps.parentId);
      try {
        const rows = db
          .prepare(
            `SELECT title, status, last_review, html_path FROM courses WHERE topic = ? ORDER BY sort_order, title`
          )
          .all(params.topic) as Array<{ title: string; status: string; last_review: string; html_path: string }>;
        if (!rows.length) return ok(`主题「${params.topic}」下没有课程（可用 parent_library_topics 核对 topic 名）`);
        return ok(
          rows
            .map((r) => `- ${r.title}｜${r.status}｜最近 ${r.last_review || "-"}｜${r.html_path || "无资料"}`)
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
      "**先核对再覆盖**：覆盖前先 parent_library_courses 看现有字段，避免误改系统维护的进度字段（status/last_review/review_count）。",
    parameters: Type.Object({
      topic: Type.String({ description: "主题目录名（如 lunyu）" }),
      title: Type.String({ description: "课程名" }),
      sort_order: Type.Optional(Type.Number({ description: "排序（缺省 0）" })),
      status: Type.Optional(Type.String({ description: "掌握状态（⬜/✅，缺省 ⬜）" })),
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
             topic, title, sort_order, status, last_review,
             review_count, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric
           ) VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(topic, title) DO UPDATE SET
             sort_order = excluded.sort_order,
             status = excluded.status,
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
          params.status ?? "⬜",
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
    imageTool,
    convoTool,
    logTool,
    // 编程 agent（P3 上移）：家长 agent 描述需求 → 服务端编程 agent 产出 HTML 资料到真源
    createProgrammingTool({ dataDir: deps.dataDir, db: deps.db, parentId: deps.parentId }, { scope: "parent" }),
  ];
}

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
  "parent_read_image",
  "parent_read_child_conversation",
  "parent_build_material",
  "log_activity",
  "get_date",
];
