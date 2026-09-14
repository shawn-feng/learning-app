# [ISSUE-085] 考核计划（exam_plans）无删除 / 取消操作；排期删除仅限 pending

> ⚠️ **术语纠正（2026-09-14，用户指出）**：本 issue 原标题把 `exam_plans` 称作「考核场次」是不准确的。
> 正确口径：**`exam_plans` = 考核计划**（孩子库，出现在「今日计划」）；**`exam_attempts` = 考核场次**（主库，孩子真正提交的一次考试，逐题记录在 `per_question`）。本 issue 取消的是**考核计划**，已提交的考核场次不受影响。下文旧表述按此理解。

- **类型**：功能缺口 / 数据治理
- **优先级**：已解决
- **状态**：✅ 已解决（2026-09-13）—— 已补 exam_plans 取消端点 + 放宽排期删除
- **记录时间**：2026-09-13
- **标签**：`考核` `exam_plans` `exam_schedules` `数据治理`

---

## 一、问题要点

考核域存在两个易混的存储（见技术文档 §6.1 / §6.3）：
- `exam_schedules`（主库 `server.sqlite`）= **排期配置**（fixed 固定档 / custom 自定义档）。
- `exam_plans`（孩子库 `kb/<cid>.sqlite`）= **实际考核场次**（由 worker 从 `exam_schedules` + 学习检测展开，或从上报的 `exam_attempts` 回填）。

两者都**缺少完整的生命周期删除能力**：

1. **`exam_plans`（孩子库场次）完全没有删除 / 取消端点**：
   - 全仓无 `exam_plans` 的 `DELETE` / `cancel` / `active=0` 操作，既无 agent 工具也无 REST 路由。
   - worker `applyExamAttempts`（`worker/plan-domain.ts`）只在 `exam_attempts` 上报后 `INSERT/UPDATE` 场次、`DELETE+INSERT exam_plan_courses` 回填，**没有任何把场次置为取消 / 删除的路径**。
   - 结果：场次一旦生成（无论孩子是否真考、是否误排）永久留存，家长/孩子**无法取消某次考核**，也无法清理错误场次。这与 study_plans/life_plans 有 `study_plan_update` 的删除分支不同——考核场次是"只进不出"。

2. **`exam_schedules`（主库排期）删除仅限 `pending`**：
   - 仅 `DELETE /api/v1/exam/schedules/:id` 一个删除端点，且实现中 `if (row.status !== "pending") return 400`——**进行中 / 已完成的排期无法删除**。
   - 自定义档若排错（如 courses 选错），若已脱离 pending 则只能等其过期，无法直接撤销。
   - 此外 `normalizeExamScheduleDays` 的 `DELETE WHERE kind='fixed' AND status='pending' AND scheduled_at>?` 是无作用域 DELETE（即 ISSUE-075 风险点：客户端推空频率会清空未来全部固定档排期）。

## 二、影响范围

- **家长端**：无法取消 / 删除已生成的考核场次（exam_plans）；排期（exam_schedules）仅能在 pending 阶段撤销。
- **孩子端**：考核页"今天可参加 / 历史"里的场次无法由家长撤回；误排/误考的场次长期堆积。
- **数据治理**：随着使用时间增长，exam_plans 只增不删，无归档/清理机制。

## 三、已实施（2026-09-13，采用「软删」口径）

采用方案 A（补 `exam_plans` 取消端点）+ 方案 B 中的「软删保留审计」+ 方案 C（放宽排期删除范围）：

1. **孩子库 `exam_plans` 新增取消能力（软删）**
   - 家长 agent 工具 `parent_exam_plan_cancel`：`UPDATE exam_plans SET active=0, status='cancelled'`；`done` 状态拒绝取消（已考完的记录不可抹）；注册进 `createPlanDomainTools` 返回数组与 `PLAN_DOMAIN_TOOL_NAMES`。
   - REST `POST /api/v1/exam/plans/:id/cancel`（家长 JWT + 孩子归属校验），同一软删语义。
   - 保留历史行（不硬删），便于审计与掌握度回看，符合现有"只增不删"数据风格。
2. **主库 `exam_schedules` 放宽删除范围**：`DELETE /api/v1/exam/schedules/:id` 由仅 `pending` 放宽为 **`pending` / `started` 均可取消**，`done` 仍不可删（保留与 `exam_attempts` 的关联）。
3. **统计口径自洽**：worker `plan-domain` 的分母按 `active=1` 过滤、分子只计 `done`/`missed`，软删的 `cancelled` 行（`active=0`）不会被误计入完成率。

命名遵循 ISSUE-084 的 `parent_exam_plan_cancel`（未采用原提议的 `kp_exam_plan_cancel` 库简写式）。

## 四、遗留（本次未处理）

- `normalizeExamScheduleDays` 的**无作用域 DELETE** 风险（`DELETE WHERE kind='fixed' AND status='pending' AND scheduled_at>?`，客户端推空频率会清空未来固定档排期）仍存在，与 `ISSUE-075` 同源，需一并修。
- `exam_schedules` 仍无 agent 侧的 update/delete 工具（仅 create / list / cancel 与之相关），其余改删仍靠 REST。

## 五、关联

- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §6.4（取消端点 / 排期删除放宽）、§5.4 与附录 A（`parent_exam_plan_cancel` 工具行）、§17 #11（已解决）。
- `ISSUE-075`（exam_schedules 无作用域 DELETE 风险，见 §四 遗留）。
- `ISSUE-084`（工具命名规范；本 issue 新增工具按 `parent_exam_plan_*` 命名）。
- 代码真源：`server/src/agent/parent-plans.ts`（cancel 工具）、`server/src/routes/exam.ts`（`POST /exam/plans/:id/cancel`、放放宽后的 `DELETE /schedules/:id`）、`server/src/worker/plan-domain.ts`（统计口径）。
- 验证：server `tsc --noEmit` + esbuild 通过；`dist/server.cjs` 含 `parent_exam_plan_cancel`（工具 + 白名单）与 `/exam/plans/:id/cancel` 端点。
