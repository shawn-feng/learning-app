/**
 * 知识库数据 schema（v3，2026-08-21 修订）。
 *
 * 修订要点：**字段白名单机制已废弃**——daily 字段 / 进度条目字段由 method.md 灵活设定，
 * 代码不再约束字段名（LEARNING-DATA-SPEC 5.4 原「字段白名单」条款随之失效）。
 * 本文件只保留：区块结构常量 + 状态值域（kb 工具名约定已随 kb-lint 退役删除，ISSUE-173；
 * 工具参数语义以 server/src/agent/child-tools 注册处为真源）。
 */

/** daily 固定 4 区块（结构常量；区块内容/字段完全由 method 与 recording 灵活定义） */
export const DAILY_BLOCKS = ["学习", "生活", "问答", "任务"] as const;

/** tags 倒排文件的固定区块 */
export const TAG_BLOCKS = ["关联知识点", "关联生活事件"] as const;

/** 课程掌握状态取值约束（courses.status 值域；不是字段名白名单） */
export const PROGRESS_STATUS_VALUES = ["⬜", "✅"] as const;

