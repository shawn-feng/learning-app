# 考核内容结构化（题库 / 主题类别 / 课-类-题）设计定案 v2 — 2026-09-09

> 状态：**设计已与用户定案（v2 三表归一），待实施**（ISSUE-067）。本文是实施唯一依据；改动前先读本文与
> `electron/lib/assess-guide.ts`（ISSUE-066 产物，写作规范，后续需与本设计对齐改写）。
> **v2 变化（20:00）**：废弃 v1「每课一块表 course_assess_blocks + type_catalog JSON」方案，改为用户拍板的
> **三表归一**：题库独立成表 + 主题考核类别表 + 课程考题关系表；课程加 uuid。

## 0. 背景与目标

- 现状：每课考核内容为**一整段 markdown 自由文本**（家长库 `courses.assess_rubric`，论语 489 课
  avg 5,153 字 / max 8,685），且将随「收集例题」持续增长；出题/判分整文喂 LLM → 慢、费 token。
- 目标（用户拍板）：
  1. 考核方法决定「考哪些类别」→ 出题只取相关题，不读整份内容；
  2. 评分标准**随题独立** → 判分只带抽中那题的题干+评分+答案；
  3. 例题/题量增长不影响单场读取量；
  4. 背诵原文结构化（answer=原文 refText），不再正则抓引号；
  5. **无选择题，全主观口述题**；同课同类别多题 = 例题池，默认随机抽 1。

## 1. 设计决策一览（含 v2 新增）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 类别粒度 | 主题级定义考核类别表；课程通过关系表**选 UUID 挂类别**（不再靠文本匹配 → 无需别名归组，天然避免「字词读音/字词理解」漏匹配） |
| D2 | 存储 | **DB 为真源**，三表归一（题库 / 主题类别 / 课类题关系）；旧 `assess_rubric` 仅兼容/预览 |
| D3 | 方法 | 主题级·每孩子 `topics.method_spec`（key=childId；require/exclude/rules.recitePass）；`default` 回退 |
| D4 | 课程标识 | **courses 加 uuid 并一次性回填**（稳定 id，改名不断链） |
| D5 | 类别行为 | 类别表带 `behavior` 列：speech_recite / speech_read / generic |
| D6 | 同类别多题 | 关系表 `seq` 记课内顺序；出题同 (课,类别) 多题**默认随机抽 1**；背诵类置首题 |
| D7 | 概述 | **关系表加 `overview` 列**（该课该类别的一句话说明，如"该章侧重典故"） |
| D8 | 缺题 | 方法选中但课程该类别无题 → **跳过该类型**（不做 LLM 临时命题） |
| D9 | 判分 | 逐题小 prompt = 总则 + 该题{题干, ASR回答, scoring, answer}，可并行；speech 走发音评测 |

## 2. 数据模型 v2（家长库 `parent.sqlite`，全孩子共享内容、仅方法按孩子）

### 2.0 `courses` 加 uuid（关系表引用）

```sql
ALTER TABLE courses ADD COLUMN uuid TEXT;                 -- 一次性回填：UPDATE … SET uuid=lower(hex(randomblob(16))) WHERE uuid IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_uuid ON courses(uuid);
```

（`courses` 仍按 (topic,title) 唯一；uuid 是稳定业务 id，供 ③关系/考试归档/未来引用。）

### 2.1 题库表 `question_bank`（题目独立，可跨课复用）

```sql
CREATE TABLE IF NOT EXISTS question_bank (
  id         TEXT PRIMARY KEY,      -- 题目 UUID
  stem       TEXT NOT NULL,         -- 题目（题干）
  answer     TEXT NOT NULL,         -- 答案：口述题=参考答案要点；背诵/朗读题=标准原文 refText（评测逐字对照）
  scoring    TEXT,                  -- 评分标准 JSON {dims:[{dim,points,score,note}], special:[]}；speech 类可为空/忽略
  point_max  INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- 题目本身**无类型、无主题、无课程**——语义由「挂到哪个 (课,类别)」决定；同题可被多课引用（默认允许，防重复维护）。
- 背诵/朗读题的引擎行为由所挂**类别**的 `behavior` 决定，题库行不存类型（背诵题行：stem="背诵本章原文"、answer=原文、scoring 空）。

### 2.2 主题考核类别表 `topic_categories`

```sql
CREATE TABLE IF NOT EXISTS topic_categories (
  id        TEXT PRIMARY KEY,       -- 类别 UUID
  topic_id  TEXT NOT NULL,          -- 主题 topic_key
  name      TEXT NOT NULL,          -- 考核类别名：背诵 / 朗读 / 句意白话 / 道理 / 字词 / 典故…
  behavior  TEXT NOT NULL DEFAULT 'generic',   -- speech_recite | speech_read | generic
  UNIQUE (topic_id, name)
);
```

- 主题先建好类别集（如论语：背诵/句意白话/道理/字词/典故），课程从这里**选**，不自由造名。
- `behavior`：speech_recite（发音评测：answer=refText、不显原文、置首题、≥recitePass 通过）| speech_read（显示原文跟读，可扩展）| generic（口述主观题，判分走 LLM 小 prompt）。

### 2.3 课程考题关系表 `course_category_questions`

```sql
CREATE TABLE IF NOT EXISTS course_category_questions (
  course_id    TEXT NOT NULL,       -- courses.uuid
  category_id  TEXT NOT NULL,       -- topic_categories.id（须与 course 同主题）
  question_id  TEXT NOT NULL,       -- question_bank.id
  seq          INTEGER NOT NULL DEFAULT 0,   -- 课内同类别题的顺序（出题随机抽 1，seq 作稳定序/回溯）
  overview     TEXT,                -- 该课该类别的一句话说明（D7；同 (course,category) 各行冗余一致，写入层维护）
  PRIMARY KEY (course_id, category_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_ccq_course   ON course_category_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_ccq_category ON course_category_questions(category_id);
```

- **一课多类 / 一类多题 / 各课类别不同**：均由本表表达（某课出现类别 C ⇔ 挂了 ≥1 道 C 的题）。
- 一致性校验（写入工具负责）：类别归属与课程主题一致；speech_recite 类别只挂 answer=原文 的题；不重复挂同一题。

### 2.4 考核方法 —— `topics` 加 `method_spec`（JSON；v1 的 type_catalog 列废弃不再建）

```jsonc
{
  "perChild": {
    "<childId>": {
      "require": { "<category_uuid_背诵>": 1, "<category_uuid_句意白话>": 1, "<category_uuid_道理>": 1 },
      "exclude": ["<category_uuid_字词>", "<category_uuid_典故>"],
      "rules": { "recitePass": 90 }
    }
  },
  "default": { "require": {}, "exclude": [], "rules": { "recitePass": 90 } }
}
```

- key 全部用 UUID（childId / category uuid），不用显示名（改名不断链）。
- `default` 回退：require 为空 → 取该课关系表里**实际挂的类别各 1 题**，防止新孩子整场空。
- 旧 `topics.assess_method` 散文保留给人看/迁移对照；`type_catalog` 方案作废（别名归组需求已消失）。

**排期级方法覆盖（2026-09-10 追加）** —— 自定义考核可对**这一次**单独指定考核方法（如"这次只考背诵"），
覆盖主题默认方法，不影响其它考核。存放：排期 `exam_schedules.scope.methodSpec`：

```jsonc
{ "courses": ["论语学而篇第一章", "…"], "note": "只考核背诵",
  "methodSpec": { "require": { "背诵": 1 }, "exclude": ["字词"], "recitePass": 90 } }
```

- 类别可写**类别名**（如 "背诵"）或 uuid——服务端按该课所属主题的类别表解析（名称对 agent/家长更友好；uuid 改名不断链）。
- 优先级：`scope.methodSpec` > 主题 `method_spec.perChild[childId]` > `default`；`require` 全部解析失败 → 视为未覆盖（回退主题方法，避免整场无题）。
- 入口：家长 agent `exam_schedule_create` 的 `categories` / `excludeCategories` / `recitePass` 参数（家长端不自填规则，见 ISSUE-065）。
- 背诵通过线 `recitePass` 随题目下发到客户端，判分按它判「是否通过」（默认 90）。

## 3. 读取（出题/判分）链路

1. config：取该课关系行（join 类别/题库）+ 主题 method_spec；
2. 按孩子：`exclude` 过滤 → 依 `require` 逐类别找题池（同课同类别多题=池）；
3. 每类别随机抽 1；**该类别无题 → 跳过**（D8）；
4. 题序：speech_recite 置该课最前（背诵真实检测），其余按 require 顺序；
5. 组装：`{qid, course, category, behavior, stem, pointMax, answer/refText?, scoring?}` 下发；
6. 判分：generic → 逐题小 prompt（题干+ASR+scoring+answer）；speech → 发音评测（refText=answer），≥recitePass 通过。

## 4. 存量与兼容红线

- `courses.assess_rubric` 保留不动；**无关系行/无 method_spec 的课与主题 → 走旧整文路径**（行为不回退）。
- 存量迁移（489 课，未决后置）：解析 rubric → 建 category/question/relation + 选择题转主观（去选项、按标准答案转评分要点）+ 类型标注；标注方式（自动+抽检 / 部分 / 全人工）待定。
- courses.uuid 回填为迁移前置步骤。

## 5. 验收标准

- 珊珊：背诵 + 句意白话 + 道理 各 1（无字词/典故）；闻闻：背诵 + 句意白话。
- 已结构化课程出题 **0 次 LLM 调用**；判分每题 prompt < 1KB 级。
- 例题池加题不影响单场读取；背诵 refText=answer（无正则）；未结构化课程行为与今天一致。

## 6. 未决清单（实施时逐项确认）

1. 抽题：同 (课,类别) 多题随机抽 1（已定）是否需要「必考/轮换组」升级（v1 遗留，暂不做）。
2. 关系表 `overview` 与多题冗余：同 (course,category) 多行冗余一致由写入层保证；若后续编辑按"对"操作再考虑收敛。
3. 判分评语：LLM 生成 vs 维度模板（决定 generic 题判分是否仍需 LLM）。
4. method_spec / topic_categories / question_bank / relation 的可写工具与一致性校验。
5. `assess-guide.ts`（066）与本设计对齐（写作入口 = 题库题 + 挂课，不再是 rubric 三段 markdown）。
6. 家长端考核内容编辑器（类别管理、题+评分表单、挂课、例题追加）；存量 courses.uuid 回填脚本。

## 7. 关联与版本记录

- ISSUE-067（本设计，待实施）；ISSUE-065/066（已实施，066 写作规范待对齐）。
- 数据真源：家长库 `server/data/parents/<parent>/parent.sqlite`（courses/topics + 三张新表）。
- v1（同日早前，已作废）：course_assess_blocks 块表 + type_catalog JSON + rubric 三部分解析——仅存历史参考，勿按 v1 实施。

## 8. 流程改造分析（步骤 1 输出，2026-09-09 21:00）

改造原则：结构化课程**纯代码出题（0 LLM）**；判分按题小 prompt；旧课双路径兼容。锚点代码随现状注释。

### 8.1 现状链路（改造前）

```
ExamView: examConfig → cfg.courses[] 带 assessRubric(整文) → examGenerateCourse 逐课 LLM 出题(流式≤3)
         → 答题(文字 ASR / speech 录音) → 提交: examScore(scoringPrompt,answers) 主进程 scoreExamAttempt
           (prompt 按课 rubric 一次 + 各题) + speech 走 examAssessSpeech(发音评测)
         → examSubmit 落 attempt/per_question → examScheduleComplete
```

### 8.2 改造后（结构化课程分支；未结构化课程走 8.1 旧路径不变）

| 环节 | 改造 |
|---|---|
| 范围+方法 | 不变：排期定课程（ISSUE-065）；服务端读 method_spec(按 childId) 得每孩子 require/exclude |
| 取题（答①） | 服务端 exam config 内：course_category_questions ⋈ question_bank ⋈ topic_categories → exclude 过滤 → require 逐类别池内**随机抽 1**（缺题跳过）→ speech_recite 置该课最前 → 下发 `{qid,questionId,course,category,questionType,stem,pointMax,refText?(答题端不显示)}`。**不触发 examGenerateCourse** |
| 评分标准（答②） | 判分所需 `scoring+answer` 随 questions 下发至主进程（沿用 rubric 现状边界，答题 UI 不展示答案/原文）；speech 类取 answer=refText |
| 判分 prompt（答③） | `scoreExamAttempt` 改**逐题迷你 prompt** = 总则 + `{题干 stem, 孩子ASR回答, 本题评分标准 scoring, 参考答案 answer}`（可并发）；SCORING_PROMPT 不再含整课 rubric；speech 走发音评测(refText + rules.recitePass) |
| 结果记录（答④） | `examSubmit` per_question 每项补 `questionId`/`category`（供轮换排除与按类统计）；courseMastery 维持客户端按课程聚合 |

### 8.3 模块改动清单

| 模块 | 改动 |
|---|---|
| `server/src/routes/exam.ts` config | courses 改为携带结构化 questions（读三表抽题）或维持 rubric（无关系行的课/未配置主题回退） |
| 新 `server/src/db/assess-content.ts` | ✅ 已落地：schema ensure + 类别/题库/关系/方法 访问层（见 §9） |
| `electron/lib/exam-engine.ts` | 结构化课不走 generate/recitationFor；旧路径保留给 legacy |
| `src/components/ExamView.tsx` | cfg 带 questions 直接开考（无流式等待）；legacy 保留流式分支 |
| IPC/preload 类型 | CourseConfig 增 `questions?/structured?` 字段透传 |
| 判分 | engine.scoreExamAttempt 按题取 scoring+answer 构造 prompt |
| 落库 | per_question 加 questionId/category |

## 9. 实施状态（步骤 3 进行中，2026-09-09 21:00）

已完成：
- `server/src/db/assess-content.ts`（新）：幂等 schema（courses.uuid 回填/唯一索引、topics.method_spec、question_bank/topic_categories/course_category_questions + 索引）+ 访问层
  （listCategories/getOrCreateCategory/saveQuestion/getQuestion/getCourseUuid/replaceCourseContent/listCourseContent/getMethodSpec/saveMethodSpec）。
- `server/src/db/parent-lib.ts`：openParentLib 每次调用自动 ensureAssessContentSchema。
- 全量家长库已 ensure（186 个，uuid 缺失 0）。
- 学而篇第一章已造样例块（5 类别各 1 题 + method_spec 珊珊），读取链路验证通过：
  背诵(speech 置首)+句意白话+道理，字词/典故被 exclude。
- `server/src/assess-selection.ts`（新）：attachStructuredQuestions——按孩子 method_spec(exclude/require/default) 抽题组题；
  speech 类置首、answer=refText；非结构化课不动（走旧 rubric 路径）。
- `server/src/routes/exam.ts`：config 三个返回点统一经 structuredCourses 包裹（带挂载课的 course.questions）。
- `electron/lib/exam-engine.ts` + `src/components/ExamView.tsx`：判分支持逐题 scoringText（不贴整课 rubric）；
  流式 worker 优先用预生成题；宿主按送达顺序维护元数据，提交回填 scoringText。实测输出：
  rq1 背诵(refText=原文) → q1 句意白话 → q2 道理（各带参考答案+评分维度）。
- **存量迁移（步骤 4，2026-09-09 23:05）**：`server/src/assess-migrate.ts`（解析器：原文背诵→背诵题、必考题+可选题1 题目转主观、选择题答案/评分表/特殊情况尽力解析、关键词归类）
  + `server/migrate-assess-rubrics.ts`（preview/run）。lunyu 486/488 迁移完成（3558 题、关系行 3563），
  2 篇（颜渊篇第十章/宪问篇第十二章）无解析题目保留旧路径。抽查完善（短词归类个别残留、部分 MC 答案空）为后续项。
待办：结构化场次端到端本地考核验证（点考核→直出题→答题→判分/评测→落库）；存量迁移抽查完善。

> **步骤 2 前置结论（21:50 核实）**：客户端 `data/parents/<parent>/parent.sqlite` 是 0 字节占位，
> **权威家长库只有服务端 `server/data/parents/<parent>/parent.sqlite`**（exam config 即读它）。
> 因此家长 agent 新工具必须走 `serverFetch → /api/v1/assess/*` REST（与 /exam/*、/materials/* 同款，
> authParent 解析 parentId），**不能**在 electron 侧直开 SQLite。先加服务端端点，再加 client 工具。

> **步骤 2 进度（22:30）**：
> - 服务端 `routes/exam.ts` 内新增 `/api/v1/assess/*`：topics/:topic/categories(GET)、categories(POST 幂等)、
>   questions(POST)、courses/save(POST 整课事务替换，类别可 id/名、题目可复用/内联新建)、courses/:topic/:title(GET)、
>   method-spec(GET/POST 合并某孩子条目，require/exclude 支持类别名或 uuid)。
> - electron 新 `assess-admin.ts`（serverFetch 封装）+ `assess-tools.ts`（5 个工具：类别列表/类别创建/
>   课程内容查看/课程内容保存(payloadJson)/孩子考核方法设置），已注册进家长会话两处工具列表。
> - 仍待：写作规范 assess-guide 对齐新入口、家长端结构化编辑器(UI)、本地会话实测工具。
