## [ISSUE-065] 选课机制重构：固定档必学全考/自定义须课程/下线长周期档（2026-09-09）
- **类型**：产品规则调整（三个目标 + 数据清理）
- **目标**：
  1. 固定档（每天/每周）：候选=计划周期内「必学」课程全部考核——内置规则、不再走选课 LLM/prompt；「选学」明确标注的排除，未标注类型按必学纳入（兼容历史数据）。家长想改范围/考选学 → 用自定义经家长助手。
  2. 自定义考核：不允许家长手动填考核规则；由家长 agent `exam_schedule_create` 把描述解析为**精确课程名**填 scope.courses（必填）；考核 config 只按 courses 出卷，不再有运行时选课。
  3. monthly/halfyear/yearly 档下线（本为旧数据兼容），历史排期不可再考。
- **改动**：
  - server/src/routes/exam.ts：schedule config 分支重写——custom 无 courses → 400 提示重新安排；fixed daily/weekly → listPlanCourseMeta 窗口内 topicType!=='选学' 的课程直接 fetch rubric（附 unmatched）；monthly+ → 400 已下线；coursesParam 兼容第二段。DEFAULT_SELECTION_PROMPTS 清空 long 档、daily/weekly 改内置说明（遗留兼容字段，新逻辑不读取）。
  - src/components/ExamAdminPanel.tsx：daily/weekly 去掉选课规则 prompt 编辑（固定规则说明）；custom 页改只读（引导对话创建），saveFixed 上送 selectionPrompts 清空。
  - electron/lib/custom-tools.ts：exam_schedule_create courses 必填（精确课程名），description/execute 强约束。
  - 数据清理：删除 exam_schedules 旧自定义无 courses（5 行，含珊珊 started 9/8 场）与 monthly+（0 行）；备份 data/exam-schedules-backup-20260909.json。
- **验证**：server tsc 0 错、client tsc 0 错、electron-vite build 通过。待用户本地联调：固定档点考核 → 直接给 plan 必学课；自定义无课程旧排期已清。
- **遗留**：ExamAdminPanel 旧 custom 表单 handlers/state 与 exam.ts 的 buildSelectionPrompt/listLearnedCourseMeta 等为未引用死代码（noUnused 未开不影响编译），后续清理。
- **记录时间**：2026-09-09
