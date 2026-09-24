# ISSUE-142：孩子 agent 的通用读写工具 `child_db_read` / `child_db_write` 的场景需要度与裁剪方案

| 项 | 值 |
|---|---|
| 状态 | **待拍板（未改任何代码）** |
| 优先级 | 中 |
| 日期 | 2026-09-23 |
| 提出 | 用户：「从使用场景看，`child_db_write` 和 `child_db_read`，没有需要。」 |
| 关联 | 场景文档 §3.3（本轮新增）、§3 / §3.1 / §3.2、§4 域 G、§6 硬约束 #6、§7 |
| 关联 issue | `ISSUE-137`（F5 错题重考，含 `child_mistake_log(list)` 返回字段缺口）、`ISSUE-139`（E7 考后复盘，依赖读逐题）、`ISSUE-140`（H1 提醒工具，同属"孩子侧工具回归"）、`ISSUE-136`（提示词按场景，B6/G1/F4 的解释口径） |

---

## 一、结论（先说清楚哪里对、哪里不对）

| 用户判断 | 核实结论 | 一句话 |
|---|---|---|
| `child_db_write` 没有需要 | **基本成立，但原因不是"冗余"，而是"那条链路整体没通"** | `daily_entries` 那半确属冗余（正统通道是 `kb_insert`/`kb_update`）；`redemption_requests` 那半**是孩子侧唯一活着的兑换通道**，而**兑换（G2/G3）在两个端都没有出口**——商品表无人写、两端无界面、服务端那条接口是家长 JWT 且无人调用 |
| `child_db_read` 没有需要 | **不成立** | **4 类数据、5 条场景目前只有它读得到**（积分三表 / 掌握四列与学习结果 / 考核逐题三层 / 错题关联字段）。删掉 = 直接丢 B6、G1、F4、E7、F5 的"读出数据"这一半，只剩提示词无济于事 |
| （隐含）通用读写不该是孩子 agent 的能力 | **方向正确** | 它是**"缺专用工具时的兜底"**，不是"场景需要的能力"——一张注册表 + 一套受控 SQL 覆盖 22 张表，是**服务端实现方便**的产物。正解不是"删"，而是**把兜底变成专用**（路线 A） |

---

## 二、两个工具的真实形态（现状核实）

**装配**：`computeChildToolNames`（`server/src/agent/session-registry.ts:209`）在主 / 课程会话里装 `CHILD_DB_TOOL_NAMES` = `child_db_describe` / `child_db_read` / `child_db_write` / `child_mistake_log`（`agent/child-db-tools.ts:287-292`）；**英语场景会话不装**（只有 `display_content` / `scene_command` / `get_date`）。

**`child_db_read`**（`child-db-tools.ts:83`）：对**孩子库 22 张已登记表**做受控查询——等值 `where` + 列裁剪 + 排序 + 行数上限（默认 50 / 最大 200 行）+ 字符预算（40k / 单元格 4000）。注册表 `childKbTableSpecs()`（`agent/db-channel.ts:951`）逐列登记，`childKbReadableRegistry()` 由它派生。

**`child_db_write`**（`child-db-tools.ts:155`）：白名单**两张表**——
- `daily_entries`：`insert` / `update` / `delete`，`rowLimit: 30`；
- `redemption_requests`：**只能 insert**，`rowLimit: 5`，`child_id` 由服务端强制覆盖；
- 其余（积分、奖励规则、计划、灵活实体 `ns:`）**一律不可写**（`childKbWritableRegistry()`，`db-channel.ts:1224`）。

**`child_db_describe`**（`child-db-tools.ts:59`）：列可读/可写表与列含义，与 ③ 运行时自动注入的表清单**重复**。

---

## 三、写侧评估

### 3.1 `daily_entries` 那半：冗余（可收）

写 daily 的**正规通道是 `kb_insert` / `kb_update`**（`worker/kb-tools.ts:276` / `:341`），它们比 db write 多三件事：

| | `kb_insert` / `kb_update` | `child_db_write` → `daily_entries` |
|---|---|---|
| 语义解析 | ✅ `### 标题` + 字段行 → 结构化列 | ❌ 直接给列值 |
| 去重 | ✅ 重复自动跳过 | ❌ 主键冲突报错 |
| 计划联动 | ✅ `planId` / `planOutcome` → 系统更新生活计划状态 | ❌ 无 |
| C 域场景需要度 | **唯一正规通道** | **一个场景都用不上**（场景文档「域 C 讨论 ·8.1」） |

⇒ **场景表里没有任何一条依赖它**；建议**收掉这一半**（收法见 §五）。

### 3.2 `redemption_requests` 那半：孩子侧唯一活通道，但兑换链路整体没通

实测四条证据（全仓核实，2026-09-23）：

1. **上游断了**：`redemption_items`（可兑换商品表）**全仓没有任何写入点**——只有建表 SQL（`server/src/db/kb.ts:322`）、表登记（`db-channel.ts:1133`）与引用校验（`db-channel.ts:1269`）。**家长没有"发布可兑换奖励"的入口**，这张表永远是空的。
2. **孩子端没有界面**：`src/`（Electron 渲染层）、`web/src/`（Web 版）、`electron/` **全仓搜不到兑换相关交互**，只有 `src/components/RewardPanel.tsx`（"已兑换"统计）与 `TodoModal.tsx` 的**展示**。⇒ 场景文档 §4 里 G2/G3 写的"**界面自带**"**是错的**（本轮已改判）。
3. **有一条服务端接口，但没人调**：`POST /api/v1/rewards/:childId/redeem`（`server/src/routes/plans-rewards.ts:659`）要求 **家长 JWT**（`authParent`），并且**当场扣分 + 写 `points_ledger` / `points_balance`**；客户端**零调用点**。
4. **与既有硬约束冲突**：场景文档 §6 第 6 条：「**现实权益扣分发生在家长履约时，不是孩子申请时**」——而 `/redeem` 是**申请即扣**。

⇒ 所以正确的表述不是"`child_db_write` 冗余"，而是：**"兑换（G2/G3）在两个端都没有出口，只剩 agent 这条半截通道"**（只写申请、不扣分、等家长审批——**语义反而是对的**）。删掉 write = **承认 G2/G3 目前彻底没有出口**；要恢复就得先做界面或开通接口。

---

## 四、读侧评估：`child_db_read` 的不可替代范围

| 要读的数据 | 场景 | 为什么别的工具读不到（已核实） |
|---|---|---|
| **积分三表**：`points_ledger` / `points_balance` / `reward_daily_stats` | **B6** 为什么没加分、**G1** 积分怎么少了 | **没有任何积分类工具**；`kb_query` 的 5 种查询（daily / topics / progress / course / tags，`worker/kb-tools.ts:271`）**不含积分** |
| **掌握四列**：`courses.mastery_level` / `mastery_desc` / `teaching_advice` / `mastery_updated_at`，**学习结果** `study_plans.result_summary` | **F4** 我学得怎么样、**C1** 进度 | `kb_query(progress)` 的 course 分支**只 select 五列**（`topic/topic_key/title/status/last_review`，`worker/kb-tools.ts:215`），**不含 mastery 四列**；三个 `*_plan_list` 只回人读文本、**不含 `result_summary`** |
| **考核逐题三层**：`exam_plan_courses` / `exam_course_results` / `knowledge_point_records` | **E7** 这次错在哪（见 `ISSUE-139`） | **没有任何"读考核结果"的工具**；`*_plan_list` 只到"考了没、几分"这一层 |
| **错题关联字段**：`course_ref` / `knowledge_point_name` / `question_id` | **F5** 错题重考（见 `ISSUE-137`） | `child_mistake_log(action=list)` 的返回**不含这三列**（`child-db-tools.ts:262-268`） |

⇒ 这 4 类**没有一个是"可以用别的工具凑出来"的**。删 `child_db_read` 必须**同时补出口**，否则 B6 / G1 / F4 / E7 / F5 **五条场景的"读出数据"整段失效**。

**另外**：场景文档 §3.2 那套「三个 `*_plan_list` 读任意列 + 时间范围」的改造落地后，read 在**"计划细则"**这一块的唯一价值（拿回 list 折叠掉的 `due_at` / `points` / `task_type` / 考核范围 / 结果概要）**自动消失**——届时它的不可替代范围**只剩上表 4 类**，这也是"现在别急、但要按计划收"的理由。

---

## 五、三条路线（建议 A）

### 路线 A（推荐）：先把兜底变成专用，再删通用读

**第一步：补 3 个专用只读工具 + 扩 1 个工具的返回**

| 新工具 | 覆盖场景 | 契约草案 |
|---|---|---|
| `child_points_report` | **B6 / G1** | 入参 `{ days?: number }`（默认 7）；一次返回 **余额 + 当日/区间结算（完成率、命中档位、是否过门槛）+ 最近 N 笔流水（类型/变动/原因/来源）**；返回**人读文本 + 口径说明**（把"为什么没加分"的门控口径**写在工具描述里**，与 `child_mistake_log` 同一先例） |
| `child_mastery_report` | **F4 / C1** | 入参 `{ topic?: string, course?: string }`；返回**课程掌握四列 + `study_plans.result_summary` + 最近考核得分率**；`topic` 缺省 = 全主题概览 |
| `child_exam_result` | **E7** | 入参 `{ plan_id?: string, latest?: boolean }`；返回**某场考核逐题明细**（题干 / 原文 / 得分 / 对错 / AI 评语 / 知识点 / 序号）+ **每课概要**；**不含标准答案**（沿用 `ISSUE-139` 的泄题红线） |
| （扩）`child_mistake_log(list)` | **F5** | 返回**补 `course_ref` / `knowledge_point_name` / `question_id`**（`ISSUE-137` 已提）——**不新增工具**，改返回更自然 |

**第二步：删** `child_db_read` + `child_db_write`（`child_db_describe` 一起删）。

**收益**：① 每个出口自带口径 → §0 那条"**有数据、没口径**"在**工具层**消解（不必只靠提示词）；② 孩子 agent 不再持有"通用 SQL 读 / 通用写"能力，安全面与可维护面同时收窄；③ 工具数 28 → 28（删 3 加 3），但**语义全部是业务语言**（积分 / 掌握 / 考核），提示词可以写得下去。

**代价**：3 个新工具的开发与测试；`ISSUE-137` / `ISSUE-139` 的"读取路径"章节要改（从 `child_db_read` 改指新工具）。

### 路线 B（省事）：只删 `child_db_describe`

- 它**与 ③ 自动注入的表清单重复**（`session-registry.ts:318` 的 `dbTablesBlock`），模型读之前通常不需要先 describe；
- `child_db_read` 暂留，等 §3.2 改造 + 路线 A 的新工具就位后再删；
- **风险为零、收益小**，适合"现在不想动"。

### 路线 C（激进）：现在就删 `child_db_read`

- **明确后果**：B6 / G1 / F4 / E7 / F5 的"读出数据"这一段**立刻失效**；
- 只有在"接受这 5 条场景暂时不做"的前提下才可以——**不建议**。

---

## 六、影响面（改时会碰到的地方）

| 位置 | 内容 |
|---|---|
| `server/src/agent/child-db-tools.ts` | `CHILD_DB_TOOL_NAMES` 与三个工具定义；`createChildDbTools(...)` 调用点（`session-registry.ts:293`） |
| `server/src/agent/db-channel.ts` | `childKbWritableRegistry()`（写白名单）、`childKbTableSpecs()`（读注册表）——**删工具不等于删注册表**：`parent_db_read/write`（家长侧管理口径）仍在用同一份 |
| `server/src/agent/prompt.ts` + `registry-prompt.ts` | ③ 注入的"可读/可写表清单"文案（`db-channel.ts:1483` 那段）需与工具面**同时改**，否则提示词会教模型调不存在的工具 |
| 场景文档 §3 / §3.3 / §4（B6 G1 F4 E7 F5 G2 G3 行）/ §附 统计 | 已在本轮改口径；若走路线 A，需再改一遍工具名 |
| `ISSUE-136`（B6 / G1 / F4 三节）/ `ISSUE-137` / `ISSUE-139` | 提示词里凡"用 `child_db_read` 查…"的句子都要换成新工具名 |
| `ISSUE-105`（写面矩阵） | 写白名单的变更要回写该矩阵 |
| `probe:registry-drift` | 注册表漂移探针（新增工具不涉及，但**删注册表项要过它**） |

---

## 七、待拍板

1. **走哪条路线**：A（先补专用再删，推荐）/ B（只删 describe）/ C（现在就删，接受丢 5 场景）？
2. **走 A 的话，三个新工具的名字与粒度**是否认可（`child_points_report` / `child_mastery_report` / `child_exam_result`）？是否要合并成一个 `child_self_report(kind: points|mastery|exam)`（工具更少、但每个 kind 返回结构不同）？
3. **`child_db_write` 怎么收**：整只删（则兑换彻底无出口）/ 只留 `redemption_requests` 那一半（改成专用 `child_redeem_request`，更像业务语言）/ 原样留着等兑换链路做完？
4. **兑换（G2/G3）要不要立项**：① 家长端"发布可兑换奖励"入口（`redemption_items` 写入）；② 孩子端申请界面；③ 服务端 `/rewards/:childId/redeem`（家长 JWT、申请即扣）与 §6 硬约束 #6"家长履约才扣分"**二选一**并修掉冲突。
5. **`child_db_describe` 是否无条件删**（与 ③ 注入重复，与上面路线选择解耦）。

---

## 八、验收口径（若走路线 A）

1. **工具面**：`computeChildToolNames` 里不再有 `child_db_*`；主 / 课程会话工具名全部是业务语言；
2. **能力不回退**：B6 / G1 / F4 / E7 / F5 五条场景各自跑一遍真实对话——① B6 能说出"为什么没加分"（含门控口径）；② G1 能说出"哪笔积分、为什么"；③ F4 能说出"这门课学到哪、掌握到什么程度"；④ E7 能读出某场考核的逐题结果并只讲一两题；⑤ F5 能说出错题关联的课程 / 知识点；
3. **提示词同步**：③ 注入的表清单里不再出现"用 `child_db_read` 查询"的措辞；`ISSUE-136` 三节提示词里的工具名已替换；
4. **越权不回退**：新工具**一律只读**，且不接受任意表名 / 列名 / SQL 片段；`child_points_report` 等不得暴露 `operator` / 内部 id 之类的管理字段（沿用 §3.1 的"报内部数字"禁忌）；
5. **回归**：`probe:registry-drift` 通过；家长侧 `parent_db_read/write` 不受影响。

---

## 九、落地结果（2026-09-23 当晚实施，路线 A）

**用户拍板原文**：「既然梳理了场景，就针对场景设计工具或优化现有工具吧，不用通用工具了。如果再遇到没有考虑到的场景，就再增加工具吧。」
⇒ 即 **路线 A**（把兜底变成专用），并要求**后续增量按"先补专用工具"处理，不再开通用通道**。

### 9.1 改动清单

| 文件 | 改动 |
|---|---|
| **`server/src/agent/child-report-tools.ts`**（新增） | 三个**业务语言只读工具**：`child_points_report`（积分：余额 / 逐日结算含完成率·命中档位·门槛是否解锁 / 每笔流水原因 / 家长加分规则 → B6 G1）、`child_mastery_report`（学习情况：主题进度 / 每课掌握四列 / 最近考核得分率 / 每次学习结果 → F4 C1）、`child_exam_result`（考核：最近几场 / 某一场逐题含题干·原文·得分·对错·老师评语·有无录音 / 每课概要+复习重点 / 知识点档位 → E7）。**无表名/列名/SQL 入口**，取数范围写死在代码里 |
| **`server/src/agent/child-db-tools.ts`** | 删 `child_db_describe` / `child_db_read` / `child_db_write`；**只保留 `child_mistake_log`**；`action=list` 返回**补关联课程 / 知识点 / "有原题可重做"**（`course_ref` / `knowledge_point_name` / `question_id`，即 ISSUE-137 的缺口）；`course` 参数描述修正为"**课程名**（拿不准先 `kb_query` 查，别猜也别写主题名）"（原"关联主题/课程名（如 论语）"是混用）；`CHILD_DB_TOOL_NAMES` 收窄为 `["child_mistake_log"]` |
| **`server/src/agent/session-registry.ts`** | 装配 +3（`...createChildReportTools`）−3（通用工具随常量收窄）；`computeChildToolNames` 加 `...CHILD_REPORT_TOOL_NAMES` |
| **`server/src/agent/registry-prompt.ts`** | `buildChildSelfBlock` 从「22 张表的表名+列名清单 + 写面」改为**「我能查到什么 —— 哪个问题用哪个工具」能力清单**（不再暴露表/列；顺带删掉 `childKbWritableRegistry` 的 import） |
| **`server/src/agent/prompt.ts`** | 「数据规则」段补三个新工具与"**先查再答，不许凭印象**"；注入段标题由「我的数据表清单（列名以此为准）」改为「**我能查到的信息**」 |
| **`server/src/agent/db-channel.ts`** | `describeChildTables` 文案去掉工具名（**家长侧** `parent_db_describe` 仍在用同一函数）；`childKbWritableRegistry` 注释标注"**孩子侧已无调用者**，保留为 ISSUE-105 权限矩阵真源，供将来兑换类专用工具复用" |
| **`test/issue142-child-report-tools.test.ts`**（新增） | **11 例**回归：积分报告（含"门槛未过所以没加分"、越界 days 夹取、不吐 `operator`/`meta_json`）、掌握报告（概览 / 主题 / 单课含 `result_summary` / 课名对不上时不瞎编）、考核结果（已完成列表 / 逐题+每课概要+知识点 / **未考完不给题** / 课过滤 / 不吐 `audio_file_id`）、错题 list 关联字段 |

### 9.2 工具面变化（总数不变，语义全换）

| | 撤掉 | 新增 |
|---|---|---|
| 读 | `child_db_read`（22 表任意等值与列裁剪）、`child_db_describe` | `child_points_report`、`child_mastery_report`、`child_exam_result` |
| 写 | `child_db_write`（`daily_entries` + `redemption_requests`） | （写 daily 继续走 `kb_insert`/`kb_update`） |
| 记录 | — | `child_mistake_log` **返回增强** |

⇒ 主 / 课程会话工具数 **28 → 28**（删 3 加 3）；孩子侧**不再持有任何"任意表 / 任意列 / 任意写"能力**。

### 9.3 验收证据

1. `cd server && tsc --noEmit` **通过**（无错误）；
2. `test/issue142-child-report-tools.test.ts` **11 / 11 通过**；
3. 全量 `vitest run`：**8 files / 15 tests 失败，逐个核对后判定全部为既有失败（pre-existing）、与本次改动无关**——
   ① 这 8 个失败文件（`assess-guide` / `assessment` / `english-course-session` / `event-poll-config` / `kb-sqlite` / `page-bridge` / `sync` / `token-stats`）**没有任何一个 import 本次改动的模块**（`db-channel` / `child-db-tools` / `child-report-tools` / `session-registry` / `registry-prompt` / `prompt` / `tier2`）；
   ② 抽查 `kb-sqlite` 的失败原因是「progress 字段『掌握度』不支持」——那是 2026-09-10 计划域重构删掉的旧字段口径；`page-bridge` 的两处是桥脚本体积（13.54KB > 13KB 上限）与注入文本快照，均与本次无关；
   ③ **本次改动导致的两处过期断言已同步修正**：`test/db-channel-child.test.ts`（原断言 describe 文案含 `child_db_read` / `child_db_write`）、`test/data-channel-v2.test.ts`（原断言孩子元数据块含 `points_ledger` 表名）→ 改为断言新行为（文案不再绑工具名 / 元数据块是能力清单且**不含表名**）；
   ④ 改动面相关 3 个文件（`db-channel-child` / `data-channel-v2` / `issue142-child-report-tools`）**51 / 51 通过**；全量计数 514（含新增 14 例）。

### 9.4 有意留下 / 后续（按"遇到场景再加工具"处理）

1. **孩子侧灵活实体（`ns:`）读出口随通用读下线**：当前没有任何场景需要（场景表里没有"孩子读家长自定义实体表"），故不保留通用入口。**将来若出现该场景，按同样原则加专用只读工具**。
2. **兑换（G2/G3）仍无出口**：需要时加 `child_redeem_request` 这类**专用写工具**（单条申请、只写申请不扣分），并同时补家长端发布入口与孩子端界面；**不再恢复通用写**。
3. **一批旧组件保留**：`childKbTableSpecs` / `childKbReadableRegistry` / `describeChildTables` / `executeRead` / `executeWrite` 全部保留——**家长侧**（`parent_db_read` / `parent_db_write` / `parent_db_describe`）与注册表漂移探针 `probe:registry-drift` 仍在用；`childKbAdminWriteSpecs` 也仍在用（家长管理口径）。
4. **本轮没做（属其他 issue）**：§3.2 三个 `*_plan_list` 改造、`ISSUE-140` 的 3 个提醒工具、`ISSUE-141` 视频播放页、`ISSUE-139` 的 E7 提示词落地、`ISSUE-136` 提示词整体重排。
