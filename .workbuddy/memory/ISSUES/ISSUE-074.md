# ISSUE-074｜家长端列表的静默 LIMIT 截断（题库 2000 / 排期 100）

- **类型**：bug（数据静默截断，界面无任何提示）
- **优先级**：中（题库已在生产实际发生：3575 条只能看到 2000 条）
- **记录时间**：2026-09-11
- **状态**：**两处已修并上生产**；剩余项与分页设计待处理

---

## 描述

家长端多个列表用 `LIMIT <固定数>` 从 SQL 直接截断，**超出部分在界面直接消失、没有任何「还有更多」提示**。
生产数据量增长后会静默丢数据，用户无法察觉。

2026-09-11 盘点结果：

| # | 落点 | 原上限 | 生产实况 | 处理 |
|---|---|---|---|---|
| 1 | `server/src/db/assess-content.ts` `listAllBankQuestions`（家长「题库」） | **2000** | 题库 **3575** 条 → **1575 条不可见** | ✅ 已改 `BANK_LIST_LIMIT = 10000` |
| 2 | `server/src/routes/exam.ts:1068` `GET /exam/schedules/:childId`（家长「考核计划」） | **100** | 单孩子已 **68** 条，固定档每天自动生成约 3 条 → **约 11 天后撞上限** | ✅ 已改 `1000` |
| 3 | `server/src/routes/exam.ts:1780` 考核记录（`exam_attempts ... LIMIT 60`） | 60 | 生产 0 条（尚未开始考核） | ⏳ 未动，量起来前需评估 |
| 4 | `server/src/routes/study-plans.ts:126` 学习计划（`LIMIT 2000`） | 2000 | 生产 290 条 | ⏳ 未动，暂够用 |
| 5 | `server/src/db/agents.ts:100` prompt_history（`LIMIT 50`） | 50 | 非家长可见（审计用途），属有意截断 | ✅ 视为设计，不改 |

两处已修的改动都**保持响应形状不变**（仍是数组、不分页），因此**不影响既有客户端**。

## 影响范围

- 家长端「题库」菜单（`src/components/QuestionBankPanel.tsx`，数据来自 `electron/lib/assess-admin.ts` → `/assess/questions/list`）。
- 家长端「考核计划」（`src/components/ExamAdminPanel.tsx` → `/exam/schedules/:childId`）。
- 孩子端拿排期（同一路由，`ExamView`）——被截断的排期孩子也看不到。

## 排查 / 修改入口（可直接执行）

1. 已修两处见上表；仓库改动在 `server/src/db/assess-content.ts`（`BANK_LIST_LIMIT` 常量 + 注释）与 `server/src/routes/exam.ts:1068`。
2. 剩余项的判断标准：**家长端是否需要看到全量**。
   - 「考核记录」建议保留一个「最近 N 条」语义（60 → 建议 200），并在 UI 上加「仅显示最近 N 条」文案，避免再次静默。
   - 「学习计划」当前 2000 足够；随历史积累（每天 1 行/课）会缓慢增长，建议改成按时间范围（如近 60 天）或分页。
3. 建立约定：**服务端任何面向家长列表的 `LIMIT` 必须二选一** —— ①给出足够大的上限并在 UI 标注「最近 N 条」；②做分页/服务端过滤。禁止「固定小上限 + 无提示」的静默截断。

## 待确认项

1. **题库的真正解法是分页还是服务端过滤**：题库已 3575 条，`/assess/questions/list` 全量返回的 payload 约数 MB（含 stem/answer/scoring/options/contexts）。
   - 方案 A（推荐）：按「主题 → 课程」服务端过滤（家长本来就是按课看题），列表页只给摘要（不返回 answer/scoring）。
   - 方案 B：分页（`limit`/`offset` 或游标）+ 前端虚拟列表。
   - 两者都改 API 形状 → 建议与 ISSUE-073（类别→知识点）**同批次**做，只改一次客户端。
2. 题库超过 2000 后家长端渲染性能是否需要虚拟滚动（当前 `QuestionBankPanel` 一次性渲染列表项）。
