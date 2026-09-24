/**
 * 孩子 agent 的数据工具（ISSUE-142 收敛，2026-09-23）。
 *
 * 历史：本文件曾导出 `child_db_describe` / `child_db_read` / `child_db_write`——即 ISSUE-105 方案 B P2
 * 的「通用受控数据通道」（22 张表任意等值查询 + 两表白名单写）。按"场景 → 工具"逐条对齐后确认：
 * **没有任何场景需要通用通道**，它只是"缺专用工具时的兜底"：
 * - 写 daily 的正规通道是 `kb_insert` / `kb_update`（带语义解析 / 去重 / 计划联动）；
 * - 读积分、掌握、考核逐题结果已由 `child-report-tools.ts` 的三个**业务语言**专用工具承接；
 * - 读课程 / 主题 / 进度 / 标签走 `kb_query`；读计划走三个 `child_*_plan_list`。
 * ⇒ 通用三工具于 ISSUE-142 撤掉（孩子侧不再有"任意表 / 任意列"入口）。
 *
 * 现在本文件只保留与「错题本」这一业务对象相关的工具：
 * - `child_mistake_log`：记录 / 查看 / 标掌握 / 标不算（复习闭环入口，ISSUE-114）。
 *
 * 安全边界（延续 ISSUE-105 权限矩阵）：连接不经过参数——`openKb` 的 parentId/childId 来自会话绑定，
 * 物理上只能读写自己的库；错题本状态流转只经 `db/mistakes.ts` 的受控函数，不提供任意写通道。
 */
import { defineTool } from "./tool-kit.js";
import { Type } from "typebox";
import { listMistakes, setMistakeStatus, upsertMistake, type MistakeStatus } from "../db/mistakes.js";

export interface ChildDbToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const cut = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function createChildDbTools(deps: ChildDbToolDeps) {
  // —— 错题/生字本（ISSUE-114 C1）：孩子 agent 记录/查看/关闭自己的漏洞信号 ——
  const mistakeTool = defineTool({
    name: "child_mistake_log",
    label: "错题本（记录/查看/掌握）",
    description:
      "把学习中的「漏洞信号」记入错题本，或查看/关闭已有条目。\n\n" +
      "**何时记录（只认明确漏洞信号，先教学后记录）**：\n" +
      "1. 孩子明确说出做错题的经历（「昨天有道题做错了」「这道题我上次就不会」「又错了」）→ kind=wrong_question，记题干摘要 + 卡住点 + 本次讲解要点；\n" +
      "2. 孩子在聊天里问字词读音/释义（「这个字念什么」）→ kind=unknown_word，content=字词，detail=读音释义；\n" +
      "3. 孩子表达稳定的薄弱点（「最怕应用题」「课文总背不住」，反复或明确说学不好）→ kind=weak_point。\n\n" +
      "**不要调用**：提问学习内容本身 ≠ 不会（「什么是比喻句」是求知）；考核错题系统自动同步、不要手动记；口误玩笑；本轮已经记过。\n" +
      "**时序**：先共情 + 讲解，讲解完成后的同轮收尾时静默记录，可轻带一句「已帮你记到错题本」并顺势提供类似练习。\n\n" +
      "action=log：content（题干摘要或字词，同内容自动合并计数）+ detail（正解/释义/讲解要点）+ kind + course（可选，**课程名**——用孩子库里的课程名，拿不准就先 `kb_query` 查一下，别猜也别写主题名）；\n" +
      "action=list：查看错题本（可按 kind/status 过滤，缺省 open；返回含关联课程/知识点、以及有没有可重做的原题）；\n" +
      "action=master：孩子确认掌握（先小题验证再标）→ status=mastered；action=dismiss：记错/重复 → status=dismissed（id 从 list 取）。",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("log"), Type.Literal("list"), Type.Literal("master"), Type.Literal("dismiss")],
        { description: "log=记录 / list=查看 / master=标掌握 / dismiss=不算了" }
      ),
      kind: Type.Optional(
        Type.Union(
          [Type.Literal("wrong_question"), Type.Literal("unknown_word"), Type.Literal("weak_point")],
          { description: "log 必填：wrong_question=错题 / unknown_word=生字词 / weak_point=薄弱点" }
        )
      ),
      content: Type.Optional(Type.String({ description: "log 必填：题干摘要或字词（同内容自动合并计数）" })),
      detail: Type.Optional(Type.String({ description: "log 可选：正解 / 释义 / 卡住点 / 讲解要点" })),
      course: Type.Optional(Type.String({ description: "log 可选：关联的**课程名**（如 学而第一）" })),
      id: Type.Optional(Type.String({ description: "master/dismiss 必填：条目 id（list 里取）" })),
      status: Type.Optional(Type.String({ description: "list 可选：open（缺省）/ mastered / dismissed" })),
    }),
    execute: async (
      _id: string,
      params: {
        action: "log" | "list" | "master" | "dismiss";
        kind?: "wrong_question" | "unknown_word" | "weak_point";
        content?: string;
        detail?: string;
        course?: string;
        id?: string;
        status?: string;
      }
    ) => {
      if (params.action === "log") {
        const row = upsertMistake(deps.dataDir, deps.parentId, deps.childId, {
          kind: params.kind ?? "weak_point",
          content: String(params.content ?? ""),
          detail: String(params.detail ?? ""),
          source: "conversation",
          course_ref: String(params.course ?? ""),
        });
        return ok(
          `已记入错题本（第 ${row.count} 次）：${row.content}。` +
            (row.count > 1 ? "反复出现说明还没掌握，教学时可优先复习。" : "")
        );
      }
      if (params.action === "list") {
        const status = ["open", "mastered", "dismissed"].includes(String(params.status))
          ? (params.status as MistakeStatus)
          : "open";
        const rows = listMistakes(deps.dataDir, deps.parentId, deps.childId, {
          status: status as MistakeStatus,
          limit: 30,
        });
        if (!rows.length) return ok(`错题本（${status}）暂时是空的。`);
        const KIND_ZH: Record<string, string> = { wrong_question: "错题", unknown_word: "生字词", weak_point: "薄弱点" };
        const lines = rows.map((r) => {
          const rel: string[] = [];
          if (String(r.course_ref ?? "").trim()) rel.push(`课程：${String(r.course_ref).trim()}`);
          if (String(r.knowledge_point_name ?? "").trim()) rel.push(`知识点：${String(r.knowledge_point_name).trim()}`);
          if (String(r.question_id ?? "").trim()) rel.push("有原题可重做");
          return (
            `- [${r.id}] ${KIND_ZH[r.kind] ?? r.kind}：${r.content}${r.count > 1 ? `（${r.count} 次）` : ""}` +
            `${r.detail ? `｜${cut(r.detail, 80)}` : ""}${rel.length ? `｜${rel.join(" ｜ ")}` : ""}`
          );
        });
        return ok(`错题本（${status}，${rows.length} 条）：\n${lines.join("\n")}`);
      }
      if (!params.id) throw new Error(`${params.action} 需要 id（先 action=list 获取）`);
      const done = setMistakeStatus(
        deps.dataDir,
        deps.parentId,
        deps.childId,
        params.id,
        params.action === "master" ? "mastered" : "dismissed"
      );
      return done
        ? ok(params.action === "master" ? "已标为掌握 ✅ 继续保持！" : "已标记忽略。")
        : ok("条目不存在（可能已被处理），用 action=list 核对。");
    },
  });

  return [mistakeTool];
}

/** 孩子会话装配的数据工具名（ISSUE-142 起只剩错题本；通用 db 通道已撤） */
export const CHILD_DB_TOOL_NAMES = ["child_mistake_log"];
