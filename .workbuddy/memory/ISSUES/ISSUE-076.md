# ISSUE-076｜学习计划的「完成」判定依赖 AI 手写 `courses.last_review`——没有日期就永远判不了完成

- **类型**：bug / 设计缺陷（判定输入由 LLM 自由裁量；且历史数据大面积缺日期）
- **优先级**：**高**（生产已实际发生：孩子复习完课程，todolist 仍显示未完成；62% 已学课都不可能被打勾）
- **记录时间**：2026-09-11
- **状态**：**待实施**（已定位取证 + 已出改造方案 §6；未改动代码、未改数据）
- **现场**：201 生产 / 家长 `86a84278…` / 孩子珊珊 `1f050a7f…`

> 前置澄清：**不存在 todolist 表**。`GET /api/v1/plans/today` 直接查三张计划表（`study_plans`/`life_plans`/`exam_plans`）里「窗口覆盖当天且 `active=1`」的行，行上的 `status` 就是界面上的对勾状态（`server/src/routes/plans-rewards.ts:117-214`）。客户端 `todo:get` 走同一接口（`electron/lib/ipc-handlers.ts:1034-1045`），不读任何本地表。

---

## 一、计划表状态的更新机制（四条路径）

### 路径 1 · 创建（插行，`status='pending'`）

| 触发者 | 时机 | 落点 |
|---|---|---|
| `expandRecurrences`（plan tick） | **每 2 分钟**（`scheduler.ts:70` `*/2 * * * *`），`plan_recurrences` 命中今天的规则 → 插行，`origin='recurrence'`，用 `last_expanded_date` 幂等 | 三表之一 |
| 家长端 / 孩子端 agent 工具 | 会话中即时：`POST /plans/life`、`POST /plans/exam`、`POST /study-plans`（agent 工具 `plan_life`/`plan_study`/`plan_exam`） | 三表之一，`origin='conversation'` |
| carry | 见路径 3 | 三表之一，`origin='carry'` |

窗口固定为**当天**：`start_at = 00:00:00`、`due_at = 23:59:59`、`active = 1`。

### 路径 2 · `pending → done`（三域各自信号，stat tick 每 2 分钟）

`runPlanStat`（`plan-domain.ts:544-564`）= `applySignals` → `applyExamAttempts` → `expireAndCarry` → `settleRewards`。

| 域 | 判定信号源 | 精确条件 | 写入 |
|---|---|---|---|
| **学习** | 孩子库 `courses.last_review` | 同名课程（`title == course_name` 全等）且 `dateOf(last_review)` **落在** `[dateOf(start_at), dateOf(due_at)]` | `status='done'`、`done_at='<学习日> 12:00:00'`、`result='学习完成'`；并回写当天 daily 学习条目的 `plan_id` |
| 考核 | 主库 `exam_attempts` | 按 `schedule_id` 匹配 plan id（无排期用 `exam_<attemptId>`），幂等 | `status='done'`、`attempt_id`、`score`；明细写 `exam_plan_courses` |
| 生活 | 孩子库 `daily_entries` | `plan_id != ''` 且 `plan_outcome='done'`（**只由 recording 写**） | `status='done'`、`result='生活完成（记录判定）'` |

**学习域是唯一会「静默失败」的**：信号源 `courses.last_review` 是一个**由 AI 手写的字段**，没有任何确定性代码维护它。

### 路径 3 · `pending → missed` + 复制新行（carry）

`expireAndCarry`（同一 tick，在 applySignals **之后**）：
- 条件：`status='pending' AND active=1 AND due_at != '' AND due_at < now`（`now` 是**时刻**，故当天行只在**次日 00:00 后**才落 missed）
- 动作：原行 `status='missed'`；**复制一份新行到今天**（`status='pending'`、`origin='carry'`、`carry_from=原 id`、窗口=当天）
- `exam_plans` 不 carry（考核错过由家长重排）

### 路径 4 · 人工审计（仅家长端）

`POST /plans/status`：`cancel` / `reopen`（撤销完成）/ `done`（代判完成）—— 客户端入口 `plan:setStatus`（`ipc-handlers.ts:1103-1118`）。
**孩子端没有"打勾"入口**（设计如此：孩子端不能手工勾选任何计划）。

### 谁在写 `courses.last_review`？——没有人（这是问题所在）

- 考核提交**只写主库 `exam_attempts`**，`electron/lib/exam.ts:5` 明确注释「掌握度由服务端按最近一次考核聚合，**不再回写孩子库**」。
- 服务端全库检索：**无任何 `UPDATE courses SET last_review`**（只有读取）。
- 唯一写入通道是 `kb.courses.updateField(s)`（`server/src/routes/db.ts:590/621`），由 **AI 自己在会话/录制里调 `kb_update`** 触发：
  - 孩子端系统提示（`electron/lib/pi-session.ts:108`）只要求「完成一课后用 kb_update 更新该课程**状态**」，**未强制写「最近复习」**；
  - 录制提示（`electron/lib/recording-prompt.ts:64`）虽列了「最近复习」，但**同句还在要求写已被删除的 `掌握度`/`首次学习`列**，本身已过时。

## 二、现象与归因

珊珊 **2026-09-11** 当日 todolist（实调 `/plans/today`）共 **9 条**：

| 状态 | 课程 | `courses.last_review` |
|---|---|---|
| `done` | 论语为政篇第二章 | `2026-09-11` ✅ |
| `done` | 论语为政篇第九章 | `2026-09-11` ✅ |
| `pending` | 论语为政篇第一章 | **`-`** |
| `pending` | 论语为政篇第三章 | **`-`** |
| `pending` | 论语为政篇第四章 | **`-`** |
| `pending` | 论语为政篇第五章 | **`-`** |
| `pending` | 论语为政篇第十章 | **`-`** |
| `pending` | 论语为政篇第十一章 | **`-`** |
| `pending` | 论语学而篇第十六章 | **`-`** |

**7 条 pending 与「`last_review` 无有效日期」100% 一一对应。** 当天 daily 里的 4 条复习记录（为政 3/6/7/8 章）中，只有第三章落在 todolist 内（且 pending）；6/7/8 章的计划行是 **09-10 的、已 done**，`done` 不参与 carry、今天也没有新行 → 它们今天不在 todolist。

### 根因 1：todolist 打勾与 daily 记录是两条互不相干的链路

- 打勾 ← `study_plans.status`；判定 ← `courses.last_review`。
- `daily_entries` 在学习域**不作为依据**，只有两处被消费：判定成功后**回写** `plan_id`；**生活域**用 `plan_id + plan_outcome='done'` 判定。

> 所以「daily 有学习记录」天然不会让学习计划打勾（设计如此：`ARCHITECTURE.md:87`、`DESIGN-plan-domain-rewrite-2026-09-10.md:383`）。

### 根因 2：`last_review = '-'`（✅ 但无日期）恒判不了完成

`plan-domain.ts:191-206`：

```ts
const courses = kb.prepare("SELECT ... last_review AS learned_at FROM courses WHERE last_review != ''")...
const learnedAt = c?.learned_at ?? "";
if (!learnedAt) continue;
const d = dateOf(learnedAt);                 // dateOf = ts.slice(0,10) → "-"
const inWindow = d >= dateOf(p.start_at) && d <= dateOf(p.due_at);  // "-" >= "2026-09-11" → false
```

`'-'` 的语义是「已标 ✅ 但**没有日期**」——`server/src/db/kb.ts:287`、`electron/lib/kb-sqlite.ts:150` 的视图都显式把 `('', '-')` 视同 NULL，但这里 `!= ''` 把它当有效值捞出，随后参与日期比较**恒 false**。

**生产实测（珊珊库 `courses`，613 门 `status='✅'`）**：

| `last_review` 形态 | 门数 | 能否判 done |
|---|---|---|
| 合法日期 | 230 | ✅ |
| `'-'` | **380** | ❌ |
| 空串 | 3 | ❌ |
| **无日期合计** | **383（62.5%）** | — |

### 根因 3：复习不刷新 `last_review`（与设计定案冲突）

`DESIGN-plan-domain-rewrite-2026-09-10.md:289` 明确要求「`last_review` 语义扩展为**最近学习时间（学或复习都更新）**」，但写入侧没有任何确定性路径（见上）。实测：6/7/8 章 09-11 复习后 `last_review` 仍是 `2026-09-10`，与"学或复习都更新"不符。

### 排除项（已核实，均非本次原因）

1. **不是迁移丢数据**：升级前备份对照 —— 这几章 `first_learned` 本就为空、`last_review` 本就是 `'-'`。
2. **不是 worker 没跑**：日志显示升级后（09-11 12:54/13:12/13:20 北京时间）stat tick 仍在判定（`[worker:stat] ... 学习判定 1，考核场次 0，missed 0`）。
3. **不是旧表驱动的界面**：`todo_items`（74 行）是升级前遗留快照、已停止更新，客户端已无读取路径；它 09-11 的 9 行仍全 pending，**与界面无关**。
4. **worker_state 的 `todo_stat`/`study_plan_carry` 停在 09-10** 属正常：新版 `runStatTick`/`runPlanTick` 不再写这两个游标（旧版残留），**不代表 worker 停止**。

## 三、影响面

1. **孩子端/家长端 todolist**：无日期的课长期悬挂未完成。生产 daily 里孩子已多次自己发问（09-09「学习计划里为什么没有打勾」、09-10「为什么学习记录上一直没打勾」「为什么我这里这个记录上一直没打勾」）。
2. **完成率与积分**：`reward_daily_stats` 的 `required_done` 直接来自计划判定 → 完成率被系统性低估（珊珊 09-10 = 0.4545、09-11 = 0.2222）→ 影响 `todoGateMinRate` 门控与积分档位。
3. **考核候选**：`/exam/candidates` 用 `last_review` 挑「该考的课」（`server/src/routes/exam.ts:434`），无日期的 383 门课被整批排除。
4. **运维可观测性**：新 stat tick 不再写 `worker_state`，运维无法从库判断 worker 是否在跑（需看日志）。

## 四、修复建议（待拍板，未实施）

**① 根治：把「完成一课」变成确定性事件**
在确定性落点自动写 `last_review`（= 最近学习时间），不再靠 AI 记忆：
- 客户端在「标记完成 / 考核提交 / 复习完成」时统一 `kb.courses.updateFields { 状态:'✅', 最近复习: today }`；
- 或服务端在写入考核结果时回写孩子库（注意 `exam.ts:5` 现状是**不回写**，需改设计）。
- 提示词同步收紧：「**复习完成也必须写最近复习日期**」。

**② 判定侧兜底：兼容 `'-'` / 无日期**
把 `last_review IN ('', '-')` 视同「无日期」，并回退到当天 `daily_entries(block='学习', title LIKE '%课程名%')` 是否存在作为补充证据（与生活域用 daily 证据同构）。
> ⚠️ 属语义扩展，需确认「daily 是否算学习完成证据」。

**③ 历史回填（一次性脚本）**
对 383 门 `status='✅' AND last_review IN ('','-')` 的课，按 daily 里同名学习记录的**最近日期**回填；无记录者保持 `'-'`（不造日期）。

**④ 收尾**：清理 `electron/lib/recording-prompt.ts:64` 中已删除列的字段名（`掌握度`/`首次学习`）。

## 五、待确认项

1. 是否接受「daily 学习条目」作为学习完成的**补充证据**？（影响判定语义与设计文档）
2. 383 门课是否回填？回填会让它们进入 `/exam/candidates` 候选集，是否符合预期？
3. `'-'` 的来源确认：旧客户端「标 ✅ 无日期」的写法？（建议保留语义、不再产生新的 `'-'`）
4. 复习是否也应 `review_count + 1`？（当前 6/7 章为 3、3 章为 0，说明复习次数同样未一致维护）

## 六、改造方案（判定改读 daily —— 用户 2026-09-11 明确的设计口径）

### 6.1 现状核实：本地与线上是**同一份旧代码**

| 位置 | 内容 |
|---|---|
| `server/src/worker/plan-domain.ts:191-194` | `SELECT topic, title, last_review AS learned_at FROM courses WHERE last_review != ''` |
| `server/dist/server.cjs:374737`（201 实际运行的产物） | 同一行逻辑，**逐字相同** |

→ 本地开发环境与 201 生产**行为一致**，都是「比对 `courses.last_review`」的旧口径，尚未实现「与 daily 比对」。

### 6.2 目标口径（用户设计）

> ① daily 表学习条目的**标题 = 课程名**；② 学习计划的完成判定 = 拿计划行与 daily **当天的学习记录**比对：**课程名必须一致**，且 **daily 的日期落在计划的 `[start_at, due_at]` 窗口内**；③ **不再读 `courses`**。

与现有生活域口径同构（生活域已用 `daily_entries`），改造后三域里两域统一到 daily。

### 6.3 daily 侧数据质量实测（珊珊库 633 条「学习」条目）

| 形态 | 条数 | 占比 |
|---|---|---|
| 标题 **严格等于**课程名（规范） | 106 | 16.7% |
| 带「（…）」后缀、去后缀后可匹配 | 37 | 5.8% |
| **不匹配任何课程名** | **490** | **77.4%** |

- 490 条不匹配**几乎全为 2026-04 ~ 07 的旧格式**，如「论语·巧言令色（学而篇第三章）」「知识要点备注」「孝经·开宗明义第一章」。
- **2026-09 以来的记录基本规范**（如「论语为政篇第二十一章」），但**复习类会带「（复习）」后缀**（如「论语为政篇第三章（复习）」）→ 严格全等会**漏匹配**。
- `raw` 内另有「课程名：」字段：59 条有该字段，其中仅 25 条与 title 完全一致。

### 6.4 试算（珊珊 174 条计划行，模拟新口径）

按「daily 标题 = 课程名（或去尾部括号后缀）+ daily.date ∈ 窗口」试算：

- **会新判 done 4 条**，其中含本次现场的关键一条：**`论语为政篇第三章`（窗口 09-11、daily 09-11）→ pending 变 done** ✅
- 无 daily 记录的 6 条（为政 1/4/5/10/11 章、学而篇第十六章）**仍保持 pending**（今天确实没学）→ **无误判**
- 另有 3 条（子路 7/8/9 章，窗口 09-03、daily 与 `last_review` 均在 09-03）**两种口径都应为 done，实际却是 missed** → 属迁移带过来的历史状态，见 6.5

### 6.5 改造必须同时注意的 3 点

1. **历史 missed 不回溯**：`applySignals` 只处理 `status='pending'` 的行；过期行已被 `expireAndCarry` 置 `missed`。因此改口径**只对当天及未来的 pending 行生效**，历史 missed 需另行决定是否补判。
2. **「（复习）」后缀**：严格全等会漏掉带后缀的记录。两种取法需择一 ——
   - A（推荐）：判定按「标题**严格等于**课程名，或**去掉尾部「（…）」后**等于课程名」，同时收紧写入侧 prompt（标题只写课程名，状态/是否复习写进正文）；
   - B（严格）：判定仅全等，但**必须先把存量带后缀的标题规范化**（一次性脚本，含合并同课重复条目），否则复习类记录永远匹配不上。
3. **写入侧须同步收紧**：`electron/lib/recording-prompt.ts:112-116` 要求「每条学习记录用 ### 课程名 作标题」——需**明确禁止**在标题里追加「（复习）」「（进行中）」等状态后缀，并清理该文件中已删除列的引用（`掌握度`/`首次学习`）。

### 6.6 代码改动落点（待实施）

| 文件 | 改动 |
|---|---|
| `server/src/worker/plan-domain.ts:186-219` | `applySignals` 学习域：数据源由 `courses` 改为 `daily_entries`（`block='学习'`），判定条件改为 `title(规范化) == plan.course_name` 且 `daily.date ∈ [dateOf(start_at), dateOf(due_at)]`；保留判定成功后回写 `plan_id/plan_outcome` 的行为 |
| `electron/lib/recording-prompt.ts` | 收紧「标题 = 课程名」（禁止状态后缀）；清理已删除列引用 |
| （可选）一次性脚本 | 规范化存量 daily 标题（去尾部括号后缀）+ 存量 missed 是否需要按新口径补判 |

## 七、取证命令（可直接重跑）

```bash
node .workbuddy/tmp/probe_todolist.js      # 09-10/09-11 todolist 两接口实调 + 旧 todo_items
node .workbuddy/tmp/probe_lastreview.js    # 升级前备份 vs 现库对照 + 全量 last_review 形态分布
# 生产日志：grep -aE "worker:stat|worker:plan" /opt/learning-server/data/logs/server-log.jsonl | tail
```
