# ISSUE-072｜自定义考核计划需有「标题名」，家长 agent 创建时必须填入

- **类型**：需求（功能增强）
- **优先级**：中
- **记录时间**：2026-09-11
- **状态**：待实施（仅登记，未改动代码）

---

## 描述

自定义考核计划（家长 agent 通过 `exam_schedule_create` 创建的一次性排期）目前**没有独立的「标题名」**。

当前家长端 `ExamAdminPanel` 的自定义考核列表，每行只显示：
- 主标签：`📅 {考核日期}`（`fmtDay(g.scheduledAt)`）
- 副行：`g.note`（考核说明，可空）

也就是说，一个计划凭「日期 + 一段说明」辨识，没有像「论语乡党篇阶段测」「9月第一周数学小测」这样**一句话的标题名**供家长快速区分与管理。

按需求：
1. 每个自定义考核计划要有一个**标题名**；
2. 家长 agent 在设置（创建）计划时**必须填入**这个名字——不能留空、不应用日期或「自定义考核」占位。

## 影响范围

- 家长 agent 工具 `exam_schedule_create`（`electron/lib/custom-tools.ts` L1051-1131）——需新增 `title` 参数，并作为必填要求 agent 填入。
- 客户端封装 `createExamSchedule`（`electron/lib/exam.ts` L185-196）——`scope` 现含 `topics/courses/note/methodSpec/prompt`，缺 `title`；需把标题带上（建议作为顶层字段或 scope 内 `title`）。
- 服务端 `/exam/schedules` 写入模型 + `exam_schedules` 数据表——需新增 `title` 列与返回字段（⚠️ 服务端落点待定位，见下方待确认项 3）。
- 家长端 `ExamAdminPanel.tsx`：
  - 左侧列表渲染（L423-449，主标签 L443、副行 L444）；
  - 右侧详情头部（L472-476，现显示 `g.note` 为「说明」）——应优先展示标题名。
- 孩子端考核页排期选择（疑似 `src/components/ExamView.tsx` / `exam-template.ts` 拉取 schedules 处）——创建后孩子看到的也应是该标题名，便于识别「这次考什么」。

## 排查 / 修改入口（可直接执行）

1. `electron/lib/custom-tools.ts` `examScheduleCreateTool`：
   - `parameters` 增加 `title: Type.String({ description: "本次考核计划的标题名（必填，如「论语乡党篇阶段测」），家长须给出；缺省须向家长确认，不要用日期或「自定义考核」占位" })；`
   - `execute` 内增加校验：标题为空则 `throw` 要求家长确认（对齐 courses 缺省即 throw 的现有风格）；
   - 调用 `createExamSchedule` 时把 `title` 传入（L1111-1116 的 scope 对象里加 `title: params.title`）。
2. `electron/lib/exam.ts` `createExamSchedule`（L185-196）：`POST /exam/schedules` 的 `body` 现有 `{ childId, scheduledAt, scope }`，把 `title` 一并传（顶层或并入 scope，需与服务端约定一致）。
3. 服务端：定位 `/exam/schedules` 的 handler 与 `exam_schedules` 建表/插入逻辑，补 `title` 字段的写入与返回（实施前先 grep 确认真实落点）。
4. `src/components/ExamAdminPanel.tsx`：列表主标签与详情头部改用 `title`（缺省回退日期），`note` 维持「给孩子的说明」语义。
5. 孩子端排期选择展示同步改用 `title`。

## 期望行为

- 家长说「周五给珊珊安排一次考乡党篇最近 3 课的考核，就叫『乡党篇阶段测』」→ agent 调 `exam_schedule_create` 带 `title="乡党篇阶段测"`。
- 家长端自定义考核列表以「📝 乡党篇阶段测 · 9/5」形式呈现，一眼可辨。
- 家长漏说名字时，agent **主动追问标题**，不自动用日期/「自定义考核」顶替。

## 待确认项（留给实施者 / 用户拍板）

1. **`title` 与现有 `note` 的边界**：建议 `title` = 计划名（家长管理用，简短），`note` = 给孩子的说明语（考核页展示给孩子）。两者独立、不互相替代。
2. **是否必填**：按「要填入这个名字」语义，建议 `title` **设为必填**，agent 缺省即向家长确认；不要沿用 `note` 的 `|| "自定义考核"` 兜底逻辑。
3. **服务端落点待定位**：本次在 `cloud-service/app/*.py` 下 grep `exam_schedules/scheduled_at/scope` 未命中，说明 `/exam/schedules` 模型可能不在 `cloud-service/app` 主包（或在 worker / 另一服务 / 不同目录）。实施前须先定位真实 handler 与建表语句，再补字段。
4. **孩子端展示**：考核页孩子选择「开始哪次考核」时是否展示该标题（目前大概率只看日期），建议一并展示，保持家长/孩子两侧认知一致。
