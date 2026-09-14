# ISSUE-098：考核功能两项问题——①「背诵考核」配置未生效（出了别的题）；② 珊珊会话出题耗时 ~40s 过程与耗时分析

- **类型**：bug（① 行为不符预期）+ 性能/可观测性分析（②）
- **优先级**：🟡 中（① 影响考核正确性，需修；② 当前可用但偏慢，建议优化）
- **记录时间**：2026-09-14
- **状态**：✅ ①已解决（2026-09-14，结构化挂题路线）；⏳ ②性能优化未做（方向见下文）

---

## 处理记录（2026-09-14）

**定案路线**（用户拍板）：不走"methodSpec 加 mode/reciteOnly"方案，改为**把课程挂成结构化**（知识点+题库题），"只考背诵"用 `methodSpec.require={"背诵":1}` 表达；同时 `exam_plans.kind` 收敛为 custom/fixed（creator 区分建单人）。

已落地：
1. **kind 收敛**：`child_exam_plan_create` 与 REST `/plans/exam` 改写 `kind='custom'` 且 **courses 必填**（写入 `scope_json.courses`，解析不到真实课程名不落库）；孩子库 schema ensure 幂等迁移 `UPDATE exam_plans SET kind='custom' WHERE kind='self'`。→ 本 issue 排查中发现的"孩子自请计划落进 fixed-weekly 分支导致 36 课全考"问题随之消除。
2. **题库结构化覆盖**（server/scripts/seed-knowledge-points.mjs + restore-question-bank.mjs）：
   - 恢复 09-09 建设的 3575 道题库题（源：`.workbuddy/tmp/rehearsal` 的 parent.sqlite 快照，含原 id/created_at），并按旧分类（背诵/句意白话/道理/字词/典故）挂成知识点 → **489 门论语课全部结构化**（1969 KP）；
   - 孝经 18 门 + 千字文 30 门用模板脚本挂 3 知识点（本章原文背诵= speech_recite / 句意翻译 / 道理应用，answer 从 teaching_copy 原文/白话/道理段提取）；
   - 现状：**537 门结构化课程、488 道背诵题**。珊珊再考「学而篇背诵考核」→ config 直出背诵题、零 LLM；"背诵考核"只需 require 只含背诵知识点。
3. **scope.note 进出题链路**：custom 分支把计划 note 拼进每课 assessMethod（`【本次考核要求（家长说明）：…】`），非结构化课走 LLM 时也能感知本次要求。

**运维事故记录**：seeding 过程中误清了 parent.sqlite 的 question_bank（清理守卫只查了 max(created_at)，漏判 09-09 存量行；knowledge_points/挂载表当时为空未受影响）。已从 rehearsal 快照 100% 恢复（3575/3575，且恢复质量更高——含 352 道选择题、逐课分类挂载）。快照目录 `.workbuddy/tmp/rehearsal` 建议保留勿删。


## ① 背诵考核配置未生效：明明设了「背诵考核」，出题没有背诵、出了别的题目，应只有背诵

### 现象
家长设置「今天的考核计划 = 背诵考核」，期望只出背诵（recite）题；实际出题里**没有背诵题、而是别的题（讲意思/翻译/应用等文字题）**，或**混进了文字题**（不是「只背诵」）。

### 排查结论（根因在架构，不止现象）
背诵题在系统里是**题库/语料驱动**的，不是「引擎可被要求产出」的模式。具体三处互相叠加：

1. **背诵题只来自题库里 `behavior: speech_recite` 的题**（`server/src/db/assess-content.ts` 题级行为；`assess-selection.ts` 把这类题转成 `questionType: cn_recitation` + `refText`）。LLM 出题链路**被硬编码禁止生成背诵题**——`server/src/agent/exam-engine.ts` 的 `GENERATION_PER_COURSE_RULES`（L78-81）明确写：
   > 「⚠️ 不要出『请背诵/背出原文』这类要求背原文的题：背诵题由系统单独生成并用发音评测自动评分——你只出需要孩子用自己的话回答的文字题」
   → 所以**非结构化课程（无题库）走 LLM 时永远不出背诵题**。

2. **`methodSpec`（计划级覆盖 `require/exclude/recitePass`）只能携带「通过线 + 知识点过滤」，没有「只背通/只背诵」模式开关**。`server/src/routes/exam.ts:769` 注释虽举例「如只考核背诵」，但 `recitePass` 只是背诵题的**通过分数线（默认 90）**，不是「我要背诵题」的选择器；`parent-plans.ts:681-711` 的 `methodSpec` schema 也只有 `require/exclude/recitePass` 三字段，**无 `mode`/`reciteOnly`**。

3. **`attachStructuredQuestions`（`assess-selection.ts`）按知识点（`require`/`exclude`）筛题，不按题行为（behavior）筛**：同一知识点下若同时挂了 `speech_recite` 和 `generic` 题，文本题会一起被抽出 → 即使用户想要「只背诵」，文字题也会漏进来。

### 两条具体路径都产不出「纯背诵」
- **路径 A（非结构化课程 / 无背诵语料，如 audit 里 09-09 固定考核的 孝经/千字文，rubric 为空）**：`attachStructuredQuestions` 判定无题库 → 退回 LLM 出题 → LLM 被禁止出背诵 → `recQ=0`，只有文字题（audit 实证：孝经 `recQ=0,llmQ=3`、千字文-01/02 同）。→ 完全不出背诵，正对上「出题没有背诵、出了别的题目」。
- **路径 B（有背诵语料的课，如 论语学而篇第一章）**：客户端从课程「背诵语料/原文」注入 1 道背诵题（`recQ=1`），再让 LLM 出 2-3 道文字题 → 结果是「1 背诵 + 2~3 文字」，不是「只背诵」。audit 实证每次自定义 论语 都是 `recQ=1 + llmQ=2~3`。

### 修复方向（待评审）
- 在 `methodSpec` / 主题 `assess_method` 增加**行为选择器**：`mode: "recite"` 或 `reciteOnly: true`（或 `behaviors: ["speech_recite"]`）。
- 出题侧据此：
  - 结构化：把 `attachStructuredQuestions` 的筛选从「仅按知识点」扩展为「再按 behavior 过滤」，reciteOnly 时只留 `behavior: speech_recite`，丢弃 `generic`。
  - 非结构化：新增「从课程背诵语料直接生成 `cn_recitation` 题」的服务端能力（当前背诵语料注入只在客户端做、且 LLM 被禁），reciteOnly 时不再走 LLM 文字题链路。

---

## ② 珊珊（childId `1f050a7f-df8a-45b0-925a-1ffe2aa35674`）会话考核过程与 ~40s 出题耗时分析

> 数据来源：`data/exam-audit/1f050a7f.../20260908.jsonl`、`20260909.jsonl`（本地审计落盘；注意这是 09-08/09-09 的历史数据，用户口头说的「~40s」对应其中单次生成调用）。

### 一次考核的三阶段（以自定义 论语 为例）
| 阶段 | 做了什么 | 实测耗时 | 入口 |
|---|---|---|---|
| select（仅自定义） | LLM 选课/定范围 | ~15.6s（09-08） | 家长 agent 选课 |
| generate（出题） | 每门课 1 次 LLM 调用（`generateCourseQuestions`），客户端再注入 1 道背诵题 | **单课 32~92s**（见下） | `exam-agent.ts:89` → `exam-engine.ts:288` |
| score（判分） | **每题 1 次 LLM 调用**，`CONCURRENCY=3` | 2~4 题 → **45~104s** | `exam-engine.ts:341` |

### 出题耗时明细（generate 单次调用，`costMs`）
- 论语（自定义）：92.7s(09-08) / 86.5s(09-09 02:14) / **41.3s(09-09 04:39)** / 32.6s(09-09 08:51)
- 固定考核单课（孝经 22.5s、千字文-01 33.4s、千字文-02 34.9s）：三门**并发**起（时间戳显示约同秒启动），墙钟≈ max≈35s

→ 用户说的「出题耗时差不多 40 秒」≈ **单课一次 LLM 生成调用**（论语 04:39 那次正好 41.3s，产出 1 背诵 + 2 文字）。

### 耗时去哪了（瓶颈）
1. **每次生成/判分都重建 agent 会话**：`createExamSession`（`exam-engine.ts:256`）每次都重新 `getWorkerRuntime` + `pickWorkerModel` + `DefaultResourceLoader.reload()` + `createAgentSession`。判分更甚——`scoreExamAttempt` 在循环里**每题新建一个 in-memory session**（L371），N 题 = N 次完整运行时初始化。这是判分 45~104s 的主因。
2. **LLM 本身生成 2~3 道题**占主体（约 25~40s/课），叠加上面的初始化开销。
3. **无会话/运行时复用、无批处理**：出题按课串行或并发但各自独立 session；判分逐题独立 session。

### 端到端体感
- 自定义 3 题：出题 ~40s + 判分 ~60~80s ≈ **1.5~2 分钟**。
- 固定考核 3 课（每课 3 题≈9 题）：出题并发 ~35s + 判分（9 题/并发3≈3 批）~75s+ ≈ **2 分钟+**。

### 优化方向（建议，非必改）
- 一次考核内**复用同一 model runtime / session**（至少判分 9 题不再每题重初始化）。
- 判分改为**单 session 内多题**或合并 prompt，减少握手开销。
- 出题模型可考虑更轻量/更快的模型或更长超时与进度反馈（前端已显示「出题/判分中」即可，避免家长以为卡死）。

---

## 入口清单（排查/修改落点）
- `server/src/agent/exam-engine.ts`：`GENERATION_PER_COURSE_RULES`(L78-81) 禁背通；`createExamSession`(L256) 每次重建；`scoreExamAttempt`(L341) 每题重建 session
- `server/src/assess-selection.ts`：`attachStructuredQuestions` 只按知识点筛、不按 behavior 筛（L113-134）
- `server/src/routes/exam.ts`：`structuredCourses` 调用处（L731/L751/L771/L809）；`/assess/method-spec`(L1577) 仅 `recitePass` 通过线
- `server/src/agent/parent-plans.ts`：`methodSpec` schema（L681-711）无 reciteOnly/mode
- `electron/lib/assess-guide.ts`：背诵题写法约定（`behavior: speech_recite`，语料驱动）
- 审计：`data/exam-audit/<childId>/*.jsonl`（含 `costMs`/`llmQ`/`recQ`/`outQ`，是分析耗时与题型构成的真源）
