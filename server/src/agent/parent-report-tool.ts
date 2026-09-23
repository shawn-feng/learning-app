/**
 * ISSUE-108（2026-09-21 简化定案）：家长报表 —— **markdown，不搞 HTML widget**。
 *
 * 家长 agent 产出学习情况/进度汇总时，调本工具把 **markdown 文本**推到家长端「报表」区：
 * - 展示：经 agentStreamHub 发 `display_content` 事件（source="report"）——家长 SSE 流
 *   （parent-agent/stream → server-agent-client 桥 → pi:display_content）天然送达渲染层，
 *   childId="parent"，与孩子资料推送共用一条桥（electron/lib/server-agent-client.ts:126）；
 * - 留存：写主库 settings 键 `report:<parentId>`（JSON {title, content, ts}）——重启不丢，
 *   `GET /api/v1/parent-agent/report` 读回。
 * 与孩子侧 display_content（HTML 沙盒 iframe）不同：markdown 是受信文本，无需落文件/沙箱。
 */
import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineTool } from "./tool-kit.js"; // ISSUE-134：统一还原字符串化参数
import { agentStreamHub } from "./stream-hub.js";

export interface ParentReportDeps {
  db: DatabaseSync; // 主库（settings 真源）
  parentId: string;
  streamKey: string; // agentStreamHub 会话 key（= parent-registry keyOf(parentId, kind)）
}

export interface ParentReport {
  title: string;
  content: string;
  ts: number;
}

const KEY_PREFIX = "report:";

export function saveParentReport(db: DatabaseSync, parentId: string, report: ParentReport): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated) VALUES (?, ?, ?)").run(
    `${KEY_PREFIX}${parentId}`,
    JSON.stringify(report),
    new Date().toISOString()
  );
}

export function getParentReport(db: DatabaseSync, parentId: string): ParentReport | null {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${KEY_PREFIX}${parentId}`) as
    | { value_json?: string }
    | undefined;
  if (!row?.value_json) return null;
  try {
    const r = JSON.parse(row.value_json) as ParentReport;
    return r && typeof r.content === "string" ? r : null;
  } catch {
    return null;
  }
}

export function createParentReportTool(deps: ParentReportDeps) {
  return defineTool({
    name: "parent_display_report",
    label: "推送家长报表（markdown）",
    description:
      "把给家长看的汇总/报表（孩子学习进度与情况、阶段总结、周报等）以 **markdown 文本**推送到家长端「📊 报表」区展示并留存。\n" +
      "**何时调用**：家长要求「看看学习情况/进度报告/来份总结」，或你完成了一次值得留档的汇总分析。\n" +
      "**要求**：直接给完整 markdown 文本（支持标题/表格/列表/加粗），不要写 HTML；数据用你刚查到的真实结果，不要编造。",
    parameters: Type.Object({
      markdown: Type.String({ description: "完整 markdown 报表文本" }),
      title: Type.Optional(Type.String({ description: "报表标题（缺省「学习报表」）" })),
    }),
    execute: async (_id: string, params: { markdown?: string; title?: string }) => {
      const content = String(params.markdown ?? "").trim();
      if (!content) throw new Error("parent_display_report 需要 markdown（完整报表文本）");
      const title = String(params.title ?? "").trim() || "学习报表";
      const ts = Date.now();
      saveParentReport(deps.db, deps.parentId, { title, content, ts });
      agentStreamHub.publish(deps.streamKey, "display_content", {
        path: `report/${ts}.md`,
        source: "report",
        title,
        content,
        ts,
      });
      return {
        content: [{ type: "text" as const, text: `已推送报表「${title}」——家长端「📊 报表」区已更新并留存。` }],
        details: {},
      };
    },
  });
}
