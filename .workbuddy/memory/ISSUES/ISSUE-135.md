# ISSUE-135：学习/考核掌握闭环 —— 结果记录 → 知识点掌握情况 → 课程进度与教学建议

- **类型**：需求 / 架构（计划域 + 考核域重构 + 新增掌握闭环）
- **优先级**：中-高（家长最核心诉求：学完/考完能看见"到底掌握了什么"，并据此安排下一次）
- **记录时间**：2026-09-22（设计定稿 2026-09-23；08:20 按用户"废弃 attempts"决定改写为 v2 方案）
- **状态**：🚧 **P0-a 已实施（2026-09-23）**：考核结果重构完成（孩子库三层 + 评测存档 + 主库 `exam_attempts` 退场 + 读取侧全切 + worker 收窄 + P0 结构 + P1 防硬删）；P0-b/P2/P3/P4/P5 未开工。**未部署**（需用户明确同意）

---

## 0. 需求（用户原始表述，三环闭环）

1. **内容域**：学习主题 / 课程划分 / 教学方法 / 教学文案 / 学习资料 / 知识点 / 考核题库。
2. **计划域**：制定计划 → 执行 → **记录结果**。学习与考核计划同构，都要有"课程层面概要 + 分知识点明细"，**只到知识点、不分题目**；结果**只记在当前计划里**。
3. **分析域**：定时任务汇总每次学习/考核结果，产出**课程进度表**（课程级 + 知识点级掌握情况），反哺下一次计划与教学方案。

**第 1 环经源码核对已完全支持**（家长库 `topics`/`courses`/`knowledge_points`/`question_bank` + 挂载表，家长 agent 已可管理），本 issue 只覆盖第 2、3 环。

## 1. 用户决策（2026-09-22~23 五轮答复，本文前提）

| # | 决策 |
|---|---|
| **D1** | **新建独立的知识点掌握情况表**，用家长库 `knowledge_points.id` 把知识点与"本次学习/考核计划"挂钩；学习与考核**共用同一张表**，用字段区分来源。 |
| **D2** | 计划一旦完成**不再删除**（现状有硬删路径，见 §6）。 |
| **D3** | 掌握度口径 = **累计**，用**自然语言描述**演进（最开始 → 中间 → 最新）。 |
| **D4** | **不改教学方案**（家长手写的 `topics.method` / `courses.lesson_method` 保持真源不动）；分析产生的教学建议**单独存一处**，下次教学时读出来发给 LLM。 |
| **D5** | 范围：**只做课程级 + 知识点级**，不做主题级汇总。 |
| **D6** | **课程进度落孩子库 `courses` 表**（它本来就是孩子学习进度表），不另建课程进度表。 |
| **D7** | **考核结果分课程记录**：一个考核计划是一次考核、含多门课程。 |
| **D8** | **知识点维度不放在考核结果里**，唯一落 `knowledge_point_records`；靠 **`plan_id` + `course_uuid`** 两把键与计划结果关联。 |
| **D9** | 分析任务时间点**家长可配置**（走既有「定时任务」体系），且**默认自动建一条**（@21:30、启用）。 |
| **D10** | 删列/改结构方式：**直接改**（带备份 + 行数/Σ 校验）。 |
| **D11** | ⭐ **废弃 `exam_attempts`**（不搬、不保留）：既然 `exam_plan_courses` 已承担明细，就不再需要场次表；**另建新表记录「课程每次考核的结果概要」**。（2026-09-23 08:17 定案，取代此前"搬到孩子库"方案） |
| **D12** | `score` 语义与描述同步：按推荐执行 —— 得分率用**显式 `rate` 列**表达（不靠含义模糊的 `score`）；`kb.ts:109` 过时注释 + `db-channel` 表描述/列注释一并改。 |
| **D13** | **`speech_assessments`（题级口语评测存档）搬到孩子库，并与 `exam_plan_courses` 建立关联**：补 `plan_id` + `course_uuid` + **`question_id`**（旧表缺题目键），按 `(plan_id, course_uuid, question_id)` 关联明细行；旧 `exam_attempt_id` 改为 `attempt_ref` 仅作迁移溯源。（2026-09-23 08:27 定案） |

## 2. 现状判定（源码核对）

| 环节 | 现状 |
|---|---|
| 第 1 环 内容域 | ✅ 已达标，本 issue 不动 |
| 第 2 环 考核侧 | ⚠️ `exam_plan_courses` 有逐题明细；`exam_attempts`（主库）是逐题原始 + 掌握度/巩固建议的宿主，**归属错位且与逐题明细重复**（见 §8） |
| 第 2 环 学习侧 | ❌ 只有 `study_plans.result` 一句 `"学习完成"`（`plan-domain.applySignals` 写死）；**无课程概要、无知识点级记录** |
| 第 3 环 分析 | ❌ 孩子库 `courses` 无掌握字段（9/10 重构删了 `mastery/exam_mastery/first_learned`）；仅 `course_progress` **视图**；无知识点级、无教学建议、**无任何定时汇总任务**（`registerTask` 只有 recording / autoNewSession） |

## 3. 数据结构

除特别标注外，全部在**孩子库** `kb/<parentId>/<childId>.sqlite`。知识点 id 是家长库 `knowledge_points.id` 的**跨文件逻辑引用**（无 FK）+ `knowledge_point_name` 快照防悬挂 —— 与既有 `mistake_book` 同模式。

### 3.1 新增 `knowledge_point_records`（知识点掌握情况流水，第 2 环产出）

一行 = 某知识点在某次学习/考核计划中的一次情况；学习与考核同表，`source` 分类。

```sql
CREATE TABLE IF NOT EXISTS knowledge_point_records (
  id                   TEXT PRIMARY KEY,
  parent_id            TEXT NOT NULL DEFAULT '',
  child_id             TEXT NOT NULL DEFAULT '',
  source               TEXT NOT NULL CHECK (source IN ('study','exam')),
  plan_id              TEXT NOT NULL DEFAULT '',          -- study_plans.id / exam_plans.id
  knowledge_point_id   TEXT NOT NULL,                     -- 家长库 knowledge_points.id
  knowledge_point_name TEXT NOT NULL DEFAULT '',          -- 快照防悬挂
  topic_key            TEXT NOT NULL DEFAULT '',
  course_uuid          TEXT NOT NULL DEFAULT '',
  course_name          TEXT NOT NULL DEFAULT '',
  record_at            TEXT NOT NULL DEFAULT '',
  outcome              TEXT NOT NULL DEFAULT '',          -- solid | partial | weak
  point_got            REAL,                              -- 考核：该知识点本次得分（学习 NULL）
  point_max            REAL,
  rate                 REAL,
  summary              TEXT NOT NULL DEFAULT '',          -- LLM 本次情况描述
  detail_json          TEXT NOT NULL DEFAULT '{}',        -- 困难点/亮点/题目 id 列表
  source_ref           TEXT NOT NULL DEFAULT '',          -- 迁移溯源：旧 exam_attempts.id / daily 日期
  created_at           TEXT NOT NULL,
  UNIQUE (source, plan_id, course_uuid, knowledge_point_id)   -- 幂等
);
CREATE INDEX IF NOT EXISTS idx_kpr_kp     ON knowledge_point_records(knowledge_point_id, record_at);
CREATE INDEX IF NOT EXISTS idx_kpr_link   ON knowledge_point_records(plan_id, course_uuid);
CREATE INDEX IF NOT EXISTS idx_kpr_plan   ON knowledge_point_records(source, plan_id);
CREATE INDEX IF NOT EXISTS idx_kpr_course ON knowledge_point_records(course_uuid, record_at);
CREATE INDEX IF NOT EXISTS idx_kpr_child  ON knowledge_point_records(child_id, record_at);
```

**关联契约（D8）**：`source='study'`+`plan_id` → `study_plans.id`；`source='exam'`+`plan_id` → `exam_plans.id`；`course_uuid` → 该计划涉及的课程；`knowledge_point_id` → 家长库知识点。题目 id 不落行键，放 `detail_json.question_ids` 供追溯。
「查一个知识点的所有学习结果」= `WHERE knowledge_point_id = ? ORDER BY record_at`（跨学习与考核）。

### 3.2 新增 `knowledge_point_progress`（知识点累计掌握，第 3 环产出）

```sql
CREATE TABLE IF NOT EXISTS knowledge_point_progress (
  parent_id            TEXT NOT NULL DEFAULT '',
  child_id             TEXT NOT NULL,
  knowledge_point_id   TEXT NOT NULL,
  knowledge_point_name TEXT NOT NULL DEFAULT '',
  course_uuid          TEXT NOT NULL DEFAULT '',
  course_name          TEXT NOT NULL DEFAULT '',
  level                TEXT NOT NULL DEFAULT 'learning',  -- not_started|learning|needs_review|mastered
  mastery_desc         TEXT NOT NULL DEFAULT '',          -- D3 累计自然语言（最开始→中间→最新）
  study_count          INTEGER NOT NULL DEFAULT 0,
  exam_count           INTEGER NOT NULL DEFAULT 0,
  last_outcome         TEXT NOT NULL DEFAULT '',
  last_rate            REAL,
  first_at             TEXT NOT NULL DEFAULT '',
  last_at              TEXT NOT NULL DEFAULT '',
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (child_id, knowledge_point_id)
);
```

### 3.3 课程进度 → 孩子库 `courses` 加 4 列（D6，不新建表）

```sql
ALTER TABLE courses ADD COLUMN mastery_level      TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN mastery_desc       TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN teaching_advice    TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN mastery_updated_at TEXT NOT NULL DEFAULT '';
```

| 列 | 记什么 | 示例 |
|---|---|---|
| `mastery_level` | 机器用档位（枚举）：未学 / 学习中 / 待巩固 / 已掌握。用于排序筛选、驱动计划（`needs_review` → 下次排 `mode='review'`）、界面配色 | `needs_review` |
| `mastery_desc` | 给人看也给 LLM 读的**累计掌握叙述**（最开始→中间→最新） | 「最开始（09-10）只能背原文；中间（09-15）能说清字面意思，但把『德』和『政』讲混了；最新（09-21）能自己解释并举例，只是『譬如北辰』还需提示。」 |
| `teaching_advice` | **下次教学建议**（D4 落点），可操作、可直接进 systemPrompt；只增补、不改教学方案 | 「下次先让孩子复述『为政以德』的字面意思，再举身边的例子说明『德』与『政』的关系；『譬如北辰』需先给画面提示。」 |
| `mastery_updated_at` | 这三列的刷新时间戳；用于判断过期、界面显示、避免重复跑分析 | `2026-09-22T21:31:07.482Z` |

⚠️ **不要复用旧列名**：`mastery` / `exam_mastery` / `first_learned` 是 9/10 重构主动删除的旧口径列，`db/kb.ts:dropLegacyCourseColumns()` **至今仍在每次开库时幂等删它们** —— 必须把新列名**排除出删除名单**，否则下次启动被误删。
比率与时间**不重复存**：`lastExamRate`/`lastExamAt`/`lastLearnedAt` 继续由 `course_progress` 视图实时算（视图保留，不 DROP；数据源改读 §3.5 新表）。

### 3.4 学习侧计划表加列（D7）

```sql
ALTER TABLE study_plans ADD COLUMN result_summary TEXT NOT NULL DEFAULT '';
```
**`exam_plans` 不加**（一次考核跨多课，课程级概要按 §3.5 记）。

### 3.5 新增 `exam_course_results` —— **课程每次考核的结果概要**（D7/D11）

一行 = **考核计划 × 课程**（一次考核每门课一条）。这是 `course_summary` 的唯一落点（**不再往逐题明细上冗余写**），也是第 3 环分析任务的直接读入。

```sql
CREATE TABLE IF NOT EXISTS exam_course_results (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT NOT NULL DEFAULT '',
  child_id       TEXT NOT NULL,
  plan_id        TEXT NOT NULL,                 -- exam_plans.id（一次考核）
  attempt_ref    TEXT NOT NULL DEFAULT '',      -- 迁移溯源：旧 exam_attempts.id（新数据为空）
  topic_key      TEXT NOT NULL DEFAULT '',
  course_uuid    TEXT NOT NULL,
  course_name    TEXT NOT NULL DEFAULT '',
  exam_at        TEXT NOT NULL DEFAULT '',      -- 本次考核时间
  point_got      REAL NOT NULL DEFAULT 0,       -- 该课本次 Σ得分
  point_max      REAL NOT NULL DEFAULT 0,       -- 该课本次 Σ满分
  rate           REAL,                          -- 该课本次得分率 0~1（D12：显式 rate，不用 score）
  question_count INTEGER NOT NULL DEFAULT 0,    -- 本次该课考了几道题
  course_summary TEXT NOT NULL DEFAULT '',      -- 课程结果概要（LLM 生成，可重算）
  plan_review_at TEXT NOT NULL DEFAULT '',      -- 承接旧 reinforce_plan.planReviewAt（复习到期）
  focus_json     TEXT NOT NULL DEFAULT '[]',    -- 承接旧 reinforce_plan.focus[]（复习重点）
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (plan_id, course_uuid)
);
CREATE INDEX IF NOT EXISTS idx_ecr_child  ON exam_course_results(child_id, exam_at);
CREATE INDEX IF NOT EXISTS idx_ecr_course ON exam_course_results(course_uuid, exam_at);
```

### 3.6 `exam_plan_courses` —— **考核明细表**（保持逐题，不收敛；补题级富字段）

它是"这次考核这门课考了哪些题、每题得几分、孩子答了什么、老师怎么评"的明细，**结构保持一行一题**（`plan_id / course_uuid / course_name / knowledge_point_id / question_id / point_got / point_max / seq`），并**补上承接 `exam_attempts.per_question` 的题级富字段**（否则三处界面的"逐题报告 + 听原音"会失数据，见 §8.3）：

```sql
ALTER TABLE exam_plan_courses ADD COLUMN ai_comment    TEXT NOT NULL DEFAULT '';   -- AI 评语
ALTER TABLE exam_plan_courses ADD COLUMN asr_text      TEXT NOT NULL DEFAULT '';   -- 孩子回答的 ASR 转写
ALTER TABLE exam_plan_courses ADD COLUMN audio_file_id TEXT NOT NULL DEFAULT '';   -- 录音（听原音）
ALTER TABLE exam_plan_courses ADD COLUMN duration_ms   INTEGER NOT NULL DEFAULT 0; -- 用时
ALTER TABLE exam_plan_courses ADD COLUMN correct       INTEGER;                    -- 1/0/NULL
ALTER TABLE exam_plan_courses ADD COLUMN behavior       TEXT NOT NULL DEFAULT '';  -- 题级行为（speech_recite / speech_read / generic）
ALTER TABLE exam_plan_courses DROP COLUMN score;   -- 与该题 point_got 重复、全仓只写不读（D12）
```

**分层与分工（本 issue 的目标模型）**

| 层 | 表 | 说明 |
|---|---|---|
| 考核计划（进「今日计划」） | `exam_plans`（孩子库） | 一次考核的头 |
| **考核明细（逐题）** | `exam_plan_courses` | 课程 / 知识点 / 题目 / 得分 / 评语 / 录音 |
| **口语评测存档（题级）** | `speech_assessments`（孩子库，D13） | 维度分 + 录音引用；按 `(plan_id, course_uuid, question_id)` 关联明细 |
| **课程每次考核结果概要** | **`exam_course_results`（新增）** | 一行 = 计划 × 课程：得分率 + 概要 + 复习重点 |
| 知识点情况（学习+考核） | `knowledge_point_records`（新增） | 按 `plan_id` + `course_uuid` 关联上面两层 |
| ~~考核场次~~ | ~~`exam_attempts`~~ | **废弃**（§8） |

### 3.7 搬入 `speech_assessments`（题级口语评测存档，与明细关联，D13）

**现状查证**：一行 = 提交时 `perQuestion` 里**带 `speech` 结果的那道口语题**（`routes/exam.ts:1375` 循环写入，`is_exam=1`）；唯一写入口 = 考核提交。字段有 `topic_key / course_name / question_type / ref_text / audio_file_id / overall / pron / dimensions_json / detail_json`，**但没有 `question_id`/`qid`** —— 所以它是"题级但没键"，只能靠 `course_name + question_type + audio_file_id` 反推。另查实：**全仓无任何读取方**（只有 INSERT + 一处失败告警）⇒ 纯存档，搬迁风险为零。

搬入孩子库（同名同构 + 补关联列）：

```sql
CREATE TABLE IF NOT EXISTS speech_assessments (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT NOT NULL DEFAULT '',
  child_id        TEXT NOT NULL,
  -- 与考核明细的关联（D13）
  plan_id         TEXT NOT NULL DEFAULT '',   -- exam_plans.id
  course_uuid     TEXT NOT NULL DEFAULT '',
  question_id     TEXT NOT NULL DEFAULT '',   -- ★ 新增：关联 exam_plan_courses.question_id
  attempt_ref     TEXT NOT NULL DEFAULT '',   -- 迁移溯源：旧 exam_attempts.id
  topic_key       TEXT NOT NULL DEFAULT '',
  course_name     TEXT NOT NULL DEFAULT '',
  question_type   TEXT NOT NULL DEFAULT '',
  ref_text        TEXT NOT NULL DEFAULT '',
  audio_file_id   TEXT NOT NULL DEFAULT '',
  overall         REAL NOT NULL DEFAULT 0,
  pron            REAL NOT NULL DEFAULT 0,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  detail_json     TEXT NOT NULL DEFAULT '{}',
  is_exam         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_speech_child    ON speech_assessments(child_id, created_at);
CREATE INDEX IF NOT EXISTS idx_speech_question ON speech_assessments(plan_id, course_uuid, question_id);
```

**关联契约**：`(plan_id, course_uuid, question_id)` ↔ `exam_plan_courses(plan_id, course_uuid, question_id)`；**同一题多行 = 多次评测**（重练/重考，历史保留）；`audio_file_id` 与明细行的 `audio_file_id` 可互校。将来「听原音 + 看评测维度分」直接 join 明细即可。
> 备选（更极简，供比较）：考核内一道题只有一次评测 ⇒ 可把评测结果并成明细行的 `speech_json` 一列、整张表废弃。但若要保留"同一题反复练"的多次评测历史，独立表更合适 —— 按 D13 采用独立表。

### 3.8 既有表定位

| 表 | 角色 |
|---|---|
| `exam_plan_courses` | **考核明细表**（逐题，含评语/录音引用） |
| `exam_course_results` | **课程每次考核结果概要**（新增） |
| `mistake_book` | 已带 `knowledge_point_id` + `count` + `status`，**直接作为"薄弱证据"喂给分析 LLM**（只读，不改）；旧 `exam_attempts.wrong_questions` 的职责已由它承接 |
| `daily_entries(block='学习')` | 学习发生的原始证据，学习结果抽取素材之一 |
| `course_progress`（视图） | 保留：课程级时间/比率实时口径（数据源改读 `exam_course_results`） |
| `speech_assessments` | **题级口语评测存档**（D13）：搬到孩子库 + 补 `plan_id`/`course_uuid`/`question_id`，与 `exam_plan_courses` 按 `(plan_id, course_uuid, question_id)` 关联（见 §3.7） |

## 4. 写入路径

### 4.1 学习计划完成（第 2 环）
- `applySignals()` 判定逻辑保留（daily 学习条目窗口命中）→ 置 done。
- **结果抽取放到每日分析任务**：素材 = 该计划窗口内 `daily_entries(block='学习')` 的 raw + 该课 `course:<课程名>` 子会话文本；知识点清单 = 家长库该 `course_uuid` 的 `knowledge_points`。一次 LLM 调用产出课程概要 + 逐知识点情况 → 写 `study_plans.result_summary` + `knowledge_point_records(source='study')`。
- 兜底：素材为空也要写课程概要（"按计划完成学习，未采集到过程细节"），不静默跳过。

### 4.2 考核完成（第 2 环，D7/D8/D11）

`POST /exam/attempts`（端点名保留，语义改为"提交考核结果"）改为**直接写孩子库**，不再落 `exam_attempts`：

1. **明细**：按提交的 `perQuestion` 逐题写 `exam_plan_courses`（含新增的评语/ASR/录音/用时/行为字段）。
2. **课程概要**：按 `(plan_id, course_uuid)` 聚合 Σgot/Σmax、题目数 → UPSERT `exam_course_results`（`rate = Σgot/Σmax`；`course_summary` 由 LLM 生成，可重算）。
3. **知识点记录**：按 `(plan_id, course_uuid, knowledge_point_id)` 聚合 → 每知识点一行 `knowledge_point_records(source='exam')`；`outcome` = rate ≥0.8 solid / ≥0.6 partial / 其余 weak；`summary` 优先拼该知识点下错题的 `aiComment`；知识点归属用 `perQuestion.knowledgePointId`，**缺失回退家长库 `course_knowledge_questions`**（按 course_uuid + question_id 定位）；两者都拿不到则不写 records，只在 `course_summary` 里带一句说明。
4. **计划回填**：`exam_plans` 置 `done` + `score` + `done_at`（`attempt_id` 列可保留作历史溯源，不再写入新值）。
5. worker `applyExamAttempts`：职责收窄为**幂等兜底**（离线/失败补写），不再从主库读 `per_question`。
6. **规则可算**（不依赖 LLM 即产出结构化记录），LLM 只润色描述 → P2 上线即有数据。

### 4.3 每日分析任务 `progressAnalysis`（第 3 环，D9）
```ts
type: "progressAnalysis"
points(cfg) => cfg.analysis?.enabled === false ? [] : (cfg.analysis?.times?.length ? cfg.analysis.times : ["21:30"])
catchUp: "latest"
```
**配置链路（走既有「定时任务」体系）**：`db/task-runs.ts` 的 `SchedulerTaskType` + `SCHEDULER_TASK_TYPES` 加 `progress_analysis`；`buildEffectiveChildConfig()` 按 `recording` 的多时间点模式解析 `analysis:{enabled,times[]}`；`worker/tasks.ts` 的 `WorkerSchedulerChildConfig` 加 `analysis?`；`worker/scheduler.ts:schedulerTaskTypeFor()` 加映射；**首次迁移幂等插一条 @21:30 启用任务行**（分配给孩子）；客户端「定时任务」页类型下拉加「学习情况分析」（复用现有表单）。

**运行步骤（幂等）**：
1. **找待归纳计划**：`study_plans`/`exam_plans` 中 `status='done'` 且 `knowledge_point_records` 无对应 `plan_id` 的计划 → 天然支持补跑与历史回填。
2. 逐计划抽取结果（§4.1/§4.2）。
3. 累进知识点：对涉及的每个 `knowledge_point_id` 读其全部 records → LLM 生成 `mastery_desc`（最开始/中间/最新）+ 定 `level` + 计数 → UPSERT `knowledge_point_progress`。
4. 累进课程：汇总该课所有知识点 level + 读 `mistake_book` 未掌握项 → LLM 生成课程 `mastery_desc` 与 `teaching_advice` → UPDATE 孩子库 `courses` 四列。
5. **按课程一次批量调用**（不是每知识点一次）。

**LLM 成本口径（举例）**：一天 2 个学习计划 + 1 次考核（含 2 课）→ 去重 3 门课 → **当天只调 3 次**；同一天同课既学又考只调 1 次；无学习/考核则 0 次。单次输入 ≈ 6~8k token（知识点清单 + 本次学习素材 + 本次考核素材 + 历史记录摘要 + `mistake_book` 证据 + 输出契约）、输出 ≈ 1~1.2k → 3 门课合计 ≈ 2~2.4 万 / 3~3.6k token。对照 09-21 家长助手实测（input 132 万 + 缓存读 1813 万）**不到 2%**。

**反哺闭环（D4）**：`teaching_advice` 只写 `courses.teaching_advice`（孩子库），**从不回写** `topics.method` / `courses.lesson_method` / `method_spec`。

## 5. 消费侧

| 消费口 | 改动 |
|---|---|
| 家长 agent 制定计划 | 新增读工具（如 `parent_course_mastery`）：读 `courses` 四列 + `knowledge_point_progress` → 优先把 `needs_review` 知识点所在课程排 `mode='review'` |
| 孩子上课（教学注入） | 扩展 `kb.courses.get`（`routes/db.ts:264`）响应加 `mastery_desc` / `teaching_advice` / `weak_knowledge_points[]` → 课程子会话（ISSUE-029 的 `course:<课程名>` systemPrompt 链路）拼进 systemPrompt |
| 家长界面 | 课程进度列（`mastery_desc` + 教学建议）→ 可展开知识点级（level + 累计描述 + 学习/考核次数） |
| **三处「考核记录」界面** | 数据源从 `GET /exam/attempts/:childId` 切到新口径：`exam_plans(done)` + `exam_course_results`（课程概要）+ `exam_plan_courses`（逐题明细含评语/录音）；涉及 `src/components/ExamView.tsx:145`、`CourseDetail.tsx:134`、`ChildExamPlans.tsx:72`（含听原音） |
| 口语评测明细（现状无读取方） | 搬迁后可按 `(plan_id, course_uuid, question_id)` join `exam_plan_courses` 展示维度分（准确/完整/流利/韵律），录音走明细行 `audio_file_id`（D13） |
| 旧读取侧 | `listCourseStatus` / `lastExamAtByCourse` / `latestReinforcePlan`（`routes/exam.ts:323/425/348`）改读 `exam_course_results`（单库、免跨库聚合） |

## 6. D2 落地：计划不可删（现状调查，源码核实）

**会删，且有两处硬删无状态保护** 👇

| 位置 | 操作 | 保护 | 判定 |
|---|---|---|---|
| `agent/parent-plans.ts:527` `parent_study_plan_update` act=delete | `DELETE FROM study_plans` | **无 status 检查** | ❌ 家长可硬删已完成学习计划 |
| `routes/study-plans.ts:443` `DELETE /api/v1/study-plans/:id` | `DELETE FROM study_plans` | **无 status 检查** | ❌ 同上 |
| `agent/plan-tools.ts:658` `child_study_plan_update` delete | `DELETE FROM study_plans` | ✅ done 拦截 | 已合规 |
| `agent/plan-tools.ts:713` `child_exam_plan_update` delete | `DELETE FROM exam_plans` | ✅ done 拦截 | 已合规 |
| `agent/parent-plans.ts:992` `parent_exam_plan_cancel` | `UPDATE active=0, status='cancelled'` | ✅ done 拦截 + 软删 | 已合规 |
| `parent-plans.ts:680` / `plan-tools.ts:350`（life_plans） | `DELETE FROM life_plans` | 无保护 | ⚠️ 生活域同类，可另开 |

`expireAndCarry` 只 `UPDATE status='missed'` + `INSERT` 顺延行，**不删行** ✅。

**要改**：① 两处 `done`/`missed` 行禁止硬删，统一软删（`active=0, status='cancelled'`，对齐考核侧）；② 这不只是"规矩"——`knowledge_point_records.plan_id`、`exam_course_results.plan_id` 都指向计划行，硬删会让历史记录**失联**，保护是闭环的必要条件。

## 7. 实施顺序与验收

| 阶段 | 内容 | 可独立上线 |
|---|---|---|
| **P0-a** | **考核结果重构（§8）**：建 `exam_course_results`；`exam_plan_courses` 补题级富字段 + 删冗余 `score`；**`speech_assessments` 搬孩子库 + 补 `question_id` 关联（D13）**；提交端点改写入（三层 + 评测存档）；三处界面 + 4 处服务端读取切新口径；迁移旧 `exam_attempts` 数据 → 停写 → 删表 | 是（本 issue 最大的一块） |
| **P0** | 建表 `knowledge_point_records` / `knowledge_point_progress`；`courses` 加 4 列；`study_plans.result_summary`；**`dropLegacyCourseColumns` 排除新列名** | 是 |
| **P0-b** | 回填 `knowledge_point_records`（从明细/旧 attempts 数据按 `(plan_id,course_uuid,kp_id)` 聚合）→ 校验行数与 Σgot/Σmax | 是 |
| **P1** | §6 两处硬删保护 | 是（小改） |
| **P2** | 考核侧写入规则化（`exam_course_results` + records；规则聚合不依赖 LLM） | 是（上线即有数据） |
| **P3** | 学习侧写入（会话/daily → LLM 抽取课程概要 + 知识点情况） | 是 |
| **P4** | `progressAnalysis` 任务 + 累计自然语言描述 + `teaching_advice` + 配置链路（含默认任务行、客户端下拉） | 是 |
| **P5** | 消费侧（家长 agent 读工具 / `kb.courses.get` 扩展 + 课程子会话注入 / 家长界面） | 分批 |

**验收**
- 学习计划完成 → 次日可查到该课知识点 records，`study_plans.result_summary` 非空。
- 考核完成 → `exam_course_results` 每课一行（含 `rate` 与 `course_summary`）；`exam_plan_courses` 逐题留有评语/ASR/录音引用；知识点 records 带 `course_uuid`。
- **`exam_attempts` 表已删**；三处「考核记录」界面（孩子端考核页 / 课程详情 / 家长端考核计划 tab）与"听原音"功能数据完整、逐题评语与录音可回放。
- 同一知识点跨多次学习/考核 → 按 `knowledge_point_id` 查到全部记录，按时间有序。
- 孩子库 `courses` 对应行有 `mastery_level` + `mastery_desc`（含"最开始/中间/最新"）+ `teaching_advice` + `mastery_updated_at`。
- 制定下次计划时 agent 能引用教学建议与薄弱知识点；孩子上课 systemPrompt 含本课建议。
- 已完成计划不可硬删（接口 + 工具双重保护）；「定时任务」页默认已有「学习情况分析」@21:30 且可改/停用；`task_runs` 出现 `progress_analysis`。
- 重跑分析不产生重复 records（UNIQUE 幂等）、不重复计次数。

## 8. 专项：废弃 `exam_attempts`（D11）

### 8.1 实测现状（本地 `server/data` 现场探测，2026-09-23）
- **主库 `server.sqlite` 有 `exam_attempts`，19 行**（含 `per_question` 逐题明细 + `course_mastery` / `reinforce_plan` / `wrong_questions`）。
- **100+ 个孩子库 `kb/<parentId>/<childId>.sqlite` 全部没有 `exam_attempts` 表**（含 `test-parent`）；孩子库里是 `exam_plans` + `exam_plan_courses`。

### 8.2 与 2026-09-10 定案的对账（澄清"搬了/没搬"）
09-10 计划域重构定过：①"库搬迁：`study_plan_items`/`exam_schedules`/`exam_attempts`(含 per_question) 从主库按 child_id 拆入各孩子 kb，迁后主库表停写只读保留一版"；②迁移映射写的是 "`exam_attempts`+per_question → `exam_plan_courses`"；③"`exam_attempts` 历史明细被考核计划表(场次头)+考核计划课程表(逐题明细)**接管后退场**"。

**实际只执行了一半**：逐题**得分**被 `applyExamAttempts()` 回填进孩子库 `exam_plan_courses`（这半成了）；**场次表没搬也没退场**（至今主库、仍是 `POST /exam/attempts` 的写入真源），且 `per_question` 的**富字段没搬**（ASR 转写 / 音频 / 用时 / AI 评语 + `course_mastery` / `reinforce_plan` / `wrong_questions`）。
⇒ 本 issue 用 D11 把这件事收口：**不搬，直接废掉**，把它承载的信息分别归位到 §3.6（明细）与 §3.5（课程概要）。

### 8.3 消费方清单与替代路径（必须一起切换）

| 消费方 | 现在读 | 废 attempts 后读 |
|---|---|---|
| `POST /exam/attempts` 提交 | INSERT `exam_attempts` | 写 `exam_plan_courses`（明细）+ `exam_course_results`（概要）+ `knowledge_point_records` + `exam_plans(done)` |
| 孩子端考核页 `ExamView.tsx:145` | `GET /exam/attempts/:childId`（历史成绩 + 逐题报告） | `exam_plans(done)` + `exam_course_results` + `exam_plan_courses` |
| 课程详情 `CourseDetail.tsx:134` | `examAttempts` → `perQuestion` 过滤 course | `exam_course_results` + `exam_plan_courses`（按 `course_uuid`） |
| 家长端「考核计划」tab `ChildExamPlans.tsx:72` | `examAttempts` → `perQuestion` + `audioFileId` 听原音 | 同上（明细行带 `audio_file_id`） |
| worker `applyExamAttempts`（`plan-domain.ts:353`） | 读主库 `per_question` 回填 | 降级为**幂等兜底**（不再跨库） |
| `computeExamRate`（`:512`）/ `listCourseStatus`（`routes/exam.ts:425`）/ `lastExamAtByCourse`（`:323`）/ `latestReinforcePlan`（`:348`） | 读主库 attempts | 读 `exam_course_results`（单库） |
| 家长端考核记录 REST `GET /exam/course-records/:childId`（`:1478`） | 聚合 `per_question` + `reinforce_plan` | 读 `exam_course_results` |
| ISSUE-109（家长 agent 读成绩） | 需给主库开**白名单豁免** | **整案取消**（改走孩子库读通道，归属=文件路径天然隔离） |

### 8.4 数据处置：**不迁数据，直接废弃**（2026-09-23 08:31 用户定案）

实测对照（本地 19 场 attempt ↔ 孩子库 `exam_plan_courses`）：

| 数据 | 是否在 `exam_plan_courses` 里 |
|---|---|
| 课程 / 知识点 / 题目 / 每題得分（结构数据） | ✅ **在**（每场都有对应明细行） |
| `aiComment`（AI 评语） | ❌ 不在（83 条） |
| `asrText`（孩子回答转写） | ❌ 不在（55 条） |
| `audioFileId`（录音引用，听原音） | ❌ 不在（46 条）；**音频文件本体在 `files`/磁盘，不受影响** |
| `speech`（发音评测维度分） | ❌ 不在（25 条）；另有 `speech_assessments` 存档（D13 搬走） |

⇒ **结论：用户判断对了一半** —— 结构数据确实都在，但**题级富信息（评语/ASR/录音引用）只存在于 `exam_attempts`**。经用户确认：**这批数据（20 场考核 / 83 道题，全部是 2026-09-01~09-17 的早期测试数据、同一个孩子）放弃不留，直接废弃不迁**。

> 若日后改主意：回填只需一个脚本（按 `plan_id + question_id` 把 `per_question` 的评语/ASR/录音补进明细行）—— 但本 issue 按"不迁"执行。

**执行**：`DROP TABLE exam_attempts`（连同 `idx_exam_attempts_child`），不导出、不保留只读副本。

### 8.5 顺带实测发现（P0-a 应一并处理）

1. **`exam_plan_courses` 老数据有重复行**：多个旧场次的明细行数是其逐题数的 **2 倍**（如 `sch_1788400121` 20 行 / 逐题 10 题；`sch_1788478231` 38 行 / 19 题；`ep_17893587520` 4 行 / 1 题）。根因之一：**旧数据 `question_id` 为空**（83 题里只有 37 题有 `questionId`）→ 去重键失效，`COUNT(DISTINCT question_id)` 恒为 1。P0-a 应**按 `(plan_id, course_uuid, question_id, seq)` 去重清理**（`question_id` 为空的行只能按 `(plan_id, course_uuid, seq)` 去重）。
2. **`knowledgePointId` 缺失严重**：83 题里只有 **31 题**带知识点 → 按 §4.2 ③ 回退家长库 `course_knowledge_questions` 定位；仍定位不到的不写 records（只在 `course_summary` 里说明）。这也解释了老数据"分知识点统计"必然漏数。
3. `listPlanCourseMeta()`（`routes/exam.ts:583`，调用点 `:255`/`:861`）读**已停写**的主库 `study_plan_items` 构建固定档考核候选，疑似既有缺口，需单独确认是否已记录。

### 8.5 顺带发现（不属本 issue 范围，需单独确认）
`routes/exam.ts:583 listPlanCourseMeta()`（调用点 `:255` 固定档 config 下发、`:861`）读**主库 `study_plan_items`** 构建固定档考核候选，而该表自 09-10 计划域重构后**已停止写入**（`routes/study-plans.ts:98` 自述"仅作历史归档"）→ **固定档候选可能一直只看到 9/10 之前的旧计划**。疑似既有缺口，待确认是否已记录。

## 9. 待拍板：**已清零** ✅

| 议题 | 结论 |
|---|---|
| `speech_assessments` 怎么处理 | ✅ **D13**：题级存档，搬孩子库 + 补 `plan_id`/`course_uuid`/`question_id`，按 `(plan_id, course_uuid, question_id)` 与明细关联（§3.7） |
| 旧 `exam_attempts` 数据去留 | ✅ **不迁数据，直接废弃**（`DROP TABLE`，不导出、不留只读副本）；放弃范围已如实记录（83 条评语 / 55 条 ASR / 46 条录音引用 / 25 条评测，均为 09-01~09-17 早期数据，音频本体不受影响）—— 见 §8.4 |

**其余已确认项**：D1~D13；删列/改结构＝直接改（带备份 + 校验）；`score`＝用显式 `rate` 表达；描述同步＝一并改。

**开工前置**：无。**P0-a（考核结果重构）可直接开工。**

## 10. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-09-22 23:23 | 首版：3 张新表（含 `course_mastery`）+ 计划表加 `result_summary` + 每日分析任务 |
| 2026-09-22 23:44 | 课程进度改落**孩子库 `courses` 加列**（D6）；考核结果**分课程**（D7）；分析任务**家长可配**（D9） |
| 2026-09-22 23:54 | **知识点不放在考核结果里**、以 `plan_id`+`course_uuid` 关联（D8）；默认建任务行 |
| 2026-09-23 07:38 | `exam_plan_courses` 曾计划"收敛为一课一行"（含删 `question_id`）；给出全仓引用清单与迁移校验 |
| 2026-09-23 07:43 | 补「收敛前后对照」与「逐题明细归属」详解；查实 `score` 只写不读 |
| 2026-09-23 07:54 | 新增 `exam_attempts` 归属专项：历史原因、已付代价、建议搬 |
| 2026-09-23 08:08 | **实测核实**：主库 19 行、所有孩子库无此表 ⇒ 确认没搬；澄清 09-10 定案只执行了一半。**本文从独立设计稿迁入 ISSUE**（用户要求：不再单独写文档），原设计稿已删除 |
| 2026-09-23 08:20 | ⭐ **方案改写（v2）**：采纳用户决定 —— **`exam_attempts` 废弃不搬（D11）**；**新增 `exam_course_results` 记录课程每次考核结果概要**；`exam_plan_courses` **保持逐题明细**（撤销"收敛为一课一行"）并补题级富字段；`score` 改为显式 `rate` 落概要表；补 §8.3 消费方切换清单与 §8.4 数据处置 |
| 2026-09-23 08:27 | **D13**：查证 `speech_assessments` 是**题级**（一行一题，`routes/exam.ts:1375` 循环写）但**缺 `question_id`**、且**全仓无读取方**（纯存档）⇒ 定案**搬到孩子库 + 补 `plan_id`/`course_uuid`/`question_id`**，与 `exam_plan_courses` 按 `(plan_id,course_uuid,question_id)` 关联（新增 §3.7） |
| 2026-09-23 08:31 | **旧数据处置定案：不迁、直接废弃**。实测对照确认：**结构数据（课程/知识点/题目/得分）确实都在 `exam_plan_courses`**，但题级富信息（83 条 `aiComment` / 55 条 `asrText` / 46 条 `audioFileId` / 25 条 `speech`）只在 `exam_attempts` → 经用户确认视为可放弃的早期数据（09-01~09-17，同一孩子）、执行 `DROP TABLE`。另新增 §8.5 两条实测发现：**明细表老数据有重复行**（行数=逐题数×2，因 `question_id` 为空导致去重键失效）+ **`knowledgePointId` 仅 31/83 有值**。**待拍板清零，P0-a 可开工** |
| 2026-09-23 10:10 | ✅ **P0-a 已实施**（+ P0 结构 + P1 防硬删），见 §11 实施记录 |

---

## 11. 实施记录（2026-09-23）

### 11.1 已落地（P0-a + P0 + P1）

| # | 内容 | 落点 |
|---|---|---|
| 1 | **孩子库新增 4 张表**：`exam_course_results`（课程每次考核概要，§3.5）/ `knowledge_point_records`（知识点流水，§3.1）/ `knowledge_point_progress`（知识点累计，§3.2，建表未写数）/ `speech_assessments`（题级评测存档，§3.7，D13） | `server/src/db/kb.ts` `KB_MASTERY_TABLES` |
| 2 | **`exam_plan_courses` 重构**：删 `score`（D12）；补 `knowledge_point_name` / `question_text` / `ref_text` / `correct` / `ai_comment` / `asr_text` / `audio_file_id` / `duration_ms` / `behavior`（§3.6）；**老库幂等补列 + 删列 + 按 `(plan_id,course_uuid,question_id,seq)` 去重**（§8.5①，meta 游标只跑一次） | 同上 + `ensureExamPlanCourseColumns` / `dropLegacyExamPlanCourseScore` / `dedupeLegacyExamPlanCourses` |
| 3 | **`course_progress` 视图改数据源**：读 `exam_course_results`（单表直读，不再按逐题明细 GROUP BY）；视图改为 DROP + CREATE（旧定义不会因 `IF NOT EXISTS` 更新） | 同上 `KB_PLAN_SCHEMA_VIEWS` |
| 4 | **P0 结构**：`courses` 加 `mastery_level` / `mastery_desc` / `teaching_advice` / `mastery_updated_at`，**列名刻意避开 `dropLegacyCourseColumns` 删除名单**（有注释钉死，单测覆盖"重开库两次仍在"）；`study_plans` 加 `result_summary` | 同上 |
| 5 | **主库下线**：`exam_attempts` / `speech_assessments` 的 CREATE 与 `schedule_id` 迁移代码删除，改为幂等 `DROP TABLE`（附原因注释） | `server/src/db.ts` |
| 6 | **提交端点重写 → 结果直写孩子库三层**，抽成独立模块 `persistExamResult()`（便于单测）：① 逐题明细（先清后插幂等）② 课程概要（UPSERT `(plan_id,course_uuid)`，显式 `rate`，规则文案 `course_summary`）③ 知识点记录（`outcome` 阈值 0.8/0.6；`knowledgePointId` 缺失时回退家长库 `course_knowledge_questions`）④ 评测存档（按 `(plan_id,course_uuid,question_id)` 关联，同一 plan 先清后插）⑤ 计划置 done + 回填 `attempt_id/score/done_at`；**课程 uuid 解析三跳**（孩子库 → 家长库 → 回写孩子库，本地实测 296/2992 门课 uuid 为空必须回填）；缺 `scheduleId` 时自动补建 custom 计划 | **新增 `server/src/exam-results.ts`** + `server/src/routes/exam.ts` |
| 7 | **错题本同步前移**：考核错题（未满分）写入 `mistake_book` 的逻辑从 worker 移到提交端点（`source_ref=attempt_id` + `question_id` 幂等哨兵口径不变），避免收窄 worker 时丢功能 | `routes/exam.ts` |
| 8 | **读取侧全切新口径**：`GET /exam/attempts/:childId`（**响应形状保持不变 → 三处考核界面与「听原音」零改动**）、`GET /exam/course-records/:childId`、`GET /courses/status/:childId`、`lastExamAtByCourse` / `latestReinforcePlan`（改吃孩子库 kb）、`GET /assess/questions/:questionId/records` | `routes/exam.ts` |
| 9 | **worker 收窄**：`applyExamAttempts` → 单库幂等兜底（补概要 + 补 `done`，`DO NOTHING` 不覆盖 LLM 润色结果）；`computeExamRate` 去掉主库兜底，改「概要 → 逐题明细」单库两级回退；`attemptDetailSums` 删除 | `worker/plan-domain.ts` |
| 10 | **P1 计划不可硬删**：`parent_study_plan_update` act=delete 与 `DELETE /api/v1/study-plans/:id` 遇 `done`/`missed` 行改软删（`active=0, status='cancelled'`）；`readStudyPlans` 加 `active=1 AND status != 'cancelled'` 过滤，避免取消行仍出现在 agent 列表 | `agent/parent-plans.ts` + `routes/study-plans.ts` |
| 11 | **数据访问注册表同步**：`exam_plan_courses` 列清单更新（去 `score`、补新列）+ 新增 4 张表的登记 + `courses`/`study_plans` 新列登记 —— `probe:registry-drift` 实测**无漂移** | `agent/db-channel.ts` |
| 12 | **测试**：新增 `test/issue135-exam-results.test.ts`（5 用例：写全三层 / 幂等 / 知识点回退 / 结构收敛与视图 / worker 兜底不覆盖）；改写 `test/issue112-exam-rate.test.ts` 到新口径（结算 90% / 幂等 / 单库兜底） | `test/` |

**验证**：`tsc --noEmit` 0 错；`node scripts/build.mjs` 构建通过（bundle 已含改动，版本号仍 0.5.5）；`probe:registry-drift` 无漂移；相关 7 个测试文件 56 用例全绿；全量 481 用例中 458 通过、15 失败、8 跳过 —— **失败清单与本改动无关**（assessment / assess-guide / event-poll-config / kb-sqlite(旧 electron 版) / page-bridge / sync / token-stats / english-course-session，均为既有失败）。

### 11.2 未做（后续阶段）

- **P0-b**：回填 `knowledge_point_records`（从现有明细/旧 attempts 聚合）+ 行数与 Σgot/Σmax 校验脚本。
- **P2**：考核概要与知识点 `summary` 的 LLM 润色（现状为规则文案，已可上线）。
- **P3**：学习侧写入（`applySignals` 后由 LLM 抽取课程概要 → `study_plans.result_summary` + `knowledge_point_records(source='study')`）。
- **P4**：`progressAnalysis` 定时任务（默认 @21:30）+ `knowledge_point_progress` 累计叙述 + `courses.teaching_advice` + 配置链路与客户端下拉。
- **P5**：消费侧（家长 agent 读工具 / `kb.courses.get` 扩展 + 课程子会话注入 / 家长界面知识点级展开）。

### 11.3 实施中的取舍与实测（供复核）

1. **接口形状保持不变**（`GET /exam/attempts/:childId` 仍返回 `{attempts:[{id,title,submittedAt,score,perQuestion[],courseMastery,reinforcePlan,…}]}`，由孩子库三表现场组装）——§7 验收要求的"三处界面切新口径"以**数据源切换**达成，客户端零改动，风险最小；如需彻底改为新 DTO，另开一轮。
2. **`behavior` 一列兼收题级行为与题型**：客户端提交的 `questionType`（背诵/朗读/口语）与题库 `behavior`（`speech_recite`/`speech_read`/`generic`）在提交项里是同一个语义位，落库统一进 `behavior`，读取时同时回填 `questionType` 与 `assessMethod`（保证前端"背诵/口语"标签与听原音判断不变）。
3. **课程 uuid 回填是必要动作**：本地实测 1764 个孩子库 / 2992 行课程里 **296 行 `uuid` 为空**，不回填会让明细/概要/知识点流水与课程失联（视图 join 不上）。
4. **`exam_attempts` 的 DROP 写在 `db.ts` 建表 SQL 里**（跟随 `exam_schedules` / `materials` 的既有下线写法）：服务端启动即幂等执行，不需要单独迁移脚本；本地 dev 库已在探针运行时执行过一次。
5. **`attempt_ref` 语义微调**：DDL 注释写"迁移溯源"，实现里同时存**本次提交的 attempt id**（即写入 `exam_plans.attempt_id` 的那个），供考核记录界面按计划匹配；DDL 注释已同步说明。
