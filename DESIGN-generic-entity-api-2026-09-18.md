# 通用实体数据 API 设计稿（namespace 注册表 + 统一数据工具）

- **状态**：📝 设计稿（待评审）——第 1~3 节为**已定案**；第 4~6 节为**设计契约**（部分未实现）；第 7~8 节为**现状审计 + 实施计划**
- **日期**：2026-09-18
- **议题来源**：ISSUE-105（受控数据通道）、ISSUE-110（家长 agent 可操作表盘点升级为设计稿）、2026-09-18 当日多轮讨论
- **关联文档**：`技术实现文档-功能实现与数据流转-2026-09-13.md`（技术实现唯一真源，本稿定案并落地后需同步其 §8）
- **代码落点**：`server/src/agent/db-channel.ts`（注册表与执行器）、`server/src/agent/parent-tools.ts`（工具面）、`server/src/agent/parent-registry.ts`（会话与 prompt）、`server/probe-registry-drift.ts`（漂移检测）

---

## 0. 一句话

> 让 agent **永不写 SQL**：它只表达「**查哪个实体、走哪条已登记的关系路径、按什么条件**」，由**注册表**声明结构，由**引擎**生成参数化 SQL 在数据库内执行。

**要解决的痛点**：每来一个新场景，就要新增一张表 / 新增一个专用工具 / 改一次 schema（ISSUE-105 原话：「工具的增长是无上界的」）。

**要在本稿之外显式排除的东西**（今日已否决，避免回头重走）：

| 被否决的方案 | 否决理由 |
|---|---|
| Markdown / Vault 作数据层 | 对「灵活 schema + 工具无关」无独特贡献，反而引入文件系统一致性、并发、索引重建等新坑（`demo-md-vault` 已验证可跑，但结论是不采用） |
| 四张关联表扁平化进 `entities(ns, data_json)` 单表 | 多跳关联（主题→课程→知识点→题）会退化成应用层手搓 JOIN；丢失 PK/UNIQUE 约束与既有视图 |
| 给 agent 自由 SQL 通道（ISSUE-105 方案 A） | 破坏业务不变量（考核状态机、积分只增、recurrence 游标），且写错 WHERE 的语义错误无法静态拦截。**降级为远期备选**，不在本稿范围 |
| 让 `describe` 支持一次查多表（当日 F8） | 本质是把 JOIN 推给模型在上下文里手拼（N 次往返 + 每跳信息全进上下文 + 易漏跳）。**关联查询应由注册表承载** |

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| **实体类（entity class）** | 一类数据的抽象，如「题」「课程」。一个实体类对应注册表里的一个登记项 |
| **namespace** | 实体类的稳定标识名（如 `question`、`course`）。**是实体类，不是一条具体查询** |
| **注册表（registry）** | 声明「有哪些实体类、各自什么表/主键/列/关系/可走路径」的元数据。**是地图，不是查询** |
| **命名路径（path）** | 注册表里一条**具名的多跳关系链**（如 `topic_questions` = 主题→课程→知识点→挂载→题）。模型只能**选路径名**，不能拼 JOIN |
| **原语（primitive）** | 统一 API 的原子操作。设计为 5 个：`listEntity` / `readEntity` / `queryEntity` / `updateEntity` / `appendEntity` |
| **Tier 1 / Tier 2** | 注册表的两层来源。Tier 1 = 关系核心（代码注册表，需发版）；Tier 2 = 灵活实体（数据行注册，零 DDL 零发版） |
| **SQL 下沉** | filter 被编译成**参数化 SQL** 交给数据库引擎按索引过滤，**不是**把整表读进内存再筛 |

---

## 2. 设计契约（5 条不变量）

这 5 条是本机制的验收基线。任何后续实现改动都不得推翻其中任何一条。

| # | 契约 | 说明 |
|---|---|---|
| **C1** | **agent 永不写 SQL** | 工具入参只有「表/路径名 + 操作 + 条件 + 行数据」，SQL 由执行器拼装。不给自由 SQL、不给模板字符串 |
| **C2** | **关系查询由注册表承载** | 新增一个关联查询 = 注册表里**新增一条命名路径**，零业务代码。注册表的**写侧与读侧共用同一份关系声明** |
| **C3** | **namespace 进 prompt** | agent 在**首次调用前**就知道有哪些实体类、哪些列、哪些路径可用。不允许「靠猜列名 + 报错重试」收敛 |
| **C4** | **灵活 schema = 注册新 namespace** | Tier 1：人写 DDL + 加注册（发版）；Tier 2：设计器 agent 调 `defineNamespace` 写 registry 行，**零 DDL、零发版、即时生效** |
| **C5** | **filter 走 SQL 下沉** | 条件编译成参数化 SQL，在库内执行；**只返回命中行**。但**返回体仍会进上下文**，故必须有体量护栏（见 §8 F1） |

### 安全红线（与 C1~C5 并列，不可让步）

1. **读默认开放，写默认关闭**——读面按注册表放开（修复 ISSUE-110「没工具就读不到」的盲区）；写面必须逐表登记 `ops` + 列白名单 + 校验 + 熔断 + 事务 + 审计。
2. **连接不经过参数**——库由调用方按 token 解出的 `parentId`（+ 目标 `childId`）打开，agent 无从指定库路径。
3. **运行期家长/孩子 agent 永不触碰注册表**——注册表是设计期产物；运行期 agent 只有 Tier 2 的**只读消费**权（且经设计器 agent 落库）。
4. **敏感列二次确认**——影响判定结果的列（`question_bank.answer` / `options` / `rules_json`）写入后必须回传提示，由 agent 向家长逐条复述。
5. **孩子侧永远只读为主**——考核 / 积分 / 奖励规则在任何通道都只读（ISSUE-105 权限矩阵）。

---

## 3. 数据布局与租户隔离

| 库 | 文件 | 内容 | 打开方式 |
|---|---|---|---|
| 主库 | `data/server.sqlite` | 跨租户：parents（凭据）/ settings / sessions / scheduler / worker_state | 服务端单例 |
| **家长内容库** | `data/parents/<parentId>/parent.sqlite` | 课程库 + 题库 + 知识点 + 挂载桥 + `db_audit` | `openParentLib(dataDir, parentId)` |
| **孩子库** | `data/kb/<parentId>/<childId>.sqlite` | 该孩子的计划 / 考核 / 积分 / 日常 | `openKb(dataDir, parentId, childId)` |
| agent 内部库 | `data/agents.sqlite` | prompts / prompt_history | agent 不可见 |

**租户隔离由文件路径天然实现**：`parentId` 来自 token，孩子库再经归属校验。新通道沿用既有入口，**不新增任何跨库路径**。

> 注：主库不进通用数据通道（跨租户 + 凭据/对话/成绩三类最敏感数据都在主库，且家长/孩子的真实诉求已被现有工具覆盖）。ISSUE-110 的方向是**主库瘦身**：把 parent 归属、agent 可操作的内容搬到 parent.sqlite 或孩子库，主库最终只剩系统/隐私/跨租户表。

---

## 4. 注册表设计（核心）

注册表是本机制唯一的元数据真源。**它同时驱动四件事**：读面、写校验、模型可见的元数据、SQL 生成。

```
                  ┌────────────────────────────┐
                  │        注册表 registry      │
                  │  表登记 / 关系声明 / 命名路径  │
                  └──────────────┬─────────────┘
        ┌───────────────┬────────┴────────┬────────────────┐
        ▼               ▼                 ▼                ▼
   读面授权        写校验规则        模型元数据         SQL 生成
 (可读列/路径)  (白名单/refs/熔断)  (prompt+schema)  (JOIN/WHERE/LIMIT)
```

### 4.1 表登记 `TableSpec`

现已实现（`db-channel.ts`），字段如下（节选，权威定义见源码）：

```ts
export interface TableSpec {
  table: string;                 // 库内真实表名
  label: string;                 // 中文名
  desc: string;                  // 一句话用途（describe 输出）
  ops: Array<"insert" | "update" | "delete">;  // 允许的写操作（读由 ops 派生/默认开放）
  rowLimit: number;              // 单次影响行数上限（熔断）
  pk: string[];                  // 主键列
  serverGenerated?: string[];    // 服务端生成列（id / created_at），agent 给了也忽略
  insertRequired?: string[];     // insert 必填列
  /** ⚠ 现仅在写侧使用；设计上应提升为 §4.2 的 refs */
  refChecks?: RefCheck[];
  insertInvariant?: (row) => string | null;    // 跨列校验
  touchUpdatedAt?: boolean;      // update 时自动 touch updated_at
  columns: Record<string, ColumnSpec>;         // 列白名单（读写的共同边界）
}

export interface ColumnSpec {
  kind: "string" | "number" | "enum";
  desc: string;
  maxLen?: number; min?: number; max?: number; int?: boolean;
  enumValues?: string[];
  notEmpty?: boolean;
  confirm?: boolean;             // 写入后须向家长复述
}
```

### 4.2 关系声明 `refs`（**新增**：把 refChecks 提升为一等公民并进读面）

现状问题（见 §7 审计 ②）：`refChecks` 是**唯一**的关系声明，但

- 只用**写侧**（insert/update 校验）；
- `parentReadableRegistry()` 派生只读面时**把它丢掉了**（`db-channel.ts:674-690` 的映射只带 `table/label/desc/columns`）；
- `ReadableTableSpec`（`:489-494`）**没有任何关系字段**。

设计上 `refs` 应成为**读写共用的关系声明**，并被读面消费：

```ts
export interface RefEdge {
  /** 本表列 → 目标表.列 */
  column: string;
  refTable: string;
  refColumn: string;
  desc: string;
  /** 关系基数提示，供模型理解语义（校验不依赖它） */
  kind?: "many-to-one" | "one-to-many";
}

/** 注册表新增：读侧可见的关系面 */
export interface ReadableTableSpec {
  table: string;
  label: string;
  desc: string;
  columns: Record<string, string>;
  refs?: RefEdge[];              // ← 新增
  paths?: string[];              // ← 新增：该表参与的命名路径名（反向索引）
}
```

**家长库真实关系网（实测，5 条边）**：

| 边 | 声明 | 实测命中 | 孤儿 |
|---|---|---|---|
| `courses.topic → topics.topic_key` | ⚠ 现注册表错写为 `topics.name` | 需要修正：现声明命中 **0 / 1317**；改指 `topic_key` 后 **1317 / 1317** | 0 |
| `knowledge_points.course_uuid → courses.uuid` | ✅ | 2114 / 2114 | 0 |
| `course_knowledge_questions.course_id → courses.uuid` | ✅ | 3720 / 3720 | 0 |
| `course_knowledge_questions.knowledge_point_id → knowledge_points.id` | ✅ | 3720 / 3720 | 0 |
| `course_knowledge_questions.question_id → question_bank.id` | ✅ | 3720 / 3720 | 0 |

> **结论**：关系网良构（除边 1 的声明错），**可直接用于生成 JOIN，无需先清洗数据**。

### 4.3 命名路径 `paths`（**新增**：让引擎而不是模型去 JOIN）

这是 C2 的落地形态。一条路径 = 一段已登记的 hop 链 + 可过滤列 + 可返回列。

```ts
export interface RegistryPath {
  /** 路径名（模型可见、可调用） */
  name: string;
  label: string;
  desc: string;
  /** 结果主体表：SELECT 的基准表，也是 returns 的主表 */
  select: string;
  /** 跳链：按顺序 JOIN。on 语义 = 本表列 → 已出现表.列（别名即表名） */
  hops: Array<{ table: string; on: Record<string, string> }>;
  /** 允许作为 where 条件的列，形如 "courses.topic" */
  filterable: string[];
  /** 默认返回列，形如 "question_bank.id" */
  returns: string[];
  /** 单次返回行数上限 */
  rowLimit: number;
}
```

**示例（家长库第一个落地路径）**：

```jsonc
{
  "name": "topic_questions",
  "label": "某主题下的全部题",
  "desc": "主题→课程→知识点→挂载→题 的多跳关联",
  "select": "question_bank",
  "hops": [
    { "table": "course_knowledge_questions", "on": { "question_id": "question_bank.id" } },
    { "table": "knowledge_points",           "on": { "id": "course_knowledge_questions.knowledge_point_id" } },
    { "table": "courses",                    "on": { "uuid": "knowledge_points.course_uuid" } }
  ],
  "filterable": ["courses.topic", "courses.title", "knowledge_points.name", "question_bank.behavior"],
  "returns": ["question_bank.id", "question_bank.behavior", "question_bank.stem", "courses.title", "knowledge_points.name"],
  "rowLimit": 200
}
```

**模型侧调用（一次调用，一条 SQL）**：

```jsonc
{
  "path": "topic_questions",
  "where": { "courses.topic": "lunyu" },
  "columns": ["question_bank.id", "question_bank.behavior", "knowledge_points.name"],
  "limit": 20
}
```

**引擎侧行为**：把 `hops` 编译成参数化 JOIN 链（表名即别名）→ `where` 编译成等值条件 → 校验 `where`/`columns` 的每一列都必须在路径涉及的表内且已登记 → 加 LIMIT 与字节预算 → 在库内执行。

**这条路径的口径（实测，样本家长库 `86a84278-…`，courses 1317 行）**：

| 口径 | 题 | 涉及课程 | 涉及知识点 |
|---|---|---|---|
| 全库 | 3720 | 537 | 2114 |
| `where courses.topic='lunyu'` | **3576** | **489** | **1970** |

> 现状要拿到这个结果，agent 需 **4 次分步 read**（courses → kp → ckq → question_bank），每次结果全量进上下文，且极易漏跳。

### 4.4 路径的约束（为什么这不等于「给 agent 自由 JOIN」）

| 约束 | 说明 |
|---|---|
| 只能选路径名 | 模型不能提交表名组合或 JOIN 片段；未注册的路径一律拒绝 |
| hop 链是注册期固定的 | 模型不能改跳序、不能加跳、不能给 JOIN 条件 |
| 过滤/返回列白名单 | `filterable` / `returns` 之外的一律拒绝 |
| 参数化 | 所有值走占位符；表名/列名只能来自注册表常量，**不来自模型输入** |
| 行数熔断 | `rowLimit` + 全局上限 |
| 表名在一条路径内不得重复 | 避免自连接歧义（暂不支持自连接路径） |

### 4.5 Tier 模型（C4：灵活 schema 怎么来）

| | **Tier 1 关系核心** | **Tier 2 灵活实体** |
|---|---|---|
| 覆盖对象 | topics / courses / knowledge_points / question_bank / 挂载桥 / 计划 / 考核 / 积分…… | 家长自定义低频场景（习惯打卡、自定义考核……） |
| 存储 | **真关系表**（保留 PK/UNIQUE/视图） | 复用 `entities(namespace, data_json)` 一行一实体 |
| 注册表来源 | **代码常量**（`REGISTRY.ts`），由迁移 seed | **数据行**（registry 表），由设计器 agent 写入 |
| 新增方式 | 人写 DDL + 加注册 → 评审 → 发版 | 调 `defineNamespace(ns, schema)` → 即时生效 |
| DDL | 需要 | **零 DDL** |
| 读面 | 列清单 + 路径**常驻 prompt** | 运行时才存在 → 只能靠 `describe` 兜底 |

**`defineNamespace` 护栏**：schema 校验 + 命名冲突检查 + 人工确认关 + 审计；**运行期家长/孩子 agent 无此工具**（只有独立的设计器 agent 有）。

### 4.6 注册表的存取方式

| 项 | 设计 |
|---|---|
| 真源 | 单一：Tier 1 代码常量 + Tier 2 registry 表，由同一个加载器合并 |
| 读取 | **运行时读 + 内存缓存 + 版本号**（registry 行变更递增版本号，命中缓存），而非构建期烧死 |
| 派生 | 读面（列清单、可走路径、`table` 枚举）由注册表**自动生成**，不手写第二份 |
| 一致性门 | `npm run probe:registry-drift`（见 §7.2）——注册表声明 vs 真实 schema 的逐列比对，有漂移 exit 1 |

---

## 5. 工具面设计（统一数据 API）

### 5.1 五原语 → 三工具

设计原语 5 个，落地合并为 **3 个工具**（读侧三类查询合并、写侧 update/append 合并并收编 delete）：

| 工具 | 覆盖的原语 | 语义 |
|---|---|---|
| `parent_db_describe` | —（元数据出口） | 查表结构 / 校验规则 / 枚举值域 / 路径清单 |
| `parent_db_read` | `listEntity` `readEntity` `queryEntity` | 只读：`table` + `where` + `columns` + `orderBy` + `limit`；**或** `path` + 同样参数 |
| `parent_db_write` | `updateEntity` `appendEntity`（+ delete） | 受控单表 `insert` / `update` / `delete` |

> 合并的代价（已知缺口）：**丢失 count / 聚合**（F6）。判断「有没有」这类问题现在只能靠拉行。

### 5.2 `parent_db_read` 参数契约

```jsonc
{
  "table": "登记的表名",          // 与 path 二选一
  "path":  "已登记的路径名",       // 与 table 二选一；给 path 时 table 忽略
  "child": "孩子姓名或 id",       // 省略=家长库；传了=该孩子库
  "columns": ["列名或 表.列名"],
  "where":   { "列名或 表.列名": 值 },   // 等值，全部须登记
  "orderBy": "列名",
  "orderDesc": true,
  "limit": 20
}
```

### 5.3 `parent_db_write` 参数契约

```jsonc
{
  "table": "登记的表名",
  "child": "孩子姓名或 id",       // 省略=家长库
  "op": "insert | update | delete",
  "rows": [ { "列": 值 } ],       // insert=行数组；update=要改的列值对象
  "where": { "列": 值 }           // update/delete 必填，且必须命中登记列
}
```

**执行器强制项**：列白名单 → 逐列校验（类型/长度/枚举/数值域）→ 跨列不变量 → 引用校验（refs）→ where 必填 → **先 SELECT COUNT 预览影响行数** → 熔断 → 事务 → 审计 `db_audit` → confirm 列提示。失效一律 **ROLLBACK + 返回可读原因**（不静默）。

### 5.4 参数级加固（**待实现**）

| 项 | 说明 |
|---|---|
| `table` / `op` / `path` 加 **enum** | JSON Schema 可静态表达的部分直接给枚举，模型不必先 describe |
| `columns` 的跨表依赖 | JSON Schema 表达不了 → 靠 §6 的元数据常驻解决 |
| 字节预算 | 返回体按预算截断 + 提示「已返前 N 行/共 M 行，取全文请用 columns + 精确 where」（F1） |
| 自愈式错误 | 列名错 → 直接回该表可用列；空结果 → 回该列**实际取值样例**（F2） |

---

## 6. 与 agent 的接口

### 6.1 独立「数据管理 agent」（`parent-data`）

| 项 | 值 |
|---|---|
| 会话 kind | `ParentSessionKind = "parent" \| "parent-content" \| "parent-data"` |
| 会话 key | `<parentId>:parent-data`（独立落盘目录，历史不互串） |
| 工具集 | `DATA_AGENT_TOOL_NAMES = ["parent_db_describe", "parent_db_read", "parent_db_write", "get_date"]` |
| 隔离 | **不含**资料生成 / 对话阅读 / 编程 / 计划域工具——与运营类家长助手完全隔离 |
| UI 入口 | 家长端左侧栏「🗃️ 数据管理」→ `Dashboard` 的 `dataagent` 视图 → `<ParentChatPanel childId="parent-data" />` |

家长主助手（`parent`）**也挂**这三个通用工具，另加专用工具（`parent_upsert_course_content` 整课替换、`parent_read_child_conversation` 读逐字稿等）。

### 6.2 元数据如何进入模型（C3）

**设计**：注册表**自动生成**两处模型可见面 —— ① system prompt 的紧凑实体/列/路径清单；② 工具 JSON Schema 的 enum。

**成本（实测）**：

| 方案 | 字符 | ≈ token |
|---|---|---|
| 现状：逐表 `describe` 全量（按需拉取） | 家长 2799 + 孩子 2810 = **5609** | ~3790 |
| **提议：紧凑清单常驻 prompt** | 家长 994 + 孩子 1759 = **2754** | **~1861** |
| 现状：`describe` 不传 table 的实际返回 | **1403**（只有表名 + 一句话，**无任何列名**） | ~948 |
| 对照：本次事故单次查询返回体 | **364180** | **246474** |

> 即：把列清单常驻只要 **1861 token（≈事故的 0.75%）**，一次性、可缓存，换掉「猜列名 + N+1 往返」。

### 6.3 `describe` 的定位（收窄后）

| 用途 | 是否仍需 describe |
|---|---|
| ① 写操作前查引用校验 / 必填 / 行数熔断 / 敏感列 | ✅ 需要 |
| ② 查枚举值域 | ✅ 需要（或由 F2 自愈替代） |
| ③ Tier 2 动态注册实体的元数据出口 | ✅ **唯一**出口 |
| ④ **读操作（含读关联）** | ❌ **不应需要**——列清单 + 路径清单常驻 prompt |

---

## 7. 现状审计（2026-09-18）

### 7.1 契约符合度

| 契约 | 现状 | 判定 |
|---|---|---|
| **C1 agent 永不写 SQL** | `executeRead` / `executeWrite` 拼参数化 SQL，工具只收表名/路径/条件/行数据 | ✅ **达标** |
| **C2 关系查询由注册表承载** | `refChecks` 仅写侧且派生只读面时被丢弃；`ReadableTableSpec` 无关系字段；真正的多跳 JOIN **硬编码在领域模块**（`assess-content.ts:189`、`:330-331`、`:415-416`、`kb.ts:302/305`、`task-runs.ts:104/191/372/464`）；全仓无 `paths` 概念 | ❌ **未落地** |
| **C3 namespace 进 prompt** | prompt 只有**表名**；`parent_db_read` 的 `table` 是裸 `Type.String()`、`columns` 是 `Type.Array(String)`，**无枚举无列清单**；`describe` 不传 table 时只回 1403 字符的表清单（无列）→ 拿列必须逐表再调（N+1） | ❌ **未落地** |
| **C4 灵活 schema（Tier 2）** | 无 `defineNamespace`、无 `entities(ns, data_json)`；注册表是**手写 TS 常量**（`parentLibTableRegistry()` 返回字面量）→ 加表 = 改代码 + 发版 | ❌ **未落地** |
| **C5 SQL 下沉** | 下沉已做到；但**缺 count / 聚合**，且**无返回体字节预算** | ⚠️ **部分** |

**一句话结论**：当前实现 = **ISSUE-105「方案 B」（通用行级 CRUD）的加长版**（加了只读面、扩到了孩子库），**不是**本稿的 namespace 关系查询方案。方案 B 原文即写明「不能 JOIN、不能聚合、不能改表结构」。

### 7.2 漂移实测（`npm run probe:registry-drift`）

逐表比对「注册表声明列」vs「库内真实 schema」。家长库 51 个（同一份代码注册表，按库去重）、孩子库 415 个（取最大库）。

**按库去重的系统性漂移**：

| 库 | 表 | 问题 |
|---|---|---|
| 家长库·读/写 | `topics` | 库里有 `method_spec` 未登记 |
| 家长库·读/写 | **`courses`** | **库里有 `uuid` 未登记** → 内部断链：`knowledge_points.course_uuid` 要求 `courses.uuid`，但 uuid 读不回来 |
| 家长库·读/写 | **`question_bank`** | **`id` / `created_at` / `updated_at` 未登记** → 挂载桥需要 `question_bank.id`，但读不回来 |
| 家长库·读/写 | `knowledge_points` | `id` 未登记（同上，挂载桥需要） |
| 孩子库·读 | **`topics`** | ❌ **注册表声明了库里不存在的 `assess_method`** → 默认全列读**必报错**（`no such column: assess_method`）；另有 `progress` / `rules_json` 未登记 |
| 孩子库·读 | `study_plans` | 22 列中 10 列未登记（`course_uuid` / `recurrence_id` / `count_in_rate` / `origin` / `carry_from`…） |
| 孩子库·读 | `exam_plans` | 23 列中 11 列未登记 |
| 孩子库·读 | `points_ledger` | 15 列中 7 列未登记（`reason_code` / `rate` / `meta_json` / `operator`…） |
| 孩子库·读 | `reward_daily_stats` / `plan_recurrences` / `exam_plan_courses` / `life_plans` / `courses` / `redemption_*` / `reward_configs` / `points_balance` / `daily_entries` | 同类列缺口（明细见 `server/registry-drift.txt`） |

**未被注册表覆盖的表**：家长库 `meta`（预期，迁移标记）；**孩子库 `meta` / `tags`(93 行) / `child_todo_stats`(4 行) / `todo_items`(85 行)** ← 新场景根本没走「注册一行」的路径，正是「加表 = 改代码发版」的直接证据。

**根因（不是疏漏，是架构）**：

1. 注册表是**手写 TS 常量**，没有版本号、没有运行时读取、没有一致性校验；
2. `childKbReadableRegistry()` 是**手写数组**、`parentReadableRegistry()` 才是**派生**——两份真源必然分叉；
3. 设计原话「注册表整体数据驱动、API 运行时读、**自动生成 prompt 工具描述**」的后半句从未实现，`describe` 就是为这个缺口打的补丁。

---

## 8. 差距清单与实施计划

按「先正确性 → 再治体量 → 再补元数据 → 最后补关系查询」排序。

| ID | 事项 | 类型 | 依赖 | 验收 |
|---|---|---|---|---|
| **F13** | **关系真源修正**：`refs` 提升为一等公民并进读面；修 `courses.topic` 声明 `topics.name` → `topics.topic_key`（**改注册表，不动 1317 行存量**——既有写入方也都按 key 走） | 正确性 | — | 读侧能看到关系；`where topic='lunyu'` 能命中；用 `lunyu` 写入不再被 refChecks 误拒 |
| **F14** | **注册表回归真源**：补齐漂移列（`courses.uuid`、`question_bank.id`、`knowledge_points.id`、孩子库各表）；删掉孩子库 `topics.assess_method` 幽灵列；登记 `tags` / `todo_items` / `child_todo_stats`；`childKbReadableRegistry` 改为派生 | 正确性 | — | `npm run probe:registry-drift` **exit 0**（零漂移） |
| **F2** | **错误/空结果自愈**：列名错 → 回该表可用列清单；空结果 → 附该列**实际取值样例**；顺手修 `db-channel.ts:735` 把工具名写死成 `child_db_describe` 的笔误（家长侧应为 `parent_db_describe`） | 效率/正确性 | F14 | 猜错列名/值域后**一次往返**内自愈，不再重复同参重试 |
| **F1** | **读返回体字节预算**：默认约 4 万字符，超预算按行截断并提示「已返前 N 行 / 共 M 行，取全文请用 columns + 精确 where」；单列超长（>4000）截断并标注 | 体量护栏 | — | `courses` 默认查询不再产生 36 万字符的返回体；同时改掉工具描述里「不会把整表拉进上下文」的**误导**（SQL 下推 ≠ 结果不进上下文） |
| **F7** | **元数据常驻 prompt**：注册表 → 紧凑实体/列/路径清单（≈1861 token）常驻两个 agent 的 prompt；`table` / `op` / `path` 参数加 enum | C3 | F13/F14 | 读场景**零 describe**；首次调用即用对列名 |
| **F10** | **命名路径查询**：注册表加 `paths`；`parent_db_read` 加 `path` 参数；首条路径 `topic_questions` 端到端打通（实测口径 3576 题 / 489 课） | C2 | F13/F14/F7 | 一次调用拿到四跳关联结果；未注册路径被拒绝 |
| **F10-b** | **收编硬编码 JOIN**：把 `assess-content.ts`（`:189` / `:330-331` / `:415-416`）、`kb.ts`（`:302/305`）、`task-runs.ts`（`:104/191/372/464`）的多跳 JOIN 逐步改为走已登记路径 | 消除第二真源 | F10 | 关系只有「注册表」一份真源 |
| F6 | `count` / 聚合能力 | 补缺 | F7 | 「有没有 / 有几条」不再靠拉行 |
| F15 | Tier 2：`entities(ns, data_json)` + `defineNamespace` + 设计器 agent | C4 | F14/F7 | 新增自定义实体零 DDL、零发版 |

**落地顺序**：`F13 + F14`（正确性，漂移归零）→ `F2`（自愈）→ `F1`（体量）→ `F7`（元数据常驻）→ `F10`（首条路径）→ `F10-b`（收编）→ `F6` / `F15`。

> **预期收益**（基于 2026-09-18 那次 221 秒事故的实测归因）：F1 把该轮上下文从 24.6 万 token 压到约 2.7 万；F7 让首次调用即用对列名；F2 省掉约 4~5 次无效往返；F10 让四跳关联从 4 次分步查询降到 1 次。合计预期把「3.7 分钟 / 10 次调用」降到「十几秒 / 2~3 次调用」。

---

## 9. 风险与开放问题

| # | 风险 / 问题 | 现状 |
|---|---|---|
| R1 | **路径爆炸**：每条关联都注册一条路径，长期可能几十条。需要「路径命名约定 + 按需注册 + 反向索引（表→参与路径）」 | 待观察，先只注册高频路径 |
| R2 | **自连接 / 多义路径**（同一表在路径中出现两次）暂不支持 | 明确排除，写入约束 |
| R3 | **硬编码 JOIN 与 paths 并存期**存在第二真源 | 用 F10-b 收编，期间以 `probe:registry-drift` 兜底 |
| R4 | **写侧不变量仍未集中于注册表**：考核状态机、积分只增、recurrence 游标仍散在领域模块 | ISSUE-105 已列「不变量收口清单」，本稿不展开 |
| R5 | Tier 2 的 `defineNamespace` 若被滥用会退化回「随手加表」 | 护栏 + 人工确认关 + 审计；先只对设计器 agent 开放 |
| R6 | 注册表运行时读取的性能（每会话加载） | 缓存 + 版本号 |
| Q1 | `paths` 是否要支持 hop 上的**可选条件**（如只取 `status='pending'` 的课程）？ | 待评审：先只支持叶端过滤 |
| Q2 | `paths` 的返回是否允许**聚合列**（count/avg）？ | 倾向并入 F6 |
| Q3 | 孩子库是否共享家长库的 `refs`/`paths`（两库 schema 同构但不同源） | 待定：F14 统一来源后再评估 |

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 首版：定案 C1~C5 契约；否决 Markdown 数据层 / JSON 扁平化 / 自由 SQL / describe 多表；确立注册表 `refs` + `paths` 设计；记录现状审计（仅 C1 达标）与漂移实测；排出 F13→F14→F2→F1→F7→F10→F10-b 实施顺序 |
| 2026-09-19 | **落地记录（WP1~WP6 + WP8 实施，WP9 待排期）**：F13 ✅（`RefEdge` 进读面、`courses.topic→topics.topic_key` 修正）；F14 ✅（家长库补 uuid/method_spec/question_bank.id 等、孩子库读面改为 `childKbTableSpecs` 派生、tags 登记、todo_items/child_todo_stats DROP、探针改为「打开即迁移」并把只读列计入声明——**probe exit 0 漂移归零**，顺带完成 132 个存量库迁移清扫）；F1 ✅（读返回体 40k 字符预算 + 单列 4k 截断 + 「已返前 N/共 M」提示）；F6 ✅（`countOnly`）；F2 ✅（列名错回可用列、空结果回取值样例；§7.2 笔误随之消灭）；F7 ✅（`registry-prompt.ts` 紧凑清单常驻三处 prompt，Tier 2 namespace 一并进清单——C3 对两层统一成立，describe 收窄定位达成；table 参数保持 String 未加硬 enum，因 ns: 动态值需要）；F10 ✅（`buildPathQuery`/`executePathRead` + 首批 4 条路径，中间表可过滤=Q1 消解，LEFT JOIN 可选跳）；F10-b 部分 ✅（assess-content 三处 JOIN 收编；task-runs.ts 留 P2 表搬家后做）；F15a ✅（`tier2.ts`：entities/namespaces 表、defineNamespace 执行器+演进规则、json_extract 参数化过滤、refs 应用层校验、审计；设计器 agent 未挂=严格执行者先行）。**未做**：F15b（设计器 agent + 家长确认 UI，需客户端发版）；P3 沙箱决策点（维持 F10 后评估，按运行时模型实测 go/no-go）。§7.2 漂移清单以本次探针结果为准（旧清单作废）。测试：`test/data-channel-v2.test.ts` 17 例全绿；全量 289 过/15 败（15 项均为与本次无关的存量失败） |
