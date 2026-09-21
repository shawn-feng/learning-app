# ISSUE-121：为什么考核计划一天只能有一条「未考」的？——✅ 已解决（2026-09-21 拍板 B+命名：考核取名、同日同名去重、不同名可同天多场）

- **类型**：设计澄清 / UX 语义（考核计划创建的去重约束；待产品拍板是否演进）
- **问题**：为什么考核计划一天只能有一个未完成的（未考的）考核计划存在？
- **限制在哪（已核实代码，两处同款守卫）**：
  1. **家长 agent 工具** `parent_exam_plan_create`（`parent-plans.ts:805-812`）：插入前查 `exam_plans WHERE child_id=? AND kind='custom' AND creator='parent' AND active=1 AND status='pending' AND substr(start_at,1,10)=?`——命中即**跳过创建**，返回「已有一条未考的自定义考核计划，未重复创建（**需更换内容请先取消原计划**）」（工具描述 `:713` 同步声明）。
  2. **管理面板 REST** `POST /exam/schedules`（`routes/exam.ts:1087-1092`）：同款查询，命中后返回 **`{ok:true, id:旧计划id, duplicated:true}`**——**静默复用旧计划**，家长在新创建里填的新内容被丢弃且界面表现为"创建成功"。
- **为什么存在（设计动机）**：
  - **防重复兜底**：创建入口有 agent LLM 参与（对话创建可能因重试/口误重复触发），一条"每天最多一条未考"的粗守卫保证幂等，成本最低；
  - **「一天一场考试」的产品语义**：自定义考核时间区域固定为当天 00:00~23:59，孩子端考核页按计划进考试——设计假设当天一场、考完即 done（done/取消的不占名额，重考计划 ISSUE-115 也因此无冲突：创建时原计划已 done）。
  - **范围澄清（不受限的路径）**：固定考核（kind='fixed'，worker 从配置生成）不受影响；**孩子自请**（`child_exam_plan_create`）只做"**同日同名**跳过"（plan-tools.ts:501），同天可多条；done/cancelled/active=0 不占名额。另注：自定义考核 title 在两条 INSERT 里**硬编码『自定义考核』**（parent-plans.ts:819 / exam.ts:1102-1104）——家长计划连"同名去重"都做不了，这也是守卫只能按天粗去重的一个原因。
- **问题点（为什么要记 issue）**：
  ① **同天多场不同内容被一刀切**：家长想上午考语文背诵、下午考数学（或给孩子加考一场），无路可走，只能先取消再重建（agent 至少有提示，面板则完全无感）；
  ② **REST 静默复用是误改陷阱**：家长想**修改**当天考核内容 → 面板重新创建 → 返回 `duplicated:true` + 旧 id → 界面成功、内容没变——家长以为改好了，孩子考的还是旧内容；
  ③ agent 侧工作流别扭：改内容必须"先取消原计划"两步走。
- **候选演进（需产品拍板）**：
  - **A（推荐）替换语义**：同日已有 pending 自定义计划时不再跳过，而是**取消旧 + 创建新**（保留审计：旧计划 active=0），"改内容=重新创建"零成本；REST 响应带 `replaced:旧id`，界面提示「已替换当日原计划」。防重复目标由"内容相同才跳过"承接（scope_json 归一化比对，ISSUE-104 已有 parsePlanCourses 基建）。
  - **B 放开同日多条**：允许多条 pending 并存（去重改为"同日同 scope 跳过"），孩子端当天列多个考核入口——产品语义变化最大，需确认孩子端考核入口/待考角标（`getExamPending`）对多计划的展示。
  - **C 最小修**：维持一天一条不动，仅修 ②——REST `duplicated:true` 时面板必须明确提示"当日已有计划，未做修改"，消除静默误改。
- **回归**：A/B 均不得影响固定考核、重考链路（ISSUE-115）、`computeExamRate` 归属日统计（多条 done 同天时得分率合并口径本来就不限一条）；孩子端 ExamView 取"当天 pending 计划"的逻辑需随所选方案核对。
- **优先级**：中（②是静默丢内容的真实陷阱；①是产品能力缺口，拍板后改动量小）
- **记录时间**：2026-09-21


---

## ✅ 解决记录（2026-09-21，按用户拍板实施：取名 + 同日多场）

- **① 考核取名（不再硬编码「自定义考核」）**：
  - agent 工具 `parent_exam_plan_create` 加 `name` 参数（描述引导：同天多场靠名字区分，如上午语文背诵、下午数学口测；缺省「自定义考核」）；INSERT title 用 name（`parent-plans.ts`），成功返回带名称。
  - REST `POST /exam/schedules` 收 `body.name`/`scope.name`（`routes/exam.ts`），INSERT title 同步；响应带 `name`。
- **② 同日多场（去重收窄为「同日同名」）**：两处守卫同款修改——dup 查询加 `AND title = ?`；不同名未考计划同天并存（与孩子自请 `child_exam_plan_create` 的「同日同名跳过」语义对齐）。agent 跳过话术更新：「已有同名未考考核…换一个名字可同天多场；需更换内容请先取消原计划」。
- **核实不 regress 的面**：孩子端 ExamView 当天 pending 按列表渲染（`todayOpen.map`，无单条假设）；`computeExamRate` 多条 done 同天合并求和本来就不限一条；固定考核（kind=fixed）与重考链路（ISSUE-115，确定性 id、创建时原计划已 done）均不受影响；孩子自请（creator=child）语义原样。
- **调查附带发现（未修，另行跟进）**：管理面板 `ExamAdminPanel` 的自定义考核**新建/编辑表单已是死代码**（左右布局重构后 JSX 不再渲染输入框，`saveCustom`/`startCreate` 无引用），且其残留 scope 格式（topics/prompt）与现行路由（scope.courses，ISSUE-104）不匹配——面板创建入口实际已不存在，考核创建只剩家长 agent 对话一路。面板如需恢复创建/编辑 UI，需按 ISSUE-104 courses 口径重做（新 issue 候选）。
- **验证**：新增 `test/issue121-exam-name.test.ts` 4 用例（带 name 落库 title / 同日同名跳过 / 同日不同名并存 / 缺省名与具名互不干扰），连同 ISSUE-112/115/116、exam、plan-scope 共 47 测试全过；server tsc 零错误。
