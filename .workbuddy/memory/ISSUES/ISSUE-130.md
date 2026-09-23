# ISSUE-130 家长侧边栏收敛：计划/考核/积分并入孩子详情（对齐孩子端布局）

- **类型**：需求 / 信息架构
- **记录时间**：2026-09-22
- **状态**：✅ 已实施（2026-09-22，见实施记录）

## 需求（用户原话拍板）

1. 调整家长页面左侧边栏，**去掉「学习计划」和「学习考核」**——孩子管理里孩子详情已经有了。
2. 把「**积分**」也合并到孩子详情里。
3. 孩子详情里的**考核计划**，要**按照孩子端的布局展示**，不仅有历史还有未来的。
4. 把家长端孩子详情里「学习计划」改为「**计划**」，展示**每天孩子要完成的事情**，每天的分为**家长制定**和**孩子自己制定**的，**就和孩子端的显示一样**。

## 现状（实施前）

- 家长 Dashboard 侧边栏 11 项：孩子管理/课程管理/题库/**学习计划**(StudyPlanPanel)/​**学习考核**(ExamAdminPanel)/**积分**(RewardPanel)/定时任务/Token/设置/数据管理/报表。
- 孩子详情（ChildDetailPage）tabs：进度/**学习计划**(StudyPlanPanel 只读排期)/每日记录/主题/**考核记录**(ExamRecords 只看已完成)/账号/对话回顾。
- 差距：
  - 考核：家长侧看不到**未来**排期（ExamRecords 仅已完成；ExamAdminPanel 的创建表单早已是死代码——ISSUE-121 结论，创建实际走家长 agent 的 examCreateTool / 孩子自请）；
  - 计划：StudyPlanPanel 是「今天卡片 + 学习域排期表」，没有**三域聚合**、没有**家长制定/孩子自定**分组（孩子端 TodoModal 有，但只看当天且是弹框）；
  - 积分：家长要先去独立页再切孩子。
- 孩子端「今日计划」数据接口 `GET /plans/today?date=` 本就支持任意日期，但**重复计划（plan_recurrences）只在当天由 worker 物化**，直接按未来日期查会漏掉循环任务。

## 方案

1. **服务端** `GET /api/v1/plans/range?childId=&from=&days=`（家长 JWT + 归属校验）：今天起默认 14 天、逐日三域聚合（item 形状与 /plans/today 完全一致）；对 `plan_recurrences` 未来命中日做**只读虚拟展开**（`virtual:true`，exam 规则同 expandRecurrences 口径跳过），当日已有同 recurrence_id 物化行则不重复。核心逻辑放导出函数 `collectPlanRange`（可测）。
2. **electron**：IPC `plans:range` + preload `plansRange(childId, from?, days?)`；**web shim** plans 域同名方法（web-shim-coverage 回归守着）。
3. **新组件 ChildDailyPlans**（孩子详情「计划」tab）：按天分组（今天置顶常显、其余仅列有安排的天），每天分「👨‍👩‍👧 家长制定（必须完成项）」「🧒 孩子自己制定（加分项）」两组，组头带完成计数 x/y；行内：状态图标/域标签/顺延📌/循环🔁/新学复习标签/截止时间。只读（审计修正仍走积分 tab）。
4. **新组件 ChildExamPlans**（孩子详情「考核计划」tab）：孩子端 ExamView pick 页同布局——顶部「今天要做的考核」卡（家长只读，无开始按钮）；下方左「全部考核计划」列表（时间/状态筛选、按距今天近远排序）+ 右详情：状态徽标/考核课程+要点（normalizePlanCourses 双格式兼容，防 ISSUE 前科白屏）；未来=未到考核时间提示、已完成=成绩逐题（得分/评语/听原音）。数据 examSchedules + examAttempts（IPC 均已有）。
5. **ChildDetailPage**：tabs 改为 进度/**计划**/每日记录/主题/**考核计划**/**积分**/账号/对话回顾；「积分」tab 直接复用 RewardPanel（单孩子时隐藏孩子切换器）。
6. **Dashboard**：侧边栏移除 学习计划/学习考核/积分 三项及其 view；随之删除无引用组件 StudyPlanPanel.tsx / ExamRecords.tsx / ExamAdminPanel.tsx。

## 边界说明

- 未来日期的「计划」里，重复规则行是**虚拟展开**（只读预览）；真实状态推进仍由 worker 每天物化，家长看到的状态语义不变。
- 家长不发起考核：ChildExamPlans 无「开始考核」入口，考核仍由孩子在孩子端参加。

## 关联

- ISSUE-033（StudyPlanPanel 初版，本 issue 后组件删除）
- ISSUE-007（ChildDetailPage tabs 架构）
- ISSUE-121（ExamAdminPanel 死代码结论）
- 孩子端 TodoModal（「必须完成项/加分项」分组语义来源，2026-09-10 计划域重构）

---

## 实施记录（2026-09-22）

- **服务端**：`server/src/db/plans-range.ts` 新建——`collectPlanRange(dataDir, parentId, childId, from, days)`：三表窗口聚合（物化行）+ plan_recurrences 逐日命中虚拟展开（daily/weekly、start/end 界、当日已有同 recurrence_id 物化行则跳过；exam 规则跳过）；item 形状与 /plans/today 一致 + `virtual:true`。`routes/plans-rewards.ts` 挂 `GET /api/v1/plans/range`（from 缺省今天、days 夹取 1~31、缺省 14）。
- **electron**：`ipc-handlers.ts` `plans:range`（serverFetch 透传）；`preload.ts` `plansRange`；web shim `domains/plans.ts` 同名方法（web-shim-coverage 通过）。
- **前端**：新建 `src/components/ChildDailyPlans.tsx`（14 天逐日、家长制定/孩子自定两组、完成计数、顺延/循环/新学复习标签）；新建 `src/components/ChildExamPlans.tsx`（孩子端 pick 布局：今天可考核卡 + 全部计划左列表（时间/状态筛选）+ 右详情（课程/要点/未来提示/已完成成绩逐题+听原音））；`ChildDetailPage.tsx` tabs 改「🗓 计划 / 🎯 考核计划 / ✨ 积分」（积分复用 RewardPanel）；`RewardPanel.tsx` 单孩子时隐藏孩子切换器；`Dashboard.tsx` 侧边栏删除 学习计划/学习考核/积分 三项。
- **删除无引用组件**：StudyPlanPanel.tsx、ExamRecords.tsx、ExamAdminPanel.tsx。
- **测试**：新增 `test/issue130-plans-range.test.ts` 4 用例（物化行逐日聚合/循环规则虚拟展开+当日不重复/exam 规则跳过/范围越界夹取）；服务端 tsc 0 错、全量 vitest 通过、客户端 `npm run build` 通过。
