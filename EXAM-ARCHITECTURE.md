# EXAM-ARCHITECTURE.md — 学习考核模块架构与工作流程（真源）

> 状态：**当前架构真源**（2026-09-10 收口）。考核功能经 ISSUE-027（初版）→ ISSUE-049/050（流式出题）→ ISSUE-054（选课重构）→ ISSUE-065（选课机制+档位）→ ISSUE-066（家长 agent 编写职责）→ ISSUE-067（考核内容结构化 v2）演进，本文档记录**当前**架构与流程；历史细节见文末决策索引。
> 配套：设计细节 `DESIGN-course-assess-structured-2026-09-09.md`（结构化 v2 定案）；`EXAM-REQUIREMENTS.md` 为初版需求（**部分已过时**，以本文为准）。

---

## 1. 一句话定位

孩子对**已学课程**做结构化语音考核：按「考核方法」（主题默认或本次覆盖）从**题库**直接抽题（结构化课 0 LLM），逐题作答（背诵→发音评测、选择题→看选项口答、问答题→ASR 口述），提交后逐题判分，结果落库供家长端查看与后续复习安排。

## 2. 模块地图

```
孩子端 (renderer)
  ExamView.tsx ─ 考核入口（今天可参加/历史补考/已完成查看）、答题壳（iframe）、提交编排
  src/lib/exam-template.ts ─ 答题页模板（题面/选项/录音/ASR/提交流，iframe 内运行）
家长端 (renderer)
  ExamAdminPanel.tsx ─ 学习考核计划管理（daily/weekly/custom 只读+引导对话创建）
  ExamRecords.tsx ─ 孩子管理→考核记录（左列表右详情）
  TopicDetail.tsx 考核要点 tab ─ 结构化内容浏览（类别→题目→详情+该题考核记录）
  QuestionBankPanel.tsx ─ 「题库」菜单（全量题目+各孩子最近得分）
客户端主进程 (electron)
  exam-engine.ts ─ 旧路径 LLM 出题 / 逐题并发判分（≤3）/ 选择题规则判分 / 背诵题注入(兼容)
  exam.ts ─ 服务端 REST 封装（config/schedules/submit/…）
  custom-tools.ts + assess-tools.ts + assess-admin.ts ─ 家长 agent 工具（考核排期/内容结构化 CRUD）
  pi-session.ts ─ 家长/孩子会话组装（工具 allowlist + 提示词 §2.6）
服务端 (server)
  routes/exam.ts ─ /exam/config（组题下发）/schedules CRUD /assess/*（结构化 CRUD+记录查询）
  assess-selection.ts ─ 结构化抽题选择器（方法过滤→随机抽→排序→组题下发）
  assess-migrate.ts / repair-choice-options.ts / repair-assess.ts / migrate-assess-rubrics.ts ─ 存量迁移与修复
  db/assess-content.ts ─ 三表 schema+访问层（真源数据层）
  db/parent-lib.ts ─ 打开家长库即自动 ensure schema
数据（唯一真源 = 服务端家长库 server/data/parents/<pid>/parent.sqlite；客户端本地 parent.sqlite 是空占位）
  question_bank / topic_categories / course_category_questions / courses(+uuid) / topics(+method_spec)
```

## 3. 数据模型（家长库）

| 表/字段 | 说明 |
|---|---|
| `question_bank` | 题库（uuid 主键）。stem 题干 / **answer**（口述题=参考答案要点；背诵朗读题=标准原文 refText）/ scoring（JSON dims+special，speech 类空）/ point_max / **behavior**（题级判定：`speech_recite`背诵评测·`speech_read`朗读·`generic`口述，**判题以题为准**）/ note 备注 / knowledge_summary 知识点概要（供向量检索）/ **options**（选择题选项 `[{key,text}]`，`[]`=非选择题） |
| `topic_categories` | 主题考核类别（id/topic_id/name/behavior）。类别 behavior 仅作**新题默认继承**，不参与判题 |
| `course_category_questions` | 课-类-题关系（course_id/category_id/question_id/seq/overview/**knowledge_point_id**）。一课多类、一类多题=例题池（随机抽）、各课类别可不同；knowledge_point_id=该挂载关联的课内知识点（2026-09-10 知识点实体化，可空） |
| `knowledge_points` | **知识点实体**（2026-09-10）：id/course_uuid（外键 courses.uuid）/name/seq，UNIQUE(course_uuid,name)。挂在课下；题目经 ccq 挂载关系关联（同题跨课可挂各自课的知识点） |
| `courses.uuid` | 课程 uuid（关系表外键，2026-09-09 回填） |
| `topics.method_spec` | **主题级考核方法**（JSON，key=childId）：`perChild{require{类别uuid:题数}, exclude[], rules.recitePass}` + `default` 回退（require 空→该课实际挂的类别各 1 题） |
| `courses.assess_rubric` / `topics.assess_method` | 旧自由文本 rubric/方法（**兼容保留**：未结构化课走旧路径；不要再新写） |
| `exam_schedules.scope` | fixed：固定档配置；custom：`{topics?, courses!, note?, methodSpec?}`（见 §5） |

## 4. 两层考核方法

| 层 | 存储 | 作用范围 | 设置入口 |
|---|---|---|---|
| 主题级 | `topics.method_spec`（key=childId） | 该主题下**所有**考核，按孩子区分 | 家长 agent `assess_method_set`（或对话） |
| **排期级（本次覆盖）** | `exam_schedules.scope.methodSpec`：`{require:{类别名:题数}, exclude:[类别名], recitePass}` | **仅这一次**考核 | 家长 agent `exam_schedule_create` 的 `categories/excludeCategories/recitePass` 参数 |

优先级：**排期级 > 主题级 perChild > default**。排期级类别可写**名称**（服务端按该课主题类别表解析；uuid 亦可）；require 全部解析失败→视为未覆盖（回退主题方法，避免整场无题）。背诵通过线 recitePass 随题下发，判分按它判通过（默认 90）。

## 5. 端到端工作流程

### 5.1 排期与入口
- **固定档** daily/weekly：内置规则=学习计划周期内「必学」课程全部考核（不走 LLM、家长不可改规则）；家长改范围→用自定义。
- **自定义档**：家长 agent `exam_schedule_create`，**courses 必填精确课程名**（先查 `course_status`/`parent_library_courses`），可选本次方法（§4）；无 courses 的旧排期→400 提示重排。monthly/halfyear/yearly 已下线。
- 孩子端考核页分两区：**今天可参加**（当天 pending/started）/ **历史**（过去未完成→补考；已完成→查看成绩）。未来排期不显示。

### 5.2 取题（`GET /exam/config`）
1. custom：按 `scope.courses` 取课（fixed：plan 必学课）；**custom 额外读 `scope.methodSpec` 作本次方法覆盖**。
2. 每门课走 `attachStructuredQuestions`（结构化直出，0 LLM、毫秒级）：
   - 该课无关系行 → 非结构化，走旧路径（§5.3）；
   - 方法过滤（exclude → require 命中；require 空=default 该课全部类别）；
   - 每类别题池**随机抽 require 数**（缺题跳过该类别，不 LLM 临时命题）；
   - **speech 题置该课最前**（背诵前不出含原文引用的其它题，防泄漏）；speech 题 `refText=answer`、带 `recitePass`；选择题带 `options/correctKey/answerText`；文字题带 `scoringText`（参考答案+维度+特殊情况）；
   - 每题带 `questionId/categoryId`（落库溯源/轮换排除）**与 `knowledgePointId/knowledgePointName`**（挂载关联的课内知识点，2026-09-10 起；经 questionMetaRef 回填后写入 per_question 溯源，按知识点聚合掌握度后置）。
3. 旧路径（仅非结构化课）：客户端 LLM 逐课出题（`generateForCourse`，注入 assess_method 按孩子点名 + rubric 全文；流式并发≤3，首门课就绪即开考）。

### 5.3 答题（iframe 模板）
- 顺序作答、答完锁定、可回看；背诵题（cn_recitation/cn_poem）**不显示原文**（防看文朗读）；**选择题显示选项列表**（只读），提示"看选项说出你选哪一个"；问答题 ASR 转写可修改。
- 题面选项/评分标准/溯源 id 由宿主 `questionMetaRef` 按送达顺序维护，提交时回填（iframe 会重排 qid、丢未知字段）。

### 5.4 提交与判分
- **背诵/朗读题**：多段录音合并 16k wav → 上传评测（服务端转发）→ 总分 ≥`recitePass` 才算通过；**单题评测失败软失败**（记 0 分注明原因，不阻断整场）。
- **选择题**（带 options）：**本地规则判分不进 LLM**——说「选B」/念出正确项内容→满分；命中其它选项→0 分带评语；判定不出→兜底 LLM（带选项参照）。
- **问答题**：逐题并发判分（≤3），每题迷你 prompt=总则+题干+回答+本题 scoringText（不贴整课 rubric；旧题才带课程 rubric）。
- 掌握度 courseMastery 客户端按课程本地聚合；**复习计划已从判分移除**（家长 agent 按需提供）。

### 5.5 落库与结果
`exam_attempts`（score/per_question 含 pointMax/questionId/categoryId）+ `speech_assessments` + 排期 `done`。家长端考核记录（左列表右详情）、课程详情该题记录、题库页各孩子最近得分，均按 questionId/categoryId 溯源。

## 6. 家长 agent 工具（考核相关）

| 工具 | 用途 |
|---|---|
| `assess_categories_list` / `assess_category_create` | 主题考核类别查看/创建（REST `/assess/*`） |
| `assess_course_get` / `assess_content_save` | 课程结构化内容查看/整课保存（事务替换；题可引用或内联，支持 behavior/note/knowledgeSummary/options/**knowledgePoint**——题级知识点名（课内自动创建/同名复用）或 knowledgePointId，item 级可给默认） |
| `assess_method_set` | 主题级考核方法（按孩子 require/exclude/recitePass） |
| `exam_schedule_create` | 自定义考核排期（courses 必填；categories/excludeCategories/recitePass=本次方法） |
| 旧通道 `parent_course_save`(assessRubric) / `parent_topic_save`(assessMethod) | 仅存量未迁移课程兼容，**不要新写** |
| 辅助 | `course_status`（掌握/复习/考核状态）、`parent_library_courses`（权威课程名）、`parent_list_children`、`assess_categories_list`（类别名核对） |

写作规范真源：`electron/lib/assess-guide.ts`（`COURSE_ASSESS_GUIDE_MD`，v2 结构化优先）→ 运行副本 `data/.pi/agent/assess-rubric-guide.md`；家长提示词 §2.6 注入。

## 7. 审计与排查

- `exam-audit`（`electron/lib/exam-audit.ts`）：`{dataDir}/exam-audit/{childId}/{YYYYMMDD}.jsonl`，记录 select/generate/score 三类事件的 prompt+回复+解析+耗时（结构化场次**无 generate/select**=没调 LLM，即直出题生效的判据）。
- 评测链路：背诵录音经服务端转发评测（当前智聆 16k_zh；阿里 SSECP 已弃用——其 wss 接入协议不公开）。评测失败软失败不阻断。

## 8. 关键设计决策（索引）

| 日期 | 决策 |
|---|---|
| 09-08 | 背诵题只考本课原文（rubric「原文背诵」行提取，防跨章错题）；背诵页隐藏原文（防看文朗读）；考核 AI 会话审计落盘 |
| 09-09 | 固定档=plan 必学全考（内置规则不走 AI）；自定义须精确 courses（去家长手填规则入口）；月/半年/年档下线；判分瘦身（rubric 按课去重、只出分、复习计划移除）；出题/判分均客户端直连模型（mimo，全局默认）；出题禁止 LLM 生成背诵文字题；评测软失败 |
| 09-09 | 结构化 v2 定案（ISSUE-067）：三表+题级 behavior+methodSpec，DB 真源；出题按方法抽题（0 LLM）、判分逐题小 prompt |
| 09-10 | 选择题选项找回（352 道）+题面显示选项+规则判分；**排期级考核方法覆盖**（本次只考 X）；recitePass 真正生效；考核入口信息架构（孩子两区/家长记录归孩子管理） |

## 9. 实现红线（改动前必读）

1. **服务端家长库是唯一真源**——agent 工具/服务端一律走 REST 或服务端侧访问层，禁止在 electron 直开家长库 SQLite。
2. 结构化与旧 rubric **双路径兼容**：动 config/抽题必须保证"无关系行→回退旧路径"不破。
3. 背诵题 refText 必须**逐字权威**（来自题库 answer/语料），不可让 LLM 手写原文。
4. iframe 模板会重排 qid、丢弃未知字段——判分锚定物（scoringText/options/correctKey/recitePass）必须走宿主 `questionMetaRef` 按送达序回填。
5. 判分 prompt 不读主题考核方法（assess_method 只管出题构成；判分按题库 scoring/answer）。
6. 家长会话工具需**同时**登记 `tools`（名字 allowlist）与 `customTools`（对象）两处，漏一即"工具不存在"。
7. server dev（tsx）无 watch，改服务端代码必须重启进程；客户端主进程改动需重启 dev 客户端。
