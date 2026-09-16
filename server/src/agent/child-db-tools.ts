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
import {
  childKbReadableRegistry,
  childKbWritableRegistry,
  describeChildTables,
  executeRead,
  executeWrite,
  type ReadRequest,
  type WriteRequest,
} from "./db-channel.js";

export interface ChildDbToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function createChildDbTools(deps: ChildDbToolDeps) {
  const readSpecs = childKbReadableRegistry();
  const writeSpecs = childKbWritableRegistry();

  const describeTool = defineTool({
    name: "child_db_describe",
    label: "查看我的数据表",
    description:
      "列出我的数据库里可查询/可写入的表（学习计划、考核计划、积分流水、日常记录、兑换等）与每列含义。\n" +
      "传 table 看单表详情；不传看全部清单。查数据前不确定列名时先看这个。",
    parameters: Type.Object({
      table: Type.Optional(Type.String({ description: "表名（可省略=列出全部）" })),
    }),
    execute: async (_id: string, params: { table?: string }) => {
      return ok(describeChildTables(readSpecs, writeSpecs, params.table?.trim() || undefined));
    },
  });

  const readTool = defineTool({
    name: "child_db_read",
    label: "查询我的数据",
    description:
      "查询自己数据库里的表：学习/考核计划、积分流水与余额、兑换商品与申请、日常记录、课程进度等。\n" +
      "等值条件查询（如 where={status:\"pending\"}），支持选列、排序、限制行数（默认 50，最多 200）。\n" +
      "查「今天要做什么」请优先用 child_study_plan_list / child_exam_plan_list / child_life_plan_list（带今日窗口语义）。",
    parameters: Type.Object({
      table: Type.String({ description: "表名（用 child_db_describe 查询可用表）" }),
      columns: Type.Optional(Type.Array(Type.String(), { description: "只查这些列（缺省=全部可读列）" })),
      where: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "等值条件，如 {status:\"pending\"}" })),
      orderBy: Type.Optional(Type.String({ description: "排序列" })),
      orderDesc: Type.Optional(Type.Boolean({ description: "是否倒序（缺省正序）" })),
      limit: Type.Optional(Type.Number({ description: "返回行数上限（缺省 50，最大 200）" })),
    }),
    execute: async (_id: string, params: { table: string; columns?: string[]; where?: Record<string, unknown>; orderBy?: string; orderDesc?: boolean; limit?: number }) => {
      const db = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const req: ReadRequest = {
          table: params.table,
          columns: params.columns,
          where: params.where,
          orderBy: params.orderBy,
          orderDesc: params.orderDesc,
          limit: params.limit,
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
      "考核计划、积分、奖励规则等不允许写——积分只能由考核/任务流程产生。\n" +
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

  return [describeTool, readTool, writeTool];
}

export const CHILD_DB_TOOL_NAMES = ["child_db_describe", "child_db_read", "child_db_write"];
