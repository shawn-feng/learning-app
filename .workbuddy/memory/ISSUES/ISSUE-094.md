# [ISSUE-094] 考核域重构：取消 exam_schedules 排期表——固定档改配置项每日生成、自定义直接写 exam_plans

- **类型**：架构重构（用户 2026-09-14 定案并要求实施）
- **优先级**：高（已完成）
- **状态**：✅ 已实施（2026-09-14）
- **记录时间**：2026-09-14
- **标签**：`考核` `exam_plans` `exam_schedules` `配置项` `worker` `架构重构`

---

## 一、需求定案（用户原话归纳）

1. **取消 `exam_schedules`**（排期表整个废除）。
2. **制定了计划就直接写入 `exam_plans`**（自定义考核不再经排期中转）。
3. **每日/每周改成配置项**（不再物化未来 60 天排期行）。
4. **每天定时检查配置项，生成对应的计划写入 `exam_plans`**。
5. 术语沿用 2026-09-14 纠正：`exam_plans`=考核计划，`exam_attempts`=考核场次。

## 二、实施内容（2026-09-14）

**服务端**
- `db.ts`：删除 `exam_schedules` 建表，改为 `DROP TABLE IF EXISTS exam_schedules`（旧排期数据废弃；考核计划/场次数据不受影响）。
- `routes/exam.ts`：
  - 删除 `ensureFixedSchedules`（未来 60 天懒生成）、`normalizeExamScheduleDays`、`freqToMs`、废弃的 `buildSelectionPrompt`（选课 LLM 残留，全仓无调用方）。
  - 新增 `ensureTodayExamPlans(db, dataDir, parentId)`：读配置项 `exam_fixed:<parentId>`（frequencies + weekly.weekday），为**当天**生成 `exam_plans`（`kind='fixed'`、`origin='config'`、当天 0点/23:59:59、`status='pending'`）；幂等（同 child+日+freq 去重）；daily 每天生成、weekly 仅配置的周几生成、同日两档命中只留 weekly。
  - `parent_exam_plan_create`（agent）与 `POST /exam/schedules`（管理面板）**直接写孩子库 `exam_plans`**（`kind='custom'`、`scope_json={topics,courses,note,methodSpec?}`、同日去重）。
  - `GET /exam/schedules/:childId`：改读 `exam_plans`（响应形状与旧排期列表一致，渲染层零改动），并幂等补跑 `ensureTodayExamPlans`。
  - `start/complete/DELETE /exam/schedules/:id`：改操作 `exam_plans`（`findExamPlanRow` 扫家长名下孩子库定位行；DELETE 改软删 `active=0/status='cancelled'`，`done` 拒绝）。
  - `GET /exam/config/:childId?schedule=<id>`：改读 `exam_plans` 行；custom 取 `scope.courses`+`methodSpec`，fixed 按 `freq` + `start_at` 算计划窗口取必学课程。
  - `POST /exam/attempts`：`body.scheduleId`（现携带计划行 id）非空时直接 `UPDATE exam_plans SET done/attempt_id/score/done_at`；逐题明细仍由 worker `applyExamAttempts` 幂等补 `exam_plan_courses`。
  - 固定配置 POST：去掉"清未来排期"逻辑（无表可清）。
- `worker/scheduler.ts`：`runPlanTick` 每轮调用 `ensureTodayExamPlans`（每天首个 tick 生成当天计划，满足"每天定时检查配置项"）。

**客户端（契约不变，渲染层零改动）**
- `/exam/schedules*` 路由路径与响应形状保留；`electron/lib/exam.ts` 仅更新注释与 `ExamScheduleItem.status` 放宽为 string。

## 三、效果

- 考核域从「排期配置 → 展开」两层简化为「配置项 / 直接写入 → 考核计划」一层；`exam_plans` 成为考核计划唯一真源。
- 副产品：**ISSUE-075 的无作用域 DELETE 风险随表取消而彻底消除**（`normalizeExamScheduleDays` 与固定排期清理 DELETE 一并删除）。
- 设置页「固定考核配置」（频率档/每周几）UI 不变，语义从"排期模板"变为"生成配置"。

## 四、验证

- server `tsc --noEmit` + esbuild 构建通过；`dist/server.cjs` 中 `exam_schedules` 仅剩 `DROP TABLE` 语句，`ensureTodayExamPlans` 已接入 worker tick 与列表路由。
- 技术文档 §0.2 / §5.1 / §5.4 / §6.1 / §6.3 / §6.4 / §17 #11、#14 / 附录 A 已同步。
