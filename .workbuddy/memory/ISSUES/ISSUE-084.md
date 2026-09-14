# [ISSUE-084] agent 工具 / 后端方法的命名未体现目标库表，可读性差（命名优化）

- **类型**：架构 / 代码质量 / 可维护性
- **优先级**：已解决
- **状态**：✅ 已解决（2026-09-13）—— 采用方案 B（动作+显式目标，统一 parent_/child_ 前缀）
- **记录时间**：2026-09-13
- **标签**：`命名规范` `agent-tools` `db` `可维护性`

---

## 一、问题要点

agent 工具与后端数据操作方法的**命名未能体现其实际读写的目标库 / 表**，仅从名称无法判断该工具落到哪个库、哪张表。这会误导维护者（误以为在写 A 库，实际写 B 库），也让孩子端工具、服务端工具、worker 方法的语义边界模糊。

典型反例：

- **`parent_plan_create`**：名称含 `parent`（像写家长库），但实际写入的是**孩子库 `kb/*.sqlite` 的 `life_plans` 表**。从名称完全看不出它写给 `life_plans`，更看不出是写孩子库。
- **`parent_*` 前缀的工具群**：如 `parent_upsert_topic` / `parent_upsert_course` 实际写的是**家长库 `parent.sqlite`**（这部分命名对）；但 `parent_plan_create` / `parent_content` 等又混合指向孩子库或跨库读取，前缀语义不统一。
- **`kb_insert` / `kb_update`**：名称只说"kb"，未表明写的是孩子库 `courses` 表的进度字段（而非课程内容）；读者需进实现才能确认"只写 status/material/tags、不含课程内容"。
- **`parent_content`**：命名像"家长内容"，实际是**孩子端会话**用来读取家长库课程内容的只读工具，归属与语义错位。
- **`exam_schedule_create`** 写主库 `exam_schedules`，但同模块还有 `exam_fixed`（配置）与上报路径 `exam_attempts`，命名未形成统一的"库-表-动作"层次。

## 二、影响范围

- **维护者阅读工具清单**：家长/孩子会话挂载的 agent 工具名列表（如 `PARENT_AGENT_TOOL_NAMES`、`CHILD_AGENT_TOOL_NAMES`、worker 工具）无法从字面值判断数据落点，定位"某张表的写入方"需逐个进实现查。
- **误用风险**：名称误导可能导致后续在错误会话错误地调用工具、或误以为某库已写/未写。
- **文档一致性**：技术文档的「工具说明（数据库读写）」小节需费额外篇幅逐条澄清"名称 vs 实际落库"，本应可由命名自解释。

## 三、已实施（2026-09-13，采用方案 B：动作 + 显式目标，统一 `parent_` / `child_` 前缀）

对计划域三个子域（学习 / 生活 / 考核）做对称重命名，每个 agent 只用自己的前缀，名称自带"谁在用 + 哪个域 + 什么动作"：

**家长 agent（`parent-plans.ts`，挂载于家长会话）**
- `parent_list_children`（读主库 `children`）
- `parent_study_plan_sources` / `parent_study_plan_create` / `parent_study_plan_list` / `parent_study_plan_get` / `parent_study_plan_update`（孩子库 `study_plans`）
- `parent_life_plan_create` / `parent_life_plan_list` / `parent_life_plan_update`（孩子库 `life_plans`）
- `parent_exam_plan_create` / `parent_exam_plan_list` / `parent_exam_plan_cancel`（主库 `exam_schedules`，cancel 为 ISSUE-085 新增）

**孩子 agent（`plan-tools.ts`，挂载于孩子会话）**
- `child_study_plan_list` / `child_exam_plan_list` / `child_life_plan_list`（只读，按 from/to 窗口）
- `child_life_plan_create` / `child_life_plan_update`（写孩子库 `life_plans`，且 update 仅限 `creator=child` 行）

**命名规范落地为**：`<归属>_<域>_plan_<动作>`（归属 = parent / child；域 = study / life / exam；动作 = create / list / get / update / cancel）。**未采用** `<库简写>_<表名>_<动作>`（原方案 A）——因为 agent 工具的"归属"信息（哪个端在用、权限边界）比"库表"信息对模型与维护者更关键，且库表名（study_plans/life_plans/exam_schedules）已在域词中体现。

同步范围：`parent-plans.ts`、`plan-tools.ts`、`session-registry.ts`（import + customTools + `computeChildToolNames` 白名单）、`parent-registry.ts` 与 `prompt.ts` 的提示词、路由注释、`electron/preload.ts` 注释、技术文档相应章节。

## 四、评估记录（原方案对比）

1. 方案 A（库-表-动作三段式，如 `kp_life_plan_create`）：名称可定位库表，但丢失"哪个端在用/权限边界"，且库表名已在域词中体现——未采用。
2. **方案 B（本 issue 采用）**：`parent_*` / `child_*` + 域 + 动作，改动可控且两端对称。
3. 方案 C（不改名，只补文档/元信息）：最小改动但"名称自解释"目标未达成——未采用；文档侧的「工具说明」小节仍保留为映射表（附录 A 为权威清单）。

## 五、关联

- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md`（附录 A 及每模块「工具说明（数据库读写）」小节 = 工具名 → 库.表 → 读写字段的权威映射表）。
- `ISSUE-085`（考核场次取消；新增 `parent_exam_plan_cancel` 已按本规范命名）。
- 与 `ISSUE-082`（提示词解耦）、`ISSUE-083`（提示词收敛）正交——本 issue 只治理"工具命名可读性"，不触及提示词内容。
- 验证：server `tsc --noEmit` + esbuild 通过；`dist/server.cjs` 含全部 `parent_*` / `child_*` 工具名与白名单；`server/src` 与文档中已无旧名（`study_plan_*` / `life_plan_*` / `exam_schedule_create` / `get_today_plan`）残留（历史表 `study_plan_items` 是不同对象，保留）。
