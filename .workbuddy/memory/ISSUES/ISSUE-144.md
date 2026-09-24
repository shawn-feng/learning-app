# ISSUE-144：家长 agent 的「场景技能（skill）」——把常驻提示词改成"常驻层 + 按需加载的 8 个场景"

| 项 | 值 |
|---|---|
| 状态 | **P0–P4 + P7 已实施**：单测 **49/49**（skills 31 + P4 报告工具 18）、`tsc` 0 错、全量回归零新增失败（8 files/15 tests 为既有失败）；**P5/P6 未做**（P6 的前置已清） |
| 优先级 | 高（家长端最高频的"问"已能讲清：P4 三把报告工具到位） |
| 日期 | 2026-09-25 |
| 提出 | 用户：「能否通过 skill 来管理每个场景域的 prompt 和工具调用描述。这样按需调用，不会导致提示词臃肿以及工具描述太多太乱，分散模型注意力」→ 后续拍板「按场景划分」「入口让模型自选」「会话内不切工具集（怕丢缓存）」「拆成 学习考核安排 / 定时任务 两个场景，重复规则两边都写」→「都按照你的建议做。执行吧」 |
| 关联文档 | `docs/家长agent-场景skill方案-讨论稿.md`（方案）、`docs/家长agent-场景skill实施方案-2026-09-25.md`（执行版）、`docs/家长agent使用场景梳理-2026-09-24.md`（逐条台账：37 条 / 6 域） |
| 关联 issue | `ISSUE-142`（孩子端同类改造：把通用读写换成场景专用工具——家长侧是同一问题的未处理版本）、`ISSUE-136`（提示词按场景分层） |

---

## 一、做了什么（一句话）

家长提示词从**一份写死的长基底**改成「**常驻层（短）+ 8 个按场景加载的技能正文**」：常驻层只留身份、当前上下文、**场景索引**、**铁律**、通用通道兜底句与工作原则；各场景的步骤与汇报口径搬进 `server/src/agent/skills/parent/*`，由模型按家长意图调 `load_skill` **按需读进来**。**工具集全程不变**（不切工具，避免前缀缓存失效）。

## 二、改动清单

| 文件 | 改动 |
|---|---|
| **`server/src/agent/skills/parent/shared.ts`**（新增） | 技能类型 `ParentSkill`；**A 层铁律 `IRON_RULES`（A1–A7）** 与 `IRON_RULES_BLOCK`；**`REPEAT_RULES_BLOCK`（重复规则同源片段）** |
| **`server/src/agent/skills/parent/{progress,course,plan,automation,materials,child,points,config}.ts`**（新增 8 个） | 8 个场景技能正文（何时用 / 步骤 / 口径 / 红线 / 结束）：由原基底对应段落改写 + 台账各域讨论里已定的口径（考核三段式、掌握档位"空≠差"、错题本聚合、代理模型未配的报错处理、定时任务白名单与失败语义、配置管理负向口径…） |
| **`server/src/agent/skills/parent/index.ts`**（新增） | 注册表 `PARENT_SKILLS`（8 个）、**台账映射 `PARENT_SKILL_COVERAGE`**（34 条对话场景，一条只落一个场景）、`UI_ONLY_SCENARIOS`（A4 A5 F1）、`visibleParentSkills()`（灰度开关）、`buildSkillIndexBlock()`（常驻索引） |
| **`server/src/agent/parent-skills.ts`**（新增） | 覆盖层合并 `listParentSkillOverrides` / `resolveParentSkill`（**DB 优先、内置兜底**，上限 64KB 截断）、`createLoadSkillTool`（`load_skill`：会话内**幂等**、未知技能报可读错并列出可用项、加载日志） |
| **`server/src/db/agents.ts`** | 新增 `listAgentPrompts(dataDir, scope)`（列某 scope 全部当前版本；技能覆盖层用它取 `skill:<name>`） |
| **`server/src/agent/parent-registry.ts`** | `buildServerParentPrompt` **重写为常驻层**（原 8 个业务域段落移出）；装配加 `load_skill`（`customTools` + `toolNames`），`parent` / `parent-content` 共用 |
| **`server/src/agent/parent-plans.ts`** | `parent_exam_plan_create` 描述**瘦身**（1275 → ~470 字符）：保留"精确课程名 + 信息不全必须问 + 出题即时定死 + 特殊要求必须转参数"四条要点，把"常见说法 → `methodSpec`"对照表移进 `parent-scene-plan` 技能 |
| **`server/src/agent/parent-tools.ts`** | `parent_sync_courses_to_child` 描述的"何时调用"三条压成一条（其余在技能里）；**铁律（同步范围 / 不代分配 / 不删行 / 不动进度）原样保留** |
| **`test/issue144-parent-skills.test.ts`**（新增） | 31 例回归：预算（常驻字符数 / 每个技能规模 / 索引长度）、覆盖不重不漏、声明工具名存在、**重复规则两处同源**、**A 层"常驻层 + 技能 + 守卫"**、`load_skill` 正常/未知/幂等、**加载不改 system prompt 与工具面**、覆盖层（DB 优先 / 截断 / 清空回落 / 非 `skill:` 前缀不混入）、18 条验收样本静态自检、**A 路线 6 例**（压缩机制、逐把下沉形态、结构保留、工具→场景覆盖完整、省量、文案到场）+ 守卫 5 例（含多场景任一放行） |
| **`server/src/agent/parent-tool-compact.ts`**（新增，2026-09-25 A 路线） | 说明下沉的**统一压缩层**：`firstSentence`（第一句派生，括号内不切句）、`stripParamDescriptions`（只删 schema 说明、结构不动）、`scenesOfTool`（工具→场景，真源＝各技能 `tools` 清单）、`compactParentTool(s)`（原地改：描述→一句+指路、schema 去说明、`execute` 外包**场景守卫**）、`COMPACT_EXEMPT_TOOLS`（通用设施不下沉）。只在注册点过一道 ⇒ 工具数组不变、缓存前缀不受影响 |

## 三、预算（改前 → 改后，同一 `tablesBlock` 桩）

| 项 | 改前 | 改后 | 说明 |
|---|---|---|---|
| **常驻提示词** | **4710 字符** | **2501 字符**（-47%） | 组成：场景索引 987 + 铁律 691 + 通用通道兜底 338 + 当前上下文 141 + 工作原则 261 + 身份 42 |
| **技能正文** | 0（全在常驻） | **11491 字符（8 个，按需加载）** | 常驻 2501 < 全部正文 11491 —— 渐进披露成立 |
| 家长工具 description | 10732 字符 | **9833**（-8.4%） | 只瘦了 `parent_exam_plan_create` 这个离群值（1275）与 sync 的"何时调用"；**结构性规格与铁律一律不瘦** |

> **为什么工具描述只瘦这一点**：39 把工具的描述里绝大部分是**参数语义 + 铁律 + 参数化约束**（如 `methodSpec` 怎么传、执行会话白名单是什么），删了会让"没加载技能"的模型直接做错；真正冗余的只有 `exam_plan_create` 那一类"把参数说明再复述一遍 + 说法对照表"。测试里加了总量上限（10500）与单把上限（≤800）防回涨。

### 3.1 补测（2026-09-25 当日，更正"9833"的口径）

**上面那个 9833 只是 `description` 字段**，不含参数 JSON Schema，也不含 `load_skill` / `read·write·edit·ls` / `parent_display_report`。按"真正进请求的东西"量：

| 口径 | 数值 |
|---|---|
| 家长会话工具**把数** | **45**（39 业务 + `load_skill` + `read`/`write`/`edit`/`ls` + `parent_display_report`） |
| `description` 合计 | 10585 字符 |
| **参数 JSON Schema 合计** | **14493 字符**（比全部描述还大） |
| **工具块合计（每轮都在前缀里）** | **25078 字符** ≈ 常驻提示词（2501）的 **10 倍** |

按场景分摊（若将来真要按场景切，基数＝常驻基础设施 1788 字符）：`progress` 4256 / `automation` 2918 / `child` 3064 / `points` 3173 / `materials` 4312 / `course` 8099 / `plan` 9705（20 把）/ `config` 1788。最肥的 6 把＝`parent_upsert_course_content` 2257（其中 schema 1502，嵌套知识点/题目/选项）、`parent_db_read` 1385、`parent_db_write` 1268、`parent_exam_plan_create` 1267、`parent_scheduler_task_create` 1130、`parent_recurrence_create` 1020。
**没有任何场景声明**的：`parent_db_write` 1268（通用通道，待退场）、`parent_library_course_content` 453、`parent_db_describe` 409（待退场）、`log_activity` 299。

**内核事实核实（免得后人重推）**：`pi-coding-agent@0.84.1` 的 `dist/core/agent-session.js:631-645`，`setActiveToolsByName()` 确实会重建 system prompt，但 `agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt`，且 `_rebuildSystemPrompt()` 把我们的提示词当作 `customPrompt`（取自 ResourceLoader）⇒ **会话内切工具不会丢掉我们的常驻提示词**，也**不需要重建会话**。但"改了工具数组＝缓存前缀整条失效"依然成立，**决定 3（不切工具集）本轮未变**；另有一层待验证风险：历史消息里出现"当前已不在工具面"的工具调用，各家 provider 的容忍度不同。

### 3.2 试点（2 把）：工具说明下沉 + 场景守卫（2026-09-25 当日执行）

**为什么做**：工具块才是常驻上下文的大头（45 把 / 25078 字符 ≈ 常驻提示词的 10 倍）。逐层拆分量出：`description` 10585 + 参数 Schema 14493，而 Schema 里 **43%（6279）是散文**（属性说明），本属"场景口径/细则（B/C 层）"。⇒ 把**说明**下沉到技能（按需才进上下文），**只留结构**（字段名/类型/必填/嵌套/枚举），因为结构是**执行前校验与类型转换的依据**（`agent-loop.js:404` → `pi-ai` `validateToolArguments`），撤了就等于关校验（实测：空 schema 时 `{随便:1, topic:["不是字符串"]}` 原样放行）。

**试点对象（最肥的两把）**：`parent_upsert_course_content`（2257）、`parent_exam_plan_create`（1267）。

| 项 | 改前 | 改后 |
|---|---|---|
| 这两把（description + schema） | **3572** | **1477**（-2095，-59%） |
| 全体 39 把业务工具 `description` | 9833 | **8895**（-938） |
| **工具块全量（45 把，含 schema）** | **25078** | **22983**（-8.4%） |
| 常驻提示词 | 2501 | 2501（未变） |
| 8 个技能正文合计 | 11491 | **12705**（+1214，即下沉的说明） |

**改了什么**
1. 两把工具的 `description` 压成"一句 + 自我指路"（`…先 load_skill("parent-scene-course") 再调用——未加载时拒绝执行`，≤160 字符）；
2. 参数 Schema 里**所有 `description` 删除、结构一字不动**；`items` 改用新助手 `BareJsonArrayParam`（保留 `数组 or 字符串` 的 anyOf 兜底分支——某些模型会整串序列化，ISSUE-133/134，但**不再在 schema 里写提示**，提示进技能）；
3. 搬走的语义逐条归入 `parent-scene-course`（步骤 4 展开：整课全量快照 / knowledgePoint 与 knowledgePointId / 题的三种给法 / 题字段与缺省值 / 直接传数组）与 `parent-scene-plan`（步骤 6 增补：参数语义表 / 出题创建时定死 / 必须先有知识点与题库题）；
4. **新增场景守卫**（`parent-skills.ts` 的 `createParentSkillState` / `scenarioGuard`）：同一会话内**没加载过**所属场景时，工具**拒绝执行**并返回可读提示（先 `load_skill`）。`parent-registry` 建会话时创建一份状态，注入 `load_skill` + 两把试点工具（脚本/测试直调不传状态＝不拦）。这把"按需"从**建议**变成**机制**——否则说明搬走后，模型会在没读说明书的情况下靠猜写数据，而结构校验拦不住语义错误。

**这里主动改了一条已拍板的设计决定**：A 层铁律原来"三处同留（工具描述 + 常驻层 + 技能）"，试点工具**撤掉工具描述那一处**，改为"**常驻层 + 技能 + 守卫**"。（A1/A3 等未试点工具仍三处同留。）测试 `A 层第三处：未试点工具仍写在工具描述里；试点工具改为「指向技能 + 守卫」` 守住这条边界。

**待观察（下一批要盯的）**
- 模型会不会"没加载技能就调工具"→ 守卫拒绝一次后能否自愈（`PARENT_SKILL_SAMPLES` 里 course/plan 的样本要重点看这步）；
- `items` 的字符串化率（提示从 schema 移走后）是否上升——若上升，把该提示也写进技能对应段落即可，无需回退结构；
- 全量铺开前先确认这两把在真实会话里的表现（guard 命中率、拒跑后的自愈率）。

**验证**：`test/issue144-parent-skills.test.ts` **28/28 通过**（新增 8 例：描述长度与指路、schema 无 description、结构保留、省量对比、文案到场、守卫三种情形、加载即解锁、真实工具拒跑/放行）；`cd server && npx tsc --noEmit` **exit 0**；全量 `vitest run` = 8 files / 15 tests 失败、525 passed / 8 skipped（548 tests），失败清单与既有基线**逐项一致**，**零新增失败**。

### 3.3 评估（2026-09-25 当日）：**「用通用工具替代大部分专用工具」——已评估，不采纳**

**提议**（用户提出）：既然 `parent_db_read` / `parent_db_write` / `parent_db_describe` 在工具块里占比很低，就用它们替掉大部分专用工具，把"当前场景怎么用通用工具"写进场景技能 ⇒ 工具块更简单，专用方法按需加载。

**先纠前提**：通用三把确实便宜（3062 = `db_read` 1385 + `db_write` 1268 + `db_describe` 409），但**便宜正是因为它们不含语义**。按 40 把实测（`desc + schema`）：

| 分组 | 把数 | description | schema | 其中"只留结构" | 合计 |
|---|---|---|---|---|---|
| **通用三把** | 3 | 1112 | 1950 | 988 | **3062**（占 45 把的 12.2%） |
| `load_skill` | 1 | 292 | 137 | 77 | 429 |
| **非表类**（物料 6 + 视觉/附件/逐字稿/`log_activity`） | 10 | 2226 | 1823 | 1037 | 4049 |
| **其余（可换通用通道）** | 26 | 5557 | 8575 | 5538 | **14132** |

**三条路线的字数账**（同一口径，45 把 / 25078 现状）：

| 路线 | 组成 | 工具块 | 相对现状 |
|---|---|---|---|
| 现状 | — | 25078 | — |
| **A 全量下沉 + 守卫** | 各留一句（≈45×60）+ schema 只留结构（7640 + fs/display ≈ 2.4k） | **≈ 12~13k** | **-49%** |
| **B 通用工具替代专用工具** | 三把 3062 + `load_skill` 429 + 非表类 4049 + fs/display 3406 | **≈ 10946** | **-56%** |

⇒ **B 比 A 只多省约 1.8k 字符**（≈ 现状 7%，≈ 25 万窗口的 0.7%）。而这个地板**不能再低**：物料真源是**文件系统**（`parent-materials.ts` 沙箱路径校验，不是注册表）、图片/附件是视觉与上传层、逐字稿带归属校验——通用通道根本替不了这 10 把。
**顺带修正**：本节 §3.2 与实施方案里"全量 25078 → 10778"的目标偏乐观；按实测结构下限（40 把结构 7640 + fs/display ≈ 2.4k）加 45 句一句话，**A 的真实终点是 12~13k**。

**不采纳的六条理由（每条都有代码位置）**

1. **引擎字段要模型手写 JSON，而这个坑已经踩过一次**：`exam_plans.scope_json` 的结构是 `[{title, kps:[{name,count}]}]`，由服务端从"课程→知识点→题库题"实际数据推导（`assess-selection.ts` 的 `buildPlanSpecEntries`），开考时按它抽题；而通用通道只当它是 `TEXT`（孩子库全列都是 `str(desc, 20000)`，`db-channel.ts:935-946`）。`assess-selection.ts:241-266` 明确写着 `scope_json.courses` **存在两种历史格式**（旧 `["课程名"]` / 新 `[{title,kps}]`）、非法项**静默丢弃**——这就是半结构化 JSON 进库留下的化石。同类字段还有 `plan_recurrences.payload_json`（`plans-range.ts:190`、`worker/plan-domain.ts:161` 按 `plan_type` 解析）、`children.profile_json`、定时任务 payload。
2. **孩子库管理写规格的语义校验 ≈ 0**：`childKbAdminWriteSpecs()` = `childKbTableSpecs()` 全表 + 全 ops，列规格是 `str(desc, 20000, {notEmpty:false})`——**无类型/无枚举/无必填/无引用校验**，且"insert 需自带 id/时间戳（未配 `serverGenerated`）"（`db-channel.ts:1296`）。今天这些字面量写死在工具里：`creator='parent'`、`kind='custom'`、`status='pending'`、`freq=''`、`attempt_id=''`、`count_in_rate=1`、`points=0`、`active=1`（`parent-plans.ts:830-833`）、id 形态 `ep_<ms>_<rand6>`。通用化后每个字面量都要进技能散文、由模型每次手打，**没有任何东西在核对**。
3. **多表/多库事务退化成 N 次独立写**：`parent_upsert_course_content` 是"只读预校验 → getOrCreate 知识点 → 复用题库题 → 整课替换"，`parent-tools.ts:1052` 那句注释就是为防"报错但已建出孤儿知识点/题"；通用化后是逐表 5~10 次调用、各自独立事务。`parent_rename_course`（保 uuid + 联动所有孩子库，描述里点名 ISSUE-123 R1）、`parent_sync_courses_to_child`（跨家长库 + N 个孩子库、保进度、幂等）同理。
4. **报错质量退化**：今天会说「要求的知识点「X」在该课不存在（现有：…）」（`assess-selection.ts:318`）；`db_write` 只能报形状错误（列未登记），语义错误静默入库。
5. **往返次数与延迟上升**：一次 `parent_study_plan_create`（739 字符）内部就完成逐日展开 + 真实课程名校验 + 同日同课去重；通用化后要先 read 课程 → read 已有计划 → 逐条 insert（`rowLimit` 50）→ 出错重来。读侧同理：`parent_exam_plan_list`（597）返回的是把 `scope_json` 展开成人话的视图，`db_read` 只给原始 JSON 行。
6. **这个方向在本仓库已被反转过一次**：孩子侧 `child_db_write` 于 ISSUE-142 撤掉（`child-db-tools.ts:4`、`db-channel.ts:1224-1228`，按"场景 → 工具"逐条对齐）；`parent_db_write` 自己的描述就写着「**不要**用它替代 `parent_upsert_course_content` 的整课替换语义」。且 ISSUE-133 的存在说明：schema 一放松，模型就开始把 JSON 参数**字符串化**，通道层不得不写还原层——schema 松 ⇒ 格式漂移，有实证。

**还要一条硬约束**：**结构搬不进技能**。说明（description）能搬，结构（字段名/类型/必填/enum）不能——模型**选工具那一刻手里还没有技能**，得先看见参数契约才敢选。若连结构也撤掉（工具只声明名字、参数留自由文本），等于关掉执行前校验（实测：空 schema 连 `{随便:1, topic:["不是字符串"]}` 都放行）。

**吸收进来的两条替代路径**

- **A（本 ISSUE 主线，已采纳）**：全量说明下沉 + 场景守卫 ⇒ 工具块 ≈ 12~13k，语义、校验、引擎调用**全保留**。
- **C（后续候选，需实测）**：**按场景聚合动作**——把 10 把只读工具（2821 字符）合成 1~2 把 `parent_plan_query({childName, what, from, to, id})`、把 4 把 update（2183）合成 1 把 `parent_plan_update({what, id, action, …})`。服务端逻辑与校验全留，只压工具面，粗估再省 3~5k；代价是 union schema 变肥、要防 `what` 选错。
- 另：**只读侧的 db_read 配方**可以写进技能作兜底（`progress` / `points` 已有此口径），但那是补路径，不省工具块。

**决定**：不采纳"通用工具替代专用工具"（B）；工具块继续沿 A 全量铺开（见 §3.4），把"更简单"的诉求转到方案 C。

### 3.4 A 路线全量铺开（2026-09-25 当日执行，用户拍板「继续 A 全量铺开」）

**做法：机制化，不再逐把手改。** 新增 `server/src/agent/parent-tool-compact.ts`，在**注册点**（`parent-registry.ts` 的 `customTools`）统一过一道：

| 机制 | 说明 |
|---|---|
| `firstSentence(desc)` | 取原描述**第一句**作自述（括号/书名号内不切句，超 140 字截断）⇒ **单一真源**：源码里的长描述仍是"说明书真源"（不进上下文），进模型视野的只有这一句 + 指路，两处不会漂移 |
| `stripParamDescriptions(schema)` | **原地**删除参数 Schema 里所有 `description`（只删说明键，字段名/类型/必填/嵌套/enum/`anyOf` 一字不动；原地改保留 TypeBox 符号与 `prepareArguments`，ISSUE-134 的参数还原层不受影响） |
| `scenesOfTool(name)` | 工具 → 场景，真源＝各技能声明的 `tools` 清单；同一工具可属多场景 ⇒ 守卫**任一场景已加载即放行**（`parent_list_children` 属 progress/plan/child，`read_image`/`read_upload`/`put_material` 属 course/materials，`library_topics`/`library_course_content` 属 progress/course） |
| `compactParentTool(s)` | 三者合一，并把 `execute` 外包一层 `scenarioGuard`；**幂等**（试点两把的形态由它重新派生，逐字一致，故试点的手写守卫已移除、本文件不再手写） |
| `COMPACT_EXEMPT_TOOLS` | **不参与下沉**：`load_skill`（加载器）、`parent_db_read`/`parent_db_write`/`parent_db_describe`（跨场景通用通道、P6 退场候选）、`log_activity`（通用设施）；另 `read/write/edit/ls` 无场景归属，原样保留 |

**预算（同一套装配实测，`description + 参数 Schema`）**

| 项 | 原始基线 | 试点后 | **A 路线全量后** |
|---|---|---|---|
| **工具块（45 把）** | 25078 | 23086 | **15997**（相对原始 **-36%**；相对试点后 -31%，省 7089） |
| 其中 `description` | 10585 | 9702 | **6447** |
| 其中参数 Schema | 14493 | 13384 | **9550**（结构性的 7640 是地板） |
| 下沉工具数 | — | 2 | **37** |
| 未归属/豁免（原样保留） | — | — | **9 把 / 4843 字符**（`load_skill` 429 + 三把通用 3062 + `log_activity` 299 + fs 四把 1053） |
| 8 个技能正文合计 | 11491 | 12705 | **17706**（+5001：各技能新增「## 参数速查（本场景工具）」） |
| 常驻提示词 | 4710 | 2501 | **2501（未变）** |

**说明**：A 的真实终点是 **~16k**（不是方案里估的 10.8k）；差额就是**豁免保留的 4843**（通用通道要等 P6/P4 才会离开工具面）。§3.3 已把"12~13k"修正为实测口径。
**P4 之后（§3.5）**：工具面 45 → **48 把**，注册后工具块 **16848**（源码态 24010）；8 个技能正文 **19265**；常驻提示词仍 **2501**。三把新报告工具自带口径（进技能而非工具块），是"用专用工具换掉通用通道"的正常代价。

**决定变更（全量生效）**：**A 层铁律从"三处同留（工具描述 + 常驻层 + 技能）"改成"常驻层 + 技能 + 场景守卫"**——工具描述那一处对**所有**下沉工具撤掉，第三处由机制（未加载场景则拒跑）承担。§四 决定 4 已同步。

**技能侧同步补的内容**（把原来长在工具描述/schema 里的语义搬过来，`## 参数速查（本场景工具）`）：
- `course`：`topic_key` 与 `name` 主键关系、"**覆盖只更新你给的字段**"、`upsert_course` 全字段与缺省、`library_course_content` 返回的 `id=` 用途、`rename`/`sync`/`put_material`/`build_material`（`.html` 结尾）/`read_image` `path` / `read_upload` `ref`；
- `plan`：`id` 可只传**前 8 位**、`act` 三种/四种动作与各自必带参数、`days[]` 结构、"复习："前缀、重复规则的 `planType`/`rule`/`weekday`/`startDate`/`endDate`、`list` 的 `from`/`to`；
- `materials`：`topic`/`relPrefix`、`confirm` 的 dryRun 语义、"目标已存在会被拒绝"、"先写新路径再删旧路径"；
- `child`：`aiName`/`aiEmoji`/`aiPersonality`/`age`/`grade`/`interests`、"只改你传的字段"、同名会被拒 + 数量上限；
- `progress`：`date` 的三种形态（`YYYY-MM-DD` / `all` / 口语）、`days` 缺省 3 最多 7、`parent_display_report` 的 markdown/title；
- `automation`：`frequency` 四态与 `weekday`/`intervalMinutes`/`fireAt`。

**验证**：`test/issue144-parent-skills.test.ts` **31/31 通过**（原 28 例改写 + 新增：压缩机制单测、**逐把**下沉形态、结构保留抽查、工具→场景覆盖完整、省量、六场景文案到场、多场景守卫任一放行、只读工具同样在守卫内）；`cd server && npx tsc --noEmit` **exit 0**；全量 `vitest run` 见 §七。

**风险与回滚**：守卫会让"没加载场景就调工具"多一次往返（这是设计意图：把按需从建议变成机制）；若某个工具误判场景，只需在对应技能的 `tools` 清单里增删一项（单一真源）。回滚＝注册点去掉 `compactParentTools` 一层（工具数组与语义即回到源码形态），或逐把加入 `COMPACT_EXEMPT_TOOLS`。

### 3.5 P4：三个场景专用读工具（孩子的数据洞察，2026-09-25）

**为什么**：台账 §3.2 把"家长读考核 / 掌握 / 积分"列为**通用通道退场的硬前置**——D1（考得怎么样）、D5（哪里薄弱）、D3（错题本）、F3（积分怎么算）、F2（兑换）此前唯一的读数路径是 `parent_db_read`（对孩子库逐表拉行）：**有数据、没工具、没口径**。三把工具落地后，progress / points 两个场景的读数**不再依赖通用通道**。

**交付（新增 / 改动）**

| 文件 | 改动 |
|---|---|
| **`server/src/agent/parent-child-report-tools.ts`**（新增） | 三把**业务语言只读**工具：`parent_child_exam_report`（D1）/ `parent_child_mastery_report`（D5+D3）/ `parent_child_points_report`（F3+F2）；常量 `PARENT_CHILD_REPORT_TOOL_NAMES` |
| **`server/src/agent/report-utils.ts`**（新增） | 从 `child-report-tools.ts` 抽出的**共用零件**（档位解析与默认档位、掌握/结果/行为的中文说法、日期与百分比）——**同一份数据在两端只有一种说法**（档位口径必须与 `worker/plan-domain.ts` 的 `matchTier` 一致） |
| `child-report-tools.ts` | 改为复用 `report-utils`（输出逐字不变，ISSUE-142 的 14 例回归全过） |
| `parent-tools.ts` | 导出 `resolveConvoChild`（姓名 → 孩子 id 的**归属校验只有这一处**） |
| `parent-registry.ts` | 装配 +3（`customTools` 与 `toolNames` **同时**加），仍走注册点的 `compactParentTools`（说明下沉 + 场景守卫） |
| `skills/parent/progress.ts` / `points.ts` | 声明的 `tools` 补齐（**工具 → 场景的单一真源**）；「数据从哪来（现状）」改成**能力清单（哪个问题用哪个工具）**、不再列原始表名；各加「参数速查」；口径按核实后的机制重写 |
| **`test/issue144-parent-report-tools.test.ts`**（新增） | **18 例**：三把工具的输出契约、未考完不给题、内部字段不泄漏、对象定位（唯一孩子可省略 / 不存在报可选名 / 多孩子必须问清 / 越权读不到）、场景归属、描述只有一句 |
| `test/issue144-parent-skills.test.ts` | 装配、`known` 工具面、样本（D1/D5/F3 三条改指新工具）、文案到场、守卫（三把报告工具未加载场景同样拒跑）；预算上限随工具面同步抬 |

**契约（三把工具）**

| 工具 | 入参 | 返回 |
|---|---|---|
| `parent_child_exam_report` | `child?` · `plan_id?` · `course?` · `limit?` | 不传 `plan_id`：最近几场（每条含范围 / 得分 / 错题数 / `id=`）+ **【整体】近 N 场得分率趋势** + 未考场次的范围；传 `plan_id`：**【每门课】**（得分率 + 概要 + 复习重点）→ **【知识点】**（扎实 / 部分掌握 / 薄弱 + 本次情况）→ **【逐题】**（题干 / 原文 / 孩子答的 / 得分 / 对错 / 老师评语 / 有无录音） |
| `parent_child_mastery_report` | `child?` · `topic?` · `course?` | 概览：各主题进度（已学 / 下一课 / 最近学习 / 已掌握 / 需要复习 / **还没分析过**）+ **【薄弱项（错题本，未关闭）】**按 kind 聚合（条数、本周新增、最常出现的 ×次数）；`topic`：逐课 + **需要盯的知识点** + 该主题错题；`course`：掌握档位与叙述 + 教学建议 + **知识点档位（学 / 考次数、最近一次）** + 最近学习结果 + 本课错题 |
| `parent_child_points_report` | `child?` · `days?` | 余额 + **加分规则**（家长组按率直接评档 / 加分项看家长组门槛 + 只加不扣设置 / 次日日终结算）+ 逐日结算（完成率 · 漏项 · 档位 · 门槛 · 结算分，含"门槛未过所以没加分"）+ 最近流水 + **已提交未发放的兑换** |

**与孩子端三处刻意不同**：① 对象是**孩子**（`child` 姓名，名下唯一可省略；走同一套归属校验，找不到就报可选名字，多孩子必须问清——**绝不默认挑一个**）；② **口径是家长口径**（结算是"必做项直接评档 + 加分项看家长组门槛"，与孩子端那句简写不同，所以不能共用一把工具）；③ **仍不给标准答案**（答案在家长库，家长问解法时另调 `parent_library_course_content`，并按红线说明"这是给家长看的解释，要不要告诉孩子由你决定"）。

**本轮核出的两处"文档 ≠ 实现"（都已按实现改写，留待家长拍板）**

| # | 台账 / 旧技能里的说法 | 代码实际 | 处理 |
|---|---|---|---|
| 1 | 积分"**必须完成项**达标才解锁加分"、"每天结算一次" | **分两组**：家长组按完成率 / 得分率**直接评档**（可能真扣分）；**门槛只卡"孩子自排的加分项"**，门槛＝当天**家长组**达标；**结算在次日日终**，当天那行只是实时进度 | `parent-scene-points` 的账本口径按实现重写（依据 `worker/plan-domain.ts:581-647`）；报告工具的输出也照此讲 |
| 2 | F2"扣分发生在**家长履约**时，不是申请时" | 兑换在**提交那一刻**就扣分并写 `type='redeem'` 流水（`routes/plans-rewards.ts:659-708`），同时生成 `status='pending'` 记录；`fulfilled_at` 目前**无写入方**，该接口**也没有界面调用方** | 报告工具改说"提交时就扣分、上面这些只是还没标记已发放"，并明确"发放在对话里没有入口"；台账 §8 #5 记为**待拍板**（产品口径要不要改成"履约时扣"） |

**验证**：`test/issue144-parent-report-tools.test.ts` **18/18**；`test/issue144-parent-skills.test.ts` **31/31**；`test/issue142-child-report-tools.test.ts` **14/14**（共用零件抽取后孩子端行为不变）；`cd server && npx tsc --noEmit` **exit 0**；全量回归见 §七。

**预算（P4 之后）**：工具面 45 → **48 把**；工具块（description + Schema）源码态 **24010** → 注册后（进上下文）**16848**（P7.4 时为 15997，三把新工具 **+851**）；8 个技能正文 17706 → **19265**（progress / points 两篇扩容）；常驻提示词仍 **2501**（未变）。

## 四、关键设计决定（含理由）

1. **技能正文放 TS 模块，不放 `.md` 文件**：server 是 esbuild 打包运行（`server/src/index.ts` 有"bundled 后 `__dirname` 变化"的教训），文件要额外处理构建/asar 拷贝；而 TS 常量还能让**重复规则物理同源**（`REPEAT_RULES_BLOCK` 被 plan / automation 两处引用，测试断言两处都 `toContain` 同一常量）。
2. **不启用 SDK 自带的 Agent Skills**：① 它给的是**绝对路径** `<location>`，而我们的 `read` 拒绝绝对路径、`learning-guard` 又把 FS 限制在会话 cwd ⇒ 模型拿到路径也读不到；② 打开默认发现目录会扫 `~/.pi/agent/skills`、`~/.agents/skills` 与 **cwd 及其祖先目录**的 `.pi/skills`，而 cwd 是模型自己可写的地方 ⇒ 等于让模型给自己写指令；③ 家长覆盖层本来就要自建；④ 少依赖一层 SDK 语义（server 精确 0.84.1 / client ^0.84.1）。⇒ **自建索引 + 自建 `load_skill`，`packages/agent-core` 一行未改**。
3. **会话内绝不切工具集**：`setActiveToolsByName` 会重建 system prompt，而工具数组与 system prompt 都在消息之前 ⇒ 改头＝整条前缀缓存作废。技能正文以"工具结果"进入消息尾部，**前缀不动**。测试里加了断言防后人回退这一点。
   - **补（2026-09-25 核实）**：内核 `dist/core/agent-session.js:631-645` 的 `setActiveToolsByName()` 并**不会丢掉我们的常驻提示词**（`agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt`，而 `_rebuildSystemPrompt()` 把我们的提示词当 `customPrompt`），也**不需要重建会话**。但"改工具数组＝缓存前缀整条失效"依然成立，**决定未变**；另外历史消息里会出现"当前已不在工具面"的工具调用，各家 provider 容忍度待验证。
   - **注意区分**：**缩减工具描述/schema（§3.2 试点 / §3.4 全量）不等于切工具集**——工具数组不变，缓存前缀不受影响，只是"宣告的文字"变少。
4. **口径分三层**（实施方案 §2.3）：**A 铁律**、**B 场景口径**（只在技能）、**C 细则模板**（技能内靠后段落）。A 层每条有 ID（A1–A7），测试逐条核对。
   - **改动（§3.2 试点 → §3.4 全量生效）**：A 层原来"三处同留（工具描述 + 常驻层 + 技能）"，现在下沉工具**撤掉工具描述那一处**，变成"**常驻层 + 技能 + 场景守卫**"。理由：说明既然按需加载，工具描述就不再是可靠落点；而守卫（未加载场景 → 拒跑）保证模型**在执行前**必定读过铁律与参数语义。测试逐条核对常驻层与技能两处仍在，并断言下沉工具描述里不再有铁律正文。

## 五、验收证据

1. `test/issue144-parent-skills.test.ts`：**31 / 31 通过**（§3.4 / §3.5 后）；
2. `test/issue144-parent-report-tools.test.ts`：**18 / 18 通过**（§3.5 P4 新增）；
3. `test/issue142-child-report-tools.test.ts`：**14 / 14 通过**（共用零件抽取后孩子端行为不变）；
4. `cd server && npx tsc --noEmit`：**exit 0，零错误**；
5. 全量 `vitest run`：见 §七（按 `ISSUE-142` §9.3 的口径甄别既有失败）；
6. 预算数字见 §三 / §3.5（测试里会打印，可随时复跑）。

## 六、没做的事（明确留出）

| 项 | 为什么没做 |
|---|---|
| **P3.2 界面显示"已进入：{场景名}"** | 目前已可观测：`load_skill` 的工具结果首行固定是「已加载场景：{中文名}（{name}）」，服务端也打 `[parent-agent] skill loaded: <name>`；**前端展示**要改 `src/components/ParentChatPanel.tsx` 并重建 Web 产物，单独排（可观测性增强，不阻塞） |
| ~~**P4 三个场景专用读工具**~~ | **已做（§3.5）**——D1 / D3 / D5 / F2 / F3 的读数不再依赖通用通道 |
| **P5 家长自定义层界面** | 存储与读取通道**已经通了**（`agents.sqlite` 的 `scope=parent`、`ref=skill:<name>`；本 ISSUE 已实现读取与"覆盖优先"，测试覆盖）；缺的是**设置页编辑框** + `server/src/routes/db.ts` 的 ref 放开（现在 `scope=parent` 会把 ref 强制成 `parentId`）+ 红线校验 |
| **P6 通用通道退场** | **前置已清（P4 完成）**：剩下的触发条件是"上线后观察一个版本周期无断供"；`parent-data` 会话与 `parent_db_*` 暂留（用户已确认"暂时保留"）。⚠️ 退场时要把 `progress` 技能里那两句"兜底通道"话术与 `parent_db_read` 的声明一并删掉，否则提示词会教模型调不存在的工具 |
| **行为层 20 条样本实跑** | 需要有模型配置的会话；样本清单已固化在 `test/issue144-parent-skills.test.ts` 末尾（`PARENT_SKILL_SAMPLES`，18 条对话样本 + 2 条负样本），静态自检已过（技能存在、工具名存在、8 个场景都有样本）。**要重点看三件事**：① 模型会不会先 `load_skill` 再调工具（守卫命中率 / 被拒后的自愈率，含只读工具）；② 多场景工具的 `load_skill` 选择是否会绕远（如 `list_children` 现在提示了四个场景）；③ **P4 三把报告工具的触发是否准确**（"考得怎么样"→ `exam_report`、"哪里薄弱"→ `mastery_report`、"这分怎么算的"→ `points_report`），以及**多孩子时会不会正确地问一句**而不是猜 |
| **通用三把 + `log_activity` 的说明未下沉** | `parent_db_read`/`parent_db_write`/`parent_db_describe` 是**跨场景通用通道**（无单一场景归属，且是 P6 退场候选），`log_activity` 是通用设施——它们连同 fs 四把共 **4843 字符**留在工具块里，是 A 路线 16k 中的主要"未瘦"部分；P4/P6 落地后自然消失 |

## 七、本轮证据（回填）

1. **本次新增回归**：`test/issue144-parent-skills.test.ts` **20 / 20 通过**（预算、索引与台账覆盖、重复规则同源、铁律三处同留、`load_skill` 正常/未知/幂等、缓存护栏、覆盖层 5 例、样本静态自检）；
2. **类型检查**：`cd server && npx tsc --noEmit` **exit 0，0 错**；
3. **预算输出**（测试每次都会打印，可随时复跑）：常驻提示词 **4710 → 2501**；8 个技能正文 **11491**（按需加载）；家长工具描述 **10732 → 9833**（最长单把 755 ≤ 800 上限）；
4. **全量回归**：`npx vitest run` → **8 files / 15 tests 失败，517 passed / 8 skipped（63 files / 540 tests）**。
   这 8 个失败文件与 `ISSUE-142` §9.3 记录的**既有失败基线完全一致**（`assess-guide` / `assessment` / `english-course-session` / `event-poll-config` / `kb-sqlite` / `page-bridge` / `sync` / `token-stats`），**本次改动零新增失败**；
5. **回归清单留档**：`tmp/issue144-regression.txt`（失败文件清单）。

### 7.1 执行中的一次事故与修复（过程留档，避免重演）

- **事故**：用 PowerShell 的 `Get-Content -Raw … -replace … | Set-Content` 批量改 `ISSUE-143 → ISSUE-144` 时，本机 shell 以 **GBK** 解码 UTF-8 文件，回写后 4 个文件出现中文乱码、**换行被吞**（`parent-registry.ts` 直接编译不过）。
- **修复**：
  1. `server/src/agent/parent-registry.ts` → 该文件在工作区的唯一差异就是本次改动，**从 `git HEAD` 恢复**（512 行，已核实含 ISSUE-131 P2 / parent-data / 计划域工具），再用 `edit` 工具**逐条重放**本次 4 处改动；
  2. `skills/parent/shared.ts` / `parent-skills.ts` / `docs/家长agent-场景skill实施方案-2026-09-25.md` → 本次新建文件，直接以 `write` 工具重写；
  3. 复核：三个文件无 U+FFFD、`tsc` 0 错、20/20 单测与预算数字与事故前**完全一致**（2501 / 11491 / 9833）。
- **结论（写进实施方案 §5 风险 9）**：本机该 shell **不能**用于中文文件的原位文本替换；一律走 `edit`/`write` 工具，或 .NET 显式 `UTF8Encoding`。

### 7.2 A 路线全量铺开的证据（2026-09-25 当日）

1. **单测**：`npx vitest run test/issue144-parent-skills.test.ts` → **31 / 31 通过**（含 A 路线 6 例 + 守卫 5 例）；
2. **类型**：`cd server && npx tsc --noEmit` → **exit 0**；
3. **预算**（测试内打印，可复跑）：工具块（45 把，`description` + 参数 Schema）**23086 → 15997**（相对原始基线 25078 **-36%**）；`description` 9702 → 6447；8 个技能正文 12705 → **17706**；常驻提示词仍 **2501**；
4. **全量回归**：`npx vitest run` → **8 files / 15 tests 失败，528 passed / 8 skipped（63 files / 551 tests）**。失败清单与既有基线**逐项一致**（`assess-guide` / `assessment` / `english-course-session` / `event-poll-config` / `kb-sqlite` / `page-bridge` / `sync` / `token-stats`），**零新增失败**；留档 `tmp/full-regression-2.txt`；
5. **顺带发现（真正的 flake，与本改动无关）**：中间有一次全量跑出现 `learning-summary.test.ts` **7 例全失败**（那次为 9 files / 22 tests）。四组证据判定它是**环境依赖型 flake**，不是回归：
   - 单独跑 → 7/7 通过；与 `issue144-parent-skills.test.ts` 一起跑 → 38/38 通过；
   - 全量跑**排除**本测试文件 → 恰好回到基线（8 files / 15 tests）；**重跑**全量 → 也回到基线（8 files / 15 tests，528 passed）；
   - 原因：它依赖**外部已在运行的本地服务端**（`127.0.0.1:8788`，见 `test/helpers/server-token.ts`）与 `server/data` 里的真实测试家长数据（"拿到下一课（真实数据）"），任何时刻该环境抖动都会让它失败。
   - **建议**：单独开一个 ISSUE 处理（给它加"服务端不可用则 skip"的前置探测，或把它移出默认 `vitest run`）。
6. **执行中的一次语法事故（留档）**：往技能正文的**模板字符串**里插入 Markdown 反引号时忘了转义（`` ` `` 会终止模板字符串），`tsc` 立刻报 `TS1005/TS1443`；已全部改为 `\`` 转义。**教训：技能正文是模板字符串，反引号必须转义。**

### 7.3 P4（三个场景专用读工具）的证据（2026-09-25 当日）

1. **新增回归**：`npx vitest run test/issue144-parent-report-tools.test.ts` → **18 / 18 通过**（列表与趋势、逐题与每课概要、未考完不给题、`course` 过滤、掌握三层层级、"还没分析过"、薄弱项聚合、积分与兑换、越界 `days` 夹取、内部字段不泄漏、对象定位 4 例、装配与场景归属 3 例）；
2. **既有回归**：`test/issue144-parent-skills.test.ts` **31 / 31**（装配/工具面/样本/文案/守卫已同步加进 P4 三把）；`test/issue142-child-report-tools.test.ts` **14 / 14**（共用零件抽取后孩子端输出不变）；
3. **类型**：`cd server && npx tsc --noEmit` → **exit 0**；
4. **预算**（测试内打印）：工具面 45 → **48 把**；工具块源码态 **24010** → 注册后 **16848**（三把新工具 +851）；8 个技能正文 17706 → **19265**（仍逐篇 ≤ 6000）；常驻提示词 **2501 未变**；
5. **全量回归**：`npx vitest run` → **8 files / 15 tests 失败，546 passed / 8 skipped（64 files / 569 tests）**。失败清单与既有基线**逐项一致**（`assess-guide` / `assessment` / `english-course-session` / `event-poll-config` / `kb-sqlite` / `page-bridge` / `sync` / `token-stats`），**零新增失败**；留档 `tmp/p4-full-regression.txt`；
6. **一次测试自身的写法错误（留档，非产品问题）**：新增测试里有三处**我自己的期望写错**——① 断言"未考完不给题"时用了 `not.toContain("逐题")`，而提示语本身就写着"逐题明细与评语就会出来"（改为断言不给 `【逐题】` 段与题干原文）；② 以为"为政第二"的错题不算"论语"主题（它算，`course_ref` 过滤是按该主题下的课程名集合）；③ 多孩子提示名单按 `name` 排序（同秒创建时 `created_at` 相同）→ 改为断言两个名字都在，而不是固定顺序。**教训：断言要贴着"该说什么"写，不要贴着我以为的实现写。**

