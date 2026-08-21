/**
 * 知识库数据 schema（v3，2026-08-21 修订）。
 *
 * 修订要点：**字段白名单机制已废弃**——daily 字段 / 进度条目字段由 method.md 灵活设定，
 * 代码不再约束字段名（LEARNING-DATA-SPEC 5.4 原「字段白名单」条款随之失效）。
 * 本文件只保留：区块结构常量 + 状态值域 + kb 工具名与参数约定（ISSUE-022 检测单一真源）。
 */

/** daily 固定 4 区块（结构常量；区块内容/字段完全由 method 与 recording 灵活定义） */
export const DAILY_BLOCKS = ["学习", "生活", "问答", "任务"] as const;

/** tags 倒排文件的固定区块 */
export const TAG_BLOCKS = ["关联知识点", "关联生活事件"] as const;

/** 课程掌握状态取值约束（courses.status 值域；不是字段名白名单） */
export const PROGRESS_STATUS_VALUES = ["⬜", "✅"] as const;

/**
 * method.md 内允许引用的 kb 工具名集合（ISSUE-022 检测单一真源）。
 * 以 custom-tools.ts 实际注册为准（ISSUE-023 P2 SQLite 化后）：
 *   kb_query（查询）/ kb_insert（插入）/ kb_update（更新）为数据类；
 *   display_content / get_date / get_progress / create_html_lesson 为辅助类。
 */
export const KB_DATA_TOOLS = ["kb_query", "kb_insert", "kb_update"] as const;
export const KB_AUX_TOOLS = ["display_content", "get_date", "get_progress", "create_html_lesson"] as const;
export const METHOD_KB_TOOLS = [...KB_DATA_TOOLS, ...KB_AUX_TOOLS] as const;

/**
 * 各 kb 数据工具调用的「必需参数」（检测 method.md 示例是否缺参，依据 LEARNING-DATA-SPEC.md 5.3）。
 * 数组内为「任一即可」，单独列出的为「都要有」。
 */
export const KB_TOOL_REQUIRED: Record<string, string[]> = {
  kb_query: ["query"],
  kb_insert: ["table"],
  kb_update: ["table", "field", "value"],
};
