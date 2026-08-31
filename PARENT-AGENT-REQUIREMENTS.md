# 家长 Agent 需求与实施方案（v1）

> 状态：**需求已拍板**（2026-08-30 讨论收敛），方案待实施
> 范围：家长工作台助手（家长 Agent）能力升级——管配置、看孩子、管内容三大域
> 关联：不改变孩子 Agent；SPLIT 拆分方向上家长库读写继续走服务端 `parent_lib.*`；独立于 pi-web

---

# 第一部分：需求（v1）

## 1. 背景与定位

**定位**：家长 Agent 是家长在 App 里的**唯一对话入口**，覆盖三大能力域：配置管理（Control）、孩子数据洞察（Insight）、课程与内容管理（Curriculum）。

**核心价值在跨域闭环**：数据异常 → 建议调整配置/课程 → 内容迭代 → 效果反馈。三个域单拎出来都只是「页面功能的对话化」，联动才是非它不可的价值。

现状（2026-08-30 代码事实）与差距：

| 能力域 | 现状 | 差距 |
|--------|------|------|
| 配置 | 提示词明确「配置只读，修改引导去设置页」 | 无配置写能力、无配置 schema（键/类型/校验/影响面） |
| 数据 | `parent_stats` 覆盖 tokens/progress/daily 三类摘要 | 粒度不够：无逐课掌握度明细、无摘要口径说明、无趋势解读引导 |
| 内容 | 课程级可做（`parent_course_save/delete` + write/edit 资料） | 主题级不能做——主题新建/教学方法编辑仍是「引导去页面」 |

## 2. 三大能力域需求

### 2.1 配置域（Control）——可读可改

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
- **三层粒度**：
  - 概览：各主题进度（learned/total/next）、最近学习时间
  - 明细：逐课状态/掌握度/首次学习/最近复习、每日记录（daily_entries）
  - 摘要：会话内容**只给摘要**（复用定时任务产出的 daily_entries，天然不含原始对话）——原始对话默认不可读
- **解读而非堆数字**：agent 要讲出「本周比上周快/慢、哪个主题卡住、兴趣变化」，数据由工具给，解读在提示词引导。
- **主动提醒**：异常检测（连续多天未学、掌握度停滞）——先做会话内被动触发，主动推送后置。
- **多孩子**：childId 可空 = 全部孩子，支持对比。

### 2.3 内容域（Curriculum）——引导式

- **课程级（已有，保留）**：`parent_course_save/delete`、write/edit 资料、`move_file/copy_file`、`log_activity`。
- **主题级（新增）**：主题新建/教学方法/每日目标进 agent，新增 `parent_topic_save` 工具。
- **引导式课程创建向导**（五步，每步家长可修改，第 5 步强制确认）：
  1. 家长意图（「想学唐诗」）
  2. 结构草稿（分册/课数/节奏）→ 家长反馈
  3. 生成内容（method + 课程清单）
  4. 生成/关联资料（html 复用 `create_html_lesson` 管线）
  5. 确认落库 → 分配给孩子
- **全生命周期**：新建 → 维护（改方法/文案/资料）→ 分配 → 复盘迭代（学完一轮看效果再改）。

## 3. 关键决策记录（P1–P7）

| # | 决策 | 说明 |
|---|------|------|
| P1 | 配置范围 | app-settings / scheduler-config / 孩子 profile / AGENTS 提示词；排除认证账户密码 |
| P2 | 会话可见性 | 只给摘要（daily_entries），原始对话默认不可读；预留家长显式授权开关 |
| P3 | 操作分级 | 自动执行 / 家长确认后执行 / 永不触碰（见 §4） |
| P4 | 解读口径 | 工具给数据、提示词引导 agent 解读，不写死解读逻辑 |
| P5 | 摘要来源 | 复用定时任务产出的 daily_entries，不新建会话摘要机制 |
| P6 | 异常检测 | 先会话内被动触发，主动推送后置 |
| P7 | 向导实现 | 不建独立状态机，用提示词纪律 + 现有工具完成五步与确认点 |

## 4. 操作分级（三档）

| 级别 | 内容 |
|------|------|
| 自动执行 | 查询、生成草稿、写教学文案、资料文件读写 |
| 家长确认后执行 | 新建/删除课程与主题、调整配置、分配主题、改每日目标 |
| 永不触碰 | 认证/账户/密码、删除孩子数据、直接改 SQLite |

## 5. 明确不做（边界）

- 不改孩子数据（进度/掌握度/每日记录归属孩子，只读）
- 不碰认证与账户体系
- 不执行任意代码、不开放原始 SQL 查询
- 本期不做主动推送（异常检测仅会话内触发）

---

# 第二部分：实施方案

## 6. 总体改动面

| 文件 | 改动 |
|------|------|
| `electron/lib/app-config.ts` | **新建**：配置 schema 注册表 + `app_config` 工具（get/set/校验/备份/留痕） |
| `electron/lib/custom-tools.ts` | `parent_stats` 增强（summary/对比/趋势）；新增 `parent_topic_save`；家长侧挂 `create_html_lesson` |
| `electron/lib/pi-session.ts` | `buildParentPrompt` 重写（三大域 + 分级纪律 + 向导流程）；家长会话 tools 白名单补充 |
| `electron/lib/parent-library.ts` | `upsertParentTopic`（SPLIT 走 `parent_lib.topics.upsert`，读旧值合并）；分配复用现有链路 |
| `electron/lib/ipc-handlers.ts` | 如需要暴露配置读取给前端（家长工作台展示当前配置时共用同一 schema） |

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
| `scheduler.dailySummary` | scheduler-config.json | struct | 每日记录总结时间等 |
| `scheduler.autoNewSession` | scheduler-config.json | struct | 自动新会话开关/间隔 |
| `profile.<childId>.{name,age,interests,companion}` | children/<id>/profile.json | struct | 孩子档案 |
| `agents.child.<id>` / `agents.parent.<id>` | agents.sqlite | text | 提示词（读；写引导编辑器） |

> 注：**每日目标挂在主题上**（topics.rules_json.daily），归阶段 3 的 `parent_topic_save` 维护，不进配置注册表。

## 8. 阶段 2：数据域（parent_stats 增强）

在现有三档（tokens/progress/daily）基础上扩展：

- **`type=progress` 增强**：`childId` 缺省 = 全部孩子对比（每孩子一行 learned/total/next + 最近 updated）；单孩子时附「最近 7 天完成课程数」趋势行
- **`type=mastery`（新）**：指定 topic 时返回逐课掌握度分布（已掌握/学习中/未开始 + 列表），供家长细看卡点
- **`type=summary`（新）**：会话摘要 = 按天聚合 daily_entries（复用定时任务产物），`date` 缺省最近 7 天；**明确不含原始对话**（原始会话读取本期不做，隐私开关 `parent_allow_raw_session` 预留、默认 false）
- **解读在提示词**：buildParentPrompt 中引导「先取 progress/summary，再讲趋势/卡点/建议，不要只报数字」

## 9. 阶段 3：内容域（主题级 + 向导）

**新工具 `parent_topic_save`**（参照 `parent_course_save` 模式）：

- 参数：`topic`（目录名，如 tangshi）、可选 `name`（中文名）、`type`（必学|选学）、`method`（教学方法全文）、`dailyGoal`（每日目标）、`assignToChildren`（逗号分隔 childId，可选——复用现有分配链路做快照拷贝）
- 规则：只覆盖非空字段（读旧值合并）；SPLIT 走 `parent_lib.topics.upsert`；自动 appendActivityLog
- 删除主题本期不做工具（影响大），引导家长在页面确认

**家长会话 tools 白名单补充**：`create_html_lesson`（资料生成复用孩子端管线）、`parent_topic_save`。更新后家长白名单：

```
read, write, edit, ls, get_date, create_html_lesson,
parent_course_save, parent_course_delete, parent_topic_save,
parent_stats, log_activity, move_file, copy_file, app_config
```

**向导实现（P7）**：不建状态机——buildParentPrompt 里写死五步纪律：每一步产出后向家长复述并征求修改，第 5 步（落库+分配）必须拿到家长明确同意才执行。

## 10. 阶段 4：提示词与收尾

`buildParentPrompt` 重写要点：

1. 「配置查看」升级为「配置管理」：可读可改，改前确认、改后汇报，禁碰认证账户
2. 「数据域」：三层粒度 + 解读引导 + 摘要口径（不含原始对话）+ 异常主动提醒（会话内）
3. 「内容域」：主题级能力 + 五步向导流程 + 确认点纪律
4. 操作分级三档写入提示词（自动/确认/永不触碰）
5. 保留现有数据流转说明（两库职责、边界、SPLIT 真源）不动

## 11. 验证与风险

**验证**：
- 每个新工具补 `test/` 单测（参照现有工具测试风格，注意 vitest 事件循环让出规范）
- `tsc --noEmit`：过滤已知 5 条环境告警（TS2318/TS2552）后无业务错误
- `rm -rf out && npm run build`（electron-vite）通过
- 手工场景：改默认模型 → 重启生效且 activity-log 有记录；家长问「孩子最近怎么样」→ 返回进度+摘要+解读；「建个唐诗主题」→ 走完五步向导落库

**风险**：
| 风险 | 缓解 |
|------|------|
| 配置 schema 覆盖不全 | 注册表为中心，落地时枚举 data/ 实际文件，遗漏按需补 |
| agent 改配置出错 | set 校验 + 原值 .bak 备份 + activity-log 留痕可回退 |
| 摘要口径与页面不一致 | 摘要统一读 daily_entries（与页面同一数据源） |
| 向导误落库 | 第 5 步强制家长确认 + 操作可回退 |
| 家长会话上下文膨胀 | 工具只回聚合/摘要，提示词严禁 read 读大文件/进度全文 |
