# 知识库 SQLite Schema（KB-SQLITE-SCHEMA）

> **状态**：定稿（2026-08-21，schema v5：标签体系改造——倒排索引 → 定义表 + 数据行打标；rules 并入 topics；ISSUE-029 courses 加 lesson_method/html_path/teaching_copy）。
> **适用范围**：桌面应用「学习伙伴」的每个孩子数据目录 `data/children/{childId}/kb.sqlite`。
> **权威性**：本文件是 `kb.sqlite` 数据库结构（表 / 视图 / 列 / 约束 / 索引 / 写入语义）的**唯一权威**。与 `LEARNING-DATA-SPEC.md`（数据结构与生命周期）配合使用——SPEC 描述「数据长什么样、怎么流转」，本文件描述「数据在 SQLite 里怎么存」。
> **实现位置**：schema 定义在 `electron/lib/kb-sqlite.ts`（`SCHEMA_TABLES` / `SCHEMA_VIEWS` 常量），工具面 `kb_query / kb_insert / kb_update` 与 lint（`electron/lib/kb-lint.ts`）均以本文件 + 该常量一致。

---

## 一、总览

每孩子一个库：`data/children/{childId}/kb.sqlite`（沿用「按 childId 隔离」硬约束）。SQLite 为**唯一真源**（2026-08-20 拍板）：放弃 Obsidian 直读、不做双写、markdown 仅一次性迁移后归档不再维护。

**5 张表 + 1 个视图**：

| 对象 | 类型 | 内容 | 对应 markdown（迁移前） |
|---|---|---|---|
| `daily_entries` | 表 | daily 记录（学习/生活/问答/任务），raw 原文为内容源，tags 列打标签（生活事件） | `daily/{日期}.md` |
| `courses` | 表 | 每主题每课一行（进度明细 + tags 标签） | `learning/{topic}/{topic}.md` 的逐课条目 |
| `topic_progress` | **视图** | 各主题进度聚合（learned/total/next/updated 实时计算） | 进度文件 frontmatter（不再存储） |
| `topics` | 表 | 主题清单 + **rules_json（每日目标并入）** | `learning/topics.md` + `learning/rules.md` frontmatter |
| `tags` | 表 | **标签定义**（词表 + 维度 + 判断标准），替代倒排索引 | `tags/taxonomy.md` |
| `meta` | 表 | 元信息（schema 版本 / 迁移时间） | — |

**已删除（v4）**：`rules` 表（并入 topics.rules_json）、`tag_links` 倒排表（被 tags 定义表 + 数据行 tags 列替代）。

**不建表（查询替代索引）**：`life/`、`inquiries/`、`tasks/` 月索引**没有对应表**——用 `WHERE block=? AND date LIKE 'YYYY-MM%'` 直接查 `daily_entries` 代替。

**设计原则（v4，2026-08-21）**：
- **标签体系**：`tags` 表只存**定义**（名字 + 判断标准，家长维护，AI 打标签前查）；**应用**直接打在数据行——daily 生活事件 `tags` 列、课程 `courses.tags` 列；反查用 `WHERE (',' || tags || ',') LIKE '%,标签,%'` 扫数据行（数据量小，查询替代索引，消灭倒排一致性问题）。
- **字段名不做白名单**：daily 字段由 method.md 灵活设定，代码只约束结构（区块、主键、状态值域、标签词表）。
- **进度不存聚合**：learned/total/next/updated 由视图计算。

---

## 二、表结构详细定义

### 2.1 `daily_entries` — daily 记录（唯一真源）

```sql
CREATE TABLE daily_entries (
  date TEXT NOT NULL,
  block TEXT NOT NULL,
  title TEXT NOT NULL,
  raw TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (date, block, title)
);
CREATE INDEX idx_daily_date  ON daily_entries(date);
CREATE INDEX idx_daily_block ON daily_entries(block);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | TEXT | 日期 `YYYY-MM-DD` |
| `block` | TEXT | 区块：`学习` / `生活` / `问答` / `任务`（4 固定区块） |
| `title` | TEXT | 条目标题（`### 标题`） |
| `raw` | TEXT | **唯一内容源**：完整条目原文（method 自定义字段、多行子列表原样保真） |
| `tags` | TEXT | **标签**（逗号分隔，如 `诚实,亲情`）；**针对「生活」区块事件打标签**——`kb_insert daily` 从 content 的 `- 标签：` 行自动解析落列（raw 保留原文行） |

**约束语义**：
- 主键 `(date, block, title)` 天然去重（迁移时消除 687 条历史完全重复，无损）。
- append-only：`kb_insert` 同主键不覆盖；跨天不改。
- 标签只能从 `tags` 定义表选（lint 校验）。

**样例**：

```json
{
  "date": "2026-08-21",
  "block": "生活",
  "title": "准备去奶奶家——珊珊自己列行李清单",
  "raw": "### 准备去奶奶家——珊珊自己列行李清单\n- 标签：独立,计划\n- 概要：珊珊说明天回奶奶家，自己列了清单…",
  "tags": "独立,计划"
}
```

### 2.2 `courses` — 课程进度明细

```sql
CREATE TABLE courses (
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜',
  mastery TEXT NOT NULL DEFAULT '',
  first_learned TEXT NOT NULL DEFAULT '',
  last_review TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '',
  send_material TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lesson_method TEXT NOT NULL DEFAULT '',
  html_path TEXT NOT NULL DEFAULT '',
  teaching_copy TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (topic, title)
);
CREATE INDEX idx_courses_topic ON courses(topic, sort_order);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `topic` | TEXT | **主题目录名**（如 `lunyu`）——注意与 `topics.name`（中文名）不同 |
| `title` | TEXT | 课程名（如 `论语先进篇第十九章`） |
| `sort_order` | INTEGER | 课程顺序（进度/next 计算依据；新课程自动 max+1） |
| `status` | TEXT | 掌握状态：`⬜` / `✅`（值域约束） |
| `mastery` | TEXT | 掌握度（method 定义语义） |
| `first_learned` / `last_review` | TEXT | 首次学习 / 最近复习（YYYY-MM-DD，`-` 视为无） |
| `review_count` | INTEGER | 复习次数（`kb_update` 传 `value:"+1"` 自增） |
| `material` / `send_material` | TEXT | 教学资料 / 要发送的学习资料 |
| `tags` | TEXT | **课程标签**（逗号分隔，从 tags 定义表选，v4 确认保留） |
| `lesson_method` | TEXT | **每课教学方法全文**（v5/ISSUE-029 新增，分配时从家长库快照拷贝） |
| `html_path` | TEXT | **学习资料 html 地址**（v5/ISSUE-029 新增，相对父库根，如 `materials/lunyu/论语为政篇第一章.html`；父库共享，多孩子同一份） |
| `teaching_copy` | TEXT | **教学文案全文**（v5/ISSUE-029 延伸，由 `materials/<课程名>.md` 等文件入库，数据库唯一真源；lunyu 512 课已回填） |

### 2.3 `topic_progress` — 进度视图（非表）

```sql
CREATE VIEW topic_progress AS
SELECT
  topic,
  COUNT(*) AS total,
  SUM(CASE WHEN status = '✅' THEN 1 ELSE 0 END) AS learned,
  COALESCE(
    (SELECT c2.title FROM courses c2 WHERE c2.topic = courses.topic AND c2.status != '✅'
     ORDER BY c2.sort_order, c2.title LIMIT 1), ''
  ) AS next,
  COALESCE(
    MAX(CASE WHEN last_review IN ('', '-') THEN NULL ELSE last_review END),
    MAX(CASE WHEN first_learned IN ('', '-') THEN NULL ELSE first_learned END),
    ''
  ) AS updated
FROM courses
GROUP BY topic;
```

learned/total/next/updated **全部实时计算**，不可手动更新（`kb_update` 传这些字段被拒绝）。视图每次打开库时重建（廉价幂等）。

### 2.4 `topics` — 主题清单（含每日目标）

```sql
CREATE TABLE topics (
  name TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `name` | TEXT | 主题中文名（如 `论语`） |
| `file` | TEXT | 进度文件相对 `learning/` 路径（如 `lunyu/lunyu.md`；`file.split("/")[0]` = 目录名，关联 courses.topic） |
| `method` | TEXT | **教学方法全文**（v5/ISSUE-029 起存 method.md 整篇文本，不再是文件链接；AI 教学直接读它） |
| `progress` | TEXT | 兜底进度字符串（仅进度文件缺失时兜底，权威以视图为准） |
| `rules_json` | TEXT | **每日目标/规则**（v4 起 rules 表并入）：`{"daily":"3","type":"必学"}` |

> **⚠️ 关联键**：`topics.name`（中文）≠ `courses.topic`（目录名）。关联用 `topics.file.split("/")[0]`。rules 的 key 是**中文名**（rules.md frontmatter 原始 key，如 `论语`），直接匹配 `topics.name`。

### 2.5 `tags` — 标签定义表

```sql
CREATE TABLE tags (
  tag TEXT PRIMARY KEY,
  dimension TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT ''
);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `tag` | TEXT | 标签名（如 `诚实` / `亲情`） |
| `dimension` | TEXT | 维度（品格/关系/情绪/学习/其他/历史） |
| `criteria` | TEXT | **判断标准：什么类型的事件/课程打这个标签**（迁移时用 taxonomy 释义占位，家长可完善） |

**语义（v4 核心）**：
- 只存**定义**，不存应用——标签「打在哪里」由数据行的 tags 列记录（daily 生活事件 / courses 课程）。
- AI 打标签前先 `kb_query {query:"tags"}` 查定义（词表 + 判断标准），**只能从表中选择，不能自创**（词表纪律，lint 校验 daily/courses 的 tags ⊂ 本表）。
- 反查应用：`kb_query {query:"daily", block:"生活", tag:"诚实"}` / `kb_query {query:"progress", topic, tag:"品格"}`。

### 2.6 `meta` — 元信息

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

当前键：`schema_version`（当前 `"4"`）、`last_full_migration`（ISO 时间）。

---

## 三、数据量参考（主孩子 1f050a7f，2026-08-21 v4）

| 对象 | 行数 |
|---|---|
| `daily_entries` | 696（tags 已回填 85 行） |
| `courses` | 1300（8 主题；lunyu 512） |
| `topic_progress` | 视图（8 行聚合） |
| `topics` | 8（rules 已并入） |
| `tags` | 93（taxonomy 36 + 历史补全 57） |
| `meta` | 3 |

---

## 四、写入 / 查询语义（与工具面对应）

| 操作 | 工具 | 说明 |
|---|---|---|
| 查询 daily | `kb_query {query:"daily", date\|month, block, title, tag, listOnly}` | `tag` 按标签反查生活事件；非 listOnly 回 raw 原文 |
| 查询进度 | `kb_query {query:"progress", topic, tag, listOnly}` | 视图聚合 + 课程明细；`tag` 过滤课程 |
| 查询主题清单 | `kb_query {query:"topics"}` | topics（含 rules）+ 视图聚合 |
| 查询标签定义 | `kb_query {query:"tags", tag?}` | 词表 + 维度 + 判断标准（打标签前查） |
| 写 daily 新条目 | `kb_insert {table:"daily", date, block, content}` | content 含 `- 标签：` 行自动解析进 tags 列；同主键不覆盖 |
| 新增课程 | `kb_insert {table:"progress", topic, title, tags?...}` | sort_order 自动 max+1 |
| 更新 daily 字段 | `kb_update {table:"daily", date, block, title, field, value}` | field=标签 时同步 tags 列 |
| 更新课程进度 | `kb_update {table:"progress", topic, item:课程名, field, value}` | field：状态/掌握度/时间/复习次数(+1 自增)/教学资料/学习资料/tags |

**进度自动计算**：learned/total/next/updated 由视图计算，**不可手动更新**。
**标签纪律**：只能从 tags 定义表选（`kb_query {query:"tags"}` 查判断标准）；daily 生活事件在 content 写 `- 标签：` 行，课程用 `kb_update progress field:"tags"`。
**写入边界**：agent 只能通过 kb 工具写 SQLite；`read/write/edit` 仅用于内容文件（method.md / materials/ / uploads/），物理上碰不到数据表。

---

## 五、迁移

- **全量迁移**：`node --experimental-strip-types scripts/migrate-kb-sqlite.mjs`（**仅首次建库/灾难恢复**——SQLite 真源后重跑会覆盖丢失新增数据）。
- **就地迁移**：`openKbDb` 自动执行——`ensureV3`（v2→v3：daily 去 fields_json、进度展开 courses、聚合改视图）；`ensureV4`（v3→v4：topics 加 rules_json 并并入 rules 表、daily 加 tags 列并从 raw 回填、tag_links → tags 定义表）；`ensureV5`（v4→v5：courses 加 lesson_method/html_path，ISSUE-029）。不丢 SQLite 里迁移后新增的数据。
- **v4 补丁**：`scripts/fix-v4-tags-rules.mjs`（rules 按中文名回填 + tags 归一化）、`scripts/fix-v4-backfill-tags.mjs`（历史用过的非词表标签补入定义表，保持历史可检索）。
- **幂等**：迁移按主键 INSERT OR REPLACE，重复执行不重复入库；无数据孩子不建库（`hasAnyKbData()`）。
- **markdown 归档**：迁移后保留为归档（不再读写）。

---

## 六、相关文档

| 文档 | 关系 |
|---|---|
| `LEARNING-DATA-SPEC.md` | 数据结构 + 生命周期（权威）；本文件是其 SQLite 落库形态 |
| `LEARNING-DATA-REDESIGN.md` | 历史设计讨论与决策记录 |
| `electron/lib/kb-sqlite.ts` | schema 常量 + 全部读写函数实现 |
| `electron/lib/kb-schema.ts` | 结构常量（区块 / 状态值域）+ kb 工具名与参数约定；字段白名单已废弃 |
| `electron/lib/kb-lint.ts` | SQLite 数据校验（结构 / 状态值域 / 标签词表合规 / method 工具引用） |
| `electron/lib/custom-tools.ts` | `kb_query / kb_insert / kb_update` 工具注册 |
