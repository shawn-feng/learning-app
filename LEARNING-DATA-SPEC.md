# 孩子学习数据规范（LEARNING-DATA-SPEC）

> **状态**：数据结构已定稿（2026-08-20）；工具面（kb 系列 + lint 校验）已定稿（2026-08-20）。
> **适用范围**：桌面应用「学习伙伴」的每个孩子数据目录 `data/children/{childId}/`。
> **权威性**：本规范是孩子学习数据**现行唯一权威**。与 `LEARNING-DATA-REDESIGN.md`（历史设计讨论与决策记录）冲突时，**以本规范为准**。

---

## 一、数据组织原则

1. **单一真相源**：每天 4 类内容（学习/生活/问答/任务）都写进 `daily/{日期}.md` 一个文件（4 个固定区块），内容只写一次。
2. **分类指针索引**：`life/`、`inquiries/`、`tasks/` 按月索引、`tags/` 倒排索引、`learning/` 进度文件——都只放**指针**指向 daily 区块，不复制内容。
3. **文件名即时间线**：`daily/` 以日期命名（`2026-08-19.md`），文件系统天然构成时间线索引——**不建 `daily/index.md` 总索引**。
4. **结构化头部（frontmatter）**：`topics.md` / `rules.md` / 进度文件把机器可读数据放 frontmatter，agent 与索引器直接消费，不解析散文。
5. **追加友好**：记录只追加、不改历史；单文件膨胀用「按天分文件」解决，不反复重写大文件。

---

## 二、目录结构（定稿）

```
data/children/{childId}/
├── AGENTS.md              # 行为准则（身份+导航+custom 段），不属数据结构，见 pi-session.ts
├── profile.json           # 孩子档案（名字/头像/密码hash/AI名字性格/基本情况）
├── daily/                 # 单一真相源：## 学习 / ## 生活 / ## 问答 / ## 任务（详式）
│   └── 2026-08-19.md
├── learning/              # 按主题组织
│   ├── topics.md          # 总入口：frontmatter 唯一真源（主题→进度文件→method）
│   ├── rules.md           # 每日学习目标量（frontmatter）
│   └── lunyu/             # 每个主题一个自包含"主题包"
│       ├── lunyu.md       # 主题进度文件（frontmatter + 每课 ### 条目，含 tags）
│       ├── method.md      # 该主题教学方法
│       ├── materials/     # 教学资料（{课程名}.md 原文 + {课程名}.html 展示版）
│       └── media/         # 音视频媒体（本主题专用，不随 app 打包）
├── life/                  # 按月索引（只指针 → daily#生活）
│   └── 2026-08.md
├── inquiries/             # 按月索引（只指针 → daily#问答）【待 recording 补维护】
│   └── 2026-08.md
├── tasks/                 # 按月索引（只指针 → daily#任务）【待 recording 补维护】
│   └── 2026-08.md
├── outputs/               # 任务产物（真实文件：网页/歌曲链接等，统一放此）
├── tags/                  # 倒排索引（标签枢纽）
│   ├── taxonomy.md        # 受控词表（品格/关系/情绪/学习 四维）
│   └── 诚实.md            # 关联知识点 + 关联生活事件（指针）
└── uploads/               # 孩子上传的附件
```

---

## 三、文件 schema 详细定义

### 3.1 daily/{YYYY-MM-DD}.md（单一真相源，4 固定区块，详式）

文件名即日期。每条记录用 `### 标题` + 字段详写，**「孩子表现/概要」必填且详写、不限篇幅**（ISSUE-009 宁详勿略）。字段行键可加 markdown 加粗修饰（`- **掌握度：** 熟练`，渲染用；工具解析时自动剥离星号）：

```markdown
## 学习
### 论语先进篇第十六章
- **课程名：** 论语先进篇第十六章（与进度文件 ### 标题完全一致，不得改写）
- **考核：** 吟诵✓ 翻译✓ 道理应用✓
- **掌握度：** 熟练
- **难点：** …（讲解/纠正过程）
- **错题：** …（错在哪、如何纠正）
- **孩子表现：** …（原话/例子/提问/思考/情绪，必填详写）

## 生活
### 事件标题
- **标签：** #日常 #独立（只能从 tags/taxonomy.md 选，无法归类打 `其他`）
- **概要：** …（完整经过，必填详写）

## 问答
### 问题
- **孩子的疑问：** …（原话）
- **引导过程：** …
- **结论：** …

## 任务
### 任务名
- **需求：** …
- **过程：** …
- **产物：** outputs/xxx.html（真实文件放 outputs/）
- **状态：** done | pending
```

> 说明：daily 允许附加「内容型」## 区块（如 study-tracker 的每日评估区块），lint 只校验上述 4 个结构化区块内的字段。

### 3.2 learning/topics.md（主题总入口）

```yaml
---
topics:
  - {name: 论语, file: lunyu/lunyu.md, method: learning/lunyu/method.md, progress: 277/514}
---
```

- `file` 相对 `learning/` 目录；`progress` 仅作兜底，权威进度以进度文件 frontmatter 为准。
- **frontmatter 是唯一真源；正文只放说明性文字，不写重复数据表**。

### 3.3 learning/rules.md（每日目标量）

```yaml
---
rules:
  论语: {daily: 3, review: "全篇背诵", type: 必学}
  英语: {daily: 1, unit: 内容单元, type: 必学}
  陶笛: {type: 选学}
---
```

只与学习相关；正文可放补充说明（如英语内容单元划分）。

### 3.4 learning/{topic}/{topic}.md（主题进度文件，放主题目录下）

frontmatter 只承载进度字段（method/materials 分别在 topics.md 与 method.md 约定，不在此重复）：

```markdown
---
learned: 282
total: 514
next: "论语先进篇第十七章"
updated: 2026-08-19
---

### 论语先进篇第十六章
状态:: ✅
掌握度:: 良好
复习次数:: 0
最近复习:: 2026-08-13
tags:: [诚实, 自律]
```

- `状态::`：⬜ 待学 → ✅ 已学
- `tags::`：**创建知识点（新增该 `###` 条目）时**从 taxonomy 一次性选定，稳定不动；不归 recording 维护。tags 倒排索引的「关联知识点」据此生成。
- **不加指向 daily 的指针**（已定稿 B 方案）：进度文件职责是「进度」，学习记录的引用由 `复习次数`/`最近复习` 承载频次信息；某课的学习详录反查走 `daily` 文件名 + daily 学习区块「课程名」字段。

### 3.5 learning/{topic}/method.md + materials/ + media/

- `method.md`：该主题教学步骤（含「用课程 tags 开 `tags/{tag}.md` 找相关生活事件讲解」一步）。
- `materials/`：`{课程名}.md`（原文，agent 可读）+ `{课程名}.html`（给孩子看的展示版，`display_content` 引用）。
- `media/`：本主题音视频，固定位置。主题包结构细则见 `LEARNING-TOPIC-STRUCTURE.md`。

### 3.6 life/{YYYY-MM}.md（生活事件月索引，只指针）

**同名约束（指针精确定位的根基）**：索引条目标题必须与 daily 对应条目 `###` 标题**完全一致**（**条目标题不含日期前缀**——日期由月文件名与 daily 锚点承载）——指针 `daily/2026-08-13.md#生活` 定位到区块后，条目级靠同名标题匹配。

```markdown
## 撒谎事件
- summary: 对妈妈撒谎 | type: consult
- tags: [诚实, 亲情] | 关联: daily/2026-08-13.md#生活
```

### 3.7 inquiries/{YYYY-MM}.md 与 tasks/{YYYY-MM}.md（月索引，只指针，与 life 同构）

**同名约束同 3.6**：索引条目标题必须与 daily 对应条目 `###` 标题完全一致。

```markdown
## 恐龙为什么灭绝
- summary: 随口问恐龙灭绝原因 | type: qa
- tags: [好奇] | 关联: daily/2026-08-13.md#问答

## 做个番茄钟
- summary: 番茄钟网页，可自己调时间 | type: game | status: done
- 关联: daily/2026-08-13.md#任务
```

### 3.8 tags/taxonomy.md（受控词表）

frontmatter：`dimensions: [品格, 关系, 情绪, 学习]` + `updated`。正文按维度列出全部允许标签 + 释义。家长可增删，增删后同步维护对应 `tags/{tag}.md`。

### 3.9 tags/{tag}.md（倒排索引）

```markdown
# 标签：诚实

## 关联知识点
- 论语·吾日三省吾身 (learning/lunyu/lunyu.md)

## 关联生活事件
- 2026-08-13 撒谎事件 (daily/2026-08-13.md#生活)
```

### 3.10 outputs/（任务产物）

任务产出的真实文件（网页 html、资源等）统一放此，**不散落孩子目录根**。

---

## 四、数据流转流程（按场景）

> 本章只描述**数据如何产生与流动**（先写哪个文件、写什么、再流向哪个索引），不涉及由谁用什么工具维护——维护职责与工具见「五、维护方式与 AI 工具面」。

### 4.1 场景：新增一个学习主题

1. **创建主题包目录** `learning/{topic}/`，生成文件：
   - `{topic}.md` —— 进度文件：frontmatter（`learned/total/next/updated`）+ 每课一个 `### 课程名` 条目（状态 ⬜，**创建时选定 `tags::`**）；
   - `method.md` —— 该主题教学方法；
   - `materials/` —— 教学资料（`{课程名}.md` 原文 + `{课程名}.html` 展示版）；
   - `media/` —— 音视频（可选）。
2. **在 `learning/topics.md` 的 frontmatter 登记主题**：`{name, file, method, progress}` 一行。
3. **视情况在 `learning/rules.md` 增加该主题每日目标**（必学/选学、daily 数量）。

### 4.2 场景：创建知识点（新课程条目）

1. 在 `learning/{topic}/{topic}.md` 新增 `### 课程名` 条目，状态 ⬜；
2. 从 `tags/taxonomy.md` **一次性选定 `tags::`**（稳定不动，后续不归记录流程维护）；
3. frontmatter `total` 相应 +1。

### 4.3 场景：孩子学习一课

学习数据**先进入 `daily/`，再回流进度文件**：

1. 写 `daily/{日期}.md` 的「## 学习」区块（详式：课程名/考核/掌握度/难点/错题/孩子表现）；
2. 更新 `learning/{topic}/{topic}.md`：该课条目 状态 ⬜→✅、掌握度；frontmatter `learned`/`next`/`updated`。

学习数据不产生 life/inquiries/tasks 索引。

### 4.4 场景：复习

1. 更新 `learning/{topic}/{topic}.md` 条目：`复习次数` +1、`最近复习` 更新；
2. 写 `daily#学习` 记录本次复习。

### 4.5 场景：记录生活事件（append-only）

**固定顺序：daily → life 索引 → tags 倒排**

1. 写 `daily/{日期}.md` 的「## 生活」区块（详式；标签从 taxonomy 选，无法归类打 `其他`）；
2. 追加 `life/{月}.md` 索引行（`summary/type/tags/关联`，只指针）；
3. 同步追加 `tags/{tag}.md` 倒排「关联生活事件」（带 daily 锚点）。

历史事件不改、不删。

### 4.6 场景：记录零散问答（append-only）

1. 写 `daily/{日期}.md` 的「## 问答」区块（孩子的疑问/引导过程/结论）；
2. 追加 `inquiries/{月}.md` 索引行。

### 4.7 场景：孩子让做任务

1. 写 `daily/{日期}.md` 的「## 任务」区块（需求/过程/产物/状态）；
2. 追加 `tasks/{月}.md` 索引行；
3. 产物真实文件放 `outputs/`，daily「产物」字段指向它（如 `outputs/tomato.html`）；
4. 完成时状态置 `done`（daily 与 tasks 索引同步）。

### 4.8 场景：每日学习评估（只读，不产生数据）

读 `learning/rules.md` 目标 + 各主题进度 frontmatter，比对 `updated` 是否今天，输出当日完成情况。不写任何文件。

### 4.9 场景：标签增删 / 移除主题

- **增删标签**：改 `tags/taxonomy.md`；删除标签时同步删除 `tags/{tag}.md` 并清理引用该标签的条目；
- **移除主题**：从 `learning/topics.md` 移除登记；目录保留或归档（不删数据）。

---

## 五、维护方式与 AI 工具面

> 本章描述「由谁、在什么时机、用什么工具」维护第四节流转产生的数据。

### 5.1 维护职责矩阵

| 数据 | 创建时机 | 更新时机 | 不可修改 |
|---|---|---|---|
| `daily/{日期}.md` | 当天首次有记录时创建 | 当天内可追加（按区块） | **跨天不改**（历史即事实） |
| `learning/{topic}/{topic}.md` 条目 | 创建知识点时（含 `tags::`） | 学习/复习后更新状态与 frontmatter | 课程名不改写；`tags::` 选定后不动 |
| `learning/topics.md` / `rules.md` | 新增主题时 | 主题/目标调整时 | — |
| `life/ inquiries/ tasks/` 月索引 | 每次记录对应类型事件时 | append-only 追加 | 历史索引行不改 |
| `tags/taxonomy.md` | 家长维护 | 家长增删标签 | — |
| `tags/{tag}.md` 倒排 | 知识点创建 / 生活事件记录时 | 追加 | — |
| `outputs/` | 任务产出时 | 任务更新（产物替换） | — |

**写者边界**：
- 所有写入只能走 agent 工具面（无 shell），Path Guard 将路径锁死在 `data/children/{childId}/` 内；
- 记录类数据（daily / life / inquiries / tasks / tags 倒排）由记录流程（recording 技能）统一写，**单一写者，保证写入顺序**：先 daily、后索引；
- 进度条目 `tags::` 只由创建者（建课/脚本预生成）写，记录流程不得改动；
- 历史 daily 文件不修改。

### 5.2 现状工具（已实现）

| 工具 | 用途 | 备注 |
|---|---|---|
| `read` / `write` / `edit` | SDK 内置文件读写 | Path Guard 前缀校验，锁 childDir |
| `display_content` | 给孩子展示 html 学习资料 | `path` 引用 `materials/{课程}.html` |
| `get_date` | 获取当前日期 | 时间注入只到日期，保前缀缓存 |
| `get_progress` | 进度 frontmatter 摘要（省 token） | 严禁为取 `next` 读进度正文 |

### 5.3 结构化工具（已定稿：kb_read / kb_patch / kb_append）

> 设计目标（ISSUE-013 缺口 2/6）：**查询只回目标区块/条目**，**写入内容不进 LLM 上下文**。三者共用同一套**定位器**与 `electron/lib/kb-parser.ts`（markdown 结构解析：`##` 切块 → `###` 切条目 → 字段行 / frontmatter）。

**定位器**：`{file, block?, item?, field?}`
- `file`：相对 childDir 的路径（如 `daily/2026-08-19.md`、`learning/lunyu/lunyu.md`）；
- `block`：`##` 区块标题（如 `生活`；缺省 = 整个文件）；
- `item`：`###` 条目，支持**标题精确匹配**或**序号**（1-based，如 `item: 2` 即区块内第 2 条）；
- `field`：字段名（daily 用 `- 键：值`，进度文件用 `键:: 值`；frontmatter 用 `frontmatter:learned` 形式）。

**`kb_read`**（结构化读）

```
kb_read { file?, ref?, block?, item?, listOnly? }
```
- `{file, block:"生活", item:2}` → 只返回该区块第 2 条（几行）；
- `{file, block:"生活", listOnly:true}` → 只回区块内全部 `###` 标题清单（先看有哪些再定点）；
- **`ref` 简写**：`{ref:"daily/2026-08-13.md#生活"}` 等价于 `{file:"daily/2026-08-13.md", block:"生活"}`——`#` 后为区块锚点（与数据文件里指针的写法一致，见 3.6）；`ref` 与 `file`/`block` 互斥，同传以 `ref` 优先；
- `{file, block:"学习", listOnly:true, ref:"2026-08"}` → **month 聚合**：主进程 glob `daily/2026-08-*.md`，逐文件提取该区块标题行，返回按日期分组的精简清单（按需生成、不持久化，替代静态总索引）。

**`kb_patch`**（定位更新，无需知道当前值）

```
kb_patch { file, item?, field?, value, fields? }
```
- `{file:"learning/lunyu/lunyu.md", item:"论语先进篇第十六章", field:"掌握度", value:"熟练"}` → 主进程定位该条目该字段行，整行替换，写回；
- frontmatter：`{file, field:"frontmatter:next", value:"…"}`；
- 批量：`fields: [{field, value}, …]` 一次多字段（同条目）；
- **文件内容全程不进 LLM 上下文**；不受文本重复影响（按结构定位，非 oldText 匹配）。

**`kb_append`**（区块尾追加条目）

```
kb_append { file, block, content }
```
- `content` 为一条完整 `### 标题 + 字段行` 文本，追加到目标区块尾部（recording 高频场景：写 daily 新条目）；
- **`content` 通常直接使用 method 流程已在回复中输出给孩子的学习总结原文**——工具只校验结构（`###` 开头、区块合法），**不校验字段名**（字段质量由 method 输出流程保证，字段漂移由 5.5 lint 兜底）；
- 文件不存在时自动创建（如当日 daily 首次写入）。

**实现要求**：
- 解析器 `kb-parser.ts` 为纯函数（可单测），同时支持 `- 键：值` 与 `键:: 值` 两种字段格式；
- Path Guard：`path.resolve(ctx.cwd, file)` 前缀校验（同 `display_content`）；block/item/field 仅字符串匹配，不做路径解释，无穿越风险；
- **先整体解析验证再写回，不做部分写入**；解析失败（找不到 block/item/field）返回明确错误 + 合法值提示；
- 每个 custom 工具 name 必须同步加入 `pi-session.ts` 的 tools 白名单（否则被 `isAllowedTool` 静默过滤）。

### 5.4 文件类型分流与 schema 约束（保证 AI 按结构写）

**前提**：结构化定位要求数据文件结构固定。因此文件分两类，**只有数据文件受 schema 约束**：

| 类型 | 文件 | 写入方式 |
|---|---|---|
| **数据文件**（schema 约束） | `daily/*.md`、`learning/topics.md`、`rules.md`、`learning/{topic}/{topic}.md`、`life/ inquiries/ tasks/` 月索引、`tags/*.md`、`profile.json` | 走 `kb_patch` / `kb_append`（工具内校验）；write/edit 仅限初始化/兜底 |
| **内容文件**（自由格式） | `method.md`、`materials/*.md`、`media/` | `write` / `edit` 随意 |

**四层保障（从硬到软）**：
- **L1 写入收口**：数据文件写入只走 kb 工具（工具即 schema）；
- **L2 工具内校验**：字段白名单（见下）——`kb_patch` 传未知字段名 → 拒绝并提示合法字段（**更新**场景字段应精确）；`kb_append` 只校验结构（`###` 开头、区块合法），**不校验字段名**（content 是 method 流程已输出的总结原文，字段漂移由 L4 lint 兜底）；
- **L3 行为约束**：`AGENTS.md` 明写「数据文件禁止裸 write/edit，一律走 kb 工具」；`recording/SKILL.md` 同步；
- **L4 lint 兜底**：每日定时校验脚本（见 5.5）。

**字段白名单**（SPEC 第三章 schema 的可执行形态，存于 `electron/lib/kb-schema.ts`，kb 工具与 lint 脚本**共享同一份**，避免漂移）：

```ts
// 示意
const DAILY_FIELDS = {
  学习: ["课程名", "考核", "掌握度", "难点", "错题", "孩子表现"],
  生活: ["标签", "概要"],
  问答: ["孩子的疑问", "引导过程", "结论"],
  任务: ["需求", "过程", "产物", "状态"],
};
const PROGRESS_FIELDS = ["状态", "掌握度", "复习次数", "最近复习", "tags"];
const PROGRESS_FRONTMATTER = ["learned", "total", "next", "updated"];
```

**已知限制（坦白的残余风险）**：SDK 内置 `write`/`edit` 无法在工具层按路径禁止（内容文件需要它们），L1 收口依赖 L3 行为约束 + 5.1 单一写者 + L4 lint 兜底。

### 5.5 数据格式校验（lint 定时检查）

> 校验必须是**确定性脚本**（`scripts/kb-lint.mjs`），不靠 AI 判断。核心函数放 `electron/lib/kb-lint.ts`，主进程定时与 CLI 复用同一实现。

**运行方式**：
- app 启动时跑一次（最实用：app 是使用时才开）+ 运行期间每 24h 一次（主进程 scheduler）；
- 手动：`node scripts/kb-lint.mjs`；
- 检查结果**只报告不自动修改**（孩子学习记录不可自动改）。

**校验规则**：
| 检查项 | 规则 | 级别 |
|---|---|---|
| 目录结构 | 必需目录存在：daily/learning/life/inquiries/tasks/tags/outputs | error |
| daily 文件名 | `YYYY-MM-DD.md` 格式 | error |
| 字段白名单 | 各区块字段 ⊂ 5.4 白名单；frontmatter 键合法 | **warning**（历史基线/字段变体供人工判断） |
| 格式一致性 | `- 键：值`（daily/索引）与 `键:: 值`（进度文件）不混用 | error |
| 取值约束 | `状态::` ∈ {⬜,✅}；`tags::` 值 ∈ taxonomy 词表 | error |
| 索引指针 | life/inquiries/tasks「关联: daily/…」**三级校验**：①文件存在 → ②`## 区块`存在 → ③**同标题 `###` 条目存在**（同名约束，见 3.6/3.7） | error |
| tags 倒排 | 关联知识点/生活事件指针有效 | error |
| frontmatter 可解析 | topics.md/rules.md 能被 learning-summary 同款解析器解析 | error |

> 级别说明：**error = 结构性破坏**（指针失效/格式混用/取值非法/结构缺失），应修复；**warning = 字段名不在白名单**（历史格式基线或 recording 字段变体），供人工判断是否纳入白名单。字段白名单是「防漂移」的软约束，可随 recording 模板演进扩充（见 kb-schema.ts）。

**报告**：每个孩子目录落盘 `lint-report.md`（违规文件 + 违规行 + 违规类型 + 建议修法），符合「多孩子隔离」原则；主进程启动发现有违规时 console 警告（家长 UI 展示为后续项）。

---

## 六、查询路径速查（agent 视角）

| 查询需求 | 用 | 备注 |
|---|---|---|
| 下一课 / 主题进度 | 系统提示「学习进度概览」或 `get_progress` | 严禁 read 进度正文 |
| 某天发生了什么 | `read daily/{YYYY-MM-DD}.md` | 文件名即日期 |
| 某月生活事件 | `read life/{月}.md` → 定点 read daily | 索引只指针 |
| 某月问答 / 任务 | `read inquiries/{月}.md` / `tasks/{月}.md`，或 `kb_read` 定点 | 待 recording 维护 |
| 知识点 ↔ 生活事件 | `read tags/{tag}.md` → daily 锚点 | 倒排索引 |
| 标签词表 | `read tags/taxonomy.md` | 受限词表 |
| 教学方法 / 教学资料 | `read learning/{topic}/method.md`；`read materials/{课程}.md` + `display_content(html)` | 按需，不灌全文 |
| 跨天/跨主题回顾 | `kb_read {file:"daily/2026-08-19.md", block, item}` 定点读 + `kb_read` month 聚合（`ref:"2026-08"`） | 结构化，内容不进上下文 |

---

## 七、安全边界

- 所有文件在孩子目录内，`read/write/edit` 前缀校验（Path Guard）天然覆盖；
- 多孩子隔离：会话级 cwd + Path Guard 路径规范化比对 + 极简工具面（无 shell / 无 IPC 改设置权限）；
- 索引/倒排都锁在孩子目录，隔离边界不变。

---

## 八、相关文档

| 文档 | 关系 |
|---|---|
| `LEARNING-DATA-REDESIGN.md` | 历史设计讨论与决策记录（P0–P6 实施清单）；冲突以本规范为准 |
| `LEARNING-TOPIC-STRUCTURE.md` | 主题包（{topic}.md / method.md / materials/ / media/）结构细则 |
| `LEARNING-FRAMEWORK.md` | 学习框架（若与数据结构相关处） |
| `electron/lib/pi-session.ts` | AGENTS.md 生成（行为准则，非数据结构） |
| `data/shared/skills/recording/SKILL.md` | recording 技能细则（daily 详式字段定义在此） |
