# [ISSUE-091] 孩子无法通过 AI 创建「学习 / 考核」计划（+ 重复规则无创建入口 + 两个孤儿 REST 落库端点）

- **类型**：功能缺口（与用户使用说明书 §3.4 / §3.6 不符）
- **优先级**：P1（说明书明确承诺"学习/考核/生活三种计划孩子都能自己定"，当前只实现了生活计划）
- **状态**：✅ 已解决（2026-09-14，补 `child_study_plan_create` / `child_exam_plan_create`（creator=child、task_type=optional）+ `parent_recurrence_create/list/update`（补 `plan_recurrences` 写入入口），并接入孩子/家长会话白名单与提示词）
- **记录时间**：2026-09-13
- **标签**：`计划域` `child-agent` `加分项` `plan_recurrences` `孤儿端点`

---

## 一、说明书要求（真源：`学习伙伴-用户使用说明书.md`）

- §3.4：「家长与孩子**都可以通过各自的 AI 伙伴对话**来编排计划」「孩子也可以对自己 AI 说『我想每天练 10 分钟书法』」。
- §3.4 制定人分组：「**加分项 = 孩子自己制定的计划**」。
- §3.4 / §3.6 §FAQ：「**学习 / 考核 / 生活计划孩子都可以自己定**」（多处重复）。
- §3.6：「加分项」只加不扣，需满足门控；即"孩子自建 → creator=child → 自动进 `childTodo` / `childExam` 分组"。

## 二、代码现状（缺什么）

### 1. 孩子 agent 只有「生活计划」的写工具

`plan-tools.ts` 实际挂载（`computeChildToolNames` 白名单同步）：

| 工具 | 能力 |
|---|---|
| `child_study_plan_list` | 只读（今日/窗口内学习计划） |
| `child_exam_plan_list` | 只读（今日/窗口内考核场次） |
| `child_life_plan_create` / `child_life_plan_list` / `child_life_plan_update` | **可建/可改**（`creator='child'`、`task_type='optional'`） |
| `parent_content` | 只读家长库课程内容 |

→ **缺 `child_study_plan_create` 与 `child_exam_plan_create`**：孩子说"我想每天练书法/明天想考英语食物课"，学习与考核这两类**无法落库**。

### 2. 数据模型与计分机制其实已经就绪（无需改 worker）

- 三张计划表都有 `creator`（`DEFAULT 'parent'`）与 `task_type`（`required`/`optional`）。
- `settleRewards` 的分组键就是 **creator**：`computeGroupStats(kb, "study_plans"|"life_plans", "child", date)` 合并为 `childTodo`，`computeExamRate(kb, "child", date)` 为 `childExam` → 门控与加分档已按「加分项」判定。
- 也就是说：**只要把两个创建工具补上（写 `creator='child'`、`task_type='optional'`），加分项链路自动生效**，worker/统计/门控都不用改。

### 3. 服务端已有落库 REST，但**没有调用方**（孤儿）

| 端点 | 设计意图（代码注释） | 现状 |
|---|---|---|
| `POST /api/v1/plans/exam` | 「孩子端 agent `plan_exam` 工具的落库入口（孩子自请考核，安排而非发起）」，写 `exam_plans`：`creator='child'`、`kind='self'`、`task_type='optional'`、`scope_json='{}'`，同天同名去重 | 全仓**无调用方**（客户端不调、agent 工具已不存在） |
| `POST /api/v1/plans/life` | 「孩子端 `plan_life` / 家长端 `parent_life_plan_create` 共用」（`creator` 默认 child） | agent 侧已改走 `child_life_plan_create` 直写库；此端点客户端亦不调 → 实际上被绕过 |
| `POST /api/v1/study-plans` | 注释「家长 agent `parent_study_plan_create` / 孩子端 `plan_study`」，body 带 `creator?` | 家长端已改直写库；**孩子端 `plan_study` 工具不存在** → 孩子路径无调用方 |

→ 9/13 的 `parent_*` / `child_*` 前缀重构（ISSUE-084）把孩子的 `plan_study` / `plan_exam` 工具收掉时，**只保留了 life 的 create/update**，学习与考核的创建能力随之丢失；REST 侧留下三个无人调用的端点。

### 4. 另一个相关缺口：重复规则无创建入口

说明书 §3.4：「**重复规则（plan_recurrences）：可设置每日 / 每周固定项**（如「每天背 5 个单词」），系统每天自动展开成当天的计划行」。

代码：worker `expandRecurrences` 只**读** `plan_recurrences`（`enabled=1`）并把命中当天的规则展开成 `life_plans` / `study_plans` 行；**全仓没有任何 `INSERT INTO plan_recurrences`**（没有 agent 工具、也没有 REST 路由）→ 用户**无法设置**重复规则，该功能只有"展开半边"。

## 三、修复方向（待实施）

1. **补两个孩子 agent 工具**（改动小、无 schema 变更）：
   - `child_study_plan_create`：按 `course_name` 解析 `topic_key`/`course_uuid`（复用 `buildCourseLookup` 思路或走家长库反查），写 `study_plans`，`creator='child'`、`task_type='optional'`、`origin='conversation'`、窗口=指定日期（`date` 缺省今天）、`mode` 支持「复习：」前缀。
   - `child_exam_plan_create`：写 `exam_plans`，`creator='child'`、`kind='self'`、`task_type='optional'`、`scope_json='{}'`（与既有 `/plans/exam` 一致；考核实际发起仍在考核页）。
   - 同步 `computeChildToolNames` 白名单 + 孩子端 prompt 指令（当前 prompt 只提"今日计划"，未提可自建学习/考核）。
2. **决定三个孤儿的去留**：`POST /plans/exam` 与 `POST /plans/life` 可**保留作为 agent 工具的落库实现**（工具内部调 HTTP 或直接复用同一 SQL），或直接删除、统一"agent 直写库"；`POST /study-plans` 的 `creator` 分支同理。
3. **重复规则入口**（可选，需评估产品形态）：给 agent 补 `parent_plan_recurrence_create`（或孩子端只读展示），或在 UI 侧补"设为每日/每周"开关；否则说明书该条应删除。
4. **权限边界**：孩子自建项一律 `task_type='optional'`（只加不扣），且**不可修改家长项**（与 `child_life_plan_update` 的 `creator='child'` 边界保持一致）。

## 四、关联

- 说明书 `学习伙伴-用户使用说明书.md` §3.4（计划总述 + 制定人分组 + 重复规则）、§3.5.1（排考核）、§3.6 / §FAQ（加分项与门控）。
- 技术实现文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §5.1 / §5.2 / §5.4 / §17。
- `ISSUE-084`（工具前缀重构 —— 本缺口即该次重构的副作用）、`ISSUE-089`（家长侧主题/课程工具未挂载，同类"工具漏挂/漏补"）。
- 代码真源：`server/src/agent/plan-tools.ts`（孩子工具集）、`server/src/agent/session-registry.ts`（`computeChildToolNames`）、`server/src/routes/plans-rewards.ts`（`/plans/life`、`/plans/exam`）、`server/src/routes/study-plans.ts`（`/study-plans` 创建 + `creator`）、`server/src/worker/plan-domain.ts`（`expandRecurrences` / `settleRewards` 的 creator 分组）。
