# ISSUE-105：讨论——让 app 内 agent 具备受控的 SQLite 直接操作能力，终结「一个新场景加一个工具」

- **类型**：设计讨论 / 架构提案
- **优先级**：中（不阻塞现网，但持续消耗开发效率）
- **记录时间**：2026-09-16
- **状态**：🚧 分期实施中——P1（家长受控通道）+ P2（孩子受控通道）已实现（2026-09-16，db-channel.ts / child-db-tools.ts，回归用例 30 项全绿）；**尚未部署 201**（按项目规则等用户明确指示）；P3（受控只读 SQL 评估）待观察后决定

## 背景与问题

家长 agent / 孩子 agent 的能力全部通过**专用工具**（`parent-tools.ts` 里的 `parent_upsert_course_content`、`parent_exam_plan_create` 等）暴露。每个工具 = 一段手写的业务校验 + 手写 SQL + 手写的参数 schema 和中文描述。带来两个结构性问题：

1. **每遇新场景就要开发新工具**。典型例子：家长想「改一下某道题的题干」，旧工具只有"新建题/引用题"两种给法，改不了 → ISSUE 追了一轮才补上（2026-09-16 的 `parent_upsert_course_content` 更新能力）。而这个需求本质上只是 `UPDATE question_bank SET stem=? WHERE id=?`——数据表早就支持，缺的只是暴露通道。工具的增长是**无上界的**：改备注、调分值、批量挂载、合并知识点……每个都是新工具或旧工具加参数。
2. **工具描述膨胀**。像 `parent_upsert_course_content` 的描述已经长到需要"三种给法 + 整课替换警告"才能说清，agent 理解成本高、出错率高（传错给法就静默失效或报错）。

## 原始设想（用户提出）

> 能否让 agent 具备 SQLite 的账号权限，在权限范围内自由操作数据库？新增的场景都是对数据表的操作，只是过去的工具没有实现该操作而已。

## 技术现实：SQLite 没有"账号权限"体系

SQLite 是嵌入式库，**没有用户/角色/GRANT**——文件级访问即全权访问。所谓"权限范围内的账号"必须由应用层实现。这反而是好消息：权限模型完全可以按我们的业务需要自定义，不受数据库权限粒度限制。

## 候选方案

### 方案 A：通用 SQL 工具 + 应用层权限闸门（激进，最贴近原始设想）

给 agent 两个新工具：

- `db_schema`：返回库内全部表/列/注释（也可预生成一份 schema 说明注入 agent 系统提示）。
- `db_sql`：执行 SQL，服务端做静态解析与放行判断。

权限闸门（服务端 `db_sql` 执行前强制）：

| 维度 | 规则（初稿） |
|---|---|
| 账户隔离 | 家长 agent 只连**本家长**的库（server.sqlite + 其子女的 kb）；孩子 agent 只读本孩子的 kb，绝不跨库 |
| 语句白名单 | 家长：SELECT / INSERT / UPDATE / DELETE（仅业务表）；孩子：只读 SELECT |
| 表级黑名单 | `parents`（凭据）、`sessions`/token 类、`activity_log`、`agent_*` 内部表不可写 |
| 危险模式拦截 | 无 WHERE 的 UPDATE/DELETE、`DROP/ALTER/TRUNCATE/ATTACH/PRAGMA`、多语句、子查询跨表写 → 拒绝或要求确认 |
| 行数熔断 | 单语句影响行数上限（如 500），超限回滚报错 |
| 只读事务预检 | 先在 `BEGIN; <stmt>; ROLLBACK` 里跑一遍拿影响行数/报错，通过后再真执行（node:sqlite 支持手动事务） |
| 全量审计 | 每条 SQL 原文 + 影响行数写审计表，家长 UI 可查 |

优点：一劳永逸覆盖"改字段/批量整理/临时查询"类长尾场景；agent + schema 描述对 SQL 的掌握远超我们对工具参数的预设。
风险：LLM 写错 WHERE、误解表结构写出语义正确但业务错误的 UPDATE（如把 score 改成负数）；破坏业务不变量（如 `exam_plans.status` 与 `attempt_id` 的配对约定，现在这些不变量散落在各工具的校验里，直连 SQL 会绕过它们）。

### 方案 B：通用行级 CRUD 工具 + schema 自省（稳妥，推荐先做）

不做自由 SQL，做两个参数化工具：

- `db_describe(table)` → 表结构 + 每列业务含义注释。
- `db_write(table, op: insert|update|delete, rows, where)` → 参数化执行，服务端按**每张表的字段白名单 + 值校验器**（复用/收敛现有各工具里的校验逻辑）放行。

与方案 A 的差别：不能 JOIN、不能聚合、不能改表结构，语义破坏面小一个数量级；校验器按表注册，把现在散在工具里的业务不变量集中收口。读侧已有 `parent_library_course_content` 等查询工具，可先不动。

### 方案 C：维持现状 + 快速工具生成脚手架（最保守）

承认"新场景新工具"，但做一个工具 DSL/生成器：声明 表 + 字段 + 校验器 → 自动产出工具定义与描述，把新增工具的成本从"手写一天"降到"配置一行"。不解决描述膨胀，只降低开发成本。

## 推荐路径

1. **先 B 后 A**：方案 B 落地孩子 agent 的只读场景（风险最低、立刻消灭一批"查点别的"的小工具），家长侧先接 1~2 张低风险表（如 `question_bank` 的 note/scoring 字段）验证校验器收口。
2. 方案 A 作为 B 的演进：在 B 的审计/熔断设施之上放开受控 SQL，先只对**家长 agent + 业务表 SELECT**放开，观察一个周期再考虑受限写。
3. 无论 B/A，**业务关键不变量必须收口到服务端校验层**（考核计划状态机、attempt 配对、积分规则），这是直连数据操作的安全底线。

## 待讨论问题

1. 孩子 agent 是否需要任何写能力？（目前结论倾向：永远只读）
2. `db_write`/`db_sql` 的权限粒度放在「家长」还是「家长+孩子」维度？（影响 kb 库连接管理）
3. 失败语义：静默拒绝 + 说明原因（agent 可向家长转述），还是抛错让 agent 重试？
4. 现有工具是否逐步退役（如 `parent_upsert_course_content` 拆薄成纯编排），还是与新通道长期并存、只在描述里互相引用？
5. 审计与回滚：要不要提供「按审计记录反向回滚」的工具（对家长误操作很重要）？

## 实施记录

- **P1（2026-09-16，commit ee01047）**：`server/src/agent/db-channel.ts` 表注册表 + `parent_db_describe` / `parent_db_write`（家长内容库 6 表）；where 强制、行数熔断、事务回滚、confirm 复述提示、db_audit 审计。
- **P2（2026-09-16）**：孩子侧 `childKbReadableRegistry`（13 张可读表：计划/考核/积分/兑换/日常等）+ 写白名单仅 `daily_entries`（增改删）与 `redemption_requests`（仅 insert，`child_id` 由执行器 `force` 强制为本孩子、created_at/id 服务端生成、item_id 引用校验）；新增 `child_db_describe` / `child_db_read` / `child_db_write`（child-db-tools.ts，session-registry 注册，非 scene 会话）。
  - 设计取舍：study_plans/life_plans 的写继续走既有 child_*_create/update 专用工具（recurrence 展开与 creator 语义不宜通用化）；考核/积分表在任何通道都只读。

## 关联

- 直接诱因：2026-09-16 家长 agent「改题干始终失败」的分析与修复（`parent_upsert_course_content` 增加 questionId+内联字段=更新能力，commit `37779ef`）——该场景若当时有本提案的通道，无需改动任何服务端代码。

## 数据结构与权限建议（2026-09-16 补充，基于实读代码）

### 实际数据布局（三库层级）

| 库 | 文件 | 内容 | 连接方式 |
|---|---|---|---|
| 主库 | `data/server.sqlite`（db.ts） | 全部家长共用的跨租户数据 | 服务端单例 |
| 家长内容库 | `data/parents/<parentId>/parent.sqlite`（parent-lib.ts） | 课程库 + 题库（assess-content 三表也在其中） | 每家长一个连接 |
| 孩子库 | `data/parents/<parentId>/kb/<childId>/kb.sqlite`（kb.ts） | 该孩子的计划/考核/积分/日常 | 每孩子一个连接 |
| agent 内部库 | `data/agents.sqlite`（agents.ts） | prompts/prompt_history | agent 不可见 |

**租户隔离已经由"文件路径"天然实现**：家长 token 解出 parentId 后只能打开自己的 parent.sqlite 与其名下孩子的 kb——这正好是权限模型的地基，新通道只需沿用 `openParentLib` / `openKb(dataDir, parentId, childId)` 的既有入口，不新增任何跨库路径。

### 权限矩阵（R=只读 / W=受控写 / ✗=不可见）

**主库 server.sqlite**（家长 agent 与孩子 agent 默认都**不开直连**，这是唯一跨租户的库，隔离不能靠路径而要靠代码，风险最高、收益最低）：

| 表 | 家长 agent | 孩子 agent | 说明 / 必须守住的不变量 |
|---|---|---|---|
| parents / settings | ✗ | ✗ | 凭据与模型密钥（settings 含加密 auth），任何 agent 永不可见 |
| children | W（经 `parent_child_create/update`，字段白名单） | ✗ | 孩子的增删改涉及其 kb 目录的建删，不允许绕过服务端 |
| exam_attempts / speech_assessments | R | ✗* | 只能由考核提交流程写（分数与 exam_plans 配对）；*孩子查自己成绩走现有汇总工具，不给原始表 |
| session_messages / session_files | R（仅 `parent_read_child_conversation` 这类显式授权读取） | R（仅本人） | 对话属最敏感内容，直连查询等于绕过授权边界，不给通用读 |
| scheduler_tasks(+assignments) / task_runs / worker_state | R | ✗ | 写路径是 worker 语义，agent 写会破坏游标/重试约定 |
| materials / files | R；写经现有 `parent_put_material`（涉及物理文件落盘，必须留服务端） | R（自己的教材） | 行记录与磁盘文件必须成对，禁直写 |
| study_plan_items | R | ✗ | 由计划域 worker 从家长计划生成，孩子不该看见生成细节 |

**家长内容库 parent.sqlite**（家长 agent 主战场，**方案 B 首批放开这里**）：

| 表 | 家长 agent | 孩子 agent | 说明 |
|---|---|---|---|
| topics / courses / tags | R + W | R（经汇总工具） | 低风险目录数据，字段白名单写 |
| question_bank | R + W | R（仅挂到本人考核的题） | 本次"改题干"场景的直接受益表；注意 answer/options 批量改需二次确认 |
| knowledge_points / course_knowledge_questions | R + W | R | 挂载关系整课替换语义已存在，受控写可行；不变量=course_uuid 归属 |
| meta | ✗ | ✗ | 迁移标记表，agent 写会破坏幂等迁移 |

**孩子库 kb.sqlite**（孩子 agent 只能连**自己**的这个库；家长 agent 经 parent 工具间接写）：

| 表 | 孩子 agent | 说明 |
|---|---|---|
| study_plans / life_plans / plan_recurrences | R + W（仅本人，现有 child_*_create/update 已是此语义） | 不变量=recurrence 展开由 worker 做，直写别碰生成游标 |
| exam_plans / exam_plan_courses | R | **孩子对考核永远只读**——考试资格、状态机（pending→started→done）、完成回写是防作弊边界 |
| daily_entries / topics / tags / courses | R + W（日常记录类，孩子自己的笔记） | 低风险，字段白名单写 |
| reward_configs | R | 奖励规则是家长定的，孩子只能看 |
| points_ledger / points_balance | R | **积分永远只读**：加分只发生在考核/任务完成的服务端流程，孩子 agent 可写=可自己发分 |
| redemption_requests | W（仅 insert 自己的兑换申请） | 兑换审批仍归家长 |
| redemption_items | R | 同上，规则只读 |
| reward_daily_stats | R | 统计派生表，由 worker 维护 |
| meta | ✗ | 同上，迁移标记 |

### 从矩阵得出的实施建议

1. **孩子 agent = 单库只读 + 三张白名单写表**（life/study 计划 + 兑换申请 + 日常记录），且物理上只连自己的 kb.sqlite——一次配置，覆盖孩子侧全部长尾场景，风险面极小。
2. **家长 agent = parent.sqlite 受控读写 + 主库经现有工具**。方案 B 的 `db_describe`/`db_write` 先只注册 parent.sqlite 三张内容表（topics/courses/question_bank/knowledge_points/挂载表），这是"新场景加工具"最密集的区域（本次改题干即属此类）。
3. **主库不进直连白名单**，理由写死在方案里：跨租户 + 凭据/对话/考核成绩三样最敏感的东西都在主库，而家长/孩子对主库的真实需求全部已被现有工具覆盖，放开没有收益。
4. **不变量收口清单**（无论 A/B 都必须服务端强制，直连写绕不过去）：考核计划状态机与 attempt 配对、积分只增于服务端流程、recurrence 展开游标、materials 行↔文件成对、meta 迁移标记。
5. 二次确认策略建议按**表**声明而不是按语句：`question_bank.answer`、`redemption_requests`（孩子发起）等"影响判定结果"的写入，服务端返回"已执行，但需家长/孩子知悉"的提示语，由 agent 转述。
