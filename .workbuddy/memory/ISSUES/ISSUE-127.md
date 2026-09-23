# ISSUE-127：学习计划创建不校验课程名存在性——错名计划永远无法完成（missed 顺延 + 拖累完成率扣分）——✅ 已修复（2026-09-21）

- **类型**：bug（学习计划三条创建路径缺课程名存在性硬校验；与 `parent_exam_plan_create`/`child_study_plan_create` 的硬校验不一致）
- **调查结论（2026-09-21）**：三条路径对查不到的课程名一律 `topic_key=""`、`course_uuid=""` **照样插入**：
  ① agent 工具 `parent_study_plan_create`（parent-plans.ts，`titleToTopic.get(...) || ""`）；
  ② REST `POST /api/v1/study-plans`（routes/study-plans.ts，同款 + 注释明言「查不到留空」）；
  ③ 重复规则展开 `expandRecurrences`（plan-domain.ts，payload 原样落库）。
  工具描述仅一句软约束（「排前先 parent_study_plan_sources 查真实课程名」），无任何硬校验。
  对照：`child_study_plan_create` **本来就有**硬校验（missing → throw + 现有课程清单）；`parent_exam_plan_create` 同款。
- **为什么必须修**：学习域完成判定（`applySignals`）按 **course_name 精确匹配** daily 学习记录——
  错名计划永远匹配不上 → 永远无法完成 → 到期 missed → **carry 顺延无限循环**；
  且 creator=parent 的行 `count_in_rate=1` → 每天拖累「必须完成项完成率」→ 触发扣分档
  （与 ISSUE-112 同构的「孩子被冤枉扣分」形态）。`course_uuid/topic_key` 为空还使 course_progress 视图/关联挂不上。
- **修复（三路径三策略）**：
  ① `parent_study_plan_create`：查不到 → **整单拒绝**，报不存在清单 + 指引先查 `parent_study_plan_sources`；
  ② REST `POST /api/v1/study-plans`：同款 400（家长库不可用时跳过校验沿用旧行为，`libOk` 标记区分）；
  ③ `expandRecurrences`（study 规则）：课程已不在库 → **跳过该条 + console.warn**（tick 内不能整体失败；
     游标照常推进避免每天重复告警；规则如已失效请删除后重建）。注意 `created` 计数按分支内联
     （life/study 各自内联，删除分支外共用的 `created++`，跳过不计）。
  `parent_study_plan_update` 只支持 delete/reschedule/setmode（课程名不可改），无需动；
  `child_study_plan_create` 原有硬校验保持。
- **验证**：新增 `test/issue123-study-plan-course-check.test.ts` 3 用例（整单拒绝且真实课程不落库 /
  全真实课程创建且 topic_key/uuid 反查非空 / recurrence 有效展开+失效跳过+游标推进），连同相关 33 测试全过；server tsc 零错误。
- **部署状态**：未上 201（随下次发版）。
- **优先级**：中-高（错名计划的扣分形态与 ISSUE-112 同构；修复极小）
- **记录时间**：2026-09-21
