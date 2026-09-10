# 计划域重构设计（DESIGN-plan-domain-rewrite）

> 版本：2026-09-10 草案（待评审）
> 依据：`需求盘点-三大需求场景分析-2026-09-10.md` §10~§13 的评估与定案
> 状态：**设计稿，未实施**。评审通过后按 §11 分期执行。

## 0. 已定案（复述，避免歧义）

| # | 定案 | 出处 |
|---|---|---|
| 1 | **三张独立计划表**（学习/考核/生活） | §10 |
| 2 | **历史数据迁进新表** | §10 |
| 3 | 掌握度**只取最近一次考核**；学习状态**只查最近学习时间** | §12.1 |
| 4 | `courses.mastery` 直接删除 | §13 |
| 5 | 生活计划**不允许勾选**，由 LLM 判定；daily 记详情供家长事后审计 | §13 |
| 6 | recording 是兜底：**不操作三表**，写 daily 带 `plan_id`；stat 据此更新三表 | §13 |
| 7 | 事件载体 = **daily_entries + plan_id + plan_outcome**，不新建事件表 | §13.6 |
| 8 | 三表状态**唯一写入者 = stat**；agent/recording 只写证据 | §13.1/§13.6 |
| 9 | 家长**修正权必需**（撤销 done→missed / 标 exempt） | §13.3 |

## 1. 目标模型（三层）

> **库归属（17:45 定案）**：**内容在家长库**（课程/题库/资料，跨孩子共享）；**孩子的记录在孩子库**（计划/考核成绩/进度/daily/统计）——"学习考核表本来就是孩子的学习考核记录"。因此**三张计划表 + 考核明细 + 排期规则 + 统计表全部落在孩子 kb**；服务端主库只留账号、孩子名册、资料索引、调度状态等跨孩子数据。
> **展示名（18:35 定案）**：计划表 `creator='parent'` 面向用户称**「必须完成项」**（孩子必须完成、未达标会扣分）；`creator='child'` 称**「加分项」**（只加不扣、受门控）。详见 `DESIGN-reward-points` §3.6 术语对照。
> **由此的直接收益**：`courses`（孩子库）+ 计划表（孩子库）+ `daily_entries`（孩子库）**同库**，**掌握度/学习状态可以建 SQL 视图**（原 B 的跨库问题消失）。

```
计划层（意图）——孩子 kb
  study_plans   一行 = 一次学习任务（一课 + 窗口 + 制定人 + 状态 + 结果）
  exam_plans    一行 = 一次考核（场次头：状态 + 综合得分 + attempt 引用）
  life_plans    一行 = 一项生活安排（描述 + 窗口 + 制定人 + 状态 + 结果）
  exam_plan_courses  考核明细（课程/知识点范围 → 开考回填题目与得分）
  plan_recurrences   重复规则（自动排期：每日/每周固定项 → 展开成上表行）

排期层（展开）
  plan_recurrences 由 worker 每天展开：命中规则的日期 → 写入对应计划表的行（origin=recurrence）

执行层（判定与统计）——孩子 kb
  daily_entries(+plan_id, +plan_outcome)  过程记录（唯一真源，recording 写）——**当前仅生活计划用它做证据**
  reward_daily_stats                        每日统计（完成率/连续天数；积分输入）
  course_progress（视图，同库可建）        掌握度 = 最近一次考核；学习状态 = 最近学习时间
```

**关键取舍（本次设计的核心简化）**：
1. **carry 保留但换形态：`missed` + 复制新计划**（17:30 定案，取代原"取消 carry"）：窗口到期未完成 → **原行判 `missed`（历史留痕、扣分依据）**，同时**复制一条新计划到当天**（`start_at=due_at=今天`、`origin='carry'`、新 id、`status='pending'`，其余字段照抄）。**延后时窗口一律当天，不继承原窗口**——不管原计划是否跨天。
   - **扣分口径（17:40 定案 + 18:05 修订）**：**按"当天 missed 的比例"扣分**（即完成率命中积分负分档），**不按 missed 条数逐条扣**；每天独立结算、carry 复制来的是新 `pending`（不计 missed），故不会重复扣分。"不设上限"= 负分档按天累积、不封顶。
   - **`cancelled`（家长取消）是唯一的止损手段**（17:40 定案）：**只有家长**可以取消计划（孩子不可）；取消后**不再 carry**（否则又生成新行），且不计入完成率分母。此状态即原"exempt（豁免）"，**统一命名为 `cancelled`**。
   - 手动顺延仍可由家长/孩子经 agent 显式改 `due_at`（与自动 carry 两条路径并存）。
2. **todolist 不再落表**：孩子端"今天要做的事" = 查三表中「窗口覆盖今天且未判定」的行，UNION 输出。
3. **状态与判定在计划行上**，不引入 plan/instance 双表（重复项由展开直接生成计划行，每天一行自然可判、streak 可连续）。

## 2. DDL（**孩子 kb** `kb/<parentId>/<childId>.sqlite`）

> 位置：**孩子库**（17:45 定案：计划/考核记录/生活记录都是孩子的记录，与 courses/daily_entries 同库）。
> 时间字段：**`start_at` / `due_at` 精确到时间**（`YYYY-MM-DD HH:mm:ss`）——**只给日期时 `due_at` 补全为当天 `23:59:59`**、`start_at` 补 `00:00:00`（17:45 定案 D；不再单独设 `due_time` 列）。
> 沿用幂等迁移（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` + meta 标记）。

```sql
-- ===== 学习计划（一行 = 一次学习任务，一课一行）=====
CREATE TABLE IF NOT EXISTS study_plans (
  id           TEXT PRIMARY KEY,              -- uuid
  parent_id    TEXT NOT NULL,
  child_id     TEXT NOT NULL,
  topic_key    TEXT NOT NULL DEFAULT '',
  course_uuid  TEXT NOT NULL DEFAULT '',      -- 课程真引用（§6 P1 的落点）
  course_name  TEXT NOT NULL DEFAULT '',      -- 展示冗余（旧数据兼容/可读）
  mode         TEXT NOT NULL DEFAULT 'new',   -- new | review
  creator      TEXT NOT NULL DEFAULT 'parent',-- parent | child（制定人）
  origin       TEXT NOT NULL DEFAULT 'conversation', -- conversation | recurrence | carry | migration
  carry_from   TEXT NOT NULL DEFAULT '',      -- 由哪条 missed 计划复制而来（carry 溯源）
  recurrence_id TEXT NOT NULL DEFAULT '',     -- 由重复规则展开时记录
  start_at     TEXT NOT NULL DEFAULT '',      -- 窗口开始（YYYY-MM-DD HH:mm:ss；仅日期则 00:00:00）
  due_at       TEXT NOT NULL DEFAULT '',      -- 计划完成时间（YYYY-MM-DD HH:mm:ss；仅日期则 23:59:59）
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | done | missed | cancelled
  result       TEXT NOT NULL DEFAULT '',      -- 轻量执行结果摘要（详情在 daily）
  done_at      TEXT NOT NULL DEFAULT '',
  -- 积分预留（P0 字段落到计划行上；生活/考核同字段）
  task_type    TEXT NOT NULL DEFAULT 'required', -- required | optional
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points       INTEGER NOT NULL DEFAULT 0,    -- 选做项单件积分
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sp_child_window ON study_plans(child_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_sp_course ON study_plans(course_uuid);

-- ===== 考核计划（场次头）=====
CREATE TABLE IF NOT EXISTS exam_plans (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT NOT NULL,
  child_id     TEXT NOT NULL,
  creator      TEXT NOT NULL DEFAULT 'parent',
  kind         TEXT NOT NULL DEFAULT 'fixed',  -- fixed | custom
  freq         TEXT NOT NULL DEFAULT '',       -- daily | weekly | ''（custom）
  scope_json   TEXT NOT NULL DEFAULT '{}',     -- fixed 规则 / custom note+methodSpec
  origin       TEXT NOT NULL DEFAULT 'conversation',
  recurrence_id TEXT NOT NULL DEFAULT '',
  start_at     TEXT NOT NULL DEFAULT '',       -- 可参加窗口开始（日期则 00:00:00）
  due_at       TEXT NOT NULL DEFAULT '',       -- 可参加窗口截止（日期则 23:59:59）
  status       TEXT NOT NULL DEFAULT 'pending',-- pending | done | missed | cancelled
  attempt_id   TEXT NOT NULL DEFAULT '',       -- 结果引用（真源=考核明细）
  score        REAL,                           -- 综合得分（回填快照）
  result       TEXT NOT NULL DEFAULT '',
  done_at      TEXT NOT NULL DEFAULT '',
  task_type    TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points       INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ep_child_window ON exam_plans(child_id, status, due_at);

-- ===== 考核计划课程明细（范围 + 开考回填结果）=====
CREATE TABLE IF NOT EXISTS exam_plan_courses (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL,                  -- exam_plans.id
  course_uuid  TEXT NOT NULL,
  course_name  TEXT NOT NULL DEFAULT '',
  category_id  TEXT NOT NULL DEFAULT '',       -- 考核类别（出题构成用）
  knowledge_point_id TEXT NOT NULL DEFAULT '', -- 考点范围（计划期填）
  question_id  TEXT NOT NULL DEFAULT '',       -- 开考抽题后回填
  point_got    REAL,                           -- 回填
  point_max    REAL,
  score        REAL,                           -- 单题得分（回填）
  seq          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epc_plan ON exam_plan_courses(plan_id, course_uuid);
CREATE INDEX IF NOT EXISTS idx_epc_kp ON exam_plan_courses(knowledge_point_id);
-- 幂等：同一计划同一课程同一题只一行（question_id 为空时按 (plan,course,kp,category) 去重由应用层保证）

-- ===== 生活计划 =====
CREATE TABLE IF NOT EXISTS life_plans (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT NOT NULL,
  child_id     TEXT NOT NULL,
  title        TEXT NOT NULL,                  -- 具体描述
  creator      TEXT NOT NULL DEFAULT 'parent', -- parent | child（孩子自规划落点）
  origin       TEXT NOT NULL DEFAULT 'conversation',
  recurrence_id TEXT NOT NULL DEFAULT '',
  start_at     TEXT NOT NULL DEFAULT '',       -- 窗口开始（日期则 00:00:00）
  due_at       TEXT NOT NULL DEFAULT '',       -- 计划完成时间（日期则 23:59:59）
  status       TEXT NOT NULL DEFAULT 'pending',-- pending | done | missed | cancelled
  result       TEXT NOT NULL DEFAULT '',
  done_at      TEXT NOT NULL DEFAULT '',
  task_type    TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points       INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lp_child_window ON life_plans(child_id, status, due_at);

-- ===== 排期（重复规则，自动排期用）=====
CREATE TABLE IF NOT EXISTS plan_recurrences (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT NOT NULL,
  child_id     TEXT NOT NULL,
  plan_type    TEXT NOT NULL,                  -- study | exam | life
  payload_json TEXT NOT NULL DEFAULT '{}',     -- 模板：course_uuid/title/必做选做/积分/scope 等
  rule         TEXT NOT NULL DEFAULT 'daily',  -- daily | weekly
  weekday      INTEGER,                        -- weekly：0=周日..6=周六
  start_date   TEXT NOT NULL DEFAULT '',
  end_date     TEXT NOT NULL DEFAULT '',
  last_expanded_date TEXT NOT NULL DEFAULT '', -- 展开幂等游标（只补未展开日期）
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ===== 每日统计（由积分域统一承担：见 DESIGN-reward-points §五 reward_daily_stats）=====
-- 原计划的 plan_daily_stats 已并入积分域的 reward_daily_stats(child_id, date, source, owner, ...)：
--   需按「来源(todo|exam) × 制定人(parent|child)」分组统计，单一 (child_id,date) 主键无法表达。
--   本设计不再单独建统计表，统计统一落在 reward_daily_stats（积分结算直接消费它）。
```

**孩子 kb 侧（`daily_entries` 加两列）**：

```sql
ALTER TABLE daily_entries ADD COLUMN plan_id TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_entries ADD COLUMN plan_outcome TEXT NOT NULL DEFAULT ''; -- done | missed | unknown
```

**视图（掌握度 + 学习状态）**：

```sql
CREATE VIEW IF NOT EXISTS course_progress AS
SELECT c.topic, c.title, c.uuid AS course_uuid,
  -- 掌握度：最近一次考核（该课的最近场次得分率）
  (SELECT p.done_at FROM exam_plans p
     JOIN exam_plan_courses ec ON ec.plan_id = p.id AND ec.course_uuid = c.uuid
    WHERE p.status='done' ORDER BY p.done_at DESC LIMIT 1) AS lastExamAt,
  (SELECT ROUND(SUM(ec.point_got)*1.0/NULLIF(SUM(ec.point_max),0),4)
     FROM exam_plan_courses ec JOIN exam_plans p ON p.id=ec.plan_id
    WHERE ec.course_uuid=c.uuid AND p.status='done'
    GROUP BY ec.plan_id ORDER BY MAX(p.done_at) DESC LIMIT 1) AS lastExamRate,
  -- 学习状态：最近学习时间（只报时间）
  (SELECT MAX(s.done_at) FROM study_plans s
    WHERE s.course_uuid=c.uuid AND s.status='done') AS lastLearnedAt
FROM courses c;
```

> 说明（**17:45 定案 B：视图直接建在孩子 kb**）：计划表、`exam_plan_courses`、`daily_entries`、`courses` **同在孩子库**，因此该视图**可在孩子 kb 内直接创建**，无需跨库聚合、也不需要在服务端拼装。`/courses/status` 接口照旧对外提供，内部改为读该视图（输出口径改为 `lastLearnedAt` + `lastExamRate/lastExamAt`）。
> ⚠️ 注意：`exam_plan_courses` 引用的 `question_bank`/`knowledge_points`（内容）仍在**家长库**——跨库仅逻辑引用、无外键，与现状一致。

## 3. DDL（家长库：删除 mastery 残留）

```sql
-- ensureParentColumns / PARENT_SCHEMA_TABLES 同步：courses 去掉 status/mastery/first_learned/last_review/review_count
-- 迁移（幂等）：DROP VIEW IF EXISTS topic_progress; 再逐列 ALTER TABLE courses DROP COLUMN ...
```
（清理清单见 §9）

## 4. worker 改造清单

| 任务 | 现状 | 改造后 |
|---|---|---|
| `runTodoGenServer`（plan tick） | study_plan_items → 物化 todo_items | **取消物化**；改为 `expandRecurrences`：把 plan_recurrences 命中日期展开成三表行（origin=recurrence，写 last_expanded_date 幂等） |
| `runTodoStatServer`（stat tick） | 读 courses 变化 → 回写 plan.status + 勾 todo_items + 汇总 child_todo_stats | **重写**：①学习类：课程有学习发生（最近学习时间）→ 按窗口匹配 `study_plans` → `done` + **回写该日 daily 学习条目的 `plan_id`**；②考核类：有 attempt 提交 → `done`+score（提交路径直写，stat 只汇总）；③生活类：**查 daily_entries（`plan_id` 非空 + `plan_outcome='done'`）→ done**；④到期未完成 → `missed` **并复制新计划到当天（carry）**；⑤汇总 reward_daily_stats |
| `carry` | 未完成排期顺延到明天（新建行） | **保留但重构**：不再在 plan tick 顺延，改由 stat 判 `missed` 时**复制新行到当天**（`origin='carry'`、窗口=当天，见 §1 取舍 1） |
| `recording` | 写 daily（单源）；已用 todo_list 核对孩子自定任务 | prompt **只注入当天生活计划清单**（uuid/标题/窗口）；核对范围收窄为生活计划；输出 `plan_id` + `plan_outcome`；状态一律不写（stat 写）。学习/考核均不经 recording（见 §11） |
| `summarize_conversation`（孩子 agent 按需汇总） | 按天汇总写 daily | 与 recording 同一管线；**同样只处理生活计划**；**只判当天/窗口内，不得回溯改已结算状态** |
| 新增：`applyPlanEvents`（stat 内步骤） | — | 读今日 daily 证据 → 更新三表状态（幂等：`worker_state` 加 `plan_apply.last_key`） |

**⚠️ 库归属带来的访问方式变化（17:45 定案）**：计划表在孩子 kb 后，worker 与家长端/agent 的**所有计划读写都要走 kb RPC**（`runKbQuery/runKbExec`），不能再直连主库 SQL（现状 `study_plan_items`/`exam_schedules` 是主库直查）。需要：
1. 在 kb registry **新增 `plan.*` op 系列**（list/today/insert/updateStatus/adjustWindow/expireAndCarry/stats.upsert），读 op 放 queryHandlers、写 op 放 execHandlers（放错 registry 运行时报错——既有红线）；
2. `/today`、`/study-plans` 等路由改为按 childId 走 kb op；
3. **家长端"跨孩子"展示**需按孩子逐个查（原来一条 SQL 可按 parent_id 跨孩子查计划）——家长端本就是"选中某个孩子"的视图，影响可控，但**审计/统计类跨孩子汇总**要在服务端做循环聚合。

## 5. 迁移映射（历史数据）

| 旧 | 新 | 映射规则 |
|---|---|---|
| `study_plan_items` | `study_plans` | 保留 id；`date`→`start_at=due_at=date`；mode/origin/status/done_at/active 直迁；`course_uuid` 按 (topic_key, course_name) 从家长库 `courses.uuid` 回填；`creator='parent'`；`carried` → `pending`（due_at 保留原日期，次日 stat 判 missed）；`task_type='required'`、`count_in_rate=1` |
| `exam_schedules` | `exam_plans` | id 保留；kind/freq/scope/scheduled_at→start_at,due_at/status/attempt_id 直迁；`score` 从对应 attempt 回填 |
| `exam_attempts` + `per_question` | `exam_plan_courses` | 按 per_question 的 course/questionId/categoryId/pointGot/pointMax 生成明细行（course_uuid 按课程名回填）；新增 knowledgePointId 从 ccq 反查（知识点已于本次落地）；`score`=该场 `exam_attempts.score` |
| `todo_items`（source=child） | `life_plans` | 孩子自规划项迁为生活计划（creator='child'）；`due_time` 并入 `due_at`（日期 + 时刻拼成 `YYYY-MM-DD HH:mm:ss`），无则补 `23:59:59` |
| `todo_items`（source=parent）+ 历史 | **不迁**（归档保留） | 家长项由 study_plans 承载；历史执行记录保留原表只读，历史统计仍在 `child_todo_stats` |
| `child_todo_stats` | `reward_daily_stats` | 历史行可按 total/done/parent_*/self_* 近似换算 required_*/rate/streak 迁入；旧表停写归档 |
| `exam_attempts` 本体 | 保留只读归档 | 一个版本周期后再删（审计/录音引用） |

**迁移实现**：`server/scripts/migrate-plan-domain.mts <dataDir> [parentId]`，事务 + meta 标记幂等（参考 `migrateStudyPlanV2`）；先干跑（`--dry-run` 输出统计不写库）。

**⚠️ 库搬迁（17:45 定案：计划/考核记录迁入孩子库）**：`study_plan_items`、`exam_schedules`、`exam_attempts`（含 `per_question`）原本在**服务端主库**，新结构下要**按 child_id 拆分迁入各孩子的 kb**：
- 迁移按 `(parent_id, child_id)` 分组：主库行 → 对应孩子 kb 的新表；孩子 kb 不存在则跳过并报告（孤儿数据）。
- 迁移顺序：先建孩子 kb 新表 → 迁计划/考核 → 迁 `todo_items(source=child)` → 换算 `reward_daily_stats` → 校验行数（分组计数对账）。
- 迁完后主库对应表**停写并保留只读**，一个版本周期后清理。
- **`child_todo_stats` 数据也要迁**（用户定案 C：把数据做迁移，不做"只读兼容期"的糊弄方案）。

**C 定案（17:45）：数据全部迁移，迁完即可下线 `todo_items`**——不做"只读兼容期"；`todo_items` 迁完（孩子自规划项 → `life_plans`）后直接停用、随后删除。历史家长项不迁（由 `study_plans` 承载），历史统计由 `reward_daily_stats` 承载。

## 6. 接口与工具改造

| 层 | 改动 |
|---|---|
| `/today`（孩子端今日列表） | 改为三表 UNION 查询：窗口覆盖今天 且 `status='pending'`（含今日已完成用于展示） |
| `/study-plans` | 改读 `study_plans`（家长面板 `StudyPlanPanel`） |
| `kb.todo.*` 系列 | 下线（或保留只读兼容一个版本）；新增 `plan.*` 系列（list/setStatus/adjustWindow） |
| 孩子端勾选 UI | **移除**（不允许勾选）；改为展示"今日安排"，完成由 LLM 判定 |
| 家长端 | 新增：今日三表清单 + **审计视图**（事件摘要 = request daily 详情 + 对话原文）+ 修正操作（撤销/exempt） |
| agent 工具 `todo_list` | 改为 `plan_list`（读三表）+ `plan_exempt`（仅家长会话）；孩子会话只读 |
| agent 工具 `study_plan_update` | 语义更新为 `plan_update`（改窗口/删除/改 mode） |
| `course_status` / `learning-summary` | 输出改为 `lastLearnedAt` + `lastExamRate`（去 mastery） |

## 7. 积分衔接（预留，不在本期实施）

- P0 的四字段（`task_type/count_in_rate/points/category`）已落在三张计划表上；
- `reward_daily_stats` 直接提供"必做完成率"分档输入；
- 建议"生活/学习"的区分由表本身承担（`life_plans` vs `study_plans`），不再需要 `category` 列（**简化**：原 §6 P0 的 `category` 字段可去掉）。
- **积分域的库归属随本设计更正**：输入（计划完成率、考核得分）全在孩子库，故 `reward_configs`/`points_ledger`/`redemption_items`/`redemption_requests` **也放孩子库**（原 `DESIGN-reward-points` 建议放主库，已随之更新）；家长审批兑换走服务端接口读写孩子 kb。

## 8. 分期实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| S1 | course_uuid 回填（`study_plan_items` 加列 + 家长库对账） | 全部计划行 course_uuid 非空或标记未匹配 |
| S2 | 建新表（三表 + 明细 + recurrences + reward_daily_stats）+ daily 两列 + 迁移脚本 | 干跑统计对账；正式迁移后行数一致 |
| S3 | worker 重写（expand/stat/applyPlanEvents + carry 复制新行） | 单测 + 冒烟：构造场景验证三域判定 |
| S4 | 接口/工具/前端切换（/today、家长端审计、移除勾选） | 端到端：孩子对话 → 汇总 → 状态更新 → 家长审计 |
| S5 | mastery 清理（§9）+ 视图/聚合接口口径切换 | tsc/build + 家长端无 mastery 残留 |

## 9. mastery / first_learned 清理清单（文件级，已扫描）

**删除列**：`courses.mastery`（孩子 kb + 家长库）、`courses.exam_mastery`（孩子 kb）、**`courses.first_learned`（17:40 定案：彻底删除）**。

**⚠️ 删除 `first_learned` 后的"学习时间"来源**：判定与展示都需要一个"最近学习时间"。建议**不新增列**，把现有 `last_review` 的语义扩展为"**最近学习时间（学或复习都更新）**"，作为 `lastLearnedAt` 的输出源；`review_count` 是否仍需要按展示需求决定（`course_status` 目前用它）。列名 `last_review` 与实际语义会有点偏差，属可接受的命名债务（改列名的迁移成本高于收益）。

| 文件 | 位置/用途 | 处理 |
|---|---|---|
| `server/src/db/kb.ts` | courses 建表含 `mastery/exam_mastery/first_learned` | 建表去列 + 迁移 DROP COLUMN |
| `server/src/db/parent-lib.ts` | courses 建表含 `mastery/first_learned` + `topic_progress` 视图 | 去列 + 删视图（§3） |
| `server/src/routes/db.ts` | 字段别名表（掌握度/考核掌握度）、`kb.courses.list/upsert`、`parent_lib.courses.list/upsert`、`kb.courses.updateField(s)` 白名单；`parent_lib.progress.list` | 去字段 + 删 handler |
| `server/src/routes/exam.ts` | 提交后回写 `courses.exam_mastery`（:1319）、`listCourseStatus` 输出 mastery/examMastery/firstLearned | 去掉回写；输出改口径（lastLearnedAt/lastExamRate） |
| `server/src/worker/tasks.ts` | stat 判定用 `first_learned/last_review` | 改为单一学习时间字段 |
| `server/src/worker/kb-tools.ts` | mastery/first_learned 相关字段处理 | 清理 |
| `electron/lib/kb-sqlite.ts` | 字段别名（掌握度→mastery）、建表/迁移 | 清理 |
| `electron/lib/custom-tools.ts` | `parent_stats` 的 `mastery` 类型 + `course_status` 输出 8 类信息 | 改输出（lastLearnedAt/lastExamRate） |
| `electron/lib/exam.ts` | `CourseStatusItem.mastery/examMastery/firstLearned` | 改接口 |
| `electron/lib/parent-library.ts` | 读 mastery 展示 | 清理 |
| `electron/lib/learning-summary.ts` | 汇总含 mastery/firstLearned | 改口径 |
| `electron/lib/pi-session.ts` | 家长提示词写"mastery 查询"；孩子提示词写"判断掌握度" | 改提示词 |
| `electron/lib/delivery.ts` | 进度摘要含 mastery | 清理 |
| `src/components/`：`CourseDetail.tsx`、`ExamView.tsx`、`LearningDashboard.tsx`、`ProgressView.tsx` | 展示/聚合 mastery（含客户端 courseMastery 聚合） | 去掉展示；客户端聚合删除，改读服务端聚合 |

> 注意：客户端 `courseMastery` 聚合（判分时本地算）随本次一并删除——掌握度唯一来源 = 最近一次考核（服务端聚合）。

## 10. 风险与待确认

**待确认项 A/E/F/G 已全部定案；B/C/D 也已定案（17:45）**：

- ~~B. 掌握度/学习状态的输出方式~~ → **已定案：三张计划表 + 考核明细落在孩子库**，与 `courses`/`daily_entries` 同库 → **视图直接建在孩子 kb**（`course_progress`），`/courses/status` 内部改读该视图即可。原跨库顾虑消失。
- ~~C. `todo_items` 怎么退场~~ → **已定案：把数据做迁移**（孩子自规划项 → `life_plans`；统计 → `reward_daily_stats`），迁完即下线该表，不做长期只读兼容。
- ~~D. `due_time` 是否保留~~ → **已定案：截止时间精确到时间，不设独立 `due_time` 列**——`start_at`/`due_at` 用 `YYYY-MM-DD HH:mm:ss`；**只给日期时 `due_at` 补 `23:59:59`**、`start_at` 补 `00:00:00`（时间点提醒能力由 `due_at` 承载）。

**风险**：
1. **一次大改**：worker 管线 + todolist 语义 + 前端 + agent 工具同时切换 → 建议 S1~S5 分阶段，每阶段可回滚（新表并存、旧表停写不删）。
2. **LLM 判定误伤**：无事件即 `missed` → **家长修正权（§13.3）必须与 S4 同期上线**，否则不能放量。
3. **考核明细回填依赖知识点**：`knowledge_point_id` 范围计划需先有知识点（已于 2026-09-10 落地，存量需跑 `backfill-knowledge-points.mts`）。
4. **跨库聚合性能**：三表在孩子维度加索引（已在 DDL 中给出）。

---

## 11. 修订（16:55）：recording 只负责生活计划，三域各有确定性信号路径

> 用户定案：recording **不需要注入三张表清单，只需生活计划**；学习计划可用「课程名 + 时间」定位；考核在独立页面完成、完成时直接写入考核计划表，**不与 agent 对话，故 recording 不管考核**。

### 11.1 修正后的信号分工（每域一条确定性路径）

| 域 | 完成信号 | 证据形态 | 谁判状态 |
|---|---|---|---|
| **学习** | 课程有学习发生（不区分首次/复习——`first_learned` 语义不再需要） | courses 的学习时间；匹配成功后 **stat 回写该日 daily 学习条目的 `plan_id`** | stat：按「课程 + 学习日期落在窗口内」匹配 `study_plans` → `done` |
| **考核** | 考核页提交（独立页面，非对话） | 提交事务内直写 `exam_plans.status/score/attempt_id` + `exam_plan_courses` 明细 | **考核提交路径直写**（见 11.3 例外） |
| **生活** | 只有对话 | `daily_entries`（`plan_id` + `plan_outcome`） | stat：读 daily 证据 → `done`；到期无证据 → `missed` |

**结论**：**只有生活域需要 recording 参与**；学习域靠 courses 信号、考核域靠页面提交，两者都不需要 recording。

**补充（17:30 定案）**：学习域**不再区分"是否首次学习"**——`first_learned` 这一"首次学习"语义不需要了；判定只需「该课程发生过学习（有学习时间）+ 存在窗口覆盖该日期的未完成学习计划」两个条件。`new/review` 的 mode 仅作为计划侧的意图标记（不影响匹配口径）。

### 11.2 recording 注入内容收窄 + 学习计划匹配规则

- prompt **只注入当天的生活计划清单**（`life_plans`：uuid / 标题 / 窗口 / 必做选做）。学习与考核**不注入**。
- 核对范围相应收窄：只把对话事件落到生活计划行；对话里提到的学习内容照常写 daily（block=学习），但**不带 plan_id**（学习计划与 daily 的关联改为隐式：`(日期 + 课程名)` 可定位，家长端按此展示"该计划的当天记录"）。
- ⚠️ **学习计划匹配要给明确规则**（否则同名/多次学习会歧义）：
  1. 优先用 `course_uuid` 匹配（S1 回填后可用），退化到 `course_name`；
  2. **按窗口区间匹配，不是同日相等**（见 §11.6）：`start_at ≤ 学习日期 ≤ due_at`；命中多条时取「仍 `pending` + 最近 `created_at`」的一条；**不区分首次/复习**（`first_learned` 语义已不需要）；
  3. **匹配成功后回写 daily**：把该日（=学习日期）对应的 daily 学习条目补上 `plan_id`（并置 `plan_outcome='done'`）——这样"学习计划 ↔ 当天记录"在 daily 侧显式可查（17:30 定案）；
  4. 匹配不到任何计划行 → **不建行、不判状态**（课程学习照常记进度，daily 也不写 plan_id，表示这次学习不在计划内）。

### 11.3 例外：考核提交路径可直写 `exam_plans`（唯一非 stat 写入者）

考核在独立页面完成、提交是服务端事务内的确定性事件，不存在"LLM 推断"，因此**允许 `/exam/attempts` 提交路由直接写 `exam_plans`（status=done/score/attempt_id）与 `exam_plan_courses` 明细**。这是 §13.1「状态唯一写入者=stat」的**唯一例外**，实现上仍集中在一个服务端写入函数（`applyExamResult`），避免写入逻辑散落。

### 11.4 daily 两个新列的用途收敛

- **`plan_id` 有两个产生路径**（17:30 修正）：
  - **生活**：recording 写 daily 时直接带 `plan_id` + `plan_outcome`（`done`/`missed`/`unknown`）；
  - **学习**：stat 匹配计划成功后**回写**该日学习条目的 `plan_id`（+ `plan_outcome='done'`）。
- **`plan_outcome`**：生活必需（判定依据）；学习条目由 stat 回写时置 `done`，作为显式标记。
- 列保持通用（不加 `plan_type`）；由于 plan_id 的来源已能通过"条目 block（学习/生活）"区分归属，无需额外列。

### 11.5 对 §4/§9 的连带影响

- §4 的 `applyPlanEvents`（stat 内步骤）职责收窄为**只应用生活计划证据**；学习/考核的判定分别由 courses 信号与提交路径完成，stat 只做统计汇总。
- `reward_daily_stats` 的 `required_done` 汇总口径不变（三域合并），只是三域的"完成"来源不同。
- 家长端审计视图聚焦生活计划（事件摘要 + 对话原文 + 修正），学习/考核沿用现有记录视图。

### 11.6 窗口区间匹配规则（17:20 补充，覆盖"一个计划跨多天"）

**规则**：匹配不看"日期相等"，只看**信号日期是否落在计划窗口内**：

```
命中条件： start_at ≤ 信号日期 ≤ due_at
同日窗口： start_at == due_at == 当天 → 即"当天"语义（等价于旧行为）
跨天窗口： start_at .. due_at 覆盖 2~3 天（或更长）→ 只要信号落在区间内即命中
```

**信号日期取哪个**（分域）：
| 域 | 信号日期 | 说明 |
|---|---|---|
| 学习 | 课程的**学习时间**（学/复习都更新同一个时间；不再区分 `first_learned`/`last_review`） | 用该时间与窗口比对；匹配成功后回写该日 daily 学习条目的 `plan_id` |
| 考核 | 提交时间（场次 `submitted_at`） | 窗口=可参加期，提交落在窗口内即命中 |
| 生活 | daily 条目的 `date` | 用户表述的"daily 日期在范围内即可"正是此条 |

**配套规则（必须同时生效）**：
1. **`missed` 判定按 `due_at`，不是按"当天"**：窗口未闭合前计划保持 `pending`，不会被判未完成——这也是窗口内计划每天自然出现在动态待办里的原因。
2. **窗口缺省与粒度**：`start_at` 缺省 = `due_at`；`due_at` 缺省 = `start_at`（默认单日）。**时间精确到 `YYYY-MM-DD HH:mm:ss`**；只给日期时 `due_at` 取当天 `23:59:59`、`start_at` 取 `00:00:00`。匹配时把日期型信号（如 daily 的 `date`）展开为当天 `00:00:00~23:59:59` 与窗口求交。
3. **carry 规则（17:30/17:40 定案）**：到期未完成 → 原行 `missed` + **复制新行到当天**（`start_at=due_at=当天`、`origin='carry'`、新 id、其余字段照抄）。延后**不考虑原计划是否跨天**，新计划窗口一律当天。**`missed` 扣分不设上限**；**`cancelled`（仅家长可操作）取消后不再 carry**、不计分母——这是停止无限累积的唯一手段。

**✅ 待确认 E —— 已定案（17:30）：取 E1**
多天窗口 = **容错期限**（这几天内完成即可），**不拆成多条计划，保持一条**。窗口内任一天出现学习信号即 `done`。不适合用长窗口表达的"分次任务"，改用 `plan_recurrences` 重复展开（每天一条），而不是给单条计划加进度结构。

**✅ 待确认 F —— 已定案（17:30）：不改判**
窗口已过、已判 `missed` 之后，迟到的学习信号**不回溯改判**（保持已结算状态稳定）；确需修正走家长修正权。注意与 carry 的配合：`missed` 后已复制新计划，迟到的完成信号会命中**新计划**（若落在新窗口内），不会去改旧的 `missed`。
