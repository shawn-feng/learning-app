# 家长 Agent 需求与实施方案（v1）

> 状态：**需求已拍板**（2026-08-30 讨论收敛）；**落地方式由「方案待实施」改为「ISSUE 逐项推进」**（2026-09-06 复盘对账）
> 范围：家长工作台助手（家长 Agent）能力升级——管配置、看孩子、管内容三大域
> 关联：不改变孩子 Agent；SPLIT 拆分方向上家长库读写继续走服务端 `parent_lib.*`；独立于 pi-web

---

# 0. 落地对账（2026-09-06 复盘，重要——阅读本需求前先看）

> 本文档 2026-08-30 拍板后，实现**不是按下文「阶段 1→4」顺序走**，而是靠 ISSUE 逐项啃下来的。
> 下面对账表是**代码事实**（逐一读代码核实）——截至 2026-09-06，三块剩余缺口（配置域 / 主题级+向导 / mastery+对比）**已全部实施并通过测试**（见 §0「三块落地状态」）。其余已做项与两条设计取代见下表与「关键」一节。
> 落地状态一律以本表为准；§1–§10 的需求文字在取代处已更新，其余保留作实施蓝本。

## 三大能力域落地总览

| 能力域 | 文档条目 | 状态 | 说明 |
|--------|---------|------|------|
| **内容域 Curriculum** | §2.3 课程级 | ✅ 已落地 | `parent_course_save/delete` + `write/edit` + `create_html_lesson` + `move_file/copy_file` + `log_activity`，均在家长会话 tools 白名单 |
| | §2.3 上传资料到服务端 | ✅ 已落地 | **ISSUE-055** 新增 `parent_upload_material`（复用 `uploadMaterialToServer`），补上「自动做好资料推不上服务端真源」的闭环断点 |
| | §2.3/§9 主题级 `parent_topic_save` | ✅ 已实施 | 新工具 `parent_topic_save`（含 assignToChildren 分配快照拷贝），见下「三块落地状态」块 2 |
| | §9/§10 五步建主题向导纪律 | ✅ 已实施 | buildParentPrompt §2 已加主题场景「起草→列提案→确认→落库」五步纪律 |
| **数据域 Insight** | §2.2/§8 progress 单孩子 | ✅ 已落地 | `parent_stats type=progress`（必填 childId，主题 learned/total/next + 每课状态） |
| | §8 mastery 逐课掌握度 | ✅ 已实施 | `parent_stats type=mastery`（逐课已掌握/学习中/未开始分布），见下「三块落地状态」块 3 |
| | §2.2 多孩子对比 | ✅ 已实施 | `parent_stats type=progress` childId 缺省=全部孩子对比 |
| | §2.2/§8 daily 每日记录 UI | ✅ 超纲落地 | **ISSUE-049** 孩子详情页「📅 每日记录」tab + 服务端 `kb.daily_entries.queryByRange`（日期范围/分类/标签/标题筛选） |
| | §8 summary 会话小结 | ⛔ 以现状取代 | agent 侧不单设会话摘要机制；小结复用 `parent_stats progress/daily`（ISSUE-049 queryByRange 口径）+ 学习计划数据（见下「关键」2） |
| **配置域 Control** | §2.1/§7 全块 | ✅ 已实施 | 新建 app-config.ts（注册表+app_config 工具），见下「三块落地状态」块 1 |
| | §10 buildParentPrompt 配置纪律 | ✅ 已实施 | §3 已改为「配置管理：可读可改、改前确认、改后汇报」（原「只读引导」） |

## 关键：被取代的两处设计（正文已按新方案重写，不再保留旧表述）
1. **「每日目标挂主题 rules_json.daily」→ 学习计划 study_plans**：主题上不再设每天学什么；每天的排期统一走服务端 study_plans（一课一行），由 study_plan_* 工具读写。正文相关段落（§2.3/§7/§9/§4）均已改为「学习计划」口径。
2. **「会话摘要 type=summary / 原始对话默认不可读」→ 数据小结 + 现实可见性**：agent 侧不单设会话摘要机制，「小结」直接复用 `parent_stats progress/daily`（daily 走 ISSUE-049 queryByRange 口径）+ 学习计划数据；家长对会话内容的可见性由 ISSUE-044 对话回顾/导出 + 会话同步决定（P2/P5 已按此更新）。

## 落地环境事实（写作本需求时的代码现状，勿误读为设计决策）
1. **SPLIT 后家长库真源在服务端**：家长侧写操作走 `dbExec("parent_lib.*")`；`upsertParentTopic` 走 `parent_lib.topics.upsert` + `courses.upsert`。家长会话 tools 白名单现状（pi-session.ts）：
   ```
   read, write, edit, ls, get_date,
   parent_course_save, parent_course_delete, parent_upload_material,
   parent_stats, log_activity, move_file, copy_file,
   exam_schedule_create, study_plan_create, study_plan_list, study_plan_get,
   study_plan_update, study_plan_sources, parent_library_topics,
   parent_library_courses, course_status
   ```
2. **⚠️ prompt「用户保存版本优先」**：`buildParentPrompt` 第一行读 agents.sqlite 该家长的用户版提示词，**非空即整体替换代码默认**。因此 §10 提示词升级后，**已存过用户版本的家庭不会自动吃到新纪律**（学习计划那次已踩过同款坑）——部署后需家长在 AgentPromptEditor 重置为默认或手动采纳新版。

## 三块落地状态（2026-09-06 已全部实施，待部署）
- **块 1：配置域 Control** ✅ 已实施——新建 `electron/lib/app-config.ts`：`APP_CONFIG_REGISTRY`（schema/scope/type/校验/影响面/高影响）+ `app_config` 工具（get 全量读；set 仅 4 个 app-settings 标量，走现有类型化 setter + `.bak` 备份 + activity-log 留痕 + 高影响项 confirmed 两段式）。已注册进 pi-session 双家长会话 tools+customTools；`buildParentPrompt` §3 已从「只读引导」翻为「配置管理：可读可改、改前确认、改后汇报」，并标注只读项与安全边界。scheduler/profile/agents 只读（写引导对应页面/编辑器）。
- **块 2：主题级 + 「建主题」五步向导** ✅ 已实施——`custom-tools.ts` 新增 `parent_topic_save`（topic+name+method+courses+assignToChildren；读旧值合并非空覆盖；分配走 allocateTopicToChild 快照拷贝幂等）；已注册双家长会话；`buildParentPrompt` §2 加入「建主题」五步向导纪律（第 5 步强制家长确认）。
- **块 3：mastery + 多孩子对比** ✅ 已实施——`parent_stats` 新增 `type=mastery`（逐课已掌握/学习中/未开始分布 + mastery/exam_mastery/首学/复习）；`type=progress` childId 缺省=全部孩子对比。
- **测试**：新增 `test/parent-agent-blocks.test.ts` 16 例（mastery/topic_save 合并与分配/app_config 确认流程/备份/越界/只读/安全项/注册表完整）；更新 parent-stats 的 progress 缺省断言。tsc 0 业务错、electron-vite build 过、全套 336 测试通过。
- ⚠️ 部署提醒：`app_config`/`parent_topic_save` 为新工具、buildParentPrompt 有升级——**已存用户版家长提示词的家庭需在 AgentPromptEditor 重置为默认或手动采纳**才吃到新纪律（同 §0「用户保存版本优先」坑）。未提交/未部署。

---

# 第一部分：需求（v1）

## 1. 背景与定位

**定位**：家长 Agent 是家长在 App 里的**唯一对话入口**，覆盖三大能力域：配置管理（Control）、孩子数据洞察（Insight）、课程与内容管理（Curriculum）。

**核心价值在跨域闭环**：数据异常 → 建议调整配置/课程 → 内容迭代 → 效果反馈。三个域单拎出来都只是「页面功能的对话化」，联动才是非它不可的价值。

现状与差距（2026-09-06 复盘更新——落地状态见 §0 对账表）：

| 能力域 | 现状 | 差距 |
|--------|------|------|
| 配置 | 提示词明确「配置只读，修改引导去设置页」 | **无配置写能力、无配置 schema（键/类型/校验/影响面）——整块未落地（§0 块 1）** |
| 数据 | `parent_stats` 覆盖 tokens/progress/daily 三类 + ISSUE-049 每日记录 UI + course_status 掌握度判断 | 无逐课掌握度聚合（`mastery`）、无多孩子对比、趋势解读引导未系统化 |
| 内容 | 课程级可做（`parent_course_save/delete` + `parent_upload_material` + write/edit 资料） | 主题级不能做——主题新建/教学方法编辑/分配仍是「引导去页面」（§0 块 2） |

## 2. 三大能力域需求

### 2.1 配置域（Control）——可读可改

> ⚠️ 本域**整块未落地**（§0 块 1）：schema 注册表 / `app_config` 工具 / buildParentPrompt 配置纪律均未做。下列范围与机制为需求档案，实施时以 §7 阶段 1 为准。
> ⚠️ SPLIT 注意：`scheduler-config.json` 现为**按 parent 存**（`parents/<id>/scheduler-config.json`，非文档旧述根目录），且 2026-09-06 起客户端 config-sync 对 scheduler_config 按 childId **字段级深合并**（ISSUE-053，防 classTimes 隔夜丢失）——注册表真源路径与读写须走现有 `getChildSchedulerConfig/setChildSchedulerConfig`，勿直接裸写 JSON。

- **范围**（已拍板）：
  - `app-settings.json`：默认模型（defaultModel）、编程模型、资料上限（materialsLimit）
  - `scheduler-config.json`：定时任务（每日记录总结、自动新会话）
  - 孩子 profile：名字/年龄/兴趣/AI 伙伴
  - 家长/孩子 AGENTS 提示词（复用 agents.sqlite 存取，编辑体验仍以编辑器页为主，agent 可读、可引导修改）
- **排除**：认证、账户、密码、license、server-connection（永不触碰）
- **机制**：
  - 配置 schema 注册表：每个配置项声明 键/类型/枚举/校验规则/影响面说明/真源文件
  - 新增 `app_config` 工具（type=get/set），set 走校验 + activity-log 留痕 + 原值备份可回退
  - 修改 = 家长确认后执行（提示词纪律：改前问，改后汇报）

### 2.2 数据域（Insight）——只读

- **只读孩子库，绝不写**。
- **两层粒度**（会话内容可见性原则见 §3 P2）：
  - 概览：各主题进度（learned/total/next）、最近学习时间 —— ✅ `parent_stats progress`
  - 明细：逐课状态/掌握度/首次学习/最近复习、每日记录（daily_entries）—— ◐ 每日记录已由 ISSUE-049 UI 提供；逐课掌握度聚合（`mastery`）⏳
- **解读而非堆数字**：agent 要讲出「本周比上周快/慢、哪个主题卡住、兴趣变化」，数据由工具给，解读在提示词引导。◐ 部分落地（course_status 掌握度判断），⏳ 趋势解读未系统化
- **主动提醒**：异常检测（连续多天未学、掌握度停滞）——先做会话内被动触发，主动推送后置。⏳ 未落地
- **多孩子**：childId 可空 = 全部孩子，支持对比。◐ 仅 `tokens` 支持；`progress` 强制 childId，⏳ 无对比

### 2.3 内容域（Curriculum）——引导式

- **课程级（已有，保留）**：`parent_course_save/delete`、write/edit 资料、`move_file/copy_file`、`log_activity` + ✅ ISSUE-055 `parent_upload_material`（上传服务端真源）。
- **主题级（待建）**：主题新建/教学方法编辑进 agent，新增 `parent_topic_save` 工具（⏳ §0 块 2）。**每天学什么不在主题上设**——由「学习计划 study_plans」统一排期。
- **引导式课程创建向导**（五步，每步家长可修改，第 5 步强制确认）⏳ 未落地：
  1. 家长意图（「想学唐诗」）
  2. 结构草稿（分册/课数/节奏）→ 家长反馈
  3. 生成内容（method + 课程清单）
  4. 生成/关联资料（html 复用 `create_html_lesson` 管线）
  5. 确认落库 → 分配给孩子（随后的每日学习安排再走学习计划）
- **全生命周期**：新建 → 维护（改方法/文案/资料）→ 分配 → 复盘迭代（学完一轮看效果再改）。◐ 维护/分配/复盘已有部分链路，新建主题向导未做

## 3. 关键决策记录（P1–P7）

| # | 决策 | 说明（⚠️ 变更后标注日期） |
|---|------|------|
| P1 | 配置范围 | app-settings / scheduler-config / 孩子 profile / AGENTS 提示词；排除认证账户密码 —— ⏳ 未落地（§0 块 1） |
| P2 | 会话可见性 | 家长只读「会话摘要 / 部分会话内容」而非全量原始 jsonl：以 ISSUE-044 对话回顾/导出 + 会话同步为现实口径（家长可看的部分由这两处决定），不做「另建一套纯摘要隐藏原始对话」的机制 |
| P3 | 操作分级 | 自动执行 / 家长确认后执行 / 永不触碰（见 §4）—— ✅ 已被 buildParentPrompt 分场景纪律部分覆盖（删除/覆盖先确认）；⏳ 配置域高影响项分级未做 |
| P4 | 解读口径 | 工具给数据、提示词引导 agent 解读，不写死解读逻辑 —— ✅ 采用 |
| P5 | 摘要来源 | 「会话小结」复用现有 daily_entries（ISSUE-049 queryByRange）与学习计划数据，不新建独立会话摘要机制 —— ✅ 采用；agent 侧不再单做 summary |
| P6 | 异常检测 | 先会话内被动触发，主动推送后置 —— ⏳ 未落地 |
| P7 | 向导实现 | 不建独立状态机，用提示词纪律 + 现有工具完成五步与确认点 —— ✅ 决策成立（学习计划已验证此路），⏳ 未用于「建主题」 |

## 4. 操作分级（三档）

| 级别 | 内容 |
|------|------|
| 自动执行 | 查询、生成草稿、写教学文案、资料文件读写 |
| 家长确认后执行 | 新建/删除课程与主题、调整配置、分配主题；学习计划排期落地（study_plan_create，草案先经家长确认） |
| 永不触碰 | 认证/账户/密码、删除孩子数据、直接改 SQLite |

## 5. 明确不做（边界）

- 不改孩子数据（进度/掌握度/每日记录归属孩子，只读）
- 不碰认证与账户体系
- 不执行任意代码、不开放原始 SQL 查询
- 本期不做主动推送（异常检测仅会话内触发）

---

# 第二部分：实施方案

## 6. 总体改动面

> ⚠️ 本表为 2026-08-30 初稿。**落地对账见 §0**——其中 `custom-tools.ts` 现状已含 `parent_upload_material`/study_plan_* 等；`upsertParentTopic` 已在 parent-library.ts:393 走服务端 `parent_lib.*`。本表保留作「剩余改动」参考：

| 文件 | 改动（标注 ✅已做 / ⏳未做） |
|------|------|
| `electron/lib/app-config.ts` | **新建** ⏳：配置 schema 注册表 + `app_config` 工具（get/set/校验/备份/留痕） |
| `electron/lib/custom-tools.ts` | ✅ `parent_stats` 已有（tokens/progress/daily）；⏳ 增 `mastery`/多孩子对比；⏳ 新增 `parent_topic_save`；✅ 家长侧已挂 `create_html_lesson` |
| `electron/lib/pi-session.ts` | ⏳ `buildParentPrompt` 升级（配置管理 + 主题向导纪律）；家长会话 tools 白名单需补 `app_config`/`parent_topic_save`（现状见 §0「落地环境事实」清单） |
| `electron/lib/parent-library.ts` | ✅ `upsertParentTopic`（SPLIT 走 `parent_lib.topics.upsert`）；⏳ 暴露为工具 + 接「分配给孩子」快照拷贝 |
| `electron/lib/ipc-handlers.ts` | 如需要暴露配置读取给前端（家长工作台展示当前配置时共用同一 schema）——未做 |

## 7. 阶段 1：配置域

**新建 `electron/lib/app-config.ts`**：

```
配置注册表 APP_CONFIG_REGISTRY: Record<key, {
  file: "app-settings" | "scheduler" | "profile" | "agents";
  scope: "global" | "child:<id>" | "parent:<id>";
  type: "number" | "string" | "enum" | "boolean" | "struct";
  enum?: string[];        // enum 型合法值
  min?: number; max?: number;
  desc: string;           // 影响面说明（给 agent 看的）
  highImpact?: boolean;   // true = set 前必须家长确认
}>
```

**工具签名**（`app_config`，参照 `parent_stats` 的 type 模式）：

- `app_config {type:"get", key?, scope?}`：按 key 查单项（缺省=全部）；返回当前值 + 说明 + 影响面
- `app_config {type:"set", key, value, scope?}`：校验类型/枚举/范围 → 备份原值（`<file>.json.bak`）→ 写文件 → appendActivityLog；`highImpact` 项返回「需家长确认」提示由 agent 转述，确认后二次调用（带 `confirmed:true`）
- 校验失败 / 未注册的 key / 永不触碰范围（auth/license/server-connection）→ 直接报错

**注册表初始条目**（落地时以 data/ 实际文件枚举为准）：

| key | 真源 | 类型 | 说明 |
|-----|------|------|------|
| `materialsLimit` | app-settings.json | number 1-100 | 孩子端资料展示上限 |
| `defaultModel` | app-settings.json | string | 孩子/家长默认模型 |
| `programmingModel` | app-settings.json | string（如存在） | 编程 agent 模型 |
| `scheduler.dailySummary` | scheduler-config.json（按 parent 存 + SPLIT 深合并，见 §2.1） | struct | 每日记录总结时间等 |
| `scheduler.autoNewSession` | scheduler-config.json（同上） | struct | 自动新会话开关/间隔 |
| `profile.<childId>.{name,age,interests,companion}` | children/<id>/profile.json | struct | 孩子档案 |
| `agents.child.<id>` / `agents.parent.<id>` | agents.sqlite | text | 提示词（读；写引导编辑器） |

> 注：**「每天学什么」不进配置注册表**——由「学习计划 study_plans」（服务端真源）排期，见 §2.3 / 学习计划工具（study_plan_*）。

## 8. 阶段 2：数据域（parent_stats 增强）

在现有三档（tokens/progress/daily）基础上扩展——⚠️ 落地对账：tokens/progress/daily 已有；下述两项增强 ⏳未做。**会话小结不单设 `type=summary`**——agent 侧「最近学习小结」复用 `parent_stats progress/daily`（daily 走 ISSUE-049 queryByRange 口径）+ 学习计划数据即可；家长端逐日/逐条看记录走孩子详情页「每日记录」tab。

- **`type=progress` 增强** ⏳：`childId` 缺省 = 全部孩子对比（每孩子一行 learned/total/next + 最近 updated）；单孩子时附「最近 7 天完成课程数」趋势行（现状：必填 childId，仅单孩子）
- **`type=mastery`（新）** ⏳：指定 topic 时返回逐课掌握度分布（已掌握/学习中/未开始 + 列表），供家长细看卡点
- **解读在提示词**：buildParentPrompt 中引导「先取 progress/daily，再讲趋势/卡点/建议，不要只报数字」——✅ 学习计划/课程状态已部分引导（course_status 一次性掌握度），⏳ 趋势解读尚未系统写死

## 9. 阶段 3：内容域（主题级 + 向导）

**新工具 `parent_topic_save`**（参照 `parent_course_save` 模式）——⚠️ 截至 2026-09-06 未落地（§0 块 2），下列签名按现状拟定：

- 参数：`topic`（目录名，如 tangshi）、可选 `name`（中文名）、`method`（教学方法全文）、`assignToChildren`（逗号分隔 childId，可选——复用现有分配链路做快照拷贝）；随课程可带 `courses[]`（title/sortOrder/material/... 批量建课，复用 `upsertParentTopic` 已支持的 courses 批量 upsert）
- 说明：主题只管「教学内容与教学方法」；**「每天学什么」不在主题上设**，随后的每日安排走学习计划（study_plan_*）。
- 规则：只覆盖非空字段（读旧值合并）；SPLIT 走 `upsertParentTopic` → `parent_lib.topics.upsert` + `courses.upsert`；自动 appendActivityLog
- 删除主题本期不做工具（影响大），引导家长在页面确认

**家长会话 tools 白名单（⚠️ 更新为 2026-09-06 现状，非旧文）**：
- 现状已含 `create_html_lesson`（在家长内容会话）、study_plan_*/parent_library_*/course_status、ISSUE-055 `parent_upload_material`（见 §0「落地环境事实」完整清单）。
- **块 1/块 2 落地后追加**：`parent_topic_save`、`app_config`。目标白名单 = §0 现状清单 + `parent_topic_save, app_config`：

```
read, write, edit, ls, get_date,
parent_course_save, parent_course_delete, parent_upload_material, parent_topic_save,
parent_stats, log_activity, move_file, copy_file,
study_plan_create, study_plan_list, study_plan_get, study_plan_update,
study_plan_sources, parent_library_topics, parent_library_courses,
course_status, exam_schedule_create, app_config
```

**向导实现（P7）**：不建状态机——buildParentPrompt 里写死五步纪律：每一步产出后向家长复述并征求修改，第 5 步（落库+分配）必须拿到家长明确同意才执行。✅ 该模式已在学习计划（study_plan_*）场景跑通，⏳ 待复用到「建主题」。

## 10. 阶段 4：提示词与收尾

`buildParentPrompt` 升级要点——⚠️ 现状（2026-09-06）已含：学习计划纪律、course_status 掌握度、ISSUE-055 上传闭环、上传附件读取（ISSUE-037）。**剩余待升级**：

1. 「配置查看」→「配置管理」（⏳ 未做）：可读可改，改前确认、改后汇报，禁碰认证账户（现状 §3 仍是只读引导）
2. 「数据域」：progress/daily 数据口径 + 解读引导 + 异常主动提醒 —— ◐ progress/course_status 已有；异常提醒、趋势解读 ⏳（agent 侧「小结」复用 progress/daily，不单设 summary）
3. 「内容域」：主题级能力 + 五步向导流程 + 确认点纪律 —— ⏳ 未做
4. 操作分级三档写入提示词 —— ◐ 分场景纪律部分有，配置域高影响项分级 ⏳
5. 保留现有数据流转说明（两库职责、边界、SPLIT 真源）不动 —— ✅ 已成立
> ⚠️ **用户保存版本优先**：buildParentPrompt 若该家长在 agents.sqlite 有用户版提示词（非空），会整体替换代码默认 → 本升级对已存用户版本的家庭不自动生效，需家长在 AgentPromptEditor 重置为默认或手动采纳。

## 11. 验证与风险

**验证**：
- 每个新工具补 `test/` 单测（参照现有工具测试风格，注意 vitest 事件循环让出规范）
- `tsc --noEmit`：过滤已知 5 条环境告警（TS2318/TS2552）后无业务错误
- `rm -rf out && npm run build`（electron-vite）通过
- 手工场景：改默认模型 → 重启生效且 activity-log 有记录（块 1）；家长问「孩子最近怎么样」→ 返回进度+解读（progress/course_status + 趋势解读，若已做）；「建个唐诗主题」→ 走完五步向导落库（块 2）

**风险**：
| 风险 | 缓解 |
|------|------|
| 配置 schema 覆盖不全 | 注册表为中心，落地时枚举 data/ 实际文件，遗漏按需补 |
| agent 改配置出错 | set 校验 + 原值 .bak 备份 + activity-log 留痕可回退 |
| 向导误落库 | 第 5 步强制家长确认 + 操作可回退 |
| 家长会话上下文膨胀 | 工具只回聚合/摘要，提示词严禁 read 读大文件/进度全文 |
| 提示词升级不生效（用户版本优先） | 部署后家长在 AgentPromptEditor 重置为默认或手动采纳新版（同学习计划教训） |
