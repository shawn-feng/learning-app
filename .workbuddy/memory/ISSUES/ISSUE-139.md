# ISSUE-139 · 考核复盘与错题分析（E7：读到某次考核的全部逐题结果 + 怎么讲错题）

- **类型**：需求（**提示词为主，数据与工具已具备、无需新工具**；含 1 条边界拍板）
- **描述**：新增孩子端场景 **E7 考后复盘**——孩子考完能问"我这次考得怎么样 / 哪几题错了 / 帮我讲讲"，agent **读到某一次考核计划的所有题目的考核结果**，给孩子**分析错题**、给下一步；孩子要重考时转成"再安排一次考核"。
- **核心核实结论（好消息）**：**"某一次考核的全部逐题结果"已经在孩子库里、孩子 agent 已经能读**（ISSUE-135 P0-a 的产物），**不需要新增工具、不需要新增表**。真正的缺口只有两个：**① 提示词（怎么分析错题）完全空白；② "完整读取课程/知识点/题目"的口径需要分清哪些能开、哪些不该开（标准答案一律不开）。**
- **影响范围**：①`server/src/agent/prompt.ts` ①基底新增 [域 E] · E7 一节（+ 重考引导口径与 F5 共用）；②**可选/待拍板**：是否开放知识点详细描述给"孩子侧只读"（见 §五）。**不改表结构、不改出题/判分链路。**
- **排查/修改入口**：
  - 数据（已就绪）：`server/src/db/kb.ts`（`exam_plans` / `exam_plan_courses` 逐题明细 / `exam_course_results` / `knowledge_point_records` / `knowledge_point_progress`）
  - 可读声明：`server/src/agent/db-channel.ts`（`childKbTableSpecs()` 内已登记上述各表，含列说明；孩子库**无**命名路径）
  - 读工具：`server/src/agent/child-db-tools.ts`（`child_db_read`：`table` / `columns` / `where` / `orderBy` / `orderDesc` / `limit` / `offset` / `countOnly`）
  - 重考链路：`server/src/exam-retake.ts`（`maybeCreateRetakePlan`）、`server/src/routes/exam.ts`（`POST /api/v1/exam/attempts` 评分落库 → retake 钩子；`exam_plans.retake` = 家长设的"当天重考标准"）
  - 新建考核（重考出口）：`server/src/agent/plan-tools.ts`（`child_exam_plan_create`，与 E6 同一工具）
- **优先级**：中-高（**数据全有、提示词全无**，性价比最高的一类补齐）
- **记录时间**：2026-09-23
- **关联**：`docs/孩子使用场景梳理-2026-09-23.md`（域 E 表新增 E7 + 「域 E 讨论 · 补」+ §6 #13/#14 + §8 #15）；`ISSUE-136`（提示词按场景整理，本条 E7 属其增补）；`ISSUE-137`（F5：把错题变成一场考核——**E7 是它的上游**）；`ISSUE-135`（考核结果三层落库 = 本条的**数据前提**）；`ISSUE-115`（重考标准机制）。

---

## 一、数据核实：一次考核的"每一道题"落在哪

ISSUE-135 P0-a（2026-09-23）起，一次考核的结果分三层落在**孩子库（kb.sqlite）**：

| 层 | 表 | 一行是什么 | 关键列 | 孩子 agent 可读 |
|---|---|---|---|---|
| **逐题** | `exam_plan_courses` | **一行一题** | `plan_id` / `course_uuid` / `course_name` / `knowledge_point_id` / `knowledge_point_name` / `question_id` / `question_text` / `ref_text`（背诵朗读原文）/ `point_got` / `point_max` / `correct`(1/0/NULL) / `ai_comment` / `asr_text` / `audio_file_id`（听原音）/ `duration_ms` / `behavior` / `seq` | ✅ |
| 每课概要 | `exam_course_results` | 一次考核 × 一门课 | `plan_id` / `course_uuid` / `exam_at` / `point_got` / `point_max` / `rate`（得分率 0~1）/ `question_count` / `course_summary` / `focus_json`（复习重点）/ `plan_review_at` | ✅ |
| 知识点 | `knowledge_point_records`（`source='exam'`，一次一条）/ `knowledge_point_progress`（累计） | 本次档位 / 累计掌握 | `plan_id` / `knowledge_point_id` / `knowledge_point_name` / `outcome`(solid/partial/weak) / `point_got` / `point_max` / `rate` / `summary` / `detail_json` | ✅ |
| 场次 | `exam_plans` | 一次考核 | `id` / `title` / `status`(pending/started/done) / `score` / `result` / `done_at` / `retake` / `creator` / `task_type` | ✅ |

⇒ **需求原句"agent 要能读到某一次考核计划的所有题目的考核结果"= 已满足**：`exam_plans` 定位 + `exam_plan_courses` 按 `plan_id` 取全量。**不需要新工具。**

**读取样例（现成工具，零改造）**

```
# 1) 找"最近一次已完成"的考核（孩子点名时改用 where:{id:"<planId>"}）
child_db_read { table:"exam_plans", columns:["id","title","score","done_at","task_type"],
                where:{ status:"done" }, orderBy:"done_at", orderDesc:true, limit:5 }

# 2) 读这一次的全部逐题结果（一次读完；题干很长时用 columns 收窄）
child_db_read { table:"exam_plan_courses",
                columns:["seq","course_name","knowledge_point_name","question_text","ref_text",
                         "point_got","point_max","correct","ai_comment","behavior"],
                where:{ plan_id:"<planId>" }, orderBy:"seq" }
```

**返回预算（已核实，够用）**：单次 `limit` 缺省 50 / 最大 200；整次响应预算 **40,000 字符**，单单元格截到 **4,000 字符**——一次考核的题量（十几到几十题）通常在预算内；真超了，用 `columns` 收窄或 `limit`+`offset` 翻页。

## 二、"完整读取课程 / 知识点 / 题目"——逐项说清楚

| 想读的 | 孩子侧现状 | 能不能给 |
|---|---|---|
| **课程** | 孩子库 `courses`（含 `uuid`/`title`/`topic`/掌握四列）+ 逐题行里的 `course_name` 快照 | ✅ **已完整** |
| **知识点** | 只有**考过/学过的**：`knowledge_point_records` / `knowledge_point_progress` 的名称快照 + 档位 + 描述；**全量知识点清单与详细描述读不到**（`knowledge_points` 只在家长库，孩子侧无表、`parent_content` 也不提供） | △ **部分**；若要补 → §五·待拍板 1 |
| **题目** | **考后**：逐题快照（题干/原文/满分/评语）✅；**考前**：读不到（出题在"开始考核"时抽、落库在评分后——**这是防泄题的设计，不是缺口**） | △ **部分（且应保持）** |
| **标准答案 / 评分标准** | 读不到（`question_bank.answer` / `scoring` 只在家长库） | **✗ 建议永不开放** |

**为什么"答案不给"要写成红线**：孩子 agent 一旦能读题库答案，孩子问一句"那道题答案是什么"就能套出来，**考核的检验意义直接归零**。而**讲错题并不需要原答案**——题干、朗读/背诵题的原文（就在 `ref_text` 里）、`ai_comment`，加上课程资料与模型自身知识，足够讲清"为什么错、正确应该怎样"。

⇒ 若要让讲解更有依据，**优先开放 `knowledge_points.detail`（考核要点 / 教学内容，是"该讲什么"的骨架），而不是 `answer`。**

## 三、重考：三种形态，别混（与 F5 共用结论）

| 形态 | 现状 | 可做性 |
|---|---|---|
| **① 同一场考核再考一次** | 家长设 `exam_plans.retake`（自然语言，如"错两题以上当天原题重考"）→ **评分落库后服务端自动**生成当天重考计划（`maybeCreateRetakePlan`，`ISSUE-115`）。孩子侧**没有**主动发起"再来一次"的出口/工具 | ❌（待拍板 2） |
| **② 围绕错题另排一次考核** | `child_exam_plan_create`（**与 E6 同一工具**，按知识点级） | ✅ 可做；考的是**同知识点的题**、不保证原题（= `ISSUE-137` 路线 B） |
| **③ 锁定原题重考** | scope 无题目维度（最细"知识点 × 题数"、池内随机抽） | ❌ 协议级改造（= `ISSUE-137` 路线 A，二期） |

⇒ 与 F5 的分工：**E7 = 读结果 + 讲错题（考后）**；**F5 = 把错题变成一场新考核（出题）**。E7 是 F5 的上游。

## 四、缺口：提示词（怎么分析错题）——现在零覆盖

按 `ISSUE-136` 的三段式给出规格：

**[域 E] · E7 考后复盘**

- **孩子会说**：「我这次考得怎么样？」「哪几题错了？」「帮我讲讲错的那几题」
- **怎么做**：
  1. **定位那一次**：默认"最近一次已完成的"（`exam_plans` 按 `done_at` 倒序）；孩子点名了（"上次英语那次"）就按他说的找；
  2. **读逐题结果**（`exam_plan_courses` 按 `plan_id` + `seq`）；
  3. **先给整体，不上来就报错题**：考了几题、对了几题、**错集中在哪个知识点**（用 `knowledge_point_name` 归纳成 1~2 句，不念内部数字/得分率）；
  4. **一次只讲一两题**，挑**最基础 / 错得最集中**的先讲；讲完问孩子"要不要看下一题"；
  5. **先问"你觉得这题卡在哪"**，再讲正解——不要直接灌答案（与"答题通用口径：先引导他自己发现"一致）；
  6. 讲完给**一道同类小练习**（或让他自己复述一遍）；
  7. 孩子说要重考 → 转 `child_exam_plan_create`（同 F5）
- **边界**：
  - **一次不倾倒全部错题**（孩子会崩）；
  - **不报内部数字**（掌握度只转述叙述，与 F4 同口径）；
  - **不承诺"重考考原题"**——如实说"同类题再练一遍"；
  - **不给孩子看标准答案**（也读不到）；
  - **不出现"考得差 / 粗心 / 就是不认真"这类评价**，只讲事实 + 下一步；
  - 录音类题（`behavior=speech_recite/speech_read`）的讲法要具体到"哪个字音/停顿"，不要泛泛说"再熟一点"。

**[域 E] · E7 ·「错的我想再考一遍」**

- **孩子会说**：「错的我想再考一遍」「再考我一次」
- **怎么做**：先确认他知道**考什么**（"我把你错的这几个点再考一遍"）→ `child_exam_plan_create`（课程名必须真实）→ 建完引导他去考核页；
- **边界**：**不能"现在马上重考原卷"**（① 的出口不存在）；如实说"再考一次是**同类题**，不一定还是那几道"。

## 五、待拍板

1. **讲解依据要不要扩**：是否把 **`knowledge_points.detail`（知识点详细描述 / 考核要点）** 以"孩子侧只读"方式开放？——**`answer` / `scoring` 建议永不开放**（泄题红线，见 §二）。
2. **要不要给孩子"原场重考"的出口**（同一场考核再来一次）？现在只有家长设的重考规则由服务端自动生成；若要开，是复用 `exam_plans.retake` 机制（服务端生成重考计划）还是另做入口。

## 六、验收

- [ ] 问"我这次考得怎么样" → 能说出**几题、对几题、错集中在哪个知识点**（数据来自 `exam_plan_courses`，不是空口）；
- [ ] 问"帮我讲讲错的" → **一次只讲 1~2 题**、先提问再讲解、结尾给下一步；
- [ ] 说"错的再考一遍" → 走 `child_exam_plan_create`，并**明确告知"是同类题"**；
- [ ] **任何路径都拿不到标准答案**（模型不会声称"答案是…"来自题库；讲解靠原文/评语/课程资料）；
- [ ] 不做"考得差"式评价；
- [ ] 考前读该场考核 → **读不到题目**（防泄题保持）。
