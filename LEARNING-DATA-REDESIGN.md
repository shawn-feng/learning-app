# 孩子学习记录文件结构重设计方案

> 本文档汇总了关于「重设计孩子学习记录文件结构，让 AI agent 更高效、安全地检索与读写」的讨论，并据此形成可落地的实施方案建议。
> 适用范围：桌面应用「学习伙伴」的每个孩子数据目录 `children/{childId}/`。
> 状态：**数据结构已定稿（2026-08-20）**；工具面（kb 系列）与实施步骤待单独讨论。AGENTS.md 属行为规范，不在本文档范围（见第十节附注）。
> ⚠️ **现行权威规范见 `LEARNING-DATA-SPEC.md`**（数据结构 + 生命周期 + AI 工具面）；本文档为历史设计讨论与决策记录，冲突时以 SPEC 为准。

---

## 一、背景与目标

最初的问题：孩子数据越来越多后，agent 在讲论语某章时，如何**快速找到相关的过往生活事件**进行讲解？

逐步讨论后，目标收敛为：重做孩子的学习记录文件结构，让 agent 在「查询 / 读取 / 编辑」三类操作上都更顺，并完整覆盖孩子的 4 类使用场景：

1. **系统学习**：有计划的、系统的知识学习，含必学知识与兴趣知识。
2. **生活分享**：把 agent 当伙伴分享生活事件；有时咨询"怎么处理"，有时只是分享让 AI 帮忙记录。
3. **零散问答**：随口问的一些问题。
4. **让 AI 做事**：做网页游戏、做定时提醒、找视频/歌曲等。

---

## 二、数据组织核心原则

贯穿全流程的四项原则：

- **单一真相源**：每天 4 类内容都写进 `daily/{日期}.md` 一个文件（4 个固定区块），不分散、不重复。
- **轻量指针索引**：`learning/`、`life/`、`inquiries/`、`tasks/` 四个文件夹只放索引，指向对应日期的 daily 区块，避免内容冗余与漂移。
- **结构化头部（frontmatter）+ 关联字段（tags）**：便于 agent 和索引器直接消费，不必解析散文。
- **追加友好**：高频写入按时间/主题分文件，避免反复 `edit` 一个不断膨胀的大文件。

---

## 三、最终目录结构

```
children/{childId}/
├── AGENTS.md              # 身份 + 导航指令（学习去 learning/、生活事件必须打 tag）
├── profile.json           # 名字/头像/本地密码hash/AI名字性格/基本情况
├── daily/                 # 单一真相源：## 学习 / ## 生活 / ## 问答 / ## 任务
│   └── 2026-08-13.md
├── learning/              # 按主题组织（不按月）
│   ├── topics.md          # 总入口：主题→进度文件→method 指针
│   ├── rules.md           # 每日学习目标量（只与学习相关）
│   └── lunyu/             # 每个主题一个目录（自包含"主题包"）
│       ├── lunyu.md       # 主题进度文件：课程·状态·next·tags（放自己目录下）
│       ├── method.md      # 该主题教学方法（内容）
│       ├── materials/     # 教学资料+学习资料（内容，agent 可读）
│       └── media/         # 音视频媒体（本主题专用，固定位置，不随 app 打包）
├── life/                  # 按月索引（只指针）
│   └── 2026-08.md
├── inquiries/             # 按月索引（只指针）
│   └── 2026-08.md
├── tasks/                 # 按月索引（只指针）
│   └── 2026-08.md
├── outputs/               # 任务产物（已启用：番茄钟.html、歌曲/视频链接等真实文件统一放此，不散落孩子目录根）
└── tags/                  # 倒排索引（标签枢纽）
    ├── taxonomy.md        # 预设标签总表（可控词表，家长可增删）
    └── 诚实.md            # 关联知识点 + 关联生活事件
```

**组织方式说明**：`learning/` 按主题（课程天然归属主题，按主题查最自然）；`life/`、`inquiries/`、`tasks/` 按月（时间流，按月最自然）。后三者本质都是索引/指针，都指向 `daily/{日期}.md`——内容只在 daily 写一次。**进度文件放在各自主题目录下**（如 `learning/lunyu/lunyu.md`），与 method.md、materials/ 同目录，主题自包含；**每日目标量放 `learning/rules.md`**（只与学习相关）。不设 meta 目录——每个主题的进度文件本身已承载进度，无需跨天累积进度文件。**音视频固定放 `learning/{topic}/media/`**——主题作为自包含"主题包"额外下载、不随 app 打包，结构规范见 `LEARNING-TOPIC-STRUCTURE.md`。

---

## 四、教学方式的转变（去掉专用教学技能）

**决定：不再为教学准备专用 skill。** 改为：

- **AGENTS.md 写明确导航指令**：孩子要开始学习时，agent 去 `learning/` 找主题、找待学课程、读该课程的教学资料与学习资料。
- **每个主题一个 `method.md`**：记录该主题的教学方法，agent 按方法教学即可。
- **资料放在孩子目录内**：`learning/{topic}/materials/` 存放教学资料与学习资料。

**附带好处**：之前教学资料在 `shared/skills/`（孩子目录之外），agent 用 `read` 会被 Path Guard 拦住，只能靠 Pi 的"技能加载"机制把资料塞进上下文。现在 method/materials 放在孩子目录内，agent 原生可读可写，且仍锁在沙箱里——之前"教学资料读不到"的难题顺手解决。

**上下文控制**：AGENTS.md 只放"去哪读"的指引，不把 method/materials 全文灌进上下文；agent 按需 `read`，避免一次性撑爆上下文窗口。

---

## 五、标签关联机制（知识点 ↔ 生活事件）

这是对你最初那个问题的正解：讲某章时如何快速找到相关生活事件。

**机制**：
- **受控词表**：标签预设好（如 诚实 / 自律 / 亲情 / 友情 / 情绪 / 责任 / 助人 / 坚持 / 感恩 / 学习习惯…），家长可增删。
- **双向打标**：每个知识点（课程）建好时从词表选 tags；每次记生活事件时也打 tags。
- **倒排索引**：维护 `tags/{tag}.md`。agent 教某课时拿到它的 tags → 直接开对应 tag 文件 → 里面已列好"关联知识点 + 关联生活事件（带 daily 锚点）"。这把关联检索从"全量 read + LLM 筛"变成"开一个文件"，且天然就是 Obsidian backlinks 范式。
- 知识点与生活事件通过**同一套标签**对上——不用全文 grep，不用语义向量，纯"受控词表 + 倒排索引"就够准，对单孩子量级最划算。

---

## 六、安全边界（Path Guard 始终成立）

所有新增文件都在孩子目录内，`read/write/edit` 的前缀校验（Path Guard）天然覆盖；标签倒排索引也锁在孩子目录，隔离边界不变，无需修改守卫逻辑。

多孩子隔离仍靠：会话级 cwd 隔离（agent 默认相对 cwd 解析路径）+ Path Guard 路径规范化后比对 cwd 前缀（拦截 `../shared/auth.json`、`../../Windows` 等越界访问）+ 极简工具面（无 shell / 无 IPC 改设置权限）。

---

## 七、相对现状的改进对照

| 原痛点 | 新设计 |
|---|---|
| `life-events.md` 巨型单文件，全量读慢 / 费 token / 易遗漏 | daily 单源 + 按月/按主题索引，按需读 |
| 生活事件无标签、无法关联检索 | 受控 tags + `tags/` 倒排索引，精准反查 |
| 零散问答无处存、丢失 | `inquiries/` 专门沉淀 |
| 任务/产物散落，无法管理 | `tasks/` + `outputs/` 统一，带 status |
| agent 检索只能全量 read + LLM 筛 | index + frontmatter + tags 倒排，结构化检索 |
| 教学资料在沙箱外读不到 | 移进孩子目录内，原生可读 |

---

## 八、已拍板的决策

| 项 | 决定 |
|---|---|
| 教学方式 | 去掉专用教学技能；改为 AGENTS.md 导航 + 每主题 `method.md` + `materials/`；**不保留过渡，直接切换到 method.md** |
| 关联机制 | 受控标签词表 + `tags/` 倒排索引，知识点 ↔ 生活事件通过标签关联 |
| recording | **保留为 skill**（可临时触发做汇总）；study-tracker 同属定时任务，**确认保留为定时 skill** |
| 打标签可靠性 | recording 只能从 taxonomy 选标签，无法归类打 `其他` |
| 知识点 tags | **创建知识点（新增进度条目）时**一次性从 taxonomy 选定，写入进度文件 tags 字段，稳定不动；**不归 recording 维护** |
| 上下文控制 | method/materials 只放"去哪读"的指引，不灌全文，agent 按需 read |
| 场景覆盖 | 4 类场景（学习/生活/问答/任务）**全部落地**，不做后置 |
| 进度文件位置 | 每个主题的进度文件放**自己主题目录下**（`learning/{topic}/{topic}.md`），与 method.md、materials/ 同目录 |
| 目标量位置 | 每日目标量放 `learning/rules.md`（只与学习相关），不设 meta 目录 |
| meta 目录 | **取消**——进度由各主题进度文件承载，无需跨天累积进度文件（progress.md） |

---

## 九、文件 schema 详细定义

### daily/{YYYY-MM-DD}.md（单一真相源，4 固定区块，详式）
文件名即日期（YYYY-MM-DD），文件系统天然构成时间线索引——**不另建总索引**。每条记录用 `### 标题` + 字段详写（与 ISSUE-009「宁详勿略」对齐；「孩子表现/概要」必填且详写，不限篇幅）：

```markdown
## 学习
### 论语先进篇第十六章
- 课程名：论语先进篇第十六章（与进度文件 ### 标题完全一致）
- 考核：吟诵✓ 翻译✓ 道理应用✓
- 掌握度：熟练
- 难点：…（讲解/纠正过程）
- 错题：…（错在哪、如何纠正）
- 孩子表现：…（原话/例子/提问/思考/情绪，必填详写）

## 生活
### 事件标题
- 标签：#日常 #独立（只能从 tags/taxonomy.md 选）
- 概要：…（完整经过，必填详写）

## 问答
### 问题
- 孩子的疑问：…（原话）
- 引导过程：…
- 结论：…

## 任务
### 任务名
- 需求：…
- 过程：…
- 产物：outputs/xxx.html
- 状态：done
```

### learning/topics.md（总入口）
frontmatter：`topics: [{name, file, method, progress}]`，其中 `file` 指向主题目录下的进度文件（如 `lunyu/lunyu.md`）。
**frontmatter 是唯一真源；正文只放说明性文字，不写重复数据表**（避免双份数据漂移）。

### learning/rules.md（每日目标量，放 learning 根目录）
frontmatter：`rules: {主题: {daily, review, type}}`，只与学习相关。

### learning/{topic}/{topic}.md（主题进度文件，放自己目录下）
frontmatter 只承载进度字段（method/materials 分别在 topics.md 与 method.md 中约定，不在此重复）：

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

- 每课 `tags`：**创建知识点（新增该 `###` 条目）时**从 taxonomy 一次性选定，稳定不动；不归 recording 维护。tags 倒排索引的「关联知识点」据此生成。

### learning/{topic}/method.md + materials/
- `method.md`：该主题教学步骤（含"用 tags 找相关生活事件讲解"一步）。
- `materials/`：原文、资料、图片等，agent 用 `read` 访问。

### life/{YYYY-MM}.md（按月索引，只指针）
```markdown
## 2026-08-13 撒谎事件
- summary: 对妈妈撒谎 | type: consult
- tags: [诚实, 亲情] | 关联: daily/2026-08-13.md#生活
```

### inquiries/{YYYY-MM}.md 与 tasks/{YYYY-MM}.md（按月索引，只指针，与 life 同构）
由 recording 在写 daily「问答/任务」区块后同步维护：

```markdown
## 2026-08-13 恐龙为什么灭绝
- summary: 随口问恐龙灭绝原因 | type: qa
- tags: [好奇] | 关联: daily/2026-08-13.md#问答

## 2026-08-13 做个番茄钟
- summary: 番茄钟网页，可自己调时间 | type: game | status: done
- 关联: daily/2026-08-13.md#任务
```

### tags/taxonomy.md（受控词表）
列出全部允许标签 + 释义 + 归属维度。

### tags/{tag}.md（倒排索引）
```markdown
# 标签：诚实
## 关联知识点
- 论语·吾日三省吾身 (learning/lunyu/lunyu.md)
## 关联生活事件
- 2026-08-13 撒谎事件 (daily/2026-08-13.md#生活)
```

---

## 十、附注：AGENTS.md 不属于本文档范围

AGENTS.md 是**行为准则**（身份 + 导航指令 + 家长 custom 段），不是数据结构。其生成模板与导航指令在 `electron/lib/pi-session.ts`（`LEARNING_NAV_INSTRUCTIONS` / `buildAgentsMd` / `writeAgentsMd` 保留 custom 段）维护，不在本文档描述。涉及 AGENTS.md 的改动请直接改生成代码，并跑 `scripts/regenerate-agents.mjs` 刷新所有孩子。

---

## 十一、关键数据流

1. **学习会话**：AGENTS.md 指引 → 定位 next 课程 → method 教学 → tags 反查生活事件 → 讲完更新 `learning/{topic}.md` 状态 + 写 `daily#学习`。
2. **生活事件（recording skill）**：提取事件 → 打受限标签 → 写 `daily#生活` + 追加 `life` 索引行 + 同步更新 `tags/{tag}.md` 倒排。
3. **定时任务**：recording / study-tracker 按调度运行，产出 daily/meta 并维护索引。

**具体示例（让设计落地可感）**：
- `learning/lunyu/lunyu.md` 课程「吾日三省吾身」tags: `[反思, 自律, 诚实]`
- `tags/诚实.md` 里写：`关联知识点: 论语·吾日三省吾身`；`关联生活事件: 2026-08-13 撒谎事件 → daily/2026-08-13.md#生活`
- 孩子某天说"今天对妈妈撒谎了，怎么办" → recording 记进 life 索引，打 tag `[诚实, 亲情]`，并同步写进 `tags/诚实.md`
- 之后教「吾日三省吾身」时，agent 读 method.md → 见"用 tags 找生活事件" → 开 `tags/诚实.md` → 读 daily 区块 → 结合撒谎事件讲解

---

## 十二、实施步骤（P0–P6）

- **P0** 定义标签词表 → 写 `tags/taxonomy.md` ✅
- **P1** 重写 learning 结构（topics.md / {topic}.md / method.md / materials/）✅
- **P2** ~~改造 buildAgentsMd 模板~~（AGENTS.md 属行为规范，已移出本文档；导航/打标签规则改动走 `pi-session.ts`）
- **P3** 改造 recording skill：写 daily（详式）+ 三索引（life / inquiries / tasks）+ tags 倒排 + 受限标签（**inquiries/tasks 索引待补**）
- **P4** study-tracker 确认保留为定时 skill ✅
- **P5** 迁移脚本：清 `life-events.md` / `study-topics.md` / `study-rules.md` / `daily-logs` 残留；任务产物移入 `outputs/`；修 tags 倒排失效链接（旧 `learning/lunyu.md` → `learning/lunyu/lunyu.md`）；统一 life 旧散文数据为索引行格式
- **P6** Path Guard 复核 + 端到端测试

---

## 十三、待确认事项

- ~~study-tracker 是否也保留为 skill~~ → **已确认保留为定时 skill**
- ~~标签词表初版具体范围~~ → 初版 20 个标签（品格 / 关系 / 情绪 / 学习 四维），见 P0 实施
- ~~daily 行式 vs 详式~~ → **详式**：`### 标题` + 字段，孩子表现/概要必填详写（2026-08-20 确认）
- ~~是否建 daily/index.md 总索引~~ → **不建**：daily 文件名即日期构成时间线索引；分类索引（life/inquiries/tasks + tags 倒排）负责按维度反查（2026-08-20 确认）
- ~~知识点 tags 由谁维护~~ → **创建知识点（新增进度条目）时**一次性选定写入 tags 字段，不归 recording（2026-08-20 确认）
- ~~outputs/ 是否启用~~ → **启用**：任务产物统一放 outputs/，不散落孩子根目录（2026-08-20 确认）
- ~~AGENTS.md 模板是否属本文档~~ → **移出**：AGENTS.md 是行为准则，模板维护在 `pi-session.ts`（2026-08-20 确认）
- 是否要加"打开数据文件夹 / 在 Obsidian 打开"的辅助入口（可选，未定）
