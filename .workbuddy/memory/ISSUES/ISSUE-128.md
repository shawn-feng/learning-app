# ISSUE-128：家长 db 通道开放孩子库**全部登记表**（管理口径）——✅ 已实施（2026-09-21 用户拍板，修订 ISSUE-105 矩阵）

- **类型**：策略修订 / 功能（`parent_db_write`/`parent_db_read` + child 参数的孩子库写面开放）
- **背景（用户实测引发的拍板）**：家长 agent 用 `parent_db_write` 改孩子库 `study_plans.course_name`（改课程名最干净的路径）被两层拦住——
  ① rows 形状 schema 校验（ISSUE-122 已修，Union 后不会再因数组/字符串形状全灭）；
  ② **表白名单**：`childKbWritableRegistry` 只有 daily_entries + redemption_requests 两表（ISSUE-105 矩阵「计划/考核/积分状态机绝不开放」）——家长作为管理员没有直修孩子库数据的口子，只能删重建或等专用工具。
- **拍板（2026-09-21）**：家长 db 通道按**管理口径**开放孩子库**全部登记表**（读写皆是；`childKbReadableRegistry` 本就全量，主要是写面）。**孩子 agent 自己的写面红线不变**（`childKbWritableRegistry` 两表，agent 自我服务的口子不放开）。
- **实施**：
  - `db-channel.ts` 新增 `childKbAdminWriteSpecs()`：`childKbTableSpecs()` 全量 + `ops=["insert","update","delete"]` + `rowLimit=50`；`childKbWritableRegistry` 注释标注「仅孩子 agent 自己的写面」。
  - `parent-tools.ts` `buildDbWriteTool` child 分支切到 admin 规格；工具/参数描述改为「管理口径全表可写」+ 风险提示（优先专用工具，直写仅管理兜底）；`parent_db_describe` 孩子库文案同步。
  - `registry-prompt.ts` `buildDataChannelBlocks`（家长 agent 元数据块）孩子库可写表改 admin 规格 + 风险注记；`buildChildSelfBlock`（孩子 agent 自我视角）保持两表白名单。
  - `parent-registry.ts` 家长系统提示同步（全表可写 + 先 read 确认 + 改后复述）。
- **保持不变（护栏仍在）**：列级校验（未登记列拒绝）/ 行数熔断 50 / 事务回滚 / 审计（db_audit）/ 敏感列复述提示 / `daily_entries.plan_id/plan_outcome` 只读列 / `redemption_requests.child_id` 服务端强制。
- **已知边界（直写绕过受控流程，靠审计+复述兜底）**：状态机表（study_plans/exam_plans/points_ledger 等）直写不走完成判定/结算/余额链——`points_ledger` 直插不会重算 `balance_after` 链（可参照 ISSUE-112 heal 的重算口径）；insert 需自带 id/时间戳（specs 未配 serverGenerated）。
- **验证**：新增 `test/issue128-parent-db-write-child.test.ts` 5 用例（①用户原始场景 update study_plans.course_name / ②状态机表 insert / ③未登记列仍拒绝 / ④孩子 agent 写面不变 / ⑤管理规格覆盖全表全 ops），连同 ISSUE-122/123 相关共 16 测试全过；server tsc 零错误。
- **部署状态**：未上 201（随下次发版）。
- **优先级**：中（管理员能力开放；孩子侧红线不动）
- **记录时间**：2026-09-21
