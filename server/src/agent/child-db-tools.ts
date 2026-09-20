/**
 * 孩子 agent 受控数据通道工具（ISSUE-105 方案 B P2）。
 *
 * - child_db_describe：列出自己 kb 里可读/可写的表与列（含业务含义）；
 * - child_db_read：对可读表做受控查询（等值 where + 列裁剪 + 排序 + 行数上限，全参数化）；
 * - child_db_write：只对白名单表（日常记录 / 兑换申请）开放受控写。
 *
 * 安全边界（ISSUE-105 权限矩阵）：
 * - 连接不经过参数：openKb(dataDir, parentId, childId)，childId 来自会话绑定，物理上只能开自己的库；
 * - 考核计划/积分/奖励规则等全部只读——考核状态机与积分产生是防作弊边界，任何写通道都不登记；
 * - redemption_requests 的 child_id 由服务端强制覆盖为会话绑定的孩子，agent 传什么都不生效。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";
import { listMistakes, setMistakeStatus, upsertMistake, type MistakeStatus } from "../db/mistakes.js";
import {
  childKbReadableRegistry,
  childKbWritableRegistry,
  describeChildTables,
  executeRead,
  executeWrite,
  type ReadRequest,
  type WriteRequest,
} from "./db-channel.js";
import { loadNamespaces, tier2Read, describeNamespace, type NamespaceRow } from "./tier2.js";

export interface ChildDbToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** 孩子 scope 的 Tier 2 namespace（注册行存家长库；孩子侧一律只读） */
function childNamespaces(deps: ChildDbToolDeps): NamespaceRow[] {
  try {
    const pdb = openParentLib(deps.dataDir, deps.parentId);
    try {
      return loadNamespaces(pdb, "child");
    } finally {
      pdb.close();
    }
  } catch {
    return [];
  }
}

export function createChildDbTools(deps: ChildDbToolDeps) {
  const readSpecs = childKbReadableRegistry();
  const writeSpecs = childKbWritableRegistry();
  const nsRows = childNamespaces(deps);

  const describeTool = defineTool({
    name: "child_db_describe",
    label: "查看我的数据表",
    description:
      "列出我的数据库里可查询/可写入的表（学习计划、考核计划、积分流水、日常记录、兑换等）与每列含义。\n" +
      "表清单也已在本会话系统提示的元数据块里（读操作通常不用先调它）；传 table 看单表详情（含 ns:开头的灵活实体）。",
    parameters: Type.Object({
      table: Type.Optional(Type.String({ description: "表名或 ns:灵活实体名（可省略=列出全部）" })),
    }),
    execute: async (_id: string, params: { table?: string }) => {
      const table = params.table?.trim() || undefined;
      if (table?.startsWith("ns:")) {
        const ns = nsRows.find((n) => `ns:${n.ns}` === table);
        if (ns) return ok(describeNamespace(ns));
        return ok(`没有名为 ${table} 的灵活实体（清单见系统提示）。`);
      }
      if (table) return ok(describeChildTables(readSpecs, writeSpecs, table));
      const nsLines = nsRows.map((n) => `- ns:${n.ns}（${n.label}，只读）: ${Object.keys(n.spec.columns).join(", ")}`).join("\n");
      return ok(
        describeChildTables(readSpecs, writeSpecs) + (nsLines ? `\n\n【灵活实体 Tier 2】table 用 ns:名称（只读）：\n${nsLines}` : "")
      );
    },
  });

  const readTool = defineTool({
    name: "child_db_read",
    label: "查询我的数据",
    description:
      "查询自己数据库里的表：学习/考核计划、积分流水与余额、兑换商品与申请、日常记录、课程进度等；table 也支持 ns:开头的灵活实体（只读）。\n" +
      "等值条件查询（如 where={status:\"pending\"}），支持选列、排序、限制行数（默认 50，最多 200）；" +
      "countOnly=true 只返回命中行数（「有没有/几条」用这个）。返回体超字符预算会自动截断。\n" +
      "查「今天要做什么」请优先用 child_study_plan_list / child_exam_plan_list / child_life_plan_list（带今日窗口语义）。",
    parameters: Type.Object({
      table: Type.String({ description: "表名或 ns:灵活实体名（清单见系统提示）" }),
      columns: Type.Optional(Type.Array(Type.String(), { description: "只查这些列（缺省=全部可读列）" })),
      where: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "等值条件，如 {status:\"pending\"}" })),
      orderBy: Type.Optional(Type.String({ description: "排序列" })),
      orderDesc: Type.Optional(Type.Boolean({ description: "是否倒序（缺省正序）" })),
      limit: Type.Optional(Type.Number({ description: "单次最多返回行数（缺省 50，最大 200）" })),
      offset: Type.Optional(Type.Number({ description: "跳过前 N 行（配合 limit/orderBy 分页拉全量）" })),
      countOnly: Type.Optional(Type.Boolean({ description: "true=只返回命中行数" })),
    }),
    execute: async (
      _id: string,
      params: {
        table: string;
        columns?: string[];
        where?: Record<string, unknown>;
        orderBy?: string;
        orderDesc?: boolean;
        limit?: number;
        offset?: number;
        countOnly?: boolean;
      }
    ) => {
      if (params.table.startsWith("ns:")) {
        const ns = nsRows.find((n) => `ns:${n.ns}` === params.table);
        if (!ns) return ok(`没有名为 ${params.table} 的灵活实体（清单见系统提示）。`);
        const db = openKb(deps.dataDir, deps.parentId, deps.childId);
        try {
          return ok(
            tier2Read(db, ns, {
              columns: params.columns,
              where: params.where,
              orderBy: params.orderBy,
              orderDesc: params.orderDesc,
              limit: params.limit,
              offset: params.offset,
              countOnly: params.countOnly,
            }).text
          );
        } finally {
          db.close();
        }
      }
      const db = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const req: ReadRequest = {
          table: params.table,
          columns: params.columns,
          where: params.where,
          orderBy: params.orderBy,
          orderDesc: params.orderDesc,
          limit: params.limit,
          offset: params.offset,
          countOnly: params.countOnly,
        };
        const r = executeRead(db, readSpecs, req);
        return ok(r.text);
      } finally {
        db.close();
      }
    },
  });

  const writeTool = defineTool({
    name: "child_db_write",
    label: "写入我的数据（白名单表）",
    description:
      "只对白名单表写入：daily_entries（日常记录，可增/改/删）、redemption_requests（兑换申请，只能新增）。\n" +
      "考核计划、积分、奖励规则、灵活实体（ns:）等不允许写——积分只能由考核/任务流程产生。\n" +
      "update/delete 必须带 where 等值条件；兑换申请的 child_id 由服务端自动填，不用传。",
    parameters: Type.Object({
      table: Type.String({ description: "白名单表名：daily_entries / redemption_requests" }),
      op: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")], { description: "操作类型" }),
      rows: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: "insert=行数组；update=要写入的列值对象" })
      ),
      where: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "update/delete 必填：等值条件" })
      ),
    }),
    execute: async (
      _id: string,
      params: { table: string; op: "insert" | "update" | "delete"; rows?: Array<Record<string, unknown>>; where?: Record<string, unknown> }
    ) => {
      const db = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        // 兑换申请：child_id 强制为会话绑定的孩子（执行器侧覆盖，agent 传什么都不生效）
        const force = params.table === "redemption_requests" ? { child_id: deps.childId } : undefined;
        const req: WriteRequest = { table: params.table, op: params.op, rows: params.rows, where: params.where, force };
        const r = executeWrite(db, writeSpecs, req);
        return ok(r.text);
      } finally {
        db.close();
      }
    },
  });

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
      "action=log：content（题干摘要或字词，同内容自动合并计数）+ detail（正解/释义/讲解要点）+ kind + course（可选主题中文名）；\n" +
      "action=list：查看错题本（可按 kind/status 过滤，缺省 open）；\n" +
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
      course: Type.Optional(Type.String({ description: "log 可选：关联主题/课程名（如 论语）" })),
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
        return ok(
          `错题本（${status}，${rows.length} 条）：\n` +
            rows
              .map(
                (r) =>
                  `- [${r.id}] ${KIND_ZH[r.kind] ?? r.kind}：${r.content}${r.count > 1 ? `（${r.count} 次）` : ""}${r.detail ? `｜${r.detail.slice(0, 80)}` : ""}`
              )
              .join("\n")
        );
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

  return [describeTool, readTool, writeTool, mistakeTool];
}

export const CHILD_DB_TOOL_NAMES = [
  "child_db_describe",
  "child_db_read",
  "child_db_write",
  "child_mistake_log",
];
